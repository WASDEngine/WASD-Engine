/**
 * An app MCP server's tools reach agents connected through WASD Engine's MCP server: the MCP client's registered
 * tools, renamed under the plugin's prefix, with the server's text and images, the server's readiness, and the
 * `session` and `project` parameters that run a call in a named Session's worker.
 */
import { Context } from '@deepseek-ai/cordis'
import type { GameMcpCall, GameMcpProvider, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appToolContent, appToolStatus, offerAppTools, sessionNote } from '../src/game-mcp.ts'

function mcpTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    output: { schema: {}, render: () => [{ type: 'text', text: name }] },
    execute: async () => ({ content: [{ type: 'text', text: name }] }),
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('offerAppTools', () => {
  it('offers the server\'s registered tools under the plugin prefix while both services exist', async () => {
    const root = ctx = new Context()
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime)
    const servers: McpManagedServerView[] = [{ name: 'wasd_fake', configured: true, status: { state: 'connected', toolCount: 2, connectedAt: 1 } }]
    root.provide('mcpManager', { list: () => servers } as never)
    const provided: GameMcpProvider[] = []
    root.provide('gameMcp', {
      provide: (provider: GameMcpProvider) => {
        provided.push(provider)
        return () => { provided.splice(provided.indexOf(provider), 1) }
      },
    } as never)
    root.effect(() => root.tools.register(mcpTool('mcp__wasd_fake__scene_info')))
    root.effect(() => root.tools.register(mcpTool('mcp__other__scene_info')))
    const plugin = root.plugin({
      name: 'fake-app',
      inject: ['mcpManager'],
      apply(child: Context) {
        offerAppTools(child, 'wasd_fake', { id: 'fake', title: 'Fake', description: 'Fake tools.', instructions: 'Use scene_info.' })
      },
    })
    await plugin
    await expect.poll(() => provided.length).toBe(1)
    const provider = provided[0] as GameMcpProvider
    expect(provider).toMatchObject({ id: 'fake', title: 'Fake', description: 'Fake tools.', instructions: `Use scene_info.\n\n${sessionNote({ id: 'fake', title: 'Fake' })}` })
    expect(sessionNote({ id: 'fake', title: 'Fake' })).toBe('Agents connected through WASD Engine\'s MCP server, such as you, share one Fake session among '
      + 'themselves, apart from the sessions of WASD Engine\'s own conversations, so another connected agent can change its state between your calls. '
      + 'Agents that work at the same time, such as the subagents of one session, each get a Fake session of their own by passing session, a name such '
      + 'as their task, to every fake_* call, and project, the absolute path of the game project folder, to the first.')
    expect(provider.tools().map(tool => tool.name)).toEqual(['fake_scene_info'])
    root.effect(() => root.tools.register(mcpTool('mcp__wasd_fake__render')))
    expect(provider.tools().map(tool => tool.name)).toEqual(['fake_scene_info', 'fake_render'])
    expect(await provider.status(new AbortController().signal)).toEqual({ state: 'ready', message: 'The first call starts Fake.' })
    servers.splice(0)
    expect(await provider.status(new AbortController().signal)).toMatchObject({ state: 'starting' })
    await plugin.dispose()
    expect(provided).toEqual([])
  })
})

