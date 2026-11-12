/**
 * Agents connected through WASD Engine's MCP server use the audio tools: the whole chain from the official MCP client
 * over HTTP, through the game MCP server and the audio provider, to the connected agent's Session of the project it
 * names, with the window's picture sent as PNG bytes after the text.
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
import { compose, fakeAgent, JUMP, PIXEL_PNG, type Composition } from './composition.ts'
import { pcmWav } from './signals.ts'

const TIMEOUT = 60_000

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

/**
 * The composition with a game project registry, a Session controller that creates fake Agents, the game MCP server,
 * and an official MCP client connected to it.
 * @param registered - game project folders registered before the client connects.
 */
async function connected(registered: readonly string[] = []) {
  const current = composition = await compose()
  const { ctx, work } = current
  const workspaces: Array<{ id: string; path: string; sessionIds: SessionId[] }> = registered.map((path, index) => ({ id: `r${String(index + 1)}`, path, sessionIds: [] }))
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    create: async (path: string) => {
      const workspace = { id: `w${String(workspaces.length + 1)}`, path, sessionIds: [] }
      workspaces.push(workspace)
      return workspace
    },
    archivedSessionIds: [],
  } as never)
  const agents = new Map<SessionId, Agent>()
  ctx.provide('sessionController', {
    create: async ({ workspaceId }: { workspaceId: string }) => {
      const sessionId = SessionId(`agent-session-${String(agents.size + 1)}`)
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

describe('the audio tools over WASD Engine\'s MCP server', () => {
  it('lists both tools as read-only, each needing the project folder', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## Audio\n\n${MCP_INSTRUCTIONS}`)
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('audio_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([['audio_search', true], ['audio_review', true]])
    expect(tools.map(tool => tool.inputSchema.required)).toEqual([['project'], ['project', 'path']])
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'audio' } }))).toContain('- Audio (audio_*, ready, 2 tools)')
  }, TIMEOUT)

  it('searches the project the agent names, and refuses a relative project', async () => {
    const { client, work } = await connected()
    const relative = await client.callTool({ name: 'audio_search', arguments: { project: 'game' } })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toBe('project must be the absolute path of the game project\'s folder.')
    const search = await client.callTool({ name: 'audio_search', arguments: { project: work, kind: 'dialogue' } })
    expect(search.isError, text(search)).toBeFalsy()
    // The connected agent's Session works in the project's canonical folder.
    expect(text(search)).toContain(`1 sound dialogue lines only in ${await realpath(work)}: 1 dialogue line.`)
  }, TIMEOUT)

  it('has the window measure a sound in the agent\'s own Session and sends the picture as PNG bytes after the text', async () => {
    const current = await connected()
    const { client, work, requests, saved, reveals } = current
    current.openWindow({ measurements: JUMP, picture: { data: PIXEL_PNG, mediaType: 'image/png', layout: { width: 1024, height: 418, waveformPanels: 'mix', timeStep: 0.05, nyquist: 22_050 } } })
    const review = await client.callTool({ name: 'call_game_tool', arguments: { name: 'audio_review', arguments: { project: work, path: 'audio/sfx/jump.wav', show: true } } })
    expect(review.isError, text(review)).toBeFalsy()
    expect((review.content as Array<{ type: string }>).map(block => block.type)).toEqual(['text', 'image'])
    expect(review.content).toContainEqual({ type: 'image', data: PIXEL_PNG, mimeType: 'image/png' })
    expect(text(review)).toContain('audio/sfx/jump.wav: sound effect; WAV, 16-bit PCM, mono, 48 kHz, 0.620 s, 58.2 KB.')
    expect(requests[0]).toMatchObject({ path: 'audio/sfx/jump.wav', picture: true })
    // The connected agent's own Session of the project, not one of the composition's Agents.
    expect(requests[0]?.agent?.id).toBe('agent-session-1')
    expect(reveals).toEqual([{ sessionId: 'agent-session-1', path: 'audio/sfx/jump.wav' }])
    expect(saved).toEqual([])
  }, TIMEOUT)

  it('finds sounds from the folder the agent names when a game project registered above it holds the Session', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-audio-parent-')))
    try {
      // The registered folder holds its own audio/hit.wav; the game the agent names is in game/.
      await mkdir(join(parent, 'audio'), { recursive: true })
      await mkdir(join(parent, 'game', 'audio'), { recursive: true })
      await writeFile(join(parent, 'audio', 'hit.wav'), pcmWav({ sampleRate: 8000, frames: 80 }))
      await writeFile(join(parent, 'game', 'project.godot'), '[application]\n')
      await writeFile(join(parent, 'game', 'audio', 'hit.wav'), pcmWav({ sampleRate: 22_050, frames: 2205 }))
      const current = await connected([parent])
      const { client, requests, reveals } = current
      current.openWindow({ measurements: JUMP })
      const project = join(parent, 'game')
      const review = await client.callTool({ name: 'call_game_tool', arguments: { name: 'audio_review', arguments: { project, path: 'audio/hit.wav', picture: false, show: true } } })
      expect(review.isError, text(review)).toBeFalsy()
      expect(text(review)).toContain('audio/hit.wav: sound effect by its length; WAV, 16-bit PCM, mono, 22.1 kHz, 0.100 s')
      // The Session works in the registered folder, from which the window reads the game's sound.
      expect(requests[0]).toMatchObject({ path: 'game/audio/hit.wav' })
      expect(reveals).toEqual([{ sessionId: requests[0]?.agent?.id, path: 'game/audio/hit.wav' }])
      const search = await client.callTool({ name: 'audio_search', arguments: { project } })
      expect(text(search)).toContain(`1 sound in ${project}`)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, TIMEOUT)
})
