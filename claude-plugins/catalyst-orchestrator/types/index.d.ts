export type FleetAgent = {
  id: string
  description: string
  type: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'completed' | 'failed' | 'killed'
}

declare module 'claude-code' {
  interface PluginState {
    'catalyst-orchestrator': { agents: FleetAgent[]; now: number }
  }
}
