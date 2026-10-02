import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Candidate, Pending, Phase } from '../types'
import type { Memory } from './learn'
import {
  applyReflection,
  calibrate,
  describeRule,
  emptyMemory,
  excerpt,
  learn,
  loadMemory,
  parseJson,
  percent,
  quickScores,
  shouldReflect,
  shownIndex,
  toCandidates,
  visible,
} from './learn'
import { gradePrompt, predictPrompt, reflectPrompt } from './prompts'

const phase = atom({ plugin: 'pupilla', key: 'phase' } as const, 'idle' as Phase)
const pending = atom({ plugin: 'pupilla', key: 'pending' } as const, null as Pending | null)

const MEMORY = 'memory'
const ENABLED = 'enabled'
const COLORS = { high: 'green', medium: 'yellow', low: 'gray' } as const

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

const config = { predictor: 'fork', grader: 'haiku', reflector: 'sonnet' }

// Memory writes are read-modify-write against the store, one at a time, so
// two sessions sharing the store lose as little as possible.
let chain: Promise<unknown> = Promise.resolve()

// When the person last submitted: a prediction that finishes after it is stale.
let submittedAt = 0

async function withMemory<T>($: EngineInterface, fn: (mem: Memory) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const mem = loadMemory(await $.store.get(MEMORY))
    const out = await fn(mem)
    await $.store.set(MEMORY, mem)
    return out
  })
  chain = run.catch(() => undefined)
  return run
}

async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await $.store.get(ENABLED)) !== false
}

async function showStatus($: EngineInterface): Promise<void> {
  if (!(await isEnabled($))) {
    $.ui.status('pupilla off')
    return
  }
  const s = loadMemory(await $.store.get(MEMORY)).stats
  const shown = s.accepted + s.edited + s.own
  $.ui.status(shown === 0 ? 'pupilla learning' : `pupilla ${percent(s.accepted, shown)} as-is · ${percent(s.edited, shown)} edited · n=${shown}`)
}

async function predict($: EngineInterface, output: string, turnId: string): Promise<void> {
  const startedAt = await $.clock.now()
  await update($, pending, () => null)
  await update($, phase, () => 'predicting')
  const mem = loadMemory(await $.store.get(MEMORY))
  const isFork = config.predictor === 'fork'
  const prompt = predictPrompt(mem, output, isFork)
  const result = isFork
    ? await $.model.fork({ prompt })
    : await $.model.complete({ model: config.predictor, prompt, maxTokens: 1500, timeoutMs: 60000 })
  if (submittedAt > startedAt) {
    // The person answered first; in fork mode the transcript now holds the
    // answer, so the guess cannot be graded fairly. Drop it.
    return
  }
  if (!result.isAnswered) {
    $.ui.log(`pupilla: no prediction (${result.reason})`)
    await update($, phase, () => 'idle')
    return
  }
  const reply = parseJson(result.text)
  const candidates = toCandidates(mem, reply)
  const shown = visible(mem, candidates)
  const next: Pending = {
    turnId,
    at: startedAt,
    project: (await $.session.root()).split('/').pop() ?? '',
    output: excerpt(output),
    state: typeof reply?.state === 'string' ? reply.state : '',
    candidates,
    mass: candidates.reduce((s, c) => s + c.p, 0),
    isShown: shown.length > 0,
    picked: null,
  }
  await update($, pending, () => next)
  await update($, phase, () => next.isShown ? 'shown' : 'abstained')
  const top = shown[0]
  if (top?.confidence === 'high') {
    void $.prompt.suggest({ text: top.text })
  }
}

async function reflect($: EngineInterface): Promise<boolean> {
  const mem = loadMemory(await $.store.get(MEMORY))
  const result = await $.model.complete({ model: config.reflector, prompt: reflectPrompt(mem), maxTokens: 3000, timeoutMs: 120000 })
  if (!result.isAnswered) {
    $.ui.log(`pupilla: reflection failed (${result.reason})`)
    return false
  }
  const reply = parseJson(result.text)
  const now = await $.clock.now()
  await withMemory($, m => applyReflection(m, reply, now))
  return true
}

async function grade($: EngineInterface, held: Pending, actual: string): Promise<void> {
  let scores = quickScores(held.candidates, actual)
  let note = ''
  if (scores === null && held.candidates.length > 0) {
    const result = await $.model.complete({ model: config.grader, prompt: gradePrompt(held, actual), maxTokens: 400, effort: 'low', timeoutMs: 30000 })
    const reply = result.isAnswered ? parseJson(result.text) : null
    if (!Array.isArray(reply?.scores)) {
      $.ui.log('pupilla: could not grade this turn')
      return
    }
    scores = reply.scores.map(Number)
    note = typeof reply.note === 'string' ? reply.note : ''
  }
  const mem = await withMemory($, m => learn(m, held, actual, scores ?? [], note))
  await showStatus($)
  if (shouldReflect(mem)) {
    await reflect($)
  }
}

// The person's actual next message: settle the pending guess against it.
async function settle($: EngineInterface, actual: string): Promise<void> {
  submittedAt = await $.clock.now()
  const held = await read($, pending)
  await update($, pending, () => null)
  const idle: Phase = (await isEnabled($)) ? 'idle' : 'off'
  await update($, phase, () => idle)
  if (held !== null) {
    $.clock.after(0, () => void grade($, held, actual))
  }
}

