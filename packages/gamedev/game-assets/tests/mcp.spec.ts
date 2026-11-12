/**
 * Agents connected through WASD Engine's MCP server use the asset tools: the whole chain from the official MCP client
 * over HTTP, through the game MCP server and the asset provider, to the connected agent's Session of the project it
 * names, with the window's drawn images sent as PNG bytes after the details.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import GameMcpServer, { type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_INSTRUCTIONS } from '../src/mcp.ts'
import { compose, fakeAgent, HERO, KNIGHT, PIXEL_PNG, type Composition } from './composition.ts'

const TIMEOUT = 60_000

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

/**
 * The composition with a game project registry, a Session controller that creates fake Agents, the game MCP server,
 * and an official MCP client connected to it.
 */
async function connected(registered: readonly string[] = []) {
  const current = composition = await compose()
  const { ctx, work } = current
  const workspaces: Array<{ id: string; path: string; sessionIds: SessionId[] }> = registered.map((path, index) => ({ id: `r${String(index + 1)}`, path, sessionIds: [] }))
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    create: async (path: string) => {
      const workspace = { id: `w${workspaces.length + 1}`, path, sessionIds: [] }
      workspaces.push(workspace)
      return workspace
    },
    archivedSessionIds: [],
  } as never)
  const agents = new Map<SessionId, Agent>()
  ctx.provide('sessionController', {
    create: async ({ workspaceId }: { workspaceId: string }) => {
      const sessionId = SessionId(`agent-session-${agents.size + 1}`)
      const workspace = workspaces.find(candidate => candidate.id === workspaceId)
      workspace?.sessionIds.push(sessionId)
      // A Session created in a game project records the project's folder in its header.
      agents.set(sessionId, await fakeAgent(ctx, sessionId, 'vision', workspace?.path))
      return { sessionId }
    },
    resolveAgent: async (sessionId: SessionId) => {
      const agent = agents.get(sessionId)
      return agent === undefined ? { error: { code: 'session/not-found', message: 'no such Session' } } : { agent }
    },
  } as never)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(GameMcpServer, GameMcpServer.Config({ dataRoot: join(work, '.game-mcp'), port: 0 }))
  const server = ctx.get('gameMcp') as GameMcpServer
  const views: GameMcpView[] = []
  const stop = new AbortController()
  void (async () => {
    for await (const view of server.watch(stop.signal)) views.push(view)
  })()
  ctx.effect(() => () => { stop.abort() })
  await vi.waitFor(() => { expect(views.at(-1)?.state).toBe('listening') }, { timeout: TIMEOUT })
  const token = (await readFile(join(work, '.game-mcp', 'token'), 'utf8')).trim()
  const client = new Client({ name: 'claude-code', version: '2.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(views.at(-1)?.url as string), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  ctx.effect(() => () => client.close())
  return { ...current, client }
}

type CallResult = Awaited<ReturnType<Client['callTool']>>

function text(result: CallResult): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('the asset tools over WASD Engine\'s MCP server', () => {
  it('lists both tools as read-only, each needing the project folder', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## Assets\n\n${MCP_INSTRUCTIONS}`)
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('asset_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([['asset_search', true], ['asset_view', true]])
    expect(tools.map(tool => tool.inputSchema.required)).toEqual([['project'], ['project', 'path']])
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'asset' } }))).toContain('- Assets (asset_*, ready, 2 tools)')
  }, TIMEOUT)

  it('searches the project the agent names, and refuses a relative project', async () => {
    const { client, work } = await connected()
    const relative = await client.callTool({ name: 'asset_search', arguments: { project: 'game' } })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toBe('project must be the absolute path of the game project\'s folder.')
    const search = await client.callTool({ name: 'asset_search', arguments: { project: work, kind: '3d' } })
    expect(search.isError, text(search)).toBeFalsy()
    // The connected agent's Session works in the project's canonical folder.
    expect(text(search)).toContain(`3 3D assets in ${await realpath(work)}.`)
  }, TIMEOUT)

  it('has the window draw an asset in the agent\'s own Session and sends the images as PNG bytes after the text', async () => {
    const current = await connected()
    const { client, work, requests, saved } = current
    current.openWindow({ details: KNIGHT, images: [{ data: PIXEL_PNG, mediaType: 'image/png', width: 1, height: 1, caption: 'iso view, materials' }] })
    const view = await client.callTool({ name: 'call_game_tool', arguments: { name: 'asset_view', arguments: { project: work, path: 'models/knight.glb', shading: 'solid' } } })
    expect(view.isError).toBeFalsy()
    expect((view.content as Array<{ type: string }>).map(block => block.type)).toEqual(['text', 'image'])
    expect(view.content).toContainEqual({ type: 'image', data: PIXEL_PNG, mimeType: 'image/png' })
    expect(text(view)).toContain('Model models/knight.glb (GLB, 2.4 MB).')
    expect(requests[0]).toMatchObject({ path: 'models/knight.glb', images: true, draw: { shading: 'solid' } })
    // The connected agent's own Session of the project, not one of the composition's Agents.
    expect(requests[0]?.agent?.id).toBe('agent-session-1')
    expect(saved).toEqual([])
  }, TIMEOUT)

  it('finds assets from the folder the agent names when a game project registered above it holds the Session', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-assets-parent-')))
    try {
      // The registered folder holds its own art/hero.png; the game the agent names is in game/.
      await mkdir(join(parent, 'art'), { recursive: true })
      await mkdir(join(parent, 'game', 'art'), { recursive: true })
      await writeFile(join(parent, 'art', 'hero.png'), 'parent png')
      await writeFile(join(parent, 'game', 'project.godot'), '[application]\n')
      await writeFile(join(parent, 'game', 'art', 'hero.png'), 'game png')
      const current = await connected([parent])
      const { client, requests } = current
      current.openWindow({ details: HERO, images: [] })
      const project = join(parent, 'game')
      const view = await client.callTool({ name: 'asset_view', arguments: { project, path: 'art/hero.png' } })
      expect(view.isError, text(view)).toBeFalsy()
      expect(text(view)).toContain('Image art/hero.png (PNG')
      // The Session works in the registered folder, from which the window reads the game's file.
      expect(requests[0]).toMatchObject({ path: 'game/art/hero.png', bytes: 'game png'.length })
      const search = await client.callTool({ name: 'asset_search', arguments: { project } })
      expect(text(search)).toContain(`1 asset in ${project}.`)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, TIMEOUT)
})
