import { expect, mock, test } from 'claude-code/testing'

function usage(percent: number) {
  return {
    value: {
      startedAt: 0,
      context: { tokens: percent * 2000, window: 200000, percent },
      rateLimits: [{ kind: 'five_hour', percentUsed: 31.5 }, { kind: 'seven_day', percentUsed: 0 }],
      cost: { usd: 1.234 },
    },
  }
}

test('the status line carries context, cost, rate limits and tool calls', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const lines: Array<string | undefined> = []
  on('session.usage', () => usage(42) as never)
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('session.start', e => ({ cwd: '/repo' }) as never)
  on('tool.call', { tool: 'Read' }, () => ({ result: {} as never }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(lines.at(-1)).toBe('ctx 42% · 84k/200k · $1.23 · 5h 32%')

  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
  expect(lines.at(-1)).toBe('ctx 42% · 84k/200k · $1.23 · 5h 32% · 1 tool')
})

test('one toast when the window passes 80%', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const toasts: string[] = []
  let percent = 50
  on('session.usage', () => usage(percent) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))

  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
  await $.turn.complete(turn)
  expect(toasts.length).toBe(0)
  percent = 85
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('85%')
})
