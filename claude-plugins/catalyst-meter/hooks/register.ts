// Catalyst Meter: the session's vital signs on the status line under the prompt.
//
//   ctx 42% · 84k/200k · $1.23 · 5h 31% · 12 tools
//
// Catalyst's Manage panel already shows context and cost from the transcript,
// but only for the tab in focus and only once you open it. This puts the same
// figures, plus the account's rate-limit use, in the terminal itself, where the
// agent's work is happening. When the context window passes 80% it says so once
// with a toast, so a /compact can be chosen rather than happen.

import type { EngineInterface, Register } from 'claude-code'

const WARN_AT = 80

let tools = 0
let warned = false
let lastRefresh = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    tools = 0
    warned = false
    await refresh($)
    return ran
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      tools += 1
    }
    const ran = await next(e)
    // Tool calls come in bursts; redraw at most once a second.
    const now = await $.clock.now()
    if (now - lastRefresh > 1000) {
      lastRefresh = now
      await refresh($)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      await refresh($)
    }
    return ran
  })

  on('session.compact', async ($, e, next) => {
    const ran = await next(e)
    warned = false
    await refresh($)
    return ran
  })
}

async function refresh($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    const parts: string[] = []
    const { percent, tokens, window } = usage.context
    if (percent !== undefined && tokens !== undefined) {
      parts.push(`ctx ${percent}% · ${short(tokens)}/${short(window)}`)
      if (percent >= WARN_AT && !warned) {
        warned = true
        $.ui.toast(`Context is ${percent}% full. Consider /compact before the next big step.`, { timeoutMs: 8000 })
      }
    }
    if (usage.cost !== undefined) {
      parts.push(`$${usage.cost.usd.toFixed(2)}`)
    }
    for (const limit of usage.rateLimits) {
      if (limit.percentUsed >= 1) {
        parts.push(`${label(limit.kind)} ${Math.round(limit.percentUsed)}%`)
      }
    }
    if (tools > 0) {
      parts.push(`${tools} ${tools === 1 ? 'tool' : 'tools'}`)
    }
    $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
  } catch {
    // A status line is never worth failing a hook over.
  }
}

function short(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`
  }
  return String(n)
}

function label(kind: string): string {
  if (kind === 'five_hour') {
    return '5h'
  }
  if (kind === 'seven_day') {
    return '7d'
  }
  return kind.replace(/_/g, ' ')
}
