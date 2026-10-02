import { describe, expect, test } from 'claude-code/testing'

import type { Pending } from '../types'
import { applyReflection, calibrate, emptyMemory, learn, outcomeOf, quickScores, selectRules, toCandidates, visible } from '../hooks/learn'

function pendingOf(candidates: Pending['candidates'], isShown = true): Pending {
  return { turnId: 't', at: 1, project: 'p', output: 'Tests pass. Commit?', state: '', candidates, mass: 1, isShown, picked: null }
}

describe('candidates', () => {
  test('at most 5, coherent, at most one high', () => {
    const mem = emptyMemory()
    const reply = {
      candidates: [
        { text: 'commit this', p: 0.7 },
        { text: 'Commit this!', p: 0.6 },
        { text: 'run the tests again', p: 0.6 },
        { text: 'a', p: 0.1 },
        { text: 'b', p: 0.1 },
        { text: 'c', p: 0.1 },
        { text: 'd', p: 0.1 },
      ],
    }
    const out = toCandidates(mem, reply)
    expect(out.length).toBe(5)
    expect(out.filter(c => c.confidence === 'high').length).toBeLessThanOrEqual(1)
    expect(out.reduce((s, c) => s + c.p, 0)).toBeLessThanOrEqual(1.000001)
    // the duplicate "Commit this!" is dropped
    expect(out.filter(c => c.text.toLowerCase().startsWith('commit')).length).toBe(1)
  })

  test('abstains when the set is unlikely', () => {
    const mem = emptyMemory()
    const out = toCandidates(mem, { candidates: [{ text: 'maybe this', p: 0.08 }] })
    expect(visible(mem, out)).toEqual([])
    expect(toCandidates(mem, { candidates: [] })).toEqual([])
    expect(toCandidates(mem, null)).toEqual([])
  })
})

describe('learning', () => {
  test('calibration follows observed hit rates', () => {
    const mem = emptyMemory()
    expect(Math.abs(calibrate(mem, 0.8) - 0.8)).toBeLessThan(1e-9)
    for (let i = 0; i < 30; i += 1) {
      const cands = toCandidates(mem, { candidates: [{ text: 'yes', p: 0.8 }] })
      learn(mem, pendingOf(cands), 'no', [0], '')
    }
    expect(calibrate(mem, 0.8)).toBeLessThan(0.3)
  })

  test('rules gain on hits and lose on misses; the threshold moves', () => {
    const mem = applyReflection(emptyMemory(), { edits: [{ op: 'add', text: 'says commit after green tests' }, { op: 'add', text: 'asks for docs' }] }, 0)
    const [good, bad] = mem.rules
    const tau = mem.tau
    const cands = toCandidates(mem, {
      candidates: [
        { text: 'commit this', p: 0.5, rules: [good?.id] },
        { text: 'update the docs', p: 0.3, rules: [bad?.id] },
      ],
    })
    const scores = quickScores(cands, 'Commit this')
    expect(scores).toEqual([1, 0])
    learn(mem, pendingOf(cands), 'Commit this', scores ?? [], '')
    const after = (id?: string) => mem.rules.find(r => r.id === id)
    expect(after(good?.id)?.a).toBeGreaterThan(1)
    expect(after(bad?.id)?.b).toBeGreaterThan(1)
    expect(mem.tau).toBeLessThan(tau)
    expect(mem.stats.top1).toBe(1)
    expect(mem.episodes.length).toBe(1)
    expect(mem.misses.length).toBe(0)
  })

  test('hidden sets are still learned from', () => {
    const mem = emptyMemory()
    const cands = toCandidates(mem, { candidates: [{ text: 'ok', p: 0.1 }] })
    learn(mem, pendingOf(cands, false), 'something else entirely', [0], 'wanted a new feature')
    expect(mem.stats.turns).toBe(1)
    expect(mem.stats.shown).toBe(0)
    expect(mem.misses.length).toBe(1)
    expect(mem.episodes[0]?.note).toBe('wanted a new feature')
  })

  test('untried rules are explored before tried weak ones', () => {
    const mem = applyReflection(emptyMemory(), { edits: [{ op: 'add', text: 'old' }, { op: 'add', text: 'new' }] }, 0)
    const old = mem.rules[0]
    if (old !== undefined) {
      old.a = 2
      old.b = 6
      old.uses = 6
    }
    expect(selectRules(mem, 1)[0]?.text).toBe('new')
  })
})

describe('outcomes', () => {
  const cands = toCandidates(emptyMemory(), { candidates: [{ text: 'commit this', p: 0.6 }, { text: 'run the full suite', p: 0.2 }] })
  const picked = (i: number | null): Pending => ({ ...pendingOf(cands), picked: i })

  test('as-is, edited, own, and nothing shown', () => {
    expect(outcomeOf(picked(1), 'Run the full suite.').outcome).toBe('accepted')
    expect(outcomeOf(picked(null), 'commit this').outcome).toBe('accepted')
    expect(outcomeOf(picked(1), 'run the full suite with coverage').outcome).toBe('edited')
    // the top guess was high: a reply that extends it was taken with Tab
    expect(outcomeOf(picked(null), 'commit this and push').outcome).toBe('edited')
    expect(outcomeOf(picked(null), 'what about the docs?').outcome).toBe('own')
    expect(outcomeOf({ ...picked(null), isShown: false }, 'commit this').outcome).toBe('unshown')
  })

  test('counted in stats, and an edited pick is credited as same intent', () => {
    const mem = emptyMemory()
    learn(mem, picked(0), 'commit this', [1, 0], '')
    learn(mem, picked(1), 'run the full suite with coverage', [0, 0], 'wanted coverage')
    learn(mem, picked(null), 'what about the docs?', [0, 0], '')
    expect([mem.stats.accepted, mem.stats.edited, mem.stats.own]).toEqual([1, 1, 1])
    expect(mem.episodes[1]?.outcome).toBe('edited')
    expect(mem.episodes[1]?.taken).toBe('run the full suite')
    expect(mem.episodes[1]?.bestScore).toBe(0.5)
  })
})
