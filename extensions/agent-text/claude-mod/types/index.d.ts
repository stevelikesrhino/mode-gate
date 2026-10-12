export type Agent = {
  id: string
  name?: string
  cwd: string
  provider?: string
  model?: string
  kind?: string
  status: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-text-session': { agents: Agent[] }
  }
}
