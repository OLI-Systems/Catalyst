import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'catalyst-orchestrator',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100 } as never,
} as const

function spawn(id: string, description: string) {
  return {
    tool_use_id: `tu-${id}`,
    prompt: 'do it',
    description,
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
  } as never
}

test('the band lists running agents, then their finish, then gets out of the way', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let next = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `a${++next}` }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  // The engine's own band: nothing, as when no plugin has anything to show.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ ...BAND, surface })
    expect(await empty.find({ type: 'Text', text: /Agents/ })).toBeUndefined()
    await empty.unmount()
  }

  await $.agent.spawn(spawn('1', 'map the auth flow'))
  await $.agent.spawn(spawn('2', 'find callers of buildArgv'))
  await clock.advance(42_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Agents/ }))?.text).toContain('2 running')
  expect(await ui.find({ type: 'Text', text: /map the auth flow.*0:42/ })).toBeDefined()

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a1' })
  expect((await ui.find({ type: 'Text', text: /Agents/ }))?.text).toContain('1 running · 1 done')

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'error', agentId: 'a2' })
  await clock.advance(25_000)
  await ui.unmount()
  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /Agents/ })).toBeUndefined()
  await later.unmount()
})
