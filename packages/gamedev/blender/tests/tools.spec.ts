/** Blender tool argument bounds, worker request mapping, reply validation, and result text. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_EDGE, WorkerReplyError } from '@deepseek-ai/dsh-app-mcp'
import type { AppToolDependencies, JsonObject } from '@deepseek-ai/dsh-app-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { OBJECT_LIST_LIMIT, RENDER_MAX_EDGE, blenderTools } from '../src/tools.ts'

type Reply = JsonValue | ((params: JsonObject) => JsonValue | Promise<JsonValue>)

interface Call { method: string; params: JsonObject; options: { readonly signal: AbortSignal; readonly timeoutMs?: number } }

let dataRoot = ''
beforeAll(async () => { dataRoot = await mkdtemp(join(tmpdir(), 'dsh-blender-tools-')) })
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
  const tools = new Map(blenderTools(dependencies).map(tool => [tool.name, tool]))
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

const image = (path: string, mime = 'image/png', width = 768, height = 768): JsonValue => ({ path, mime_type: mime, width, height })

describe('tool set', () => {
  it('lists the Blender tools in a stable order with titles and descriptions', () => {
    const tools = blenderTools({ call: async () => null, takeNotes: () => [], dataRoot: '/data', requestTimeoutMs: 1000, maxTimeoutMs: 1000 })
    expect(tools.map(tool => tool.name)).toEqual([
      'scene_info', 'object_info', 'execute_python', 'new_scene', 'open_blend', 'save_blend', 'import_file', 'export_gltf',
      'export_file', 'render_preview', 'render', 'python_api', 'checkpoint', 'undo',
    ])
    for (const tool of tools) {
      expect(tool.title).toMatch(/^[A-Z.]/)
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })
})

describe('argument bounds', () => {
  const { schema } = harness({})

  it('requires absolute paths and bounded names', () => {
    expect(schema('open_blend').safeParse({ path: 'scene.blend' }).success).toBe(false)
    expect(schema('open_blend').safeParse({ path: '/work/scene.blend' }).success).toBe(true)
    expect(schema('save_blend').safeParse({}).success).toBe(true)
    expect(schema('object_info').safeParse({ name: '' }).success).toBe(false)
    expect(schema('object_info').safeParse({ name: 'x'.repeat(256) }).success).toBe(false)
    expect(schema('python_api').safeParse({ identifier: 'b'.repeat(301) }).success).toBe(false)
  })

  it('caps object lists', () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => `Object ${String(index)}`)
    expect(schema('export_gltf').safeParse({ path: '/a.glb', selection: [] }).success).toBe(false)
    expect(schema('export_gltf').safeParse({ path: '/a.glb', selection: names(OBJECT_LIST_LIMIT) }).success).toBe(true)
    expect(schema('export_gltf').safeParse({ path: '/a.glb', selection: names(OBJECT_LIST_LIMIT + 1) }).success).toBe(false)
    expect(schema('render_preview').safeParse({ objects: names(OBJECT_LIST_LIMIT + 1) }).success).toBe(false)
  })

  it('caps image sizes and render settings', () => {
    expect(schema('render_preview').safeParse({ width: AGENT_IMAGE_MAX_EDGE, height: 64 }).success).toBe(true)
    expect(schema('render_preview').safeParse({ width: AGENT_IMAGE_MAX_EDGE + 1 }).success).toBe(false)
    expect(schema('render_preview').safeParse({ height: 63 }).success).toBe(false)
    expect(schema('render').safeParse({ width: RENDER_MAX_EDGE, height: RENDER_MAX_EDGE, samples: 4096 }).success).toBe(true)
    expect(schema('render').safeParse({ width: RENDER_MAX_EDGE + 1 }).success).toBe(false)
    expect(schema('render').safeParse({ samples: 0 }).success).toBe(false)
    expect(schema('render').safeParse({ engine: 'OPENGL' }).success).toBe(false)
  })

  it('bounds execute_python code and timeouts by the tool call budget', () => {
    expect(schema('execute_python').safeParse({ code: '' }).success).toBe(false)
    expect(schema('execute_python').safeParse({ code: 'x = 1', timeout_seconds: 900 }).success).toBe(true)
    expect(schema('execute_python').safeParse({ code: 'x = 1', timeout_seconds: 901 }).success).toBe(false)
    expect(schema('execute_python').safeParse({ code: 'x = 1', timeout_seconds: 1.5 }).success).toBe(false)
    expect(schema('execute_python').safeParse({ code: 'x = 1', timeout_seconds: 0 }).success).toBe(false)
  })
})

describe('inspection tools', () => {
  it('returns scene and object JSON and prepends pending setup notes once', async () => {
    const scene = { file: null, objects: [{ name: 'Cube', type: 'MESH' }] }
    const notes = ['Blender 5.2.3 started (bpy module, Python 3.13.16) with its default scene.']
    const { calls, run } = harness({ scene_info: scene, object_info: { name: 'Cube' } }, notes)
    await expect(run('scene_info')).resolves.toEqual({ text: `${notes[0]!}\n\n${JSON.stringify(scene)}` })
    await expect(run('object_info', { name: 'Cube' })).resolves.toEqual({ text: '{"name":"Cube"}' })
    expect(calls).toEqual([
      { method: 'scene_info', params: {}, options: { signal } },
      { method: 'object_info', params: { name: 'Cube' }, options: { signal } },
    ])
  })

  it('returns API documentation text', async () => {
    const { calls, run } = harness({ python_api: { identifier: 'bpy.types.Object', kind: 'struct', text: 'bpy.types.Object (subclass of bpy.types.ID)', truncated: false } })
    await expect(run('python_api', { identifier: 'bpy.types.Object' })).resolves.toEqual({ text: 'bpy.types.Object (subclass of bpy.types.ID)' })
    expect(calls[0]!.params).toEqual({ identifier: 'bpy.types.Object' })
  })
})

describe('execute_python', () => {
  it('sends the code with the default or requested timeout and formats result and output', async () => {
    const { calls, run } = harness({ execute_python: { result: { cubes: 2 }, output: 'hello\n', seconds: 0.01 } })
    await expect(run('execute_python', { code: 'print("hello")' })).resolves.toEqual({ text: 'result: {"cubes":2}\n\noutput:\nhello\n', isError: false })
    await run('execute_python', { code: 'x = 1', timeout_seconds: 5 })
    expect(calls.map(call => [call.params, call.options])).toEqual([
      [{ code: 'print("hello")' }, { signal }],
      [{ code: 'x = 1' }, { signal, timeoutMs: 5000 }],
    ])
  })

  it('fails with the traceback first when the code raised', async () => {
    const traceback = 'Traceback (most recent call last):\n  File "<execute_python #1>", line 1\nValueError: boom\n'
    const { run } = harness({ execute_python: { result: null, output: 'partial\n', seconds: 0, error: { type: 'ValueError', message: 'boom', traceback } } })
    await expect(run('execute_python', { code: 'raise ValueError("boom")' }))
      .resolves.toEqual({ text: `${traceback.trim()}\n\noutput:\npartial\n`, isError: true })
    const bare = harness({ execute_python: { result: null, output: '', seconds: null, error: { type: 'SystemExit', message: '3', traceback: '' } } })
    await expect(bare.run('execute_python', { code: 'raise SystemExit(3)' })).resolves.toEqual({ text: 'SystemExit: 3', isError: true })
  })

  it('says when the code returned nothing and rejects malformed replies', async () => {
    const { run } = harness({ execute_python: { result: null, output: '', seconds: 0 } })
    await expect(run('execute_python', { code: 'pass' })).resolves.toEqual({ text: 'Done. The code assigned no result and printed nothing.', isError: false })
    const broken = harness({ execute_python: { output: 3 } })
    const failure = broken.run('execute_python', { code: 'pass' })
    await expect(failure).rejects.toBeInstanceOf(WorkerReplyError)
    await expect(failure).rejects.toThrow(/^The Blender worker sent an unexpected execute_python reply[\s\S]*output/)
  })
})

describe('scene file tools', () => {
  it('starts empty scenes by default, lists default objects, and names the execute_python names that went away', async () => {
    const { calls, run } = harness({
      new_scene: params => ({
        empty: params.empty ?? null, objects: params.empty === true ? [] : ['Cube', 'Light', 'Camera'],
        cleared: params.empty === true ? [] : ['render', 'verts'], cleared_count: params.empty === true ? 0 : 2,
      }),
    })
    await expect(run('new_scene')).resolves.toEqual({ text: 'Started a new empty scene.' })
    await expect(run('new_scene', { empty: false }))
      .resolves.toEqual({ text: 'Started a new scene with Cube, Light, Camera. The names that execute_python had defined are gone: render, verts.' })
    expect(calls.map(call => call.params)).toEqual([{ empty: true }, { empty: false }])
  })

  it('opens .blend files and summarizes long object and name lists', async () => {
    const objects = Array.from({ length: 60 }, (_, index) => `Rock.${String(index).padStart(3, '0')}`)
    const names = Array.from({ length: 60 }, (_, index) => `name${String(index)}`)
    const { run } = harness({
      open_blend: params => params.path === '/w/one.blend'
        ? { file: '/w/one.blend', scene: 'Scene', scenes: ['Scene'], objects: ['Cube'], object_count: 1, cleared: [], cleared_count: 0 }
        : { file: '/w/many.blend', scene: 'Level', scenes: ['Level', 'Menu'], objects, object_count: 400, cleared: names, cleared_count: 70 },
    })
    await expect(run('open_blend', { path: '/w/one.blend' })).resolves.toEqual({ text: 'Opened /w/one.blend. Scene "Scene" has 1 objects: Cube.' })
    const many = await run('open_blend', { path: '/w/many.blend' })
    expect(many.text).toBe(`Opened /w/many.blend. Scene "Level" (scenes: Level, Menu) has 400 objects: ${objects.slice(0, 50).join(', ')} and 350 more.`
      + ` The names that execute_python had defined are gone: ${names.slice(0, 50).join(', ')} and 20 more.`)
  })

  it('rejects a scene reply without the cleared names', async () => {
    const { run } = harness({ new_scene: { empty: true, objects: [] } })
    await expect(run('new_scene')).rejects.toThrow(/^The Blender worker sent an unexpected new_scene reply[\s\S]*cleared/)
  })

  it('saves to the current file or a new path with a readable size', async () => {
    const sizes: Record<string, number> = { '/w/a.blend': 512, '/w/b.blend': 2048, '/w/c.blend': 5 * 1024 * 1024 }
    const { calls, run } = harness({ save_blend: params => ({ path: typeof params.path === 'string' ? params.path : '/w/a.blend', bytes: sizes[typeof params.path === 'string' ? params.path : '/w/a.blend']! }) })
    await expect(run('save_blend')).resolves.toEqual({ text: 'Saved /w/a.blend (512 bytes).' })
    await expect(run('save_blend', { path: '/w/b.blend' })).resolves.toEqual({ text: 'Saved /w/b.blend (2.0 KiB).' })
    await expect(run('save_blend', { path: '/w/c.blend' })).resolves.toEqual({ text: 'Saved /w/c.blend (5.0 MiB).' })
    expect(calls.map(call => call.params)).toEqual([{}, { path: '/w/b.blend' }, { path: '/w/c.blend' }])
  })

  it('imports files and names the new objects', async () => {
    const { run } = harness({ import_file: params => params.path === '/w/empty.obj' ? { objects: [], count: 0, omitted: 0 } : { objects: ['Tree', 'Leaves'], count: 2, omitted: 0 } })
    await expect(run('import_file', { path: '/w/tree.glb' })).resolves.toEqual({ text: 'Imported 2 objects: Tree, Leaves.' })
    await expect(run('import_file', { path: '/w/empty.obj' })).resolves.toEqual({ text: 'Imported /w/empty.obj, which added no objects.' })
  })

  it('saves checkpoints and reports what undo restored', async () => {
    let restored = 2
    const { calls, run } = harness({ checkpoint: { checkpoint: 3 }, undo: () => ({ checkpoint: restored-- }) })
    await expect(run('checkpoint')).resolves.toEqual({ text: 'Saved checkpoint 3; undo returns the scene to this state.' })
    await expect(run('undo')).resolves.toEqual({ text: 'Restored the scene to checkpoint 2. Look objects up by name again; Python references from before the undo may be invalid.' })
    await run('undo')
    await expect(run('undo')).resolves.toMatchObject({ text: expect.stringContaining('Restored the scene to the state it was opened or created in.') as string })
    expect(calls.map(call => call.params)).toEqual([{}, {}, {}, {}])
  })
})

describe('export tools', () => {
  it('exports glTF with explicit defaults chosen from the extension', async () => {
    const { calls, run } = harness({
      export_gltf: params => ({
        path: params.path ?? '', format: params.format ?? 'GLB', bytes: 4096, objects: 3,
        files: params.format === 'GLB' ? [params.path ?? ''] : ['/g/a.gltf', '/g/a.bin'],
      }),
    })
    await expect(run('export_gltf', { path: '/g/a.GLB' })).resolves.toEqual({ text: 'Exported 3 objects to /g/a.GLB (GLB, 4.0 KiB).' })
    await expect(run('export_gltf', { path: '/g/a.gltf', selection: ['Hero'], apply_modifiers: false, animations: false }))
      .resolves.toEqual({ text: 'Exported 3 objects to /g/a.gltf (GLTF_SEPARATE, 4.0 KiB). Files: /g/a.gltf, /g/a.bin.' })
    await run('export_gltf', { path: '/g/b.glb', format: 'GLTF_SEPARATE' })
    expect(calls.map(call => call.params)).toEqual([
      { path: '/g/a.GLB', apply_modifiers: true, animations: true, format: 'GLB' },
      { path: '/g/a.gltf', apply_modifiers: false, animations: false, format: 'GLTF_SEPARATE', selection: ['Hero'] },
      { path: '/g/b.glb', apply_modifiers: true, animations: true, format: 'GLTF_SEPARATE' },
    ])
  })

  it('exports other formats with an optional selection', async () => {
    const { calls, run } = harness({ export_file: params => ({ path: params.path ?? '', format: params.format ?? '', bytes: 100 }) })
    await expect(run('export_file', { path: '/e/a.fbx', format: 'fbx' })).resolves.toEqual({ text: 'Exported FBX to /e/a.fbx (100 bytes).' })
    await run('export_file', { path: '/e/a.stl', format: 'stl', selection: ['Part'] })
    expect(calls.map(call => call.params)).toEqual([{ path: '/e/a.fbx', format: 'fbx' }, { path: '/e/a.stl', format: 'stl', selection: ['Part'] }])
  })
})

describe('render_preview', () => {
  const framing = { center: [0, 0, 0.5], size: [2, 2, 1], ortho_scale: 3.1, min: [-1, -1, 0], max: [1, 1, null] }

  it('renders into a private preview file, returns its bytes, and deletes it', async () => {
    let written = ''
    const { calls, run } = harness({
      render_preview: async (params) => {
        written = text(params.path)
        await writeImage(written)
        return { path: written, width: 640, height: 480, view: 'front', shading: 'material', objects: 2, framing, seconds: 0.2, image: image(written, 'image/png', 640, 480) }
      },
    }, ['first note'])
    const result = await run('render_preview', { width: 640, height: 480, view: 'front', shading: 'material', objects: ['Crate'] })
    expect(result).toEqual({
      text: 'first note\n\nRendered a 640x480 material preview (front view) of 2 objects. World bounds (-1, -1, 0) to (1, 1, n/a), size (2, 2, 1).',
      images: [{ data: expect.any(Uint8Array) as Uint8Array, mimeType: 'image/png' }],
    })
    expect([...result.images![0]!.data!]).toEqual([...PNG])
    expect(written).toMatch(new RegExp(`^${join(dataRoot, 'previews')}/[0-9a-f-]{36}\\.png$`))
    expect(calls[0]!.params).toEqual({
      path: written, width: 640, height: 480, view: 'front', shading: 'material', objects: ['Crate'],
      agent_image: { stem: written.replace(/\.png$/, '-agent'), max_edge: AGENT_IMAGE_MAX_EDGE, max_bytes: AGENT_IMAGE_MAX_BYTES },
    })
    expect(existsSync(written)).toBe(false)
  })

  it('uses defaults, shows a downscaled agent copy, and appends the worker note', async () => {
    const paths: string[] = []
    const { calls, run } = harness({
      render_preview: async (params) => {
        const stem = (params.agent_image as { stem: string }).stem
        paths.push(text(params.path), `${stem}.jpg`)
        await writeImage(text(params.path))
        await writeImage(`${stem}.jpg`)
        return { path: params.path ?? '', width: 768, height: 768, view: 'iso', shading: 'solid', objects: 0, framing, seconds: 0.1, image: image(`${stem}.jpg`, 'image/jpeg', 512, 512), note: 'Nothing renderable was found.' }
      },
    })
    const result = await run('render_preview')
    expect(result.text).toBe('Rendered a 768x768 solid preview (iso view) of 0 objects. World bounds (-1, -1, 0) to (1, 1, n/a), size (2, 2, 1). Nothing renderable was found.')
    expect(result.images).toEqual([{ data: expect.any(Uint8Array) as Uint8Array, mimeType: 'image/jpeg' }])
    expect(calls[0]!.params).toMatchObject({ width: 768, height: 768, view: 'iso', shading: 'solid' })
    expect(calls[0]!.params).not.toHaveProperty('objects')
    expect(paths.map(path => existsSync(path))).toEqual([false, false])
  })

  it('refuses an image path it did not request and still cleans up', async () => {
    const stray = join(dataRoot, 'stray.png')
    await writeImage(stray)
    let written = ''
    const { run } = harness({
      render_preview: async (params) => {
        written = text(params.path)
        await writeImage(written)
        return { path: written, width: 64, height: 64, view: 'top', shading: 'solid', objects: 1, framing, seconds: 0, image: image(stray) }
      },
    })
    await expect(run('render_preview', { width: 64, height: 64 })).rejects.toThrow(`returned an image outside the requested files: ${stray}`)
    expect(existsSync(written)).toBe(false)
    expect(existsSync(stray)).toBe(true)
  })
})

describe('render', () => {
  it('renders to a new file under the data folder by default and keeps it', async () => {
    let written = ''
    const { calls, run } = harness({
      render: async (params) => {
        written = text(params.path)
        await writeImage(written)
        return { path: written, width: 1920, height: 1080, engine: 'BLENDER_EEVEE', camera: 'Camera', seconds: 1.5, image: image(written, 'image/png', 1920, 1080) }
      },
    })
    const result = await run('render')
    expect(written).toMatch(new RegExp(`^${join(dataRoot, 'renders')}/\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z-[0-9a-f]{8}\\.png$`))
    expect(result.text).toBe(`Rendered 1920x1080 with BLENDER_EEVEE from camera "Camera" in 1.5 s and saved ${written}.`)
    expect(result.images).toHaveLength(1)
    expect(Object.keys(calls[0]!.params).sort()).toEqual(['agent_image', 'path'])
    expect(existsSync(written)).toBe(true)
  })

  it('passes render overrides and shows a downscaled copy that it then deletes', async () => {
    const target = join(dataRoot, 'out', 'shot.png')
    let copy = ''
    const { calls, run } = harness({
      render: async (params) => {
        copy = `${(params.agent_image as { stem: string }).stem}.png`
        await writeImage(target)
        await writeImage(copy)
        return { path: target, width: 2048, height: 1024, engine: 'CYCLES', camera: 'Shot', seconds: null, image: image(copy, 'image/png', 1568, 784) }
      },
    })
    const result = await run('render', { path: target, width: 2048, height: 1024, engine: 'CYCLES', samples: 64, camera: 'Shot' })
    expect(result.text).toBe(`Rendered 2048x1024 with CYCLES from camera "Shot" and saved ${target}. The image shown is a 1568x784 copy.`)
    expect(calls[0]!.params).toMatchObject({ path: target, width: 2048, height: 1024, engine: 'CYCLES', samples: 64, camera: 'Shot' })
    expect(existsSync(copy)).toBe(false)
    expect(existsSync(target)).toBe(true)
  })
})
