/**
 * Agents connected through WASD Engine's MCP server run the Session's own Godot tools for a Session of their own:
 * the whole chain from the official MCP client over HTTP, through the game MCP server and the Godot provider, to a
 * fake Godot game, with screenshots as PNG bytes and the window asked to show the Session that runs the game.
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import GameMcpServer, { type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { agentScreenshotWidth, MCP_INSTRUCTIONS, MCP_WORDING } from '../src/mcp.ts'
import { SESSION_WORDING } from '../src/tools.ts'
import { fakeAgent } from './agents.ts'
import { compose, type Composition } from './composition.ts'

const TIMEOUT = 60_000

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

/** The composition with the game MCP server, a Workspace registry, and a Session controller that creates fake Agents. */
async function connected(game: Record<string, unknown> = {}, config: Partial<Config> = {}) {
  const current = composition = await compose({ game: { game }, config })
  const { ctx, dir } = current
  const workspaces: Array<{ id: string; path: string; sessionIds: SessionId[] }> = []
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    create: async (path: string) => {
      const workspace = { id: `w${workspaces.length + 1}`, path, sessionIds: [] }
      workspaces.push(workspace)
      return workspace
    },
    archivedSessionIds: [],
  } as never)
  const created: SessionId[] = []
  Object.assign(current.sessionController, {
    create: async ({ workspaceId }: { workspaceId: string }) => {
      const sessionId = brandString<SessionId>(`agent-session-${created.length + 1}`)
      created.push(sessionId)
      workspaces.find(workspace => workspace.id === workspaceId)?.sessionIds.push(sessionId)
      await fakeAgent(ctx, sessionId)
      return { sessionId }
    },
  })
  await ctx.plugin(GameMcpServer, GameMcpServer.Config({ dataRoot: join(dir.root, 'game-mcp'), port: 0 }))
  const server = ctx.get('gameMcp') as GameMcpServer
  const views: GameMcpView[] = []
  const stop = new AbortController()
  void (async () => {
    for await (const view of server.watch(stop.signal)) views.push(view)
  })()
  ctx.effect(() => () => { stop.abort() })
  await vi.waitFor(() => { expect(views.at(-1)?.state).toBe('listening') }, { timeout: TIMEOUT })
  const token = (await readFile(join(dir.root, 'game-mcp', 'token'), 'utf8')).trim()
  const client = new Client({ name: 'claude-code', version: '2.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(views.at(-1)?.url as string), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  ctx.effect(() => () => client.close())
  return { ...current, client, views, workspaces, created }
}

type CallResult = Awaited<ReturnType<Client['callTool']>>

function text(result: CallResult): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function images(result: CallResult): Array<{ data: string; mimeType: string }> {
  return (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
    .flatMap(block => block.type === 'image' ? [{ data: block.data as string, mimeType: block.mimeType as string }] : [])
}

describe('the Godot tools over WASD Engine\'s MCP server', () => {
  it('names the Godot release of the shipped or installed runtime in the instructions', async () => {
    const { client } = await connected({}, { runnerPath: '', libgodotPath: '' })
    expect(client.getInstructions()).toContain(
      `${MCP_INSTRUCTIONS}\nThe godot_* tools run Godot 4.7: write code for it, and start config/features in a new project.godot with "4.7".`)
  }, TIMEOUT)

  it('names no Godot release in the instructions for configured runtime paths', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(MCP_INSTRUCTIONS)
    expect(client.getInstructions()).not.toContain('The godot_* tools run Godot')
  }, TIMEOUT)

  it('lists every Godot tool with an absolute project parameter and the wording for connected agents', async () => {
    const { client } = await connected()
    const { tools } = await client.listTools()
    const godot = tools.filter(tool => tool.name.startsWith('godot_'))
    expect(godot.map(tool => tool.name)).toEqual([
      'godot_run', 'godot_stop', 'godot_screenshot', 'godot_input', 'godot_wait', 'godot_control', 'godot_eval', 'godot_scene_tree',
      'godot_performance', 'godot_logs', 'godot_check',
    ])
    for (const tool of godot) {
      expect(tool.inputSchema.properties?.project).toMatchObject({ type: 'string' })
      expect(JSON.stringify(tool.inputSchema.properties?.project)).toContain('Absolute path')
    }
    expect(godot.find(tool => tool.name === 'godot_input')?.inputSchema.required).toEqual(['events'])
    expect(godot.find(tool => tool.name === 'godot_run')?.description?.startsWith(MCP_WORDING.run)).toBe(true)
    expect(godot.find(tool => tool.name === 'godot_screenshot')?.annotations?.readOnlyHint).toBe(true)
    expect(godot.find(tool => tool.name === 'godot_performance')?.annotations?.readOnlyHint).toBe(true)
    // A check may import the project first, which writes its import data.
    expect(godot.find(tool => tool.name === 'godot_check')?.annotations?.readOnlyHint).toBeUndefined()
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'godot' } }))).toContain('- Godot (godot_*, ready, 11 tools)')
  }, TIMEOUT)

  it('runs the game for the agent\'s own Session, shows it in the window, and returns screenshots as PNG bytes', async () => {
    const { client, project, workspaces, created, ctx } = await connected()
    const revealed: SessionId[] = []
    ctx.on('game-mcp/reveal', (sessionId) => { revealed.push(sessionId) })
    const run = await client.callTool({ name: 'godot_run', arguments: { project: join(project, 'project.godot') } })
    expect(run.isError).toBeFalsy()
    expect(text(run)).toContain('The game is running: Fake game')
    expect(workspaces).toEqual([{ id: 'w1', path: await realpath(project), sessionIds: created }])
    expect(created).toHaveLength(1)
    expect(revealed).toEqual(created)
    expect(ctx.agents.get(created[0] as SessionId)).toBeDefined()

    // Later calls default to the previous project.
    const shot = await client.callTool({ name: 'godot_screenshot', arguments: {} })
    expect(text(shot)).toMatch(/^Screenshot at frame \d+: \d+x\d+ px of a \d+x\d+ px game window\./u)
    expect(images(shot)).toEqual([{ data: Buffer.from('PNG-BYTES', 'latin1').toString('base64'), mimeType: 'image/png' }])
    expect(composition?.saved).toEqual([])
    const input = await client.callTool({ name: 'godot_input', arguments: { events: [{ kind: 'key', key: 'Space', pressed: true }], screenshot: true } })
    expect(text(input)).toContain('Sent 1 events')
    expect(images(input)).toHaveLength(1)
    const mouse = await client.callTool({ name: 'godot_input', arguments: { events: [{ kind: 'mouse_button', button: 'left', pressed: true, x: 10, y: 10 }] } })
    expect(mouse.isError).toBeFalsy()
    const measured = await client.callTool({ name: 'godot_performance', arguments: { seconds: 0.25 } })
    expect(measured.isError).toBeFalsy()
    expect(text(measured)).toMatch(/^Measured 0\.25 s of real time: 0 frames at 0\.0 FPS; the forward_plus renderer on fake draws/u)
    expect(text(await client.callTool({ name: 'godot_stop', arguments: { project } }))).toBe('Stopped the game.')
    expect(text(await client.callTool({ name: 'godot_screenshot', arguments: {} }))).toContain('call godot_run to start it again')
    // The agent keeps its Session.
    await client.callTool({ name: 'godot_run', arguments: {} })
    expect(created).toHaveLength(1)
    await client.callTool({ name: 'godot_stop', arguments: {} })
  }, TIMEOUT)

  it('holds connected agents to the run limit of WASD Engine\'s own Sessions', async () => {
    const { client, project, godot } = await connected({}, { maxRuns: 1 })
    await godot.run(brandString<SessionId>('owner'), {}, new AbortController().signal)
    const refused = await client.callTool({ name: 'godot_run', arguments: { project } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('1 Godot game already runs, as many as this computer runs at once; stop one before starting another.')
  }, TIMEOUT)

  it('starts no game or check for a connected agent while the computer is short of memory', async () => {
    const { client, project } = await connected({}, { minAvailableMemoryBytes: Number.MAX_SAFE_INTEGER })
    await writeFile(join(project, 'player.gd'), 'extends Node\n')
    const run = await client.callTool({ name: 'godot_run', arguments: { project } })
    expect(run.isError).toBe(true)
    expect(text(run)).toMatch(/ that starting the game needs, so it did not start\./u)
    const check = await client.callTool({ name: 'godot_check', arguments: { project } })
    expect(check.isError).toBe(true)
    expect(text(check)).toMatch(/ that starting a Godot script check needs, so it did not start\./u)
  }, TIMEOUT)

  it('refuses a call without a usable project', async () => {
    const { client, dir } = await connected()
    const missing = await client.callTool({ name: 'godot_run', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toBe('Pass project: the absolute path of the folder that holds project.godot.')
    expect(text(await client.callTool({ name: 'godot_check', arguments: { project: 'game' } }))).toBe('project must be an absolute path, got "game".')
    expect(text(await client.callTool({ name: 'godot_logs', arguments: { project: 42 } }))).toBe('project must be a string.')
    await mkdir(join(dir.root, 'empty'))
    const empty = await client.callTool({ name: 'godot_run', arguments: { project: join(dir.root, 'empty') } })
    expect(empty.isError).toBe(true)
    expect(text(empty)).toContain('No project.godot in')
  }, TIMEOUT)
})

describe('agentScreenshotWidth', () => {
  it('keeps the requested width while the image fits agent limits, and shrinks it otherwise', () => {
    expect(agentScreenshotWidth(1280, 1280, 720)).toBe(1280)
    expect(agentScreenshotWidth(640, 1280, 720)).toBe(640)
    expect(agentScreenshotWidth(4096, 3840, 2160)).toBe(1429)
    expect(agentScreenshotWidth(4096, 1080, 1920)).toBe(804)
    expect(agentScreenshotWidth(4096, undefined, undefined)).toBe(1568)
    expect(agentScreenshotWidth(4096, 20, 100_000)).toBe(64)
  })

  it('words the tools for connected agents apart from the Session\'s own', () => {
    expect(MCP_WORDING.checkPaths).not.toBe(SESSION_WORDING.checkPaths)
  })
})
