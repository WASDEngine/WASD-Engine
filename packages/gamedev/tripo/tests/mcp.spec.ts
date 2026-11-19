/**
 * Agents connected through WASD Engine's MCP server use the Tripo tools: the whole chain from the official MCP client over
 * HTTP, through the game MCP server and the Tripo provider, to a fake WASD Engine API, with the model written to the
 * absolute path the agent names and charged to the account the app is signed in to.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import GameMcpServer, { SIGNED_OUT_MESSAGE, type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readGlb } from '../src/glb.ts'
import { MCP_INSTRUCTIONS } from '../src/mcp.ts'
import { compose, TOKEN, type Composition } from './composition.ts'

const TIMEOUT = 60_000

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

/** The composition with the game MCP server and an official MCP client connected to it. */
async function connected() {
  const current = composition = await compose()
  const { ctx, work } = current
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

describe('the Tripo tools over WASD Engine\'s MCP server', () => {
  it('lists the five tools with their files named by absolute path, and the provider\'s instructions, which prefer it to modeling by hand', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## Tripo\n\n${MCP_INSTRUCTIONS}`)
    expect(client.getInstructions()).toContain('\n- Tripo (tripo_*): Make textured, rigged, and animated 3D models. Prefer it to modeling them yourself.\n')
    expect(MCP_INSTRUCTIONS).not.toMatch(/credit|cost|price|\$/u)
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('tripo_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([
      ['tripo_generate', false], ['tripo_texture', false], ['tripo_rig', false], ['tripo_animate', false], ['tripo_task', false],
    ])
    const generate = tools[0]
    expect(generate?.inputSchema.required).toEqual(['path'])
    expect(JSON.stringify(generate?.inputSchema.properties?.path)).toContain('Absolute path of the file to write')
    expect(JSON.stringify(generate?.inputSchema.properties?.image)).toContain('Absolute path of an existing image')
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'tripo' } }))).toContain('- Tripo (tripo_*, ready, 5 tools)')
  }, TIMEOUT)

  it('saves a model at the absolute path with the app\'s account', async () => {
    const { client, api, work } = await connected()
    const path = join(work, 'game', 'models', 'barrel.glb')
    const made = await client.callTool({ name: 'call_game_tool', arguments: { name: 'tripo_generate', arguments: { prompt: 'a wooden barrel', path } } })
    expect(made.isError, text(made)).toBeFalsy()
    const [task] = api.tasks.values()
    expect(text(made)).toContain(`Saved a textured 3D model (Tripo P2) to ${path}`)
    expect(text(made)).toContain(', facing +Z)')
    expect(readGlb(await readFile(path))).toEqual(readGlb(task?.model ?? Buffer.alloc(0)))
    expect(api.requests.map(request => [request.method, request.path, request.token])).toEqual([
      ['POST', '/v1/3d/generate', TOKEN], ['GET', `/v1/3d/tasks/${task?.id}`, TOKEN], ['GET', `/v1/3d/tasks/${task?.id}/model`, TOKEN],
    ])
  }, TIMEOUT)

  it('refuses relative paths, and every call while WASD Engine is signed out', async () => {
    const { client, api, account, work } = await connected()
    for (const [name, args, message] of [
      ['tripo_generate', { prompt: 'a barrel', path: 'barrel.glb' }, 'path must be an absolute path.'],
      ['tripo_generate', { image: 'barrel.png', path: join(work, 'barrel.glb') }, 'image must be an absolute path.'],
      ['tripo_generate', { views: { front: join(work, 'f.png'), back: 'b.png' }, path: join(work, 'barrel.glb') }, 'views must be absolute paths.'],
      ['tripo_texture', { task_id: 'a', image: 'style.png', path: join(work, 'barrel.glb') }, 'image must be an absolute path.'],
      ['tripo_task', { task_id: 'a', path: 'barrel.glb' }, 'path must be an absolute path.'],
    ] as const) {
      const refused = await client.callTool({ name, arguments: args })
      expect(refused.isError, JSON.stringify(args)).toBe(true)
      expect(text(refused), JSON.stringify(args)).toContain(message)
    }
    account.signedIn = false
    const signedOut = await client.callTool({ name: 'tripo_generate', arguments: { prompt: 'a barrel', path: join(work, 'barrel.glb') } })
    expect(signedOut.isError).toBe(true)
    expect(text(signedOut)).toContain(SIGNED_OUT_MESSAGE)
    expect(api.requests).toEqual([])
  }, TIMEOUT)
})
