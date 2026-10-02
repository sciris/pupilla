// The learning core: memory shape and the update rules, with no engine calls,
// so tests can drive it directly.
//
// Rules (see README for sources):
// - Rules bank: plain-language hypotheses about the user, each a discounted
//   Beta(a, b) over "a candidate built on this rule matched". Chosen for the
//   prompt by UCB so new rules get tried (HypoGeniC); discounting forgets old
//   evidence so the bank tracks drift.
// - Calibration: stated probabilities are mapped to hit rates through
//   discounted reliability bins, shrunk toward the stated value while a bin is
//   thin.
// - Abstention: one threshold on the calibrated mass of the candidate set,
//   moved online toward a target hit rate (adaptive conformal inference).
//   Hidden sets are graded too, so abstaining still teaches.
// - Raw episodes are the source of truth; rules and profile are rewritten only
//   in batches, from the misses (ExpeL-style ADD / EDIT / DELETE).

import type { Candidate, Confidence, Pending } from '../types'

export type Rule = {
  id: string
  text: string
  /** Discounted successes and failures, prior included. */
  a: number
  b: number
  /** Times cited by a graded candidate. */
  uses: number
  born: number
}

/**
 * What the person did with a shown set: sent a guess as-is, took one and
 * changed it, or wrote their own. `unshown` when nothing was shown.
 */
export type Outcome = 'accepted' | 'edited' | 'own' | 'unshown'

export type Episode = {
  at: number
  project: string
  /** Agent output, head and tail. */
  output: string
  /** What the user actually typed. */
  actual: string
  /** The best candidate and its grade, if there were candidates. */
  best: string
  bestScore: number
  /** Rank (1-based) of the best-scoring candidate, 0 when none scored. */
  rank: number
  isShown: boolean
  outcome: Outcome
  /** The guess taken, for `accepted` and `edited`. */
  taken: string
  /** One line on what the prediction failed to anticipate. */
  note: string
}

export type Bin = { n: number; y: number }

export type Stats = {
  turns: number
  shown: number
  /** Turns where the top candidate scored 1, among all graded turns. */
  top1: number
  /** Turns where any candidate scored 1. */
  any: number
  /** Turns where a shown set held a match. */
  shownHits: number
  /** Shown turns by outcome: a guess sent as-is, taken then changed, or the person's own. */
  accepted: number
  edited: number
  own: number
  /** Running mean Brier score over the candidate set plus "other". */
  brier: number
}

export type Memory = {
  v: 1
  profile: string
  rules: Rule[]
  bins: Bin[]
  /** Calibrated-mass threshold for showing a set. */
  tau: number
  episodes: Episode[]
  /** Indices (by `at`) of episodes not yet reflected on. */
  misses: number[]
  sinceReflect: number
  stats: Stats
  nextId: number
}

export const LIMITS = {
  episodes: 400,
  rules: 40,
  rulesInPrompt: 25,
  examples: 8,
  frequent: 12,
  maxCandidates: 5,
  /** Misses that trigger a reflection. */
  reflectAfterMisses: 5,
  /** Episodes that trigger a reflection regardless (also rewrites the profile). */
  reflectAfterEpisodes: 25,
  outputChars: 900,
}

const TUNING = {
  /** Per-update discount on a rule's evidence. */
  ruleDecay: 0.97,
  /** Per-update discount on a calibration bin. */
  binDecay: 0.995,
  /** Pseudo-count pulling a thin bin toward the stated probability. */
  binPrior: 4,
  ucb: 0.5,
  /** Target hit rate of a shown set, and the threshold's step size. */
  target: 0.5,
  step: 0.03,
  tauMin: 0.05,
  tauMax: 0.8,
  /** Below this calibrated probability a candidate is not shown. */
  minP: 0.05,
  high: 0.5,
  medium: 0.2,
  /** Weight of the newest turn in the running Brier mean. */
  brierRate: 0.05,
  /** Rules with this many uses and a mean below the floor are dropped. */
  pruneUses: 8,
  pruneMean: 0.15,
}

export function emptyMemory(): Memory {
  return {
    v: 1,
    profile: '',
    rules: [],
    bins: Array.from({ length: 10 }, () => ({ n: 0, y: 0 })),
    tau: 0.25,
    episodes: [],
    misses: [],
    sinceReflect: 0,
    stats: { turns: 0, shown: 0, top1: 0, any: 0, shownHits: 0, accepted: 0, edited: 0, own: 0, brier: 0 },
    nextId: 1,
  }
}

