/**
 * Agents connected through WASD Engine's MCP server use the reference tools: the whole chain from the official MCP
 * client over HTTP, through the game MCP server and the reference provider, to the fake web, with images sent as image
 * bytes and references saved into the project folder the agent names.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import GameMcpServer, { type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_INSTRUCTIONS } from '../src/prompt.ts'
import { compose, type Composition } from './composition.ts'
import { animatedGif, patternImage, previewPage } from './fixtures.ts'

// The plugin reaches the composition's fake web instead of this computer's. The factory imports nothing that imports
// the transport, which would wait for the factory itself.
vi.mock('../src/transport.ts', async () => {
  const { pluginWeb } = await import('./fixtures.ts')
  return { createNodeWeb: () => pluginWeb.current }
})

const TIMEOUT = 60_000

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

/** The composition with a signed-in account, the game MCP server, and an official MCP client connected to it. */
async function connected() {
  const current = composition = await compose()
  const { ctx, work } = current
  ctx.provide('deepseekAccount', { getState: () => Promise.resolve({ status: 'credential-stored' }) } as never)
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
  current.web
    .page('https://itch.example/knight', previewPage('Pixel Knight Pack', '/cover.png'))
    .image('https://itch.example/cover.png', await patternImage(320, 256, 1))
    .image('https://gifs.example/slash.gif', await animatedGif(48, 48, [80, 80, 160], 3), 'image/gif')
  current.results.set('knight sprite', {
    sources: [{ url: 'https://itch.example/knight' }, { url: 'https://gifs.example/slash.gif', title: 'Sword slash' }],
    truncated: false,
  })
  return { ...current, client }
}

type CallResult = Awaited<ReturnType<Client['callTool']>>

function text(result: CallResult): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function images(result: CallResult): string[] {
  return (result.content as Array<{ type: string; mimeType?: string }>).flatMap(block => block.type === 'image' ? [block.mimeType ?? ''] : [])
}

describe('the reference tools over WASD Engine\'s MCP server', () => {
  it('lists the tools with the provider\'s instructions, and the save with its project folder', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## Art references\n\n${MCP_INSTRUCTIONS}`)
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('reference_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([['reference_search', true], ['reference_save', false]])
    expect(tools[1]?.inputSchema.required).toEqual(['project', 'subject', 'images'])
    expect(JSON.stringify(tools[1]?.inputSchema.properties?.project)).toContain('Absolute path of the game project\'s folder')
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'reference' } }))).toContain('- Art references (reference_*, ready, 2 tools)')
  }, TIMEOUT)

  it('finds references with the contact sheet as image bytes, and saves them into the project it names', async () => {
    const { client, work } = await connected()
    const found = await client.callTool({ name: 'reference_search', arguments: { queries: ['knight sprite'] } })
    expect(found.isError).toBeFalsy()
    expect(text(found)).toContain('Found 2 reference images for "knight sprite" (1 page read).')
    expect(images(found)).toEqual(['image/jpeg'])
    const project = join(work, 'game')
    await mkdir(project)
    const saved = await client.callTool({
      name: 'reference_save',
      arguments: { project, subject: 'knight', images: ['https://itch.example/cover.png', 'https://gifs.example/slash.gif'] },
    })
    expect(saved.isError).toBeFalsy()
    expect(text(saved)).toContain('Saved 2 references for knight in references/knight, with their sources in references/knight/SOURCES.md:')
    expect(images(saved)).toEqual(['image/jpeg', 'image/png'])
    expect((await readdir(join(project, 'references', 'knight'))).sort()).toEqual(['01-pixel-knight-pack.png', '02-sword-slash.frames.png', '02-sword-slash.gif', 'SOURCES.md'])
  }, TIMEOUT)

  it('refuses a save without an absolute, existing project folder', async () => {
    const { client, work } = await connected()
    const relative = await client.callTool({ name: 'reference_save', arguments: { project: 'game', subject: 'knight', images: ['https://itch.example/cover.png'] } })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toContain('project must be the absolute path of the game project\'s folder.')
    const missing = await client.callTool({ name: 'reference_save', arguments: { project: join(work, 'nowhere'), subject: 'knight', images: ['https://itch.example/cover.png'] } })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('does not exist.')
  }, TIMEOUT)
})
