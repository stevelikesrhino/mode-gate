import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

type Request = { url: string; socketPath?: string; method?: string; body?: string }

const OK: HttpResponse = { status: 204, ok: true, headers: {}, text: '' }
const DOWN: HttpResponse = { status: 503, ok: false, headers: {}, text: '' }

// The world beneath the mod: one session, an adapter answered by `answer`.
function world(on: On, answer: (request: Request) => HttpResponse | Promise<HttpResponse>) {
  const requests: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/42.sock', HOME: '/home/u' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('http.fetch', async ($, e) => {
    const request = { url: e.url, socketPath: e.init?.socketPath, method: e.init?.method, body: e.init?.body }
    requests.push(request)
    return { value: await answer(request) }
  })
  const states = () => requests.filter(r => r.url.endsWith('/state')).map(r => JSON.parse(r.body ?? '{}'))
  return { requests, states, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal' } as never)
const turnStart = ($: Engine) => $.turn.start({ text: 'hi', turnId: 't1' })
const turnComplete = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId })

describe('state reports', () => {
  test('session start registers the command and reports idle over the inbox-named socket', async ($, on) => {
    const { requests, states, clock } = world(on, () => OK)
    await start($)
    await clock.settle()
    expect(requests[0]).toMatchObject({ url: 'http://agent-text/state', socketPath: '/home/u/.claude/agent-text/42.sock', method: 'POST' })
    expect(states()).toEqual([{ sessionId: 'session-1', cwd: '/work', model: 'claude-opus-5-5', status: 'idle' }])
  })

  test('a turn starts without waiting on a hung adapter', async ($, on) => {
    const { states, clock } = world(on, () => new Promise<HttpResponse>(() => {}))
    await turnStart($)
    await clock.settle()
    expect(states().map(s => s.status)).toEqual(['busy'])
  })

  test('an unanswered request stays the only one: no timeout, retry or event sends another', async ($, on) => {
    const { requests, clock } = world(on, () => new Promise<HttpResponse>(() => {}))
    await start($)
    await clock.settle()
    for (let i = 0; i < 5; i++) {
      await turnStart($)
      await turnComplete($)
    }
    await clock.advance(120_000)
    expect(requests).toHaveLength(1)
  })

  test('once the unanswered request fails, the folded report goes out with the latest state', async ($, on) => {
    let fail: (error: Error) => void = () => {}
    let isUp = false
    const { states, clock } = world(on, () => (isUp ? OK : new Promise<HttpResponse>((_, reject) => (fail = reject))))
    await turnStart($)
    await clock.settle()
    await turnComplete($)
    await clock.advance(60_000)
    expect(states().map(s => s.status)).toEqual(['busy'])
    isUp = true
    fail(new Error('connection closed'))
    await clock.settle()
    expect(states().map(s => s.status)).toEqual(['busy', 'idle'])
    await clock.advance(10_000)
    expect(states()).toHaveLength(2)
  })

  test('reports fold into one while a request is in flight, sent with the latest state', async ($, on) => {
    let release: (response: HttpResponse) => void = () => {}
    const { states, clock } = world(on, () => new Promise<HttpResponse>(resolve => (release = resolve)))
    await turnStart($)
    await clock.settle()
    await turnComplete($)
    await turnStart($)
    await turnComplete($)
    await clock.settle()
    expect(states().map(s => s.status)).toEqual(['busy'])
    release(OK)
    await clock.settle()
    expect(states().map(s => s.status)).toEqual(['busy', 'idle'])
    release(OK)
    await clock.settle()
    expect(states()).toHaveLength(2)
  })

  test("a subagent's turn end leaves the session busy", async ($, on) => {
    const { states, clock } = world(on, () => OK)
    await turnStart($)
    await clock.settle()
    await turnComplete($, 'agent-7')
    await clock.settle()
    expect(states().map(s => s.status)).toEqual(['busy'])
    await turnComplete($)
    await clock.settle()
    expect(states().map(s => s.status)).toEqual(['busy', 'idle'])
  })

  test('a failed report is retried 2 s after it fails, at most 30 times per event', async ($, on) => {
    const { states, clock } = world(on, () => DOWN)
    await start($)
    await clock.settle()
    await clock.advance(2000)
    expect(states()).toHaveLength(2)
    await clock.advance(120_000)
    expect(states()).toHaveLength(31)
    await turnStart($)
    await clock.advance(120_000)
    expect(states()).toHaveLength(62)
  })

  test('retries count attempts: a slow-failing one neither renews the budget nor adds requests', async ($, on) => {
    let fail: (response: HttpResponse) => void = () => {}
    const { requests, clock } = world(on, () => new Promise<HttpResponse>(resolve => (fail = resolve)))
    await start($)
    await clock.settle()
    for (let i = 0; i < 40; i++) {
      await clock.advance(120_000)
      fail(DOWN)
      await clock.settle()
      await clock.advance(2000)
    }
    expect(requests).toHaveLength(31)
    await clock.advance(600_000)
    expect(requests).toHaveLength(31)
  })

  test('an event during a pending retry cancels it and sends once', async ($, on) => {
    const { states, clock } = world(on, () => DOWN)
    await start($)
    await clock.settle()
    await clock.advance(1000)
    await turnStart($)
    await clock.settle()
    expect(states().map(s => s.status)).toEqual(['idle', 'busy'])
    await clock.advance(1000)
    expect(states()).toHaveLength(2)
    await clock.advance(1000)
    expect(states().map(s => s.status)).toEqual(['idle', 'busy', 'busy'])
  })

  test('retrying stops once a report gets through', async ($, on) => {
    let isUp = false
    const { states, clock } = world(on, () => (isUp ? OK : DOWN))
    await start($)
    await clock.settle()
    isUp = true
    await clock.advance(2000)
    await clock.advance(10_000)
    expect(states()).toHaveLength(2)
  })
})