function report(mem: Memory, isOn: boolean): string {
  const s = mem.stats
  const bins = mem.bins
    .map((b, i) => (b.n >= 1 ? `${i * 10}–${i * 10 + 10}%: ${Math.round((100 * b.y) / b.n)}% (n=${Math.round(b.n)})` : ''))
    .filter(Boolean)
  const lines = [
    `**pupilla** ${isOn ? 'on' : 'off'} · predictor ${config.predictor} · grader ${config.grader} · reflector ${config.reflector}`,
    '',
    `When guesses were shown (${s.accepted + s.edited + s.own}): sent one as-is ${s.accepted} (${percent(s.accepted, s.accepted + s.edited + s.own)}) · took one and edited it ${s.edited} (${percent(s.edited, s.accepted + s.edited + s.own)}) · wrote your own ${s.own} (${percent(s.own, s.accepted + s.edited + s.own)})`,
    `Graded turns: ${s.turns} · shown: ${s.shown} · top-1 match: ${percent(s.top1, s.turns)} · any match: ${percent(s.any, s.turns)} · shown-set match: ${percent(s.shownHits, s.shown)} · Brier: ${s.brier.toFixed(2)} · show threshold: ${mem.tau.toFixed(2)}`,
    '',
    `Calibration (stated → observed): ${bins.length > 0 ? bins.join(' · ') : 'no data yet'}`,
    `Examples: a stated 30% now shows as ${Math.round(calibrate(mem, 0.3) * 100)}%, a stated 70% as ${Math.round(calibrate(mem, 0.7) * 100)}%.`,
    '',
    `**Profile:** ${mem.profile || '(none yet)'}`,
    '',
    `**Rules** (${mem.rules.length}; misses awaiting reflection: ${mem.misses.length}):`,
    ...(mem.rules.length > 0 ? mem.rules.map(r => `- ${describeRule(r)}`) : ['- (none yet)']),
  ]
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  config.predictor = String(options.predictor ?? 'fork')
  config.grader = String(options.grader ?? 'haiku')
  config.reflector = String(options.reflector ?? 'sonnet')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pupilla',
      description: 'Next-prompt predictor: stats and rules; on, off, reflect, forget',
      argumentHint: '[on|off|reflect|forget]',
    })
    const idle: Phase = (await isEnabled($)) ? 'idle' : 'off'
    await update($, phase, () => idle)
    await showStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== ''
    if (isMain && (await isEnabled($))) {
      const { answer, turnId } = e
      $.clock.after(0, () => void predict($, answer, turnId))
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer') {
      await settle($, e.text)
    }
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.origin?.kind === 'composer' && e.command !== 'pupilla') {
      await settle($, `/${e.command}${e.args ? ` ${e.args}` : ''}`)
    }
    return next(e)
  })

  // A guess can reach the box without a band press (Tab on the dim one, or
  // typed out): note it when the box holds a shown guess exactly.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const held = await read($, pending)
    if (held !== null && held.isShown && held.picked === null) {
      const i = shownIndex(held.candidates, box.text)
      if (i >= 0) {
        await update($, pending, p => (p === null ? p : { ...p, picked: i }))
      }
    }
    return box
  })

  // The engine's own guess would compete with ours; ours abstains on purpose.
  on('prompt.suggest', { origin: { kind: 'suggestion' } }, async ($, e, next) => ((await isEnabled($)) ? { isShown: false } : next(e)))

  on('command.run', { command: 'pupilla' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') {
      await $.store.set(ENABLED, arg === 'on')
      await update($, pending, () => null)
      await update($, phase, () => arg === 'on' ? 'idle' : 'off')
      await showStatus($)
      return { text: `pupilla is ${arg}.` }
    }
    if (arg === 'reflect') {
      const isDone = await reflect($)
      return { text: isDone ? 'pupilla reflected: rules and profile updated.' : 'pupilla could not reflect; see the log.' }
    }
    if (arg === 'forget') {
      return { text: 'This erases everything pupilla has learned. Run `/pupilla forget yes` to confirm.' }
    }
    if (arg === 'forget yes') {
      await $.store.set(MEMORY, emptyMemory())
      await showStatus($)
      return { text: 'pupilla memory erased.' }
    }
    return { text: report(loadMemory(await $.store.get(MEMORY)), await isEnabled($)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) {
      return next(e)
    }
    const now = await read($, phase)
    const held = await read($, pending)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (now === 'predicting') {
      return <Text dimColor>pupilla: guessing your reply…</Text>
    }
    if (now !== 'shown' || held === null) {
      return next(e)
    }
    const width = Math.max(20, e.props.bodyColumns - 16)
    const rows = held.candidates.filter((c: Candidate) => held.isShown && c.p >= 0.05)
    return (
      <Box flexDirection="column">
        <Text dimColor>pupilla guesses · digit picks, Enter sends{rows[0]?.confidence === 'high' ? ', Tab takes the dim one' : ''}</Text>
        {rows.map((c: Candidate, i: number) => (
          <Box key={`row${i}`}>
            <Button
              key={`c${i}`}
              plain
              hotkey={String(i + 1)}
              label={clip(c.text, width)}
              onPress={async () => {
                await update($, pending, p => (p === null ? p : { ...p, picked: i }))
                await $.prompt.fill({ text: c.text, mode: 'replace' })
              }}
            />
            <Text color={COLORS[c.confidence]}>
              {' '}
              {c.confidence} {Math.round(c.p * 100)}%
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