/** Fills fields a stored memory from an older version lacks. */
export function loadMemory(stored: unknown): Memory {
  const fresh = emptyMemory()
  if (stored === null || typeof stored !== 'object') {
    return fresh
  }
  const mem = { ...fresh, ...(stored as Partial<Memory>) }
  mem.stats = { ...fresh.stats, ...mem.stats }
  if (mem.bins.length !== 10) {
    mem.bins = fresh.bins
  }
  return mem
}

// Text helpers

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(t => t.length > 2))
}

export function jaccard(x: string, y: string): number {
  const a = tokens(x)
  const b = tokens(y)
  if (a.size === 0 || b.size === 0) {
    return 0
  }
  let both = 0
  for (const t of a) {
    if (b.has(t)) {
      both += 1
    }
  }
  return both / (a.size + b.size - both)
}

/** Head and tail of a long output: the end is where questions to the user sit. */
export function excerpt(text: string, chars = LIMITS.outputChars): string {
  if (text.length <= chars) {
    return text
  }
  const head = Math.floor(chars * 0.25)
  return `${text.slice(0, head)} […] ${text.slice(text.length - (chars - head))}`
}

/** The first JSON object in a model reply, or null. */
export function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Reading memory for a prediction

function ruleMean(rule: Rule): number {
  return rule.a / (rule.a + rule.b)
}

/** Rules for the prompt: highest upper confidence bound first. */
export function selectRules(mem: Memory, k = LIMITS.rulesInPrompt): Rule[] {
  const total = mem.rules.reduce((sum, r) => sum + r.uses, 0)
  const ucb = (r: Rule) => ruleMean(r) + TUNING.ucb * Math.sqrt(Math.log(total + 2) / (r.a + r.b))
  return [...mem.rules].sort((x, y) => ucb(y) - ucb(x)).slice(0, k)
}

/** Past episodes for the prompt: the most recent, then the most similar. */
export function selectExamples(mem: Memory, output: string, k = LIMITS.examples): Episode[] {
  const recent = mem.episodes.slice(-Math.ceil(k / 2))
  const similar = mem.episodes
    .slice(0, -Math.ceil(k / 2))
    .map(ep => ({ ep, sim: jaccard(ep.output, output) }))
    .filter(x => x.sim > 0.05)
    .sort((x, y) => y.sim - x.sim)
    .slice(0, k - recent.length)
    .map(x => x.ep)
  return [...similar.reverse(), ...recent]
}

/** Prompts the user has sent more than once, most frequent first. */
export function frequentPrompts(mem: Memory, k = LIMITS.frequent): { text: string; count: number }[] {
  const counts = new Map<string, { text: string; count: number }>()
  for (const ep of mem.episodes) {
    const key = normalize(ep.actual)
    if (key.length === 0 || key.split(' ').length > 12) {
      continue
    }
    const seen = counts.get(key)
    counts.set(key, { text: seen?.text ?? ep.actual.trim(), count: (seen?.count ?? 0) + 1 })
  }
  return [...counts.values()]
    .filter(x => x.count > 1)
    .sort((x, y) => y.count - x.count)
    .slice(0, k)
}

// Turning a model's answer into candidates

function binOf(p: number): number {
  return Math.min(9, Math.max(0, Math.floor(p * 10)))
}

export function calibrate(mem: Memory, raw: number): number {
  const bin = mem.bins[binOf(raw)] ?? { n: 0, y: 0 }
  return (bin.y + TUNING.binPrior * raw) / (bin.n + TUNING.binPrior)
}

function labelOf(p: number, isTop: boolean): Confidence {
  if (isTop && p >= TUNING.high) {
    return 'high'
  }
  return p >= TUNING.medium ? 'medium' : 'low'
}

/**
 * Candidates from the predictor's parsed reply: deduplicated, stated
 * probabilities made coherent (sum at most 1), calibrated, sorted, labelled
 * with at most one `high`.
 */
