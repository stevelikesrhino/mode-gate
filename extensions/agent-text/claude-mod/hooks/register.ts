import type { EngineInterface, Register } from 'claude-code'

let status: 'idle' | 'busy' = 'idle'
let retry: { cancel: () => void } | undefined
let retries = 0

type Agent = {
  id: string
  name?: string
  cwd: string
  provider?: string
  model?: string
  kind?: string
  status: string
}

// The agent-text MCP adapter listens on this path; both sides derive it from
// Claude's config directory and the inbox socket's name.
async function adapter($: EngineInterface): Promise<string | undefined> {
  const inbox = await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
  return inbox && `${config}/agent-text/${inbox.slice(inbox.lastIndexOf('/') + 1)}`
}

async function push($: EngineInterface): Promise<boolean> {
  const socketPath = await adapter($)
  if (!socketPath) return false
  try {
    const { ok } = await $.http.fetch('http://agent-text/state', {
      method: 'POST',
      socketPath,
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

// The adapter may start after the session does, so a failed report is retried
// for a minute; later events report again either way.
async function report($: EngineInterface): Promise<void> {
  const isSent = await push($)
  if (isSent || retries >= 30) {
    retry?.cancel()
    retry = undefined
    retries = 0
  } else {
    retry ??= $.clock.every(2000, () => {
      retries++
      void report($)
    })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-text', description: 'Show online Pi and Claude Code agents' })
    const started = await next(e)
    await report($)
    return started
  })

  on('command.run', { command: 'agent-text' }, async $ => {
    try {
      const socketPath = await adapter($)
      if (!socketPath) throw new Error()
      const { ok, text } = await $.http.fetch('http://agent-text/agents', { socketPath })
      if (!ok) throw new Error()
      const [self, ...others] = JSON.parse(text) as Agent[]
      const rows = [self, ...others].map(agent =>
        [
          `${agent.name || 'Unnamed session'}${agent === self ? ' (you)' : ''} — ${agent.kind ?? 'pi'} · ${agent.status}`,
          `  ${agent.id}`,
          `  ${agent.provider ?? 'No provider'}/${agent.model ?? 'model unknown'}`,
          `  ${agent.cwd}`,
        ].join('\n'),
      )
      return { text: [`Online agents (${rows.length})`, ...rows].join('\n\n') }
    } catch {
      return { text: 'The agent-text adapter is not reachable from this session.' }
    }
  })

  // /clear and resume continue the process under another session ID.
  on('classic.SessionStart', async ($, e, next) => {
    const answered = await next(e)
    await report($)
    return answered
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const answered = await next(e)
    await report($)
    return answered
  })

  on('turn.start', async ($, e, next) => {
    status = 'busy'
    await report($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    status = 'idle'
    await report($)
    return completed
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const before = status
    status = 'busy'
    await report($)
    try {
      return await next(e)
    } finally {
      status = before
      await report($)
    }
  })
}
