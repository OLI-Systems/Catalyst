// Catalyst Orchestrator: a live band above the prompt of the subagents at work.
//
//   Agents · 2 running · 1 done
//   ● Explore          map the auth flow                 0:42
//   ● general-purpose  add tests for the session store   1:10
//   ✓ Explore          find every caller of buildArgv    0:18
//
// The orchestrate skill in this plugin teaches Claude to fan work out across
// parallel subagents; this band is how the person watches that happen without
// expanding tool rows. Each spawn is recorded at `agent.spawn`, each finish at
// the subagent's own `turn.complete`, and a one-second tick (alive only while
// something runs) keeps the timers moving and reconciles with `$.agent.list()`
// for agents that were stopped rather than finished. Finished rows linger for
// a short while and the band then gets out of the way.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { FleetAgent } from '../types'

const agents = atom({ plugin: 'catalyst-orchestrator', key: 'agents' } as const, [] as FleetAgent[])
const now = atom({ plugin: 'catalyst-orchestrator', key: 'now' } as const, 0)

const LINGER_MS = 20_000
const MAX_KEPT = 30

let ticker: Timer | null = null

export const register: Register = on => {
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      const startedAt = await $.clock.now()
      const agent: FleetAgent = {
        id: spawned.agentId,
        description: e.description,
        type: e.subagentType,
        startedAt,
        endedAt: null,
        status: 'running',
      }
      await update($, agents, list => [...list.filter(a => a.id !== agent.id), agent].slice(-MAX_KEPT))
      await update($, now, () => startedAt)
      startTicker($)
    }
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) {
      const endedAt = await $.clock.now()
      const status: FleetAgent['status'] = e.reason === 'aborted' ? 'killed' : e.reason === 'answer' ? 'completed' : 'failed'
      await update($, agents, list =>
        list.map(a => (a.id === e.agentId && a.status === 'running' ? { ...a, status, endedAt } : a)),
      )
      await update($, now, () => endedAt)
    }
    return ran
  })

  on('session.end', async ($, e, next) => {
    stopTicker()
    if (e.reason === 'clear') {
      await update($, agents, () => [])
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const at = await read($, now)
    const shown = visible(await read($, agents), at)
    if (shown.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const running = shown.filter(a => a.status === 'running').length
    if (running > 0) {
      // A reload drops the old timer while agents still run; pick it back up.
      startTicker($)
    }
    const done = shown.length - running
    const room = Math.max(1, Math.min(shown.length, e.props.maxRows - 2))
    const rows = [...shown.filter(a => a.status === 'running'), ...shown.filter(a => a.status !== 'running')].slice(0, room)
    const typeWidth = Math.min(18, Math.max(...rows.map(a => a.type.length)))
    const hidden = shown.length - rows.length

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Agents</Text>
          <Text dimColor>
            {' · '}
            {running} running{done > 0 ? ` · ${done} done` : ''}
            {hidden > 0 ? ` · ${hidden} more` : ''}
          </Text>
        </Text>
        {rows.map(a => (
          <Text key={a.id} wrap="truncate-end">
            <Text color={MARK[a.status].color}>{MARK[a.status].glyph} </Text>
            <Text dimColor={a.status !== 'running'}>{pad(a.type, typeWidth)} </Text>
            <Text dimColor={a.status !== 'running'}>{a.description} </Text>
            <Text dimColor>{clock((a.endedAt ?? at) - a.startedAt)}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}

const MARK: Record<FleetAgent['status'], { glyph: string; color: string }> = {
  running: { glyph: '●', color: 'yellow' },
  completed: { glyph: '✓', color: 'green' },
  failed: { glyph: '✗', color: 'red' },
  killed: { glyph: '■', color: 'gray' },
}

function visible(list: readonly FleetAgent[], at: number): FleetAgent[] {
  const isAnyRunning = list.some(a => a.status === 'running')
  // While anything runs, show the whole batch; afterwards let it linger briefly.
  return list.filter(a => a.status === 'running' || (a.endedAt !== null && (isAnyRunning || at - a.endedAt < LINGER_MS)))
}

function startTicker($: EngineInterface) {
  if (ticker !== null) {
    return
  }
  ticker = $.clock.every(1000, () => {
    void tick($)
  })
}

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  // Agents stopped from the outside (TaskStop, Esc) raise no turn.complete of
  // their own; the engine's task list still knows how they ended.
  try {
    const known = await $.agent.list()
    const status = new Map(known.map(k => [k.id, k.status]))
    await update($, agents, list =>
      list.map(a => {
        const s = status.get(a.id)
        if (a.status !== 'running' || s === undefined || s === 'running') {
          return a
        }
        const ended: FleetAgent['status'] = s === 'completed' ? 'completed' : s === 'killed' ? 'killed' : 'failed'
        return { ...a, status: ended, endedAt: at }
      }),
    )
  } catch {
    // the list is a refinement; the timers still move without it
  }
  await update($, now, () => at)
  const list = await read($, agents)
  if (visible(list, at).length === 0) {
    stopTicker()
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}