export function toCandidates(mem: Memory, reply: Record<string, unknown> | null): Candidate[] {
  const list = Array.isArray(reply?.candidates) ? reply.candidates : []
  const seen = new Set<string>()
  const parsed: { text: string; raw: number; rules: string[] }[] = []
  for (const item of list) {
    const c = item as { text?: unknown; p?: unknown; rules?: unknown }
    const text = typeof c.text === 'string' ? c.text.trim() : ''
    const raw = typeof c.p === 'number' && Number.isFinite(c.p) ? Math.min(1, Math.max(0, c.p)) : 0
    const key = normalize(text)
    if (key.length === 0 || seen.has(key)) {
      continue
    }
    seen.add(key)
    const rules = Array.isArray(c.rules) ? c.rules.filter((r): r is string => typeof r === 'string') : []
    parsed.push({ text, raw, rules })
  }
  const sum = parsed.reduce((s, c) => s + c.raw, 0)
  const scale = sum > 1 ? 1 / sum : 1
  const out = parsed
    .map(c => {
      const raw = c.raw * scale
      return { text: c.text, raw, p: calibrate(mem, raw), rules: c.rules, confidence: 'low' as Confidence }
    })
    .sort((x, y) => y.p - x.p)
    .slice(0, LIMITS.maxCandidates)
  // Calibration is per candidate, so the set can drift past 1; renormalize.
  const total = out.reduce((s, c) => s + c.p, 0)
  if (total > 1) {
    for (const c of out) {
      c.p /= total
    }
  }
  out.forEach((c, i) => {
    c.confidence = labelOf(c.p, i === 0)
  })
  return out
}

/** Index of the shown candidate whose text is `text`, or -1. */
export function shownIndex(candidates: Candidate[], text: string): number {
  const key = normalize(text)
  return key === '' ? -1 : candidates.findIndex(c => c.p >= TUNING.minP && normalize(c.text) === key)
}

/**
 * Classifies the reply. A guess counts as taken when it was picked from the
 * band or the box ever held it exactly (`picked`), or, failing that, when the
 * reply starts with the top guess (taken with Tab, then extended).
 */
export function outcomeOf(pending: Pending, actual: string): { outcome: Outcome; taken: number } {
  if (!pending.isShown) {
    return { outcome: 'unshown', taken: -1 }
  }
  const exact = shownIndex(pending.candidates, actual)
  if (pending.picked !== null) {
    return { outcome: exact === pending.picked ? 'accepted' : 'edited', taken: pending.picked }
  }
  if (exact >= 0) {
    return { outcome: 'accepted', taken: exact }
  }
  const top = pending.candidates[0]
  const sent = normalize(actual)
  if (top?.confidence === 'high' && sent.startsWith(normalize(top.text))) {
    return { outcome: 'edited', taken: 0 }
  }
  return { outcome: 'own', taken: -1 }
}

/** The candidates worth showing, or none when the set is too unlikely. */
export function visible(mem: Memory, candidates: Candidate[]): Candidate[] {
  const shown = candidates.filter(c => c.p >= TUNING.minP)
  const mass = shown.reduce((s, c) => s + c.p, 0)
  return mass >= mem.tau ? shown : []
}

// Learning from the actual reply

/** Score 1 without asking a model when the reply is a candidate verbatim. */
export function quickScores(candidates: Candidate[], actual: string): number[] | null {
  const key = normalize(actual)
  const exact = candidates.findIndex(c => normalize(c.text) === key)
  return exact >= 0 ? candidates.map((_, i) => (i === exact ? 1 : 0)) : null
}

/**
 * Applies one graded turn: calibration bins, rule credit, the abstention
 * threshold, running stats, and the episode log. Mutates and returns `mem`.
 * `scores[i]` grades `pending.candidates[i]`: 1 same request, 0.5 same intent,
 * 0 different.
 */
