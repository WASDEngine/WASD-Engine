/**
 * Agents connected through WASD Engine's MCP server use the image tool: the whole chain from the official MCP client
 * over HTTP, through the game MCP server and the image provider, to a fake WASD Engine API, with the image written to
 * the absolute path the agent names and charged to the account the app is signed in to.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import GameMcpServer, { SIGNED_OUT_MESSAGE, type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_INSTRUCTIONS } from '../src/mcp.ts'
import { compose, TOKEN, type Composition } from './composition.ts'
import { solidImage } from './fixtures.ts'

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

describe('the image tool over WASD Engine\'s MCP server', () => {
  it('lists image_generate with its files named by absolute path, and the provider\'s instructions, which prefer it to drawing 2D art', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## Nano Banana\n\n${MCP_INSTRUCTIONS}`)
    expect(client.getInstructions()).toContain('\n- Nano Banana (image_*): Make game art, UI pieces, and textures with Google\'s Nano Banana 2.1. '
      + 'Prefer it to drawing 2D art yourself.\n')
    expect(MCP_INSTRUCTIONS).toContain('Prefer it to drawing 2D art yourself, in GIMP or in code, and use GIMP to edit what it makes.')
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('image_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([['image_generate', false]])
    const [tool] = tools
    expect(tool?.inputSchema.required).toEqual(['prompt', 'path'])
    expect(JSON.stringify(tool?.inputSchema.properties?.path)).toContain('Absolute path of the file to write')
    expect(JSON.stringify(tool?.inputSchema.properties?.images)).toContain('Absolute paths of existing images')
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'image' } }))).toContain('- Nano Banana (image_*, ready, 1 tools)')
  }, TIMEOUT)

  it('saves an image at the absolute path with the app\'s account, sending the images it names', async () => {
    const { client, api, work } = await connected()
    const reference = join(work, 'game', 'art', 'hero.png')
    await mkdir(join(work, 'game', 'art'), { recursive: true })
    await writeFile(reference, await solidImage(512, 768))
    const path = join(work, 'game', 'art', 'hero_running.png')
    const made = await client.callTool({
      name: 'call_game_tool',
      arguments: { name: 'image_generate', arguments: { prompt: 'The same hero, running', path, images: [reference] } },
    })
    expect(made.isError).toBeFalsy()
    expect(text(made)).toBe(`Saved a 1024×1024 image (Nano Banana 2.1, 1K, 2:3) to ${path} (${Math.max(1, Math.round(api.image.data.byteLength / 1024))} KB). Made from 1 image: ${reference}.`)
    expect(await readFile(path)).toEqual(api.image.data)
    expect(api.requests.map(request => [request.path, request.token, request.body.aspect_ratio])).toEqual([['/v1/images/generate', TOKEN, '2:3']])
  }, TIMEOUT)

  it('refuses relative paths, and every call while WASD Engine is signed out', async () => {
    const { client, api, account, work } = await connected()
    const relative = await client.callTool({ name: 'image_generate', arguments: { prompt: 'a coin', path: 'coin.png' } })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toContain('path must be an absolute path.')
    const relativeImages = await client.callTool({ name: 'image_generate', arguments: { prompt: 'a coin', path: join(work, 'coin.png'), images: ['hero.png'] } })
    expect(relativeImages.isError).toBe(true)
    expect(text(relativeImages)).toContain('images must be absolute paths.')
    account.signedIn = false
    const signedOut = await client.callTool({ name: 'image_generate', arguments: { prompt: 'a coin', path: join(work, 'coin.png') } })
    expect(signedOut.isError).toBe(true)
    expect(text(signedOut)).toContain(SIGNED_OUT_MESSAGE)
    expect(api.requests).toEqual([])
  }, TIMEOUT)
})
