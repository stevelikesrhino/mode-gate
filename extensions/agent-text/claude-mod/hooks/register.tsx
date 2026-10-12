import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent } from '../types'
import { agentTable } from './table'

const PANE = 'agent-text'
const agents = atom({ plugin: 'agent-text-session', key: 'agents' } as const, [])

let status: 'idle' | 'busy' = 'idle'
let isSending = false
let isQueued = false
let retry: { cancel: () => void } | undefined
let retries = 0

// The agent-text MCP adapter listens on this path; both sides derive it from
// Claude's config directory and the inbox socket's name. On Windows (a named
// pipe inbox) the path holds the adapter's loopback port and key instead.
async function call($: EngineInterface, path: string, init: { method?: string; body?: string } = {}) {
  const inbox = await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')
  if (!inbox) throw new Error('No messaging socket.')
  const name = inbox.slice(Math.max(inbox.lastIndexOf('/'), inbox.lastIndexOf('\\')) + 1)
  if (!inbox.startsWith('\\\\.\\pipe\\')) {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
    return $.http.fetch(`http://agent-text${path}`, { ...init, socketPath: `${config}/agent-text/${name}` })
  }
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('USERPROFILE')}\\.claude`
  const { port, key } = JSON.parse(await $.fs.read(`${config}\\agent-text\\${name}`)) as { port: number; key: string }
  return $.http.fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'x-agent-text-key': key } })
}

async function push($: EngineInterface): Promise<boolean> {
  try {
    const { ok } = await call($, '/state', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: await $.session.id(),
        cwd: (await $.session.cwd()).slice(0, 300),
        model: (await $.session.model()).slice(0, 120),
        status,
      }),
    })
    return ok
  } catch {
    return false
  }
}

// Hooks never wait on a report. One request is in flight at a time, until it
// settles: $.http.fetch cannot be cancelled, so giving up on one would leave it
// to land after newer state. One left unanswered holds later reports queued
// behind it until its adapter exits and the connection closes; adapters that
// read status from Claude's registry then show only a stale model. Reports
// asked for meanwhile fold into one sent after it, with the state as it is
// then. The adapter may start after the session does, so a failed report is
// retried 2 s after it settles, up to 30 times per event; the next event
// reports again either way.
async function report($: EngineInterface, isRetry = false): Promise<void> {
  if (!isRetry) retries = 0
  if (isSending) {
    isQueued = true
    return
  }
  retry?.cancel()
  retry = undefined
  isSending = true
  const isSent = await push($)
  isSending = false
  if (isQueued) {
    isQueued = false
    return report($)
  }
  if (isSent || retries >= 30) return
  retries++
  retry = $.clock.after(2000, () => {
    retry = undefined
    void report($, true)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-text', description: 'Show online Pi and Claude Code agents' })
    const started = await next(e)
    void report($)
    return started
  })

  on('command.run', { command: 'agent-text' }, async ($, e) => {
    let list: Agent[]
    try {
      const { ok, text } = await call($, '/agents')
      if (!ok) throw new Error()
      list = JSON.parse(text) as Agent[]
    } catch {
      return { text: 'The agent-text adapter is not reachable from this session.' }
    }
    await update($, agents, () => list)
    const opened = await $.ui.open({ id: PANE, title: `Online agents (${list.length})`, focus: true, closeOnEscape: true })
    if (opened.isPlaced) return {}
    const table = agentTable(list, list[0]?.id ?? '', await $.env.get('HOME'), e.presentation?.columns ?? 80)
    return { text: [`Online agents (${list.length})`, ...table].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const width = e.props.bodyColumns || e.viewport?.columns || 80
    const table = agentTable(list, list[0]?.id ?? '', await $.env.get('HOME'), width)
    return (
      <Box flexDirection="column">
        <Text bold>Online agents ({list.length})</Text>
        {table.map(row => (
          <Text wrap="truncate-end">{row}</Text>
        ))}
      </Box>
    )
  })

  // /clear and resume continue the process under another session ID.
  on('classic.SessionStart', async ($, e, next) => {
    const answered = await next(e)
    void report($)
    return answered
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const answered = await next(e)
    void report($)
    return answered
  })

  on('turn.start', async ($, e, next) => {
    status = 'busy'
    void report($)
    return next(e)
  })

  // A subagent's run raises no turn.start; its turn.complete is not the session's.
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    status = 'idle'
    void report($)
    return completed
  })
}