export function learn(mem: Memory, pending: Pending, actual: string, scores: number[], note: string): Memory {
  const cands = pending.candidates
  const { outcome, taken } = outcomeOf(pending, actual)
  // A taken guess was the person's best starting point: at least same intent.
  const ys = cands.map((_, i) => Math.min(1, Math.max(i === taken ? 0.5 : 0, scores[i] ?? 0)))
  const best = ys.length > 0 ? Math.max(...ys) : 0
  const bestIndex = ys.indexOf(best)
  const isHit = best >= 1

  // Calibration: every candidate, shown or not, is one observation in its bin.
  for (const bin of mem.bins) {
    bin.n *= TUNING.binDecay
    bin.y *= TUNING.binDecay
  }
  cands.forEach((c, i) => {
    const bin = mem.bins[binOf(c.raw)]
    if (bin !== undefined) {
      bin.n += 1
      bin.y += ys[i] ?? 0
    }
  })

  // Rules: each cited rule is credited with the best grade among the
  // candidates that cited it.
  const credit = new Map<string, number>()
  cands.forEach((c, i) => {
    for (const id of c.rules) {
      credit.set(id, Math.max(credit.get(id) ?? 0, ys[i] ?? 0))
    }
  })
  for (const rule of mem.rules) {
    const y = credit.get(rule.id)
    if (y === undefined) {
      continue
    }
    rule.a = 1 + (rule.a - 1) * TUNING.ruleDecay + y
    rule.b = 1 + (rule.b - 1) * TUNING.ruleDecay + (1 - y)
    rule.uses += 1
  }
  mem.rules = mem.rules.filter(r => r.uses < TUNING.pruneUses || ruleMean(r) >= TUNING.pruneMean)

  // Abstention threshold: a shown miss raises it, a shown hit lowers it, and a
  // hidden set that would have hit lowers it too.
  const hit = isHit ? 1 : 0
  if (pending.isShown) {
    mem.tau += TUNING.step * ((1 - hit) - (1 - TUNING.target))
  } else if (isHit) {
    mem.tau -= TUNING.step * TUNING.target
  }
  mem.tau = Math.min(TUNING.tauMax, Math.max(TUNING.tauMin, mem.tau))

  // Stats. Brier over the set plus the implicit "something else".
  const s = mem.stats
  s.turns += 1
  s.shown += pending.isShown ? 1 : 0
  s.top1 += ys[0] !== undefined && ys[0] >= 1 ? 1 : 0
  s.any += hit
  s.shownHits += pending.isShown ? hit : 0
  if (outcome !== 'unshown') {
    s[outcome] += 1
  }
  const other = Math.max(0, 1 - cands.reduce((sum, c) => sum + c.p, 0))
  const brier = cands.reduce((sum, c, i) => sum + (c.p - (ys[i] ?? 0)) ** 2, 0) + (other - (1 - best)) ** 2
  s.brier = s.turns === 1 ? brier : s.brier + TUNING.brierRate * (brier - s.brier)

  // Episode log, and the miss bank reflection draws on.
  const episode: Episode = {
    at: pending.at,
    project: pending.project,
    output: pending.output,
    actual: actual.slice(0, 2000),
    best: cands[bestIndex]?.text ?? '',
    bestScore: best,
    rank: best > 0 ? bestIndex + 1 : 0,
    isShown: pending.isShown,
    outcome,
    taken: cands[taken]?.text ?? '',
    note,
  }
  mem.episodes = [...mem.episodes, episode].slice(-LIMITS.episodes)
  if (!isHit) {
    mem.misses = [...mem.misses, episode.at].slice(-20)
  }
  mem.sinceReflect += 1
  return mem
}

export function shouldReflect(mem: Memory): boolean {
  return mem.misses.length >= LIMITS.reflectAfterMisses || mem.sinceReflect >= LIMITS.reflectAfterEpisodes
}

export type Edit =
  | { op: 'add'; text: string }
  | { op: 'edit'; id: string; text: string }
  | { op: 'delete'; id: string }

/** Applies a reflection's rule edits and profile; clears the miss bank. */
export function applyReflection(mem: Memory, reply: Record<string, unknown> | null, now: number): Memory {
  const edits = Array.isArray(reply?.edits) ? (reply.edits as Edit[]) : []
  for (const edit of edits) {
    if (edit.op === 'add' && typeof edit.text === 'string' && edit.text.trim() !== '') {
      mem.rules.push({ id: `r${mem.nextId}`, text: edit.text.trim(), a: 1, b: 1, uses: 0, born: now })
      mem.nextId += 1
    } else if (edit.op === 'edit' && typeof edit.text === 'string') {
      const rule = mem.rules.find(r => r.id === edit.id)
      if (rule !== undefined) {
        // A reworded rule keeps half its evidence: it is mostly the same claim.
        rule.text = edit.text.trim()
        rule.a = 1 + (rule.a - 1) / 2
        rule.b = 1 + (rule.b - 1) / 2
      }
    } else if (edit.op === 'delete') {
      mem.rules = mem.rules.filter(r => r.id !== edit.id)
    }
  }
  if (mem.rules.length > LIMITS.rules) {
    // Keep the rules with the best lower bound.
    const lcb = (r: Rule) => ruleMean(r) - Math.sqrt(1 / (r.a + r.b))
    mem.rules = [...mem.rules].sort((x, y) => lcb(y) - lcb(x)).slice(0, LIMITS.rules)
  }
  if (typeof reply?.profile === 'string' && reply.profile.trim() !== '') {
    mem.profile = reply.profile.trim()
  }
  mem.misses = []
  mem.sinceReflect = 0
  return mem
}

export function describeRule(rule: Rule): string {
  return `${rule.id} (${Math.round(ruleMean(rule) * 100)}%, ${rule.uses} uses): ${rule.text}`
}

export function percent(x: number, n: number): string {
  return n === 0 ? '-' : `${Math.round((100 * x) / n)}%`
}
