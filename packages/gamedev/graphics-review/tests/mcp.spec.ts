/**
 * The graphics review for agents connected through WASD Engine's MCP server: the provider `graphics` in the server's
 * catalog, with its description in the instructions' overview and its tool, which takes only an absolute image path.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { GameToolCatalog } from '@deepseek-ai/dsh-game-mcp/src/catalog.ts'
import type { GameMcpCall } from '@deepseek-ai/dsh-game-mcp'
import { graphicsReviewMcpProvider, MCP_PROVIDER_ID } from '../src/mcp.ts'
import { MCP_DESCRIPTION, MCP_INSTRUCTIONS } from '../src/prompt.ts'

let folder: string | undefined

afterEach(async () => {
  if (folder !== undefined) await rm(folder, { recursive: true, force: true })
  folder = undefined
})

const call: GameMcpCall = {
  client: { id: 'claude-code', title: 'Claude Code' },
  signal: new AbortController().signal,
  session: () => Promise.reject(new Error('the review needs no Session')),
  reveal: () => {},
}

describe('graphicsReviewMcpProvider', () => {
  const reviewed: string[] = []
  const provider = graphicsReviewMcpProvider({
    limits: { maxBytes: 1024 * 1024, maxEdge: 1568, maxPixels: 1_150_000, minEdge: 512 },
    timeoutMs: 60_000,
    review: (request) => {
      reviewed.push(request.subject)
      return Promise.resolve('**How to make it better:** Raise the title\'s contrast against the sky.')
    },
  })

  it('offers graphics_review under the graphics prefix, read-only, with its description in the overview and its guide after it', () => {
    expect(provider).toMatchObject({ id: MCP_PROVIDER_ID, title: 'Graphics review', description: MCP_DESCRIPTION, instructions: MCP_INSTRUCTIONS })
    const [tool] = provider.tools()
    expect(tool).toMatchObject({ name: 'graphics_review', readOnly: true })
    const catalog = new GameToolCatalog(() => [provider], () => {})
    expect(catalog.overview()).toContain(`\n- Graphics review (graphics_*): ${MCP_DESCRIPTION}`)
    expect(catalog.instructions()).toContain(`## Graphics review\n\n${MCP_INSTRUCTIONS}`)
  })

  it('reviews an image at an absolute path and refuses a relative one', async () => {
    folder = await mkdtemp(join(tmpdir(), 'dsh-graphics-review-mcp-'))
    const image = join(folder, 'shot.png')
    await writeFile(image, await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).png().toBuffer())
    const catalog = new GameToolCatalog(() => [provider], () => {})
    const [entry] = catalog.tools()
    const done = await catalog.run(entry!, { image, subject: 'the title screen' }, call)
    expect(done).toEqual({ content: [{ type: 'text', text: `Graphics review of ${image}:\n\n**How to make it better:** Raise the title's contrast against the sky.` }] })
    expect(reviewed).toEqual(['the title screen'])
    const refused = await catalog.run(entry!, { image: 'shot.png', subject: 'the title screen' }, call)
    expect(refused).toEqual({ isError: true, content: [{ type: 'text', text: 'image must be an absolute path, got "shot.png".' }] })
  })
})
