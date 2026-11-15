/**
 * The tool usage report: which calls count under which plugin or MCP server and agent, how counts merge, wait, and are
 * dropped, that they go only to the sign-in they were counted under, and, in a real Host composition, the reports the
 * plugin sends to a fake WASD Engine site on its interval and as it stops, for Sessions' calls and connected agents'
 * calls, never naming an MCP server the user added.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageOutcome } from '../src/api.ts'
import { WASD_ENGINE_AGENT } from '../src/tools.ts'
import type { ToolUsageCount, ToolUsageKey } from '../src/types.ts'
import { ADDED_SERVERS, MAX_COUNT, MAX_REPORT_ENTRIES, sessionCallee, ToolUsageReport } from '../src/usage.ts'
import { callTool, compose, connect, TIMEOUT, TOKEN, type Composition } from './composition.ts'
import * as AgentFeedback from '../src/index.ts'
import { USAGE_PATH } from './fixtures.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

const BLENDER_OWNER = { provider: 'blender', title: 'Blender', tool: 'blender_execute_python' }

function key(fields: Partial<ToolUsageKey> = {}): ToolUsageKey {
  return { agent: WASD_ENGINE_AGENT, custom: false, server: 'godot', serverTitle: 'Godot', tool: 'godot_run', ...fields }
}

/** A report signed in to `account.signIn` whose sends answer with the outcomes a spec queues, recording what each sent. */
function recordingReport(outcomes: UsageOutcome[] = []) {
  const sent: Array<readonly ToolUsageCount[]> = []
  const to: string[] = []
  const overflow = vi.fn()
  const account: { signIn: string | undefined } = { signIn: 'sign-in-a' }
  const report = new ToolUsageReport({
    signIn: () => Promise.resolve(account.signIn),
    send: (signIn, counts) => {
      to.push(signIn)
      sent.push(counts)
      return Promise.resolve(outcomes.shift() ?? 'sent')
    },
    overflow,
  })
  void report.begin()
  return { report, sent, to, overflow, account }
}

describe('sessionCallee', () => {
  it('counts a tool WASD Engine\'s MCP server offers under its plugin, every added server\'s tools under one unnamed key, and nothing else', () => {
    const owner = (name: string) => name === 'mcp__wasd_blender__execute_python' ? BLENDER_OWNER : undefined
    expect(sessionCallee('mcp__wasd_blender__execute_python', owner)).toEqual({ custom: false, server: 'blender', serverTitle: 'Blender', tool: 'blender_execute_python' })
    expect(ADDED_SERVERS).toEqual({ custom: true, server: 'added-mcp-servers', serverTitle: 'MCP servers the user added', tool: 'all-tools' })
    expect(sessionCallee('mcp__github__create_issue', owner)).toEqual(ADDED_SERVERS)
    expect(sessionCallee('mcp__acme-internal-crm__export_customers', undefined)).toEqual(ADDED_SERVERS)
    for (const name of ['read', 'web_search', 'mcp__', 'mcp__server', 'mcp__server__']) expect(sessionCallee(name, owner), name).toBeUndefined()
  })
})

