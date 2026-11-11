/**
 * Agents connected through WASD Engine's MCP server use the Poly Haven tools: the whole chain from the official MCP
 * client over HTTP, through the game MCP server and the Poly Haven provider, to a fake Poly Haven, with preview
 * images sent as JPEG bytes and downloads written to the absolute folder the agent names.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import GameMcpServer, { type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_INSTRUCTIONS } from '../src/mcp.ts'
import { compose, type Composition } from './composition.ts'
import { fileBytes, PREVIEW } from './fixtures.ts'

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

describe('the Poly Haven tools over WASD Engine\'s MCP server', () => {
  it('lists the three tools, the read-only ones marked, with an absolute download folder that connected agents must pass', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## Poly Haven\n\n${MCP_INSTRUCTIONS}`)
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('polyhaven_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([
      ['polyhaven_search', true], ['polyhaven_asset', true], ['polyhaven_download', false],
    ])
    const download = tools[2]
    expect(download?.inputSchema.required).toEqual(['id', 'directory'])
    expect(JSON.stringify(download?.inputSchema.properties?.directory)).toContain('Absolute path')
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'polyhaven' } }))).toContain('- Poly Haven (polyhaven_*, ready, 3 tools)')
  }, TIMEOUT)

  it('searches without a Session, and sends an asset\'s preview as JPEG bytes after its text', async () => {
    const { client, saved } = await connected()
    const search = await client.callTool({ name: 'polyhaven_search', arguments: { query: 'moss', type: 'textures' } })
    expect(search.isError).toBeFalsy()
    expect(text(search)).toContain('- mossy_rock: Mossy Rock (texture; Stone/Rock & Cliffs/Mossy Rock; up to 2k; 3 × 3 m). Weathered rock with green moss.')
    const asset = await client.callTool({ name: 'call_game_tool', arguments: { name: 'polyhaven_asset', arguments: { id: 'mossy_rock' } } })
    expect(asset.isError).toBeFalsy()
    expect((asset.content as Array<{ type: string }>).map(block => block.type)).toEqual(['text', 'image'])
    expect(asset.content).toContainEqual({ type: 'image', data: PREVIEW.toString('base64'), mimeType: 'image/jpeg' })
    expect(saved).toEqual([])
  }, TIMEOUT)

  it('downloads into the absolute folder the agent names, and refuses a relative one', async () => {
    const { client, work } = await connected()
    const relative = await client.callTool({ name: 'polyhaven_download', arguments: { id: 'kiara_8_sunset', directory: 'sky' } })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toBe('directory must be an absolute path.')
    const directory = join(work, 'game', 'sky')
    const saved = await client.callTool({ name: 'polyhaven_download', arguments: { id: 'kiara_8_sunset', directory, resolution: '2k' } })
    expect(saved.isError).toBeFalsy()
    expect(text(saved)).toContain(`Saved Kiara 8 Sunset (Poly Haven HDRI kiara_8_sunset, hdr at 2k) in ${directory}: 1 file`)
    expect(await readdir(directory)).toEqual(['kiara_8_sunset_2k.hdr'])
    expect(await readFile(join(directory, 'kiara_8_sunset_2k.hdr'))).toEqual(fileBytes('kiara_8_sunset/kiara_8_sunset_2k.hdr'))
  }, TIMEOUT)
})