describe('/agent-text', () => {
  const AGENTS = [
    { id: 'a1', name: 'me', cwd: '/work', provider: 'anthropic', model: 'opus', kind: 'claude', status: 'busy' },
    { id: 'b2', name: 'peer', cwd: '/x\x1b[2J\n\u2028\u202ey', status: 'idle' },
  ]
  // Self first with (you) in its kind; peer text loses control, line-separator and bidi characters.
  const TABLE = [
    '╭──────────────┬────────┬────┬───────────────┬────────────╮',
    '│ Kind         │ Status │ ID │ Model         │ Directory  │',
    '├──────────────┼────────┼────┼───────────────┼────────────┤',
    '│ claude (you) │ busy   │ a1 │ opus          │ /work      │',
    '├──────────────┼────────┼────┼───────────────┼────────────┤',
    '│ pi           │ idle   │ b2 │ model unknown │ /x [2J   y │',
    '╰──────────────┴────────┴────┴───────────────┴────────────╯',
  ]

  function agentsWorld(on: On, answer: () => HttpResponse) {
    return world(on, request => (request.url.endsWith('/agents') ? answer() : OK))
  }

  test('opens the pane and shows no transcript text when it is placed', async ($, on) => {
    agentsWorld(on, () => ({ ...OK, status: 200, text: JSON.stringify(AGENTS) }))
    const opened: unknown[] = []
    on('ui.open', ($, e) => (opened.push(e), { value: { isPlaced: true as const } }))
    const result = await $.command.run({ command: 'agent-text', args: '' } as never)
    expect(result.text).toBeUndefined()
    expect(opened).toEqual([expect.objectContaining({ id: 'agent-text', title: 'Online agents (2)', focus: true, closeOnEscape: true })])
  })

  test('the pane draws the bordered table, self first, sanitized', async ($, on) => {
    agentsWorld(on, () => ({ ...OK, status: 200, text: JSON.stringify(AGENTS) }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run({ command: 'agent-text', args: '' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-text-session', surface, component: 'Pane', requestId: 'agent-text', props: {} as never })
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
      expect(texts).toEqual(['Online agents (2)', ...TABLE])
    }
  })

  test('falls back to transcript text when the pane is not placed', async ($, on) => {
    agentsWorld(on, () => ({ ...OK, status: 200, text: JSON.stringify(AGENTS) }))
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }) as never)
    const result = await $.command.run({ command: 'agent-text', args: '' } as never)
    expect(result.text).toBe(['Online agents (2)', ...TABLE].join('\n'))
  })

  test('an empty list shows zero agents and only the header', async ($, on) => {
    agentsWorld(on, () => ({ ...OK, status: 200, text: '[]' }))
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }) as never)
    const result = await $.command.run({ command: 'agent-text', args: '' } as never)
    expect(result.text).toBe(
      ['Online agents (0)', '╭──────┬────────┬────┬───────┬───────────╮', '│ Kind │ Status │ ID │ Model │ Directory │', '╰──────┴────────┴────┴───────┴───────────╯'].join('\n'),
    )
  })

  test('a narrow pane shrinks Model and Directory, keeping the end of the path', async ($, on) => {
    agentsWorld(on, () => ({ ...OK, status: 200, text: JSON.stringify([{ ...AGENTS[0], model: 'claude-opus-with-a-long-model-name', cwd: '/a/very/long/project/path/agent-text' }]) }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run({ command: 'agent-text', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'agent-text-session', surface: 'terminal', component: 'Pane', requestId: 'agent-text', props: { bodyColumns: 60 } as never })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts.slice(1).every(text => [...text].length === 60)).toBe(true)
    expect(texts[4]).toStartWith('│ claude (you) │ busy   │ a1 │ ')
    expect(texts[4]).toMatch(/ claude-opus[^│]*… │ …[^│]*agent-text │$/)
  })

  test('an unreachable adapter says so', async ($, on) => {
    agentsWorld(on, () => DOWN)
    const result = await $.command.run({ command: 'agent-text', args: '' } as never)
    expect(result.text).toBe('The agent-text adapter is not reachable from this session.')
  })
})