describe('ToolUsageReport', () => {
  it('sends counts only to the sign-in they were counted under, never to the next one', async () => {
    const { report, sent, to, account } = recordingReport(['kept'])
    report.count(key(), false)
    // Signed out at the report: the counts wait.
    account.signIn = undefined
    await report.flush(new AbortController().signal)
    expect(sent).toEqual([])
    // Another account signs in: the counts of the first never reach it.
    account.signIn = 'sign-in-b'
    await report.flush(new AbortController().signal)
    expect(sent).toEqual([])
    report.count(key({ tool: 'godot_stop' }), false)
    await report.flush(new AbortController().signal)
    expect(to).toEqual(['sign-in-b'])
    expect(sent).toEqual([[{ key: key({ tool: 'godot_stop' }), calls: 1, errors: 0 }]])
  })

  it('drops counts gathered while signed out, and those of another sign-in when the account service starts again', async () => {
    const { report, sent, account } = recordingReport()
    account.signIn = undefined
    await report.begin()
    report.count(key(), false)
    account.signIn = 'sign-in-a'
    await report.flush(new AbortController().signal)
    expect(sent).toEqual([])
    report.count(key(), false)
    account.signIn = 'sign-in-c'
    await report.begin()
    await report.flush(new AbortController().signal)
    expect(sent).toEqual([])
  })

  it('counts calls and failures by key and sends them once', async () => {
    const { report, sent } = recordingReport()
    report.count(key(), false)
    report.count(key(), true)
    report.count(key({ agent: { connected: true, id: 'codex', title: 'Codex' } }), false)
    expect(report.size).toBe(2)
    await report.flush(new AbortController().signal)
    expect(sent).toEqual([[
      { key: key(), calls: 2, errors: 1 },
      { key: key({ agent: { connected: true, id: 'codex', title: 'Codex' } }), calls: 1, errors: 0 },
    ]])
    expect(report.size).toBe(0)
    await report.flush(new AbortController().signal)
    expect(sent).toHaveLength(1)
  })

  it('keeps counts the site may take later, adding the calls counted meanwhile, and forgets those it refused', async () => {
    const { report, sent } = recordingReport(['kept', 'dropped', 'sent'])
    report.count(key({ serverTitle: 'Old title' }), false)
    await report.flush(new AbortController().signal)
    report.count(key({ serverTitle: 'Godot' }), true)
    expect(report.size).toBe(1)
    await report.flush(new AbortController().signal)
    expect(sent[1]).toEqual([{ key: key({ serverTitle: 'Godot' }), calls: 2, errors: 1 }])
    expect(report.size).toBe(0)
    report.count(key(), false)
    await report.flush(new AbortController().signal)
    expect(sent[2]).toEqual([{ key: key(), calls: 1, errors: 0 }])
  })

  it('keeps the newest display names when kept counts come back', async () => {
    let release: (outcome: UsageOutcome) => void = () => {}
    const sent: Array<readonly ToolUsageCount[]> = []
    const report = new ToolUsageReport({
      signIn: () => Promise.resolve('sign-in-a'),
      send: (_signIn, counts) => {
        sent.push(counts)
        return sent.length === 1 ? new Promise<UsageOutcome>((resolve) => { release = resolve }) : Promise.resolve('sent')
      },
      overflow: () => {},
    })
    void report.begin()
    report.count(key({ serverTitle: 'Old title' }), false)
    const first = report.flush(new AbortController().signal)
    report.count(key({ serverTitle: 'New title' }), false)
    // The second report waits for the first.
    const second = report.flush(new AbortController().signal)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    release('kept')
    await Promise.all([first, second])
    expect(sent[1]).toEqual([{ key: key({ serverTitle: 'New title' }), calls: 2, errors: 0 }])
  })

  it('counts at most as many tools as one report holds, and saturates each count', async () => {
    const { report, sent, overflow } = recordingReport()
    for (let index = 0; index < MAX_REPORT_ENTRIES + 3; index += 1) report.count(key({ tool: `tool_${index}` }), false)
    expect(report.size).toBe(MAX_REPORT_ENTRIES)
    expect(overflow).toHaveBeenCalledTimes(1)
    await report.flush(new AbortController().signal)
    expect(sent[0]).toHaveLength(MAX_REPORT_ENTRIES)
    report.count(key({ tool: 'tool_new' }), false)
    expect(report.size).toBe(1)

    const big = recordingReport(['kept'])
    for (let index = 0; index < 3; index += 1) big.report.count(key(), true)
    await big.report.flush(new AbortController().signal)
    const counts = big.sent[0] as readonly ToolUsageCount[]
    expect(counts[0]?.calls).toBe(3)
    expect(MAX_COUNT).toBe(1_000_000)
  })

  it('keeps the counts when its send fails or is cancelled', async () => {
    const sends: string[] = []
    const report = new ToolUsageReport({
      signIn: () => Promise.resolve('sign-in-a'),
      send: (_signIn, _counts, signal) => {
        sends.push(signal.aborted ? 'aborted' : 'sent')
        return signal.aborted ? Promise.reject(new Error('the report was cancelled')) : Promise.resolve('sent')
      },
      overflow: () => {},
    })
    await report.begin()
    report.count(key(), false)
    await report.flush(AbortSignal.abort())
    expect(report.size).toBe(1)
    await report.flush(new AbortController().signal)
    expect(sends).toEqual(['aborted', 'sent'])
    expect(report.size).toBe(0)
  })
})

