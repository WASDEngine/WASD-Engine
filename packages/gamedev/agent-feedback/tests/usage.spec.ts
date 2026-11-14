/**
 * The tool usage report: which calls count under which plugin or MCP server and agent, how counts merge, wait, and are
 * dropped, and, in a real Host composition, the reports the plugin sends to a fake WASD Engine site on its interval and
 * as it stops, for Sessions' calls and connected agents' calls.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageOutcome } from '../src/api.ts'
import { WASD_ENGINE_AGENT } from '../src/tools.ts'
import type { ToolUsageCount, ToolUsageKey } from '../src/types.ts'
import { MAX_COUNT, MAX_REPORT_ENTRIES, sessionCallee, ToolUsageReport } from '../src/usage.ts'
import { callTool, compose, connect, TIMEOUT, TOKEN, type Composition } from './composition.ts'
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

/** A report whose sends answer with the outcomes a spec queues, recording what each sent. */
function recordingReport(outcomes: UsageOutcome[] = []) {
  const sent: Array<readonly ToolUsageCount[]> = []
  const overflow = vi.fn()
  const report = new ToolUsageReport({
    send: (counts) => {
      sent.push(counts)
      return Promise.resolve(outcomes.shift() ?? 'sent')
    },
    overflow,
  })
  return { report, sent, overflow }
}

describe('sessionCallee', () => {
  it('counts a tool WASD Engine\'s MCP server offers under its plugin, an added server\'s tool under that server, and nothing else', () => {
    const owner = (name: string) => name === 'mcp__wasd_blender__execute_python' ? BLENDER_OWNER : undefined
    expect(sessionCallee('mcp__wasd_blender__execute_python', owner)).toEqual({ custom: false, server: 'blender', serverTitle: 'Blender', tool: 'blender_execute_python' })
    expect(sessionCallee('mcp__github__create_issue', owner)).toEqual({ custom: true, server: 'github', serverTitle: 'github', tool: 'create_issue' })
    expect(sessionCallee('mcp__my-server__list_files_0123456789ab', undefined)).toEqual({ custom: true, server: 'my-server', serverTitle: 'my-server', tool: 'list_files_0123456789ab' })
    for (const name of ['read', 'web_search', 'mcp__', 'mcp__server', 'mcp__server__']) expect(sessionCallee(name, owner), name).toBeUndefined()
  })
})

describe('ToolUsageReport', () => {
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
      send: (counts) => {
        sent.push(counts)
        return sent.length === 1 ? new Promise<UsageOutcome>((resolve) => { release = resolve }) : Promise.resolve('sent')
      },
      overflow: () => {},
    })
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
      send: (_counts, signal) => {
        sends.push(signal.aborted ? 'aborted' : 'sent')
        return signal.aborted ? Promise.reject(new Error('the report was cancelled')) : Promise.resolve('sent')
      },
      overflow: () => {},
    })
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
      ['wasd-engine', false, true, 'github', 'create_issue', 1, 1],
      ['wasd-engine', false, false, 'feedback', 'feedback_send', 1, 0],
      ['codex-mcp-client', true, false, 'blender', 'blender_execute_python', 1, 0],
      ['codex-mcp-client', true, false, 'feedback', 'feedback_send', 1, 1],
    ])
    const calls = current.site.to(USAGE_PATH)[0]?.body.calls as Array<Record<string, unknown>>
    const titles = calls.map(call => [call.agent_title, call.server_title])
    expect(titles).toEqual([['WASD Engine', 'Blender'], ['WASD Engine', 'github'], ['WASD Engine', 'Feedback'], ['Codex', 'Blender'], ['Codex', 'Feedback']])
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
      expect.objectContaining({ server: 'github', tool: 'create_issue', calls: 2, errors: 0 }),
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

  it('counts and sends nothing with usageReports off', async () => {
    const current = composition = await compose({ config: { usageReports: false } })
    current.ctx.tools.register(sessionTool('mcp__github__create_issue'))
    await callTool(current, 'mcp__github__create_issue')
    await current.unload()
    expect(current.site.requests).toEqual([])
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
