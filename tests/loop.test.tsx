import { expect, mock, test } from 'claude-code/testing'

const BAND = { plugin: 'pupilla', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

const GUESSES = JSON.stringify({
  state: 'tests pass, user will want to commit',
  candidates: [
    { text: 'commit this', p: 0.6 },
    { text: 'run the full suite', p: 0.2 },
  ],
})

test('predicts after a turn, shows guesses, and learns from the reply', { options: { predictor: 'haiku' }, timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const filled: string[] = []
  const suggested: string[] = []
  on('model.complete', () => ({ value: { isAnswered: true, text: GUESSES, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('session.root', () => ({ value: '/home/someone/proj' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.suggest', (_$, e) => {
    suggested.push(e.text)
    return { isShown: true }
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.run', () => ({ text: '' }))
  on('session.start', (_$, e) => e)

  await $.session.start({ cwd: '/home/someone/proj', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'All 40 tests pass. Want me to commit?', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'c0' })).toBeDefined()
    expect(await ui.find({ key: 'c1' })).toBeDefined()
    await ui.unmount()
  }
  expect(suggested).toEqual(['commit this'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'c0' })
  expect(filled).toEqual(['commit this'])
  await ui.unmount()

  await $.prompt.submit({ text: 'commit this', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1)
  const { text } = await $.command.run({ command: 'pupilla', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(text).toContain('Graded turns: 1')
  expect(text).toContain('top-1 match: 100%')
  expect(text).toContain('sent one as-is 1 (100%)')
})