/** A tool a test registers for the Session. */
function sessionTool(name: string, fails = false): ToolDefinition {
  return defineTool({
    name,
    description: `The ${name} tool.`,
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'done' }] },
    execute: async () => {
      if (fails) throw new Error('the tool failed on purpose')
      return {}
    },
  })
}

/** The calls of the reports the site received, each call as `[agent, connected, custom, server, tool, calls, errors]`. */
function reported(current: Composition): unknown[][] {
  return current.site.to(USAGE_PATH).flatMap((request) => {
    expect(request.token).toBe(TOKEN)
    const calls = request.body.calls as Array<Record<string, unknown>>
    return calls.map(call => [call.agent, call.connected, call.custom, call.server, call.tool, call.calls, call.errors])
  })
}

describe('the plugin\'s usage reports', () => {
  it('reports a Session\'s calls of game tools and added servers\' tools, and connected agents\' calls, as it stops', async () => {
    const current = composition = await compose({ gameMcp: true })
    const blender = sessionTool('mcp__wasd_blender__execute_python')
    current.ctx.tools.register(blender)
    current.ctx.tools.register(sessionTool('mcp__github__create_issue', true))
    current.ctx.tools.register(sessionTool('read_notes'))
    current.server?.provide({
      id: 'blender', title: 'Blender', description: 'Blender tools.',
      tools: () => [{ name: 'blender_execute_python', definition: blender }],
      status: () => Promise.resolve({ state: 'ready' }),
    })
    await callTool(current, 'mcp__wasd_blender__execute_python')
    await callTool(current, 'mcp__wasd_blender__execute_python')
    await callTool(current, 'mcp__github__create_issue')
    await callTool(current, 'read_notes')
    await callTool(current, 'feedback_send', { kind: 'bug', message: 'Broken.' })
    const client = await connect(current, 'codex-mcp-client')
    await client.callTool({ name: 'blender_execute_python', arguments: {} })
    await client.callTool({ name: 'feedback_send', arguments: { kind: 'bug', message: '' } })
    expect(current.site.to(USAGE_PATH)).toEqual([])

    await current.unload()
    expect(reported(current)).toEqual([
      ['wasd-engine', false, false, 'blender', 'blender_execute_python', 2, 0],
      ['wasd-engine', false, true, 'added-mcp-servers', 'all-tools', 1, 1],
      ['wasd-engine', false, false, 'feedback', 'feedback_send', 1, 0],
      ['codex-mcp-client', true, false, 'blender', 'blender_execute_python', 1, 0],
      ['codex-mcp-client', true, false, 'feedback', 'feedback_send', 1, 1],
    ])
    const calls = current.site.to(USAGE_PATH)[0]?.body.calls as Array<Record<string, unknown>>
    const titles = calls.map(call => [call.agent_title, call.server_title])
    expect(titles).toEqual([['WASD Engine', 'Blender'], ['WASD Engine', 'MCP servers the user added'], ['WASD Engine', 'Feedback'], ['Codex', 'Blender'], ['Codex', 'Feedback']])
    // No report names an MCP server the user added or its tools.
    expect(JSON.stringify(current.site.to(USAGE_PATH))).not.toMatch(/github|create_issue/u)
  }, TIMEOUT)

  it('sends a report every interval while calls are counted, and keeps counts through a signed-out or failing site', async () => {
    const current = composition = await compose({ config: { reportIntervalMs: 1000 } })
    current.ctx.tools.register(sessionTool('mcp__github__create_issue'))
    current.account.signedIn = false
    await callTool(current, 'mcp__github__create_issue')
    // Signed out: the report waits, and an interval passes without a request.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(current.site.requests).toEqual([])
    current.account.signedIn = true
    current.site.failures.set(USAGE_PATH, { status: 503 })
    await vi.waitFor(() => { expect(current.site.to(USAGE_PATH)).toHaveLength(1) }, { timeout: 5000 })
    current.site.failures.delete(USAGE_PATH)
    await callTool(current, 'mcp__github__create_issue')
    await vi.waitFor(() => { expect(current.site.to(USAGE_PATH)).toHaveLength(2) }, { timeout: 5000 })
    expect(current.site.to(USAGE_PATH)[1]?.body.calls).toEqual([
      expect.objectContaining({ server: 'added-mcp-servers', tool: 'all-tools', calls: 2, errors: 0 }),
    ])
    // The site took them: no further report until another call.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(current.site.to(USAGE_PATH)).toHaveLength(2)
  }, TIMEOUT)

  it('forgets counts the site refuses', async () => {
    const current = composition = await compose({ config: { reportIntervalMs: 1000 } })
    current.ctx.tools.register(sessionTool('mcp__github__create_issue'))
    current.site.failures.set(USAGE_PATH, { status: 400, message: 'calls[0].tool is not a valid name.' })
    await callTool(current, 'mcp__github__create_issue')
    await vi.waitFor(() => { expect(current.site.to(USAGE_PATH)).toHaveLength(1) }, { timeout: 5000 })
    current.site.failures.delete(USAGE_PATH)
    await current.unload()
    expect(current.site.to(USAGE_PATH)).toHaveLength(1)
  }, TIMEOUT)

  it('counts and sends nothing with usageReports off, and keeps feedback_send', async () => {
    const current = composition = await compose({ config: { usageReports: false } })
    current.ctx.tools.register(sessionTool('mcp__github__create_issue'))
    await callTool(current, 'mcp__github__create_issue')
    expect(current.ctx.tools.definitions().map(definition => definition.name)).toContain('feedback_send')
    const sent = await callTool(current, 'feedback_send', { kind: 'bug', message: 'Broken.' })
    expect(sent.isError).toBe(false)
    await current.unload()
    expect(current.site.requests.map(request => request.path)).toEqual(['/api/v1/feedback'])
  })

  it('stops counting and drops what it counted when Settings turns usage reports off, and keeps feedback_send', async () => {
    const live = { on: true }
    const current = composition = await compose({
      gameMcp: true,
      liveConfig: { ...AgentFeedback.Config({ reportIntervalMs: 1000 }), usageReports: { get: () => live.on } },
    })
    const result = (tool: string) => ({
      provider: 'godot', tool, args: {}, client: { id: 'claude-code', title: 'Claude Code' }, isError: false,
    })
    current.ctx.emit('game-mcp/tool-result', result('godot_run'))
    live.on = false
    current.ctx.emit('game-mcp/tool-result', result('godot_stop'))
    // A report time passes while the switch is off: nothing is sent, and the earlier count is gone.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(current.site.to(USAGE_PATH)).toEqual([])
    expect((await callTool(current, 'feedback_send', { kind: 'bug', message: 'Broken.' })).isError).toBe(false)
    live.on = true
    current.ctx.emit('game-mcp/tool-result', result('godot_eval'))
    await current.unload()
    expect(reported(current)).toEqual([['claude-code', true, false, 'godot', 'godot_eval', 1, 0]])
  }, TIMEOUT)

  it('never sends calls counted under one sign-in to an account that signs in later', async () => {
    const current = composition = await compose()
    current.ctx.tools.register(sessionTool('mcp__wasd_godot__run'))
    current.server?.provide({
      id: 'godot', title: 'Godot', description: 'Godot tools.',
      tools: () => [{ name: 'godot_run', definition: sessionTool('mcp__wasd_godot__run') }],
      status: () => Promise.resolve({ state: 'ready' }),
    })
    current.ctx.emit('game-mcp/tool-result', {
      provider: 'godot', tool: 'godot_run', args: {}, client: { id: 'claude-code', title: 'Claude Code' }, isError: false,
    })
    // The user signs out, and another account signs in before the next report.
    current.account.token = 'another-account-token'
    current.ctx.emit('game-mcp/tool-result', {
      provider: 'godot', tool: 'godot_stop', args: {}, client: { id: 'claude-code', title: 'Claude Code' }, isError: false,
    })
    await current.unload()
    expect(current.site.to(USAGE_PATH)).toEqual([])
  })
})

describe('the last report as the whole Host stops', () => {
  it('still finds the account sign-in, which stops only after the reports do', async () => {
    const current = composition = await compose()
    current.ctx.emit('game-mcp/tool-result', {
      provider: 'godot', tool: 'godot_run', args: {}, client: { id: 'claude-code', title: 'Claude Code' }, isError: false,
    })
    await current.ctx.fiber.dispose()
    expect(current.account.closed).toBe(true)
    expect(reported(current)).toEqual([['claude-code', true, false, 'godot', 'godot_run', 1, 0]])
  })
})