describe('session and project', () => {
  /** Offer one tool of a fake server and return it as connected agents find it. */
  async function offeredTool(): Promise<GameMcpTool> {
    const root = ctx = new Context()
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime)
    root.provide('mcpManager', { list: () => [] } as never)
    const provided: GameMcpProvider[] = []
    root.provide('gameMcp', { provide: (provider: GameMcpProvider) => { provided.push(provider); return () => {} } } as never)
    root.effect(() => root.tools.register(mcpTool('mcp__wasd_fake__execute_python')))
    await root.plugin({
      name: 'fake-app',
      inject: ['mcpManager'],
      apply(child: Context) {
        offerAppTools(child, 'wasd_fake', { id: 'fake', title: 'Fake', description: 'Fake tools.', instructions: 'Use execute_python.' })
      },
    })
    await expect.poll(() => provided.length).toBe(1)
    return (provided[0] as GameMcpProvider).tools()[0] as GameMcpTool
  }

  /** A connected agent's call whose Sessions are fake Agents named by directory and Session name. */
  function agentCall(client = 'claude-code') {
    // The offer reads nothing of the Agent; its id names the directory and the Session name it was resolved for.
    const session = vi.fn((directory: string, name?: string) => Promise.resolve({ id: `${directory}#${name ?? ''}` } as never))
    const call: GameMcpCall = { client: { id: client, title: client }, signal: new AbortController().signal, session, reveal: vi.fn() }
    return { call, session }
  }

  it('adds session and project to the server\'s parameters', async () => {
    const tool = await offeredTool()
    expect(tool.name).toBe('fake_execute_python')
    expect(tool.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string' },
        session: {
          type: 'string',
          description: 'Name of a Fake session of your own, for agents that work at the same time. Default: the Fake session that connected agents share.',
        },
        project: { type: 'string', description: 'With session: absolute path of its game project folder. Default: your previous one.' },
      },
    })
  })

  it('runs a call without session in the shared worker, without a Session', async () => {
    const tool = await offeredTool()
    const { call, session } = agentCall()
    expect(await tool.prepare!({ code: 'x = 1' }, call)).toEqual({ args: { code: 'x = 1' } })
    expect(session).not.toHaveBeenCalled()
  })

  it('runs a call with session in the agent\'s Session of that name, and remembers its project', async () => {
    const tool = await offeredTool()
    const { call, session } = agentCall()
    const first = await tool.prepare!({ code: 'a', session: ' Rigger ', project: '/games/zombies' }, call)
    expect(first).toEqual({ args: { code: 'a' }, agent: { id: '/games/zombies# Rigger ' } })
    // Names that differ only in case and spaces share the project, as they share the Session.
    expect(await tool.prepare!({ code: 'b', session: 'rigger' }, call)).toEqual({ args: { code: 'b' }, agent: { id: '/games/zombies#rigger' } })
    // A new name takes the agent's most recent project; another agent has none.
    await tool.prepare!({ code: 'c', session: 'animator', project: '/games/other' }, call)
    expect(await tool.prepare!({ code: 'd', session: 'checker' }, call)).toMatchObject({ agent: { id: '/games/other#checker' } })
    expect(await tool.prepare!({ code: 'e', session: 'rigger' }, call)).toMatchObject({ agent: { id: '/games/zombies#rigger' } })
    expect(session.mock.calls.map(([directory, name]) => [directory, name])).toEqual([
      ['/games/zombies', ' Rigger '], ['/games/zombies', 'rigger'], ['/games/other', 'animator'], ['/games/other', 'checker'], ['/games/zombies', 'rigger'],
    ])
    await expect(tool.prepare!({ code: 'f', session: 'rigger' }, agentCall('codex').call))
      .rejects.toThrow('Pass project, the absolute path of the game project folder, with your first call that names a session.')
  })

  it('refuses a project without session, a relative project, and values that are not strings', async () => {
    const tool = await offeredTool()
    const { call, session } = agentCall()
    await expect(tool.prepare!({ code: 'a', project: '/games/zombies' }, call)).rejects.toThrow('project needs session: pass session, a name for a '
      + 'Fake session of your own, or leave project out to use the Fake session that connected agents share.')
    await expect(tool.prepare!({ code: 'a', session: 'rigger', project: 'games/zombies' }, call))
      .rejects.toThrow('project must be an absolute path, got "games/zombies".')
    await expect(tool.prepare!({ code: 'a', session: 7 }, call)).rejects.toThrow('session must be a string.')
    await expect(tool.prepare!({ code: 'a', session: 'rigger', project: ['/games'] }, call)).rejects.toThrow('project must be a string.')
    expect(session).not.toHaveBeenCalled()
  })

  it('does not remember the project of a call whose Session could not be resolved', async () => {
    const tool = await offeredTool()
    const { call } = agentCall()
    const failing: GameMcpCall = { ...call, session: () => Promise.reject(new Error('/games/gone does not exist.')) }
    await expect(tool.prepare!({ code: 'a', session: 'rigger', project: '/games/gone' }, failing)).rejects.toThrow('/games/gone does not exist.')
    await expect(tool.prepare!({ code: 'b', session: 'rigger' }, call))
      .rejects.toThrow('Pass project, the absolute path of the game project folder, with your first call that names a session.')
  })
})

describe('appToolContent', () => {
  it('passes the server\'s text and images on and names other blocks', () => {
    expect(appToolContent({
      content: [
        { type: 'text', text: 'Rendered.' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource_link', name: 'x', uri: 'file:///x' },
        'not a block',
        { type: 7 },
      ],
    })).toEqual([
      { type: 'text', text: 'Rendered.' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: '[resource_link content omitted]' },
      { type: 'text', text: '[unknown content omitted]' },
    ])
    expect(appToolContent(null)).toEqual([])
  })
})

describe('appToolStatus', () => {
  it('maps the server status to readiness', () => {
    expect(appToolStatus('Blender', { state: 'connected', toolCount: 3, connectedAt: 1 }).state).toBe('ready')
    expect(appToolStatus('Blender', { state: 'reconnecting', attempt: 1, maxAttempts: 5, nextRetryAtMs: 2, lastError: 'exit 1' }).state).toBe('starting')
    expect(appToolStatus('Blender', { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' }))
      .toEqual({ state: 'unavailable', message: 'Blender\'s MCP server is not running: spawn ENOENT.' })
    expect(appToolStatus('GIMP', { state: 'failed', reason: 'reconnect-disabled' })).toEqual({ state: 'unavailable', message: 'GIMP\'s MCP server is not running.' })
    expect(appToolStatus('GIMP', { state: 'disabled' })).toEqual({ state: 'unavailable', message: 'GIMP\'s MCP server is off.' })
  })
})
