/**
 * An app MCP server's tools reach agents connected through WASD Engine's MCP server: the MCP client's registered
 * tools, renamed under the plugin's prefix, with the server's text and images, and the server's readiness.
 */
import { Context } from '@deepseek-ai/cordis'
import type { GameMcpProvider } from '@deepseek-ai/dsh-game-mcp'
import type { McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { appToolContent, appToolStatus, offerAppTools } from '../src/game-mcp.ts'

function mcpTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    parameters: { type: 'object', properties: {} },
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
    expect(provider).toMatchObject({ id: 'fake', title: 'Fake', description: 'Fake tools.', instructions: 'Use scene_info.' })
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
