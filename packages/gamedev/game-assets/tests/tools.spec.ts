/**
 * The asset tools in a real tool runtime: `asset_search` walks the project folder, and `asset_view` resolves the
 * asset, asks the open window to draw it through the scoped `game-assets/render` request, validates the answer,
 * stores the images for a model that accepts them, reports the details, and opens the asset in the Assets tab.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { Config } from '../src/index.ts'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { callerPath, DEFAULT_LIMIT, gltfFilesBytes, NO_WINDOW_MESSAGE, windowPath } from '../src/tools.ts'
import { callTool, compose, fakeAgent, HERO, KNIGHT, PIXEL_PNG, text, type Composition } from './composition.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function composed(config: Partial<Config> = {}): Promise<Composition> {
  composition = await compose(config)
  return composition
}

describe('asset_search', () => {
  it('lists the project\'s images and models folder by folder, skipping hidden folders and node_modules', async () => {
    const c = await composed()
    const result = await callTool(c, 'asset_search')
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe([
      `6 assets in ${c.work}.`,
      'Folders: art/ 2 2D; art/ui/ 1 2D; models/ 3 3D.',
      // Names in the Assets tab's reading order: `_` sorts before `.`.
      '- art/hero_walk_01.png (2D PNG, 3 B)',
      '- art/hero.png (2D PNG, 3 B)',
      '- art/ui/icon.svg (2D SVG, 6 B)',
      '- models/knight.blend (3D Blender, 5 B)',
      '- models/knight.glb (3D GLB, 3 B)',
      '- models/rock.fbx (3D FBX, 3 B)',
      'Pass a path to asset_view to look at an asset.',
    ].join('\n'))
  })

  it('ranks matches by name, filters by kind and folder, and pages', async () => {
    const c = await composed()
    expect(text(await callTool(c, 'asset_search', { query: 'hero' }))).toContain('2 assets matching "hero" in')
    const models = text(await callTool(c, 'asset_search', { kind: '3d', limit: 1, offset: 1 }))
    expect(models).toContain('3 3D assets in')
    expect(models).toContain('- models/knight.glb (3D GLB, 3 B)')
    expect(models).toContain('Showing 2–2 of 3; pass offset to list more.')
    const ui = text(await callTool(c, 'asset_search', { folder: 'art/ui/' }))
    expect(ui).toContain('1 asset under art/ui/ in')
    // Letters in order find an abbreviation.
    expect(text(await callTool(c, 'asset_search', { query: 'knblend' }))).toContain('- models/knight.blend')
    const none = await callTool(c, 'asset_search', { query: 'dragon' })
    expect(text(none)).toBe(`No assets matching "dragon" in ${c.work}.`)
  })

  it('refuses a folder outside the project and a limit out of range', async () => {
    const c = await composed()
    const outside = await callTool(c, 'asset_search', { folder: '../elsewhere' })
    expect(outside.isError).toBe(true)
    expect(text(outside)).toContain('is not a folder inside the project folder')
    const limit = await callTool(c, 'asset_search', { limit: 0 })
    expect(text(limit)).toContain('limit must be an integer from 1 to 200.')
    expect(DEFAULT_LIMIT).toBe(50)
  })

  it('reports a walk cut short by its caps', async () => {
    const c = await composed({ maxAssets: 2 })
    const result = text(await callTool(c, 'asset_search'))
    expect(result).toContain('2 assets in')
    expect(result).toContain('The project has more files than one search reads')
  })
})

describe('asset_view', () => {
  it('asks the window to draw a model with the call\'s options, and stores the images for the model', async () => {
    const c = await composed()
    c.openWindow({ details: KNIGHT, images: [{ data: PIXEL_PNG, mediaType: 'image/png', width: 1, height: 1, caption: 'iso and front views, materials, skeleton' }] })
    const result = await callTool(c, 'asset_view', { path: 'models/knight.glb', views: ['iso', 'front', 'iso'], skeleton: true, size: 512 })
    expect(result.isError).toBeFalsy()
    const [request] = c.requests
    expect(request).toMatchObject({
      path: 'models/knight.glb',
      kind: 'model',
      draw: { views: ['iso', 'front'], shading: 'material', skeleton: true, size: 512 },
      images: true,
      maxBytes: 256 * 1024 * 1024,
      maxPixels: 1_150_000,
    })
    expect(request?.agent).toBe(c.agent)
    expect(request?.signal).toBeInstanceOf(AbortSignal)
    expect(c.saved.map(image => [image.name, image.mediaType])).toEqual([['knight.png', 'image/png']])
    expect(result.content.map(block => block.type)).toEqual(['text', 'image'])
    expect(text(result)).toBe([
      'Model models/knight.glb (GLB, 2.4 MB).',
      'Size 0.92 × 1.84 × 0.41 (x × y × z, y up), from (-0.46, 0, -0.2) to (0.46, 1.84, 0.21).',
      'Geometry: 12,340 triangles and 7,021 vertices in 3 meshes; 41 nodes.',
      'Materials (1):',
      '- Body: MeshStandardMaterial, color #ffffff, metalness 0, roughness 0.8, double-sided; map body.png, normalMap body_n.png',
      'Textures (2): body.png 1024 × 1024, body_n.png 1024 × 1024.',
      'Skeleton: 4 bones, each under its parent:',
      'Hips',
      '  Spine',
      '    Head',
      '  LeftLeg',
      'Animation clips (1); pass one\'s name as animation to see frames across it:',
      '- Walk: 1.07 s, 12 tracks on 3 bones or nodes: Hips, Spine, LeftLeg',
      'Morph targets: Face: Blink, Smile.',
      'The image shows: iso and front views, materials, skeleton.',
    ].join('\n'))
  })

  it('draws the model exported from a Blender file, and opens it in the Assets tab when asked', async () => {
    const c = await composed()
    c.openWindow({ details: KNIGHT, images: [] })
    const result = await callTool(c, 'asset_view', { path: 'models/knight.blend', animation: 'Walk', show: true })
    expect(result.isError).toBeFalsy()
    expect(c.requests[0]).toMatchObject({ path: 'models/knight.glb', draw: { animation: 'Walk' } })
    expect(text(result)).toContain('models/knight.blend is a Blender file, which the viewer cannot read; this is the model exported from it.')
    expect(text(result)).toContain('It is open in the user\'s Assets panel.')
    expect(c.reveals).toEqual([{ sessionId: c.agent.id, path: 'models/knight.glb', animation: 'Walk' }])
  })

  it('asks a model that does not accept images for the details alone', async () => {
    const c = await composed()
    c.openWindow({ details: HERO, images: [] })
    const result = await callTool(c, 'asset_view', { path: 'art/hero.png', grid: { columns: 4, rows: 1 }, fps: 8 }, c.blind)
    expect(result.isError).toBeFalsy()
    expect(c.requests[0]).toMatchObject({ kind: 'image', images: false, draw: { grid: { columns: 4, rows: 1 }, fps: 8 } })
    expect(c.saved).toEqual([])
    expect(text(result)).toBe([
      'Image art/hero.png (PNG, 3 B): 128 × 32 pixels, cutout transparency (every pixel fully transparent or opaque), 24 colors.',
      'Animations (1); pass one\'s name as animation to see its frames:',
      '- run: Godot animation in scenes/hero.tscn, 4 frames of 32 × 32 at 8 fps (0.50 s), loops',
      'Your model does not accept images, so no picture was drawn.',
    ].join('\n'))
  })

  it('fails with a clear message when no window answers', async () => {
    const c = await composed()
    const result = await callTool(c, 'asset_view', { path: 'art/hero.png' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(NO_WINDOW_MESSAGE)
  })

  it('refuses paths outside the project, missing files, folders, unread formats, and Blender files without an export', async () => {
    const c = await composed()
    c.openWindow({ details: HERO, images: [] })
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ path: '../secret.png' }, 'is not a file inside the project folder'],
      [{ path: 'art/missing.png' }, 'No file at art/missing.png'],
      [{ path: 'notes.txt' }, 'notes.txt is not an asset the viewer reads'],
      [{ path: 'art/hero.png', frames: 40 }, 'frames must be an integer from 1 to 16.'],
      [{ path: 'art/hero.png', size: 9000 }, 'size must be an integer from 256 to 1568.'],
      [{ path: 'models/knight.glb', time: 1 }, 'time needs animation'],
      [{ path: 'art/hero.png', grid: { columns: 4, rows: 1, count: 9 } }, 'grid.count must be an integer from 1 to 4.'],
    ]
    for (const [args, message] of cases) {
      const result = await callTool(c, 'asset_view', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toContain(message)
    }
    const folder = await callTool(c, 'asset_view', { path: 'art.png' })
    expect(folder.isError).toBe(true)
    expect(c.requests).toEqual([])
  })

  it('refuses a malformed window answer', async () => {
    const c = await composed()
    c.openWindow({ details: { ...KNIGHT, bones: [{ name: 'Child', parent: 1 }, { name: 'Root' }] }, images: [] })
    const result = await callTool(c, 'asset_view', { path: 'models/knight.glb' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('bone listed before its parent')
  })

  it('tells the window the size of the file it draws', async () => {
    const c = await composed()
    c.openWindow({ details: KNIGHT, images: [] })
    await callTool(c, 'asset_view', { path: 'models/knight.blend' })
    await callTool(c, 'asset_view', { path: 'art/ui/icon.svg' })
    expect(c.requests.map(request => [request.path, request.bytes])).toEqual([['models/knight.glb', 3], ['art/ui/icon.svg', 6]])
  })

  it('validates its configuration', () => {
    expect(Config({})).toEqual({
      renderTimeoutMs: 120_000, imageEdge: 1024, maxImageEdge: 1568, maxImagePixels: 1_150_000,
      maxPreviewBytes: 256 * 1024 * 1024, maxFolders: 2000, maxAssets: 5000,
    })
    expect(() => Config({ imageEdge: 10 })).toThrow()
  })
})

describe('asset_view for teammates, subagents, and connected agents', () => {
  it('names the file to the window from the Session\'s project folder when the agent works in a folder below it', async () => {
    const c = await composed()
    c.openWindow({ details: HERO, images: [] })
    // A teammate started in art/ keeps the lead's project folder in its Session header, which the window reads from.
    const artist = await fakeAgent(c.ctx, 'artist', 'vision', c.work)
    const ensure = c.ctx.workingDirectory.ensure.bind(c.ctx.workingDirectory)
    vi.spyOn(c.ctx.workingDirectory, 'ensure').mockImplementation(async (agent, signal) => (agent === artist ? join(c.work, 'art') : await ensure(agent, signal)))
    const result = await callTool(c, 'asset_view', { path: 'hero.png', show: true }, artist)
    expect(result.isError).toBeFalsy()
    expect(c.requests[0]).toMatchObject({ path: 'art/hero.png', bytes: 3 })
    expect(c.requests[0]?.agent).toBe(artist)
    expect(text(result)).toContain('Image hero.png (PNG')
    expect(c.reveals).toEqual([{ sessionId: artist.id, path: 'art/hero.png' }])
  })

  it('names a file outside the Session\'s project folder by its absolute path', () => {
    expect(windowPath('/games/knight', '/games/knight/art/hero.png')).toBe('art/hero.png')
    expect(windowPath('/games/knight/art', '/games/knight/models/knight.glb')).toBe('/games/knight/models/knight.glb')
    expect(windowPath(undefined, '/games/knight/art/hero.png')).toBe('/games/knight/art/hero.png')
    // The window's paths come back from the agent's own folder, or absolute outside it.
    expect(callerPath('/games/knight', '/games/knight/art', 'art/hero.json')).toBe('hero.json')
    expect(callerPath('/games/knight', '/games/knight/art', 'scenes/hero.tres')).toBe('/games/knight/scenes/hero.tres')
    expect(callerPath('/games/knight', '/games/knight', '/elsewhere/hero.tres')).toBe('/elsewhere/hero.tres')
  })

  it('gives a teammate in a folder below the project the window\'s paths and failures from its own folder', async () => {
    const c = await composed()
    const artist = await fakeAgent(c.ctx, 'artist', 'vision', c.work)
    const ensure = c.ctx.workingDirectory.ensure.bind(c.ctx.workingDirectory)
    vi.spyOn(c.ctx.workingDirectory, 'ensure').mockImplementation(async (agent, signal) => (agent === artist ? join(c.work, 'art') : await ensure(agent, signal)))
    c.openWindow((request) => {
      if (request.draw.animation === 'jump') throw new HarnessError(`${request.path} has no 2D animation named "jump".`, 'ASSET_ANIMATION')
      return {
        details: {
          ...HERO,
          animations: [
            { name: 'run', source: 'godot', definedIn: 'scenes/hero.tres', frames: 4, fps: 8, seconds: 0.5, loop: true },
            { name: 'idle', source: 'sheet', definedIn: 'art/hero.json', frames: 2, fps: 4, seconds: 0.5, loop: true },
          ],
        },
        images: [],
      }
    })
    const viewed = text(await callTool(c, 'asset_view', { path: 'hero.png' }, artist))
    expect(viewed).toContain('Image hero.png (PNG')
    expect(viewed).toContain(`- run: Godot animation in ${join(c.work, 'scenes', 'hero.tres')}`)
    expect(viewed).toContain('- idle: sprite sheet data in hero.json')
    const failed = await callTool(c, 'asset_view', { path: 'hero.png', animation: 'jump' }, artist)
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('hero.png has no 2D animation named "jump".')
    expect(text(failed)).not.toContain('art/hero.png')
  })

  it('counts the buffers and images a glTF model names in the size it sends the window', async () => {
    const c = await composed()
    c.openWindow({ details: KNIGHT, images: [] })
    await mkdir(join(c.work, 'models', 'textures'), { recursive: true })
    await writeFile(join(c.work, 'models', 'tree.bin'), Buffer.alloc(1000))
    await writeFile(join(c.work, 'models', 'textures', 'bark color.png'), Buffer.alloc(500))
    const gltf = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'tree.bin', byteLength: 1000 }, { uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }],
      // An absolute name loads by its file name from the model's folder, as the window loads it.
      images: [{ uri: 'textures/bark%20color.png' }, { uri: '/Users/artist/old/tree.bin' }, { uri: 'textures/missing.png' }],
    })
    await writeFile(join(c.work, 'models', 'tree.gltf'), gltf)
    await callTool(c, 'asset_view', { path: 'models/tree.gltf' })
    expect(c.requests[0]?.bytes).toBe(Buffer.byteLength(gltf) + 1000 + 500)
    // Files whose JSON cannot be read add nothing.
    await writeFile(join(c.work, 'models', 'broken.gltf'), '{ not json')
    expect(await gltfFilesBytes(join(c.work, 'models', 'broken.gltf'), 10)).toBe(0)
  })

  it('opens what a teammate shows in its lead\'s Session, and what a child without a live lead shows in its own', async () => {
    const c = await composed()
    c.openWindow({ details: KNIGHT, images: [] })
    const teammate = await fakeAgent(c.ctx, 'teammate', 'vision', c.work)
    const orphan = await fakeAgent(c.ctx, 'orphan', 'vision', c.work)
    c.ctx.provide('subagents', {
      rootOf(agent: Agent): Agent {
        if (agent === orphan) throw new SubagentError('agent has no active runtime owner', 'UNAUTHORIZED')
        return agent === teammate ? c.agent : agent
      },
    } as never)
    expect((await callTool(c, 'asset_view', { path: 'models/knight.glb', animation: 'Walk', show: true }, teammate)).isError).toBeFalsy()
    expect((await callTool(c, 'asset_view', { path: 'models/knight.glb', show: true }, orphan)).isError).toBeFalsy()
    // Each draws in its own Session; each shows where the user watches.
    expect(c.requests.map(request => request.agent?.id)).toEqual([teammate.id, orphan.id])
    expect(c.reveals).toEqual([
      { sessionId: c.agent.id, path: 'models/knight.glb', animation: 'Walk' },
      { sessionId: orphan.id, path: 'models/knight.glb' },
    ])
  })

  it('fails at once while no window is connected', async () => {
    const c = await composed()
    c.openWindow({ details: HERO, images: [] })
    let connected = false
    c.ctx.provide('typertGateway', { hasLiveClient: () => connected } as never)
    const refused = await callTool(c, 'asset_view', { path: 'art/hero.png' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain(NO_WINDOW_MESSAGE)
    expect(c.requests).toEqual([])
    connected = true
    expect((await callTool(c, 'asset_view', { path: 'art/hero.png' })).isError).toBeFalsy()
  })

  it('sends calls of several agents to the window together, and gives each call its own answer', async () => {
    const c = await composed()
    const all = Promise.withResolvers<undefined>()
    // The window answers only once all three requests are open, each with the size of its own image.
    c.openWindow(async (request) => {
      if (c.requests.length === 3) all.resolve(undefined)
      await all.promise
      return { details: { ...HERO, width: request.path === 'art/hero.png' ? 128 : 64 }, images: [] }
    })
    const teammate = await fakeAgent(c.ctx, 'teammate', 'vision', c.work)
    const results = await Promise.all([
      callTool(c, 'asset_view', { path: 'art/hero.png' }),
      callTool(c, 'asset_view', { path: 'art/hero_walk_01.png' }, teammate),
      callTool(c, 'asset_view', { path: 'art/hero.png' }, c.blind),
    ])
    for (const result of results) expect(result.isError, text(result)).toBeFalsy()
    expect(results.map(text)).toEqual([
      expect.stringContaining('Image art/hero.png (PNG, 3 B): 128 × 32 pixels'),
      expect.stringContaining('Image art/hero_walk_01.png (PNG, 3 B): 64 × 32 pixels'),
      expect.stringContaining('Image art/hero.png (PNG, 3 B): 128 × 32 pixels'),
    ])
    expect(new Set(c.requests.map(request => request.agent?.id))).toEqual(new Set([c.agent.id, teammate.id, c.blind.id]))
  })
})
