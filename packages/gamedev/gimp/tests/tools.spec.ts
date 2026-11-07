/** GIMP tool argument bounds, worker request mapping, reply validation, and result text. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_EDGE, WorkerReplyError } from '@deepseek-ai/dsh-app-mcp'
import type { AppToolDependencies, JsonObject } from '@deepseek-ai/dsh-app-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { COORDINATE_MAX, IMAGE_MAX_SIDE, SPRITE_SHEET_MAX_FRAMES, gimpTools } from '../src/tools.ts'

type Reply = JsonValue | ((params: JsonObject) => JsonValue | Promise<JsonValue>)

interface Call { method: string; params: JsonObject; options: { readonly signal: AbortSignal; readonly timeoutMs?: number } }

let dataRoot = ''
beforeAll(async () => { dataRoot = await mkdtemp(join(tmpdir(), 'dsh-gimp-tools-')) })
afterAll(async () => { await rm(dataRoot, { recursive: true, force: true }) })

const signal = new AbortController().signal
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function harness(replies: Record<string, Reply>, notes: string[] = []) {
  const calls: Call[] = []
  const dependencies: AppToolDependencies = {
    async call(method, params, options) {
      calls.push({ method, params, options })
      const reply = replies[method]
      if (reply === undefined) throw new Error(`no reply for ${method}`)
      return typeof reply === 'function' ? await reply(params) : reply
    },
    takeNotes: () => notes.splice(0),
    dataRoot,
    requestTimeoutMs: 600_000,
    maxTimeoutMs: 900_000,
  }
  const tools = new Map(gimpTools(dependencies).map(tool => [tool.name, tool]))
  const tool = (name: string) => {
    const found = tools.get(name)
    if (found === undefined) throw new Error(`missing tool ${name}`)
    return found
  }
  return {
    calls,
    schema: (name: string) => z.object(tool(name).input),
    run: async (name: string, args: Record<string, unknown> = {}) => await tool(name).run(args, signal),
  }
}

function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error(`expected a string parameter, got ${JSON.stringify(value)}`)
  return value
}

async function writeImage(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, PNG)
}

const size = (id = 1, width = 64, height = 32): JsonObject => ({ id, width, height })
const layer = (id: number, name: string, kind = 'layer'): JsonObject => ({ id, name, kind, x: 0, y: 0, width: 64, height: 32 })
const info = (id: number, layers: JsonValue[], extra: JsonObject = {}): JsonObject =>
  ({ id, name: '[Untitled]', file: null, width: 64, height: 32, layers, layer_count: layers.length, selection: null, ...extra })

describe('tool set', () => {
  it('lists the GIMP tools in a stable order with titles and descriptions', () => {
    const tools = gimpTools({ call: async () => null, takeNotes: () => [], dataRoot: '/data', requestTimeoutMs: 1000, maxTimeoutMs: 1000 })
    expect(tools.map(tool => tool.name)).toEqual([
      'list_images', 'open_image', 'new_image', 'image_info', 'snapshot', 'export_image', 'save_xcf', 'close_image', 'layer',
      'select', 'transform', 'draw', 'filters', 'filter_info', 'apply_filter', 'pdb_search', 'pdb_describe', 'pdb_run',
      'execute_python', 'make_sprite_sheet', 'make_seamless',
    ])
    for (const tool of tools) {
      expect(tool.title).toMatch(/^[A-Z.]/)
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })
})

describe('argument bounds', () => {
  const { schema } = harness({})

  it('requires absolute paths, positive image ids, and layer ids or names', () => {
    expect(schema('open_image').safeParse({ path: 'art/hero.png' }).success).toBe(false)
    expect(schema('open_image').safeParse({ path: '/art/hero.png' }).success).toBe(true)
    expect(schema('image_info').safeParse({ image: 0 }).success).toBe(false)
    expect(schema('image_info').safeParse({ image: 1.5 }).success).toBe(false)
    expect(schema('layer').safeParse({ image: 1, action: 'delete', layer: 7 }).success).toBe(true)
    expect(schema('layer').safeParse({ image: 1, action: 'delete', layer: 'Shadow' }).success).toBe(true)
    expect(schema('layer').safeParse({ image: 1, action: 'delete', layer: '' }).success).toBe(false)
    expect(schema('layer').safeParse({ image: 1, action: 'explode' }).success).toBe(false)
    expect(schema('save_xcf').safeParse({ image: 1 }).success).toBe(true)
  })

  it('caps image sides, snapshot edges, and coordinates', () => {
    expect(schema('new_image').safeParse({ width: IMAGE_MAX_SIDE, height: 1 }).success).toBe(true)
    expect(schema('new_image').safeParse({ width: IMAGE_MAX_SIDE + 1, height: 1 }).success).toBe(false)
    expect(schema('new_image').safeParse({ width: 0, height: 1 }).success).toBe(false)
    expect(schema('snapshot').safeParse({ image: 1, max_size: AGENT_IMAGE_MAX_EDGE }).success).toBe(true)
    expect(schema('snapshot').safeParse({ image: 1, max_size: AGENT_IMAGE_MAX_EDGE + 1 }).success).toBe(false)
    expect(schema('snapshot').safeParse({ image: 1, max_size: 15 }).success).toBe(false)
    expect(schema('transform').safeParse({ image: 1, action: 'scale_image', width: IMAGE_MAX_SIDE + 1 }).success).toBe(false)
    expect(schema('transform').safeParse({ image: 1, action: 'crop', x: -COORDINATE_MAX, width: 4, height: 4 }).success).toBe(true)
    expect(schema('transform').safeParse({ image: 1, action: 'crop', x: 0.5, width: 4, height: 4 }).success).toBe(false)
    expect(schema('transform').safeParse({ image: 1, action: 'rotate', angle: 361 }).success).toBe(false)
    expect(schema('select').safeParse({ image: 1, mode: 'rect', x: 1.5, y: COORDINATE_MAX, width: 2.5, height: 1 }).success).toBe(true)
    expect(schema('select').safeParse({ image: 1, mode: 'rect', x: COORDINATE_MAX + 1, width: 1, height: 1 }).success).toBe(false)
    expect(schema('select').safeParse({ image: 1, mode: 'color', color: '#ff0000', threshold: 256 }).success).toBe(false)
    expect(schema('export_image').safeParse({ image: 1, path: '/a.jpg', quality: 101 }).success).toBe(false)
    expect(schema('layer').safeParse({ image: 1, action: 'set', layer: 2, opacity: 100.5 }).success).toBe(false)
  })

  it('bounds text, code, timeouts, filter properties, and procedure arguments', () => {
    expect(schema('draw').safeParse({ image: 1, action: 'text', text: 'x'.repeat(10_001) }).success).toBe(false)
    expect(schema('draw').safeParse({ image: 1, action: 'text', text: 'Score', size: 0.5 }).success).toBe(false)
    expect(schema('execute_python').safeParse({ code: '' }).success).toBe(false)
    expect(schema('execute_python').safeParse({ code: 'x'.repeat(200_001) }).success).toBe(false)
    expect(schema('execute_python').safeParse({ code: 'x = 1', timeout_seconds: 900 }).success).toBe(true)
    expect(schema('execute_python').safeParse({ code: 'x = 1', timeout_seconds: 901 }).success).toBe(false)
    const properties = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${String(index)}`, index]))
    expect(schema('apply_filter').safeParse({ image: 1, operation: 'gegl:pixelize', properties }).success).toBe(false)
    expect(schema('apply_filter').safeParse({ image: 1, operation: 'gegl:pixelize', properties: { norm: 'diamond', 'size-x': 8, list: [1, 'a', true], none: null } }).success).toBe(true)
    expect(schema('apply_filter').safeParse({ image: 1, operation: 'gegl:pixelize', properties: { nested: { a: 1 } } }).success).toBe(false)
    expect(schema('pdb_run').safeParse({ procedure: 'gimp-image-scale', arguments: { image: 1, 'new-width': 64 } }).success).toBe(true)
    expect(schema('pdb_run').safeParse({ procedure: 'gimp-image-scale', arguments: { '': 1 } }).success).toBe(false)
  })

  it('caps sprite sheets', () => {
    const paths = (count: number) => Array.from({ length: count }, (_, index) => `/frames/${String(index)}.png`)
    expect(schema('make_sprite_sheet').safeParse({ paths: paths(SPRITE_SHEET_MAX_FRAMES), columns: 16, output: '/sheet.png' }).success).toBe(true)
    expect(schema('make_sprite_sheet').safeParse({ paths: paths(SPRITE_SHEET_MAX_FRAMES + 1), columns: 16, output: '/sheet.png' }).success).toBe(false)
    expect(schema('make_sprite_sheet').safeParse({ paths: [], columns: 1, output: '/sheet.png' }).success).toBe(false)
    expect(schema('make_sprite_sheet').safeParse({ paths: ['frame.png'], columns: 1, output: '/sheet.png' }).success).toBe(false)
    expect(schema('make_sprite_sheet').safeParse({ paths: paths(1), columns: 1, output: '/sheet.png', padding: 1025 }).success).toBe(false)
  })
})

describe('image tools', () => {
  it('lists images and describes one as JSON, prepending pending setup notes once', async () => {
    const listing = { images: [{ id: 1, name: 'hero.png' }], count: 1 }
    const notes = ['GIMP 3.2.8 started (Python 3.14.10) with no images open.']
    const { calls, run } = harness({ list_images: listing, image_info: info(1, []) }, notes)
    await expect(run('list_images')).resolves.toEqual({ text: `${notes[0]!}\n\n${JSON.stringify(listing)}` })
    await expect(run('image_info', { image: 1 })).resolves.toEqual({ text: JSON.stringify(info(1, [])) })
    expect(calls).toEqual([
      { method: 'list_images', params: {}, options: { signal } },
      { method: 'image_info', params: { image: 1 }, options: { signal } },
    ])
  })

  it('opens images and points out other copies of the same file', async () => {
    const opened = info(3, [layer(4, 'Background')])
    const twice = info(5, [layer(6, 'Background')], { also_open_as: [3] })
    const { calls, run } = harness({ open_image: params => params.path === '/art/a.png' ? opened : twice })
    await expect(run('open_image', { path: '/art/a.png' })).resolves.toEqual({ text: `Opened /art/a.png as image 3.\n${JSON.stringify(opened)}` })
    await expect(run('open_image', { path: '/art/b.png' }))
      .resolves.toEqual({ text: `Opened /art/b.png as image 5. The file is also open as image 3.\n${JSON.stringify(twice)}` })
    expect(calls.map(call => call.params)).toEqual([{ path: '/art/a.png' }, { path: '/art/b.png' }])
  })

  it('creates images with only the given arguments and names the first layer', async () => {
    const { calls, run } = harness({
      new_image: params => params.fill === undefined ? info(1, [layer(2, 'Background')]) : info(3, []),
    })
    await expect(run('new_image', { width: 64, height: 32 })).resolves.toEqual({ text: 'Created image 1, 64x32 with layer "Background" (id 2), filled transparent.' })
    await expect(run('new_image', { width: 64, height: 32, fill: '#336699', name: 'tile', extra: undefined }))
      .resolves.toEqual({ text: 'Created image 3, 64x32, filled #336699.' })
    expect(calls.map(call => call.params)).toEqual([{ width: 64, height: 32 }, { width: 64, height: 32, fill: '#336699', name: 'tile' }])
  })

  it('rejects malformed replies', async () => {
    const { run } = harness({ new_image: { id: 'one' } })
    const failure = run('new_image', { width: 1, height: 1 })
    await expect(failure).rejects.toBeInstanceOf(WorkerReplyError)
    await expect(failure).rejects.toThrow(/^The GIMP worker sent an unexpected new_image reply[\s\S]*id/)
  })

  it('exports, saves, and closes images with readable sizes', async () => {
    const { calls, run } = harness({
      export_image: params => params.path === '/a/hero.png'
        ? { path: '/a/hero.png', bytes: 512, format: 'png', width: 64, height: 32, flattened: false }
        : { path: '/a/hero.jpg', bytes: 2048, format: 'jpeg', width: 64, height: 32, flattened: true },
      save_xcf: params => ({ path: typeof params.path === 'string' ? params.path : '/a/hero.xcf', bytes: 5 * 1024 * 1024, image: 1 }),
      close_image: params => ({ closed: params.image ?? 0, discarded_unsaved_changes: params.image === 2 }),
    })
    await expect(run('export_image', { image: 1, path: '/a/hero.png' })).resolves.toEqual({ text: 'Exported image 1 to /a/hero.png (PNG, 64x32, 512 bytes).' })
    await expect(run('export_image', { image: 1, path: '/a/hero.jpg', quality: 85 }))
      .resolves.toEqual({ text: 'Exported image 1 to /a/hero.jpg (JPEG, 64x32, 2.0 KiB; transparent areas became white).' })
    await expect(run('save_xcf', { image: 1 })).resolves.toEqual({ text: 'Saved image 1 with all layers to /a/hero.xcf (5.0 MiB).' })
    await expect(run('save_xcf', { image: 1, path: '/a/src/hero.xcf' })).resolves.toEqual({ text: 'Saved image 1 with all layers to /a/src/hero.xcf (5.0 MiB).' })
    await expect(run('close_image', { image: 1 })).resolves.toEqual({ text: 'Closed image 1.' })
    await expect(run('close_image', { image: 2 })).resolves.toEqual({ text: 'Closed image 2. Its unsaved changes were discarded.' })
    expect(calls.map(call => call.params)).toEqual([
      { image: 1, path: '/a/hero.png' }, { image: 1, path: '/a/hero.jpg', quality: 85 }, { image: 1 }, { image: 1, path: '/a/src/hero.xcf' },
      { image: 1 }, { image: 2 },
    ])
  })
})

describe('snapshot', () => {
  it('renders into a private file, returns its bytes, and deletes it', async () => {
    let stem = ''
    const { calls, run } = harness({
      snapshot: async (params) => {
        stem = text(params.stem)
        await writeImage(`${stem}.png`)
        return { path: `${stem}.png`, mime_type: 'image/png', width: 256, height: 128, image: size(1, 16, 8), scale: 16, transparency: 'checkerboard' }
      },
    }, ['first note'])
    const result = await run('snapshot', { image: 1 })
    expect(result).toEqual({
      text: 'first note\n\nImage 1 (16x8) shown at 256x128 (enlarged 16x without smoothing). Transparent areas show as a gray checkerboard.',
      images: [{ data: expect.any(Uint8Array) as Uint8Array, mimeType: 'image/png' }],
    })
    expect([...result.images![0]!.data!]).toEqual([...PNG])
    expect(stem).toMatch(new RegExp(`^${join(dataRoot, 'snapshots')}/[0-9a-f-]{36}$`))
    expect(calls[0]!.params).toEqual({ image: 1, max_size: 1024, stem, max_bytes: AGENT_IMAGE_MAX_BYTES })
    expect(existsSync(`${stem}.png`)).toBe(false)
  })

  it('shows reduced JPEG snapshots and same-size ones', async () => {
    const shown: string[] = []
    const { calls, run } = harness({
      snapshot: async (params) => {
        const path = `${text(params.stem)}.jpg`
        shown.push(path)
        await writeImage(path)
        return params.max_size === 512
          ? { path, mime_type: 'image/jpeg', width: 512, height: 256, image: size(2, 4096, 2048), scale: 0.125, transparency: 'none' }
          : { path, mime_type: 'image/jpeg', width: 300, height: 300, image: size(3, 300, 300), scale: 1, transparency: 'none' }
      },
    })
    const reduced = await run('snapshot', { image: 2, max_size: 512 })
    expect(reduced.text).toBe('Image 2 (4096x2048) shown at 512x256 (reduced).')
    expect(reduced.images).toEqual([{ data: expect.any(Uint8Array) as Uint8Array, mimeType: 'image/jpeg' }])
    await expect(run('snapshot', { image: 3, max_size: 300 })).resolves.toMatchObject({ text: 'Image 3 (300x300) shown at 300x300.' })
    expect(calls.map(call => call.params.max_size)).toEqual([512, 300])
    expect(shown.map(path => existsSync(path))).toEqual([false, false])
  })

  it('refuses a file it did not request and still cleans up', async () => {
    const stray = join(dataRoot, 'stray.png')
    await writeImage(stray)
    let stem = ''
    const { run } = harness({
      snapshot: async (params) => {
        stem = text(params.stem)
        await writeImage(`${stem}.png`)
        return { path: stray, mime_type: 'image/png', width: 8, height: 8, image: size(), scale: 1, transparency: 'none' }
      },
    })
    await expect(run('snapshot', { image: 1 })).rejects.toThrow(`returned a snapshot outside the requested files: ${stray}`)
    expect(existsSync(`${stem}.png`)).toBe(false)
    expect(existsSync(stray)).toBe(true)
  })
})

describe('editing tools', () => {
  it('reports each layer action with the new layer tree', async () => {
    const tree = [layer(3, 'Shadow'), layer(2, 'Background')]
    const { calls, run } = harness({
      layer: params => ({
        image: size(),
        layer: params.action === 'delete' ? null : params.action === 'add' ? layer(3, 'Shadow') : layer(9, 'Glow', 'text'),
        layers: tree,
        layer_count: params.action === 'flatten' ? 600 : 2,
        ...params.action === 'flatten' ? { layers_omitted: 100 } : {},
      }),
    })
    await expect(run('layer', { image: 1, action: 'add', name: 'Shadow', opacity: 50, mode: 'multiply', offset_x: -4, position: 0 }))
      .resolves.toEqual({ text: `Added layer "Shadow" (id 3). Image 1 has 2 layers:\n${JSON.stringify(tree)}` })
    await expect(run('layer', { image: 1, action: 'delete', layer: 'Shadow' }))
      .resolves.toEqual({ text: `Deleted the layer. Image 1 has 2 layers:\n${JSON.stringify(tree)}` })
    await expect(run('layer', { image: 1, action: 'rename', layer: 9, name: 'Glow' }))
      .resolves.toEqual({ text: `Renamed the layer to text layer "Glow" (id 9). Image 1 has 2 layers:\n${JSON.stringify(tree)}` })
    const flattened = /^Flattened the image into text layer "Glow" \(id 9\)\. Image 1 has 600 layers \(100 more not shown\):\n/
    await expect(run('layer', { image: 1, action: 'flatten' })).resolves.toMatchObject({ text: expect.stringMatching(flattened) as string })
    expect(calls.map(call => call.params)).toEqual([
      { image: 1, action: 'add', name: 'Shadow', opacity: 50, mode: 'multiply', offset_x: -4, position: 0 },
      { image: 1, action: 'delete', layer: 'Shadow' },
      { image: 1, action: 'rename', layer: 9, name: 'Glow' },
      { image: 1, action: 'flatten' },
    ])
  })

  it('describes the selection or its absence', async () => {
    const { calls, run } = harness({
      select: params => ({ image: size(4), selection: params.mode === 'none' ? null : { x: 10, y: 20, width: 30, height: 40 } }),
    })
    await expect(run('select', { image: 4, mode: 'rect', x: 10, y: 20, width: 30, height: 40, operation: 'add' }))
      .resolves.toEqual({ text: 'The selection of image 4 spans 30x40 at 10,20 (bounding box).' })
    await expect(run('select', { image: 4, mode: 'none' })).resolves.toEqual({ text: 'Nothing is selected in image 4; edits apply to whole layers.' })
    expect(calls[0]!.params).toEqual({ image: 4, mode: 'rect', x: 10, y: 20, width: 30, height: 40, operation: 'add' })
  })

  it('reports image and layer geometry after transforms', async () => {
    const { calls, run } = harness({
      transform: params => ({
        image: size(1, 128, 64),
        layer: params.layer === undefined ? null : { ...layer(5, 'Hero'), x: -3, y: 4, width: 40, height: 50 },
      }),
    })
    await expect(run('transform', { image: 1, action: 'scale_image', width: 128, interpolation: 'none' }))
      .resolves.toEqual({ text: 'Scaled the image; image 1 is now 128x64.' })
    await expect(run('transform', { image: 1, action: 'rotate', layer: 'Hero', angle: 30 }))
      .resolves.toEqual({ text: 'Rotated layer "Hero" (id 5); it is now 40x50 at -3,4 in image 1 (128x64).' })
    expect(calls.map(call => call.params)).toEqual([
      { image: 1, action: 'scale_image', width: 128, interpolation: 'none' },
      { image: 1, action: 'rotate', layer: 'Hero', angle: 30 },
    ])
  })

  it('reports drawing within the selection and new text layers', async () => {
    const { calls, run } = harness({
      draw: params => params.action === 'text'
        ? { image: size(), layer: { ...layer(7, 'Score', 'text'), x: 4, y: 6, width: 90, height: 20 }, selection: null }
        : { image: size(), layer: layer(2, 'Background'), selection: params.action === 'fill' ? { x: 0, y: 0, width: 8, height: 8 } : null },
    })
    await expect(run('draw', { image: 1, action: 'fill', color: '#ff000080' }))
      .resolves.toEqual({ text: 'Filled layer "Background" (id 2) of image 1 within the selection (8x8 at 0,0).' })
    await expect(run('draw', { image: 1, action: 'gradient', layer: 2, color: 'red', color2: '#0000ff00', x: 0, y: 0, x2: 64, y2: 0 }))
      .resolves.toEqual({ text: 'Painted a gradient on layer "Background" (id 2) of image 1.' })
    await expect(run('draw', { image: 1, action: 'text', text: 'Score', font: 'Serif', size: 18, x: 4, y: 6 }))
      .resolves.toEqual({ text: 'Added text layer "Score" (id 7) of image 1, 90x20 at 4,6.' })
    expect(calls.map(call => call.params)).toEqual([
      { image: 1, action: 'fill', color: '#ff000080' },
      { image: 1, action: 'gradient', layer: 2, color: 'red', color2: '#0000ff00', x: 0, y: 0, x2: 64, y2: 0 },
      { image: 1, action: 'text', text: 'Score', font: 'Serif', size: 18, x: 4, y: 6 },
    ])
  })

  it('makes textures seamless', async () => {
    const { calls, run } = harness({ make_seamless: { image: size(6), layer: layer(8, 'Tile') } })
    await expect(run('make_seamless', { image: 6 })).resolves.toEqual({ text: 'Made layer "Tile" (id 8) of image 6 tile seamlessly.' })
    expect(calls[0]!.params).toEqual({ image: 6 })
  })
})

describe('filters and procedures', () => {
  it('lists filters with and without a query and notes omitted ones', async () => {
    const { calls, run } = harness({
      filters: params => params.query === 'blur'
        ? { filters: [{ name: 'gegl:gaussian-blur', title: 'Gaussian Blur', categories: 'blur' }], count: 201, omitted: 200 }
        : { filters: [], count: 0 },
    })
    await expect(run('filters', { query: 'blur' }))
      .resolves.toEqual({ text: '201 filter operations match "blur".\ngegl:gaussian-blur: Gaussian Blur (blur)\n(200 more not shown; narrow the query.)' })
    await expect(run('filters')).resolves.toEqual({ text: '0 filter operations.' })
    await expect(run('filters', { query: '' })).resolves.toEqual({ text: '0 filter operations.' })
    expect(calls.map(call => call.params)).toEqual([{ query: 'blur' }, {}, { query: '' }])
  })

  it('describes filters and procedures as JSON', async () => {
    const filter = { name: 'gegl:pixelize', properties: [{ name: 'size-x', type: 'integer' }] }
    const procedure = { name: 'gimp-image-scale', arguments: [] }
    const { calls, run } = harness({ filter_info: filter, pdb_describe: procedure })
    await expect(run('filter_info', { operation: 'gegl:pixelize' })).resolves.toEqual({ text: JSON.stringify(filter) })
    await expect(run('pdb_describe', { procedure: 'gimp-image-scale' })).resolves.toEqual({ text: JSON.stringify(procedure) })
    expect(calls.map(call => call.params)).toEqual([{ operation: 'gegl:pixelize' }, { procedure: 'gimp-image-scale' }])
  })

  it('applies filters with their properties, within the selection', async () => {
    const { calls, run } = harness({
      apply_filter: params => ({
        image: size(), layer: layer(2, 'Background'), operation: params.operation ?? '',
        properties: params.properties ?? {}, selection: params.properties === undefined ? { x: 1, y: 2, width: 3, height: 4 } : null,
      }),
    })
    await expect(run('apply_filter', { image: 1, operation: 'gegl:invert-gamma' }))
      .resolves.toEqual({ text: 'Applied gegl:invert-gamma to layer "Background" (id 2) of image 1 within the selection (3x4 at 1,2).' })
    await expect(run('apply_filter', { image: 1, layer: 'Background', operation: 'gegl:gaussian-blur', properties: { 'std-dev-x': 3 } }))
      .resolves.toEqual({ text: 'Applied gegl:gaussian-blur with {"std-dev-x":3} to layer "Background" (id 2) of image 1.' })
    expect(calls.map(call => call.params)).toEqual([
      { image: 1, operation: 'gegl:invert-gamma' },
      { image: 1, layer: 'Background', operation: 'gegl:gaussian-blur', properties: { 'std-dev-x': 3 } },
    ])
  })

  it('searches procedures and points image effects at the filters tool', async () => {
    const { run } = harness({
      pdb_search: params => params.query === 'scale'
        ? { procedures: [{ name: 'gimp-image-scale', summary: 'Scale the image.' }], count: 1 }
        : params.query === 'gimp'
          ? { procedures: [{ name: 'gimp-image-new', summary: 'New image.' }], count: 900, omitted: 700 }
          : { procedures: [], count: 0 },
    })
    await expect(run('pdb_search', { query: 'scale' })).resolves.toEqual({ text: '1 procedures match "scale".\ngimp-image-scale: Scale the image.' })
    await expect(run('pdb_search', { query: 'gimp' }))
      .resolves.toEqual({ text: '900 procedures match "gimp".\ngimp-image-new: New image.\n(700 more not shown; narrow the query.)' })
    await expect(run('pdb_search', { query: 'blur' })).resolves.toEqual({ text: 'No procedures match "blur". For image effects, try the filters tool.' })
  })

  it('runs procedures and reports their return values', async () => {
    const { calls, run } = harness({
      pdb_run: params => params.procedure === 'gimp-image-scale'
        ? { procedure: 'gimp-image-scale', status: 'success', values: {} }
        : params.procedure === 'gimp-image-get-layers'
          ? { procedure: 'gimp-image-get-layers', status: 'success', values: { layers: [{ item: 2, name: 'Background' }] } }
          : { procedure: 'gimp-plug-ins-query', status: 'success', values: '[values is 30000 characters of JSON; showing a clipped copy] {}' },
    })
    await expect(run('pdb_run', { procedure: 'gimp-image-scale', arguments: { image: 1, 'new-width': 32, 'new-height': 16 } }))
      .resolves.toEqual({ text: 'Ran gimp-image-scale.' })
    await expect(run('pdb_run', { procedure: 'gimp-image-get-layers', arguments: { image: 1 } }))
      .resolves.toEqual({ text: 'Ran gimp-image-get-layers. Return values: {"layers":[{"item":2,"name":"Background"}]}' })
    await expect(run('pdb_run', { procedure: 'gimp-plug-ins-query' }))
      .resolves.toEqual({ text: 'Ran gimp-plug-ins-query. Return values: "[values is 30000 characters of JSON; showing a clipped copy] {}"' })
    expect(calls.map(call => call.params)).toEqual([
      { procedure: 'gimp-image-scale', arguments: { image: 1, 'new-width': 32, 'new-height': 16 } },
      { procedure: 'gimp-image-get-layers', arguments: { image: 1 } },
      { procedure: 'gimp-plug-ins-query' },
    ])
  })
})

describe('execute_python', () => {
  it('sends the code with the default or requested timeout and formats result and output', async () => {
    const { calls, run } = harness({ execute_python: { result: { layers: 2 }, output: 'hello\n', seconds: 0.01 } })
    await expect(run('execute_python', { code: 'print("hello")' })).resolves.toEqual({ text: 'result: {"layers":2}\n\noutput:\nhello\n', isError: false })
    await run('execute_python', { code: 'x = 1', timeout_seconds: 5 })
    expect(calls.map(call => [call.params, call.options])).toEqual([
      [{ code: 'print("hello")' }, { signal }],
      [{ code: 'x = 1' }, { signal, timeoutMs: 5000 }],
    ])
  })

  it('fails with the traceback first when the code raised', async () => {
    const traceback = 'Traceback (most recent call last):\n  File "<execute_python>", line 1, in <module>\nValueError: boom\n'
    const { run } = harness({ execute_python: { result: null, output: 'partial\n', seconds: 0, error: { type: 'ValueError', message: 'boom', traceback } } })
    await expect(run('execute_python', { code: 'raise ValueError("boom")' })).resolves.toEqual({ text: `${traceback.trim()}\n\noutput:\npartial\n`, isError: true })
    const exit = harness({
      execute_python: { result: null, output: '', seconds: null, error: { type: 'SystemExit', message: 'the code called exit(3); the worker keeps running', traceback: '' } },
    })
    await expect(exit.run('execute_python', { code: 'raise SystemExit(3)' }))
      .resolves.toEqual({ text: 'SystemExit: the code called exit(3); the worker keeps running', isError: true })
  })

  it('says when the code returned nothing and rejects malformed replies', async () => {
    const { run } = harness({ execute_python: { result: null, output: '', seconds: 0 } })
    await expect(run('execute_python', { code: 'pass' })).resolves.toEqual({ text: 'Done. The code assigned no result and printed nothing.', isError: false })
    const broken = harness({ execute_python: { output: 3 } })
    await expect(broken.run('execute_python', { code: 'pass' })).rejects.toThrow(/unexpected execute_python reply[\s\S]*output/)
  })
})

describe('make_sprite_sheet', () => {
  it('reports the sheet layout and every frame rectangle', async () => {
    const frames = [
      { index: 0, file: 'run0.png', x: 2, y: 6, width: 32, height: 32 },
      { index: 1, file: 'run1.png', x: 38, y: 2, width: 32, height: 40 },
    ]
    const { calls, run } = harness({
      make_sprite_sheet: {
        image: 9, output: '/game/art/run.png', bytes: 6292, width: 72, height: 44, columns: 2, rows: 1, frame_width: 32,
        frame_height: 40, cell_width: 36, cell_height: 44, padding: 2, frames: frames.map(frame => ({ ...frame, extra: true })),
      },
    })
    await expect(run('make_sprite_sheet', { paths: ['/f/run0.png', '/f/run1.png'], columns: 2, output: '/game/art/run.png', padding: 2 })).resolves.toEqual({
      text: 'Packed 2 frames into /game/art/run.png (72x44, 6.1 KiB): 2 columns x 1 rows of 36x44 cells (frames up to 32x40, padding 2). '
        + `The sheet is open as image 9.\nFrames: ${JSON.stringify(frames)}`,
    })
    expect(calls[0]!.params).toEqual({ paths: ['/f/run0.png', '/f/run1.png'], columns: 2, output: '/game/art/run.png', padding: 2 })
  })
})
