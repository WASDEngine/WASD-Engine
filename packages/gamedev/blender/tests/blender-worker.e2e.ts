/**
 * The Blender worker and tools against real Blender: the bpy module through uv (offline, from the
 * uv cache), the bpy runtime installed in this package's `runtime` folder as the Desktop app ships
 * it, and an installed Blender in background mode. Each suite skips when its runtime is missing on
 * this machine.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { JsonLineWorker, WorkerError, WorkerPool, materializePayload, shippedRuntimeRoot } from '@deepseek-ai/dsh-app-mcp'
import type { AppWorkerScope, JsonLineWorkerSpec } from '@deepseek-ai/dsh-app-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { BlenderWorkers, childEnvironment, findBlender, findShippedBpy, findUv, nodeBlenderSetupHost, resolveWorkerLaunch } from '../src/environment.ts'
import { blenderTools } from '../src/tools.ts'
import type { BlenderBackend, BlenderServerOptions } from '../src/types.ts'

const WORKER = fileURLToPath(new URL('../py/wasd_blender_worker.py', import.meta.url))
const BPY_VERSION = '5.2.3'
const host = nodeBlenderSetupHost(64 * 1024)
const uv = await findUv({ uvPath: '' }, host)
const uvRun = (uvPath: string): string[] => [uvPath, 'run', '--offline', '--python', '3.13', '--no-project', '--with', `bpy==${BPY_VERSION}`, 'python', '-I']
const bpyCached = uv !== undefined && spawnSync(uv, [...uvRun(uv).slice(1), '-c', 'import bpy'], { stdio: 'ignore', timeout: 300_000 }).status === 0
const blender = await findBlender({ blenderPath: '' }, host)
/** This package's `runtime` folder, where `wasdengine/blender/build.sh --install` puts the runtime that the Desktop app ships. */
const BUNDLED_ROOT = shippedRuntimeRoot(fileURLToPath(new URL('..', import.meta.url)))
const shipped = await findShippedBpy(BUNDLED_ROOT, host)

const OPTIONS: Omit<BlenderServerOptions, 'dataRoot'> = {
  backend: 'app', bpyVersion: BPY_VERSION, pythonVersion: '3.13', uvPath: '', blenderPath: '',
  startupTimeoutMs: 120_000, requestTimeoutMs: 120_000, toolCallTimeoutMs: 300_000, graceMs: 3000, maxLogBytes: 64 * 1024,
  maxWorkers: 4, workerIdleTimeoutMs: 600_000,
}

/** Scope of the tool calls, as a Session's calls reach the server. */
const SESSION = 'session:e2e'

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const PythonReply = z.object({ result: z.json() })
const PixelRange = z.object({ min: z.number(), max: z.number(), distinct: z.int() })
const SceneReply = z.object({ dirty: z.boolean() })
const PreviewReply = z.object({
  objects: z.int(), framing: z.object({ min: z.array(z.number()), max: z.array(z.number()) }), note: z.string().optional(),
})
const PrintedReply = z.object({ output: z.string() })

/** Names of the nodes in a GLB file's JSON chunk. */
function glbNodeNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))
  return z.object({ nodes: z.array(z.object({ name: z.string() })) }).parse(JSON.parse(json)).nodes.map(node => node.name)
}

/** Morph targets in a GLB file, summed over every mesh primitive. */
function glbMorphTargets(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))
  const Primitive = z.object({ targets: z.array(z.unknown()).optional() })
  const Gltf = z.object({ meshes: z.array(z.object({ primitives: z.array(Primitive) })).optional() })
  const primitives = (Gltf.parse(JSON.parse(json)).meshes ?? []).flatMap(mesh => mesh.primitives)
  return primitives.reduce((sum, primitive) => sum + (primitive.targets?.length ?? 0), 0)
}

/** Whether any process of the process group `pgid` is left. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Kill what is left of the process group `pgid`. */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // ESRCH: the group is already gone.
  }
}

/** A tetrahedron mesh object named `name`, linked to `collection` (default: the scene's collection) and parented to `parent`. */
const TETRA = `
def tetra(name, parent=None, collection=None, location=(0, 0, 0)):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)], [], [(0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)])
    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    obj.parent = parent
    obj.location = location
    return obj
`

/** A 2 m cube object named `name` at `location`, linked to `collection` (default: the scene's collection). */
const CUBE = `
def cube(name, location, collection=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    obj.location = location
    return obj

def collection(name):
    made = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(made)
    return made
`

const PIXEL_RANGE = `
img = bpy.data.images.load(PATH, check_existing=False)
pixels = list(img.pixels)
bpy.data.images.remove(img)
levels = [round(sum(pixels[i:i + 3]) / 3, 2) for i in range(0, len(pixels), 4)]
result = {'min': min(levels), 'max': max(levels), 'distinct': len(set(levels))}
`

/** How a suite launches its worker. */
interface Launcher {
  readonly argv: (dataRoot: string) => Promise<readonly string[]>
  /** Starts workers the way the server entry does: materialized script, resolved launch, setup notes. */
  readonly serverWiring: boolean
  /** Whether the worker leads its own process group; uv, which runs the bpy suite's worker, leads it otherwise. */
  readonly leadsGroup: boolean
  /** The backend that the server wiring resolves. */
  readonly backend: BlenderBackend
  /** How the first result's start note names the runtime, with server wiring. */
  readonly runtime: string
}

/** Every entry of a folder: files with their size and modification time, folders as such. */
async function treeState(root: string): Promise<Map<string, string>> {
  const state = new Map<string, string>()
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    const info = await lstat(path)
    state.set(path, entry.isDirectory() ? 'folder' : `${String(info.size)} ${String(info.mtimeMs)}`)
  }
  return state
}

function suite(name: string, { argv, serverWiring, leadsGroup, backend, runtime }: Launcher): void {
  describe(name, () => {
    let dataRoot = ''
    beforeAll(async () => { dataRoot = await mkdtemp(join(tmpdir(), 'dsh-blender-e2e-')) })
    afterAll(async () => { await rm(dataRoot, { recursive: true, force: true }) })

    const spec = async (): Promise<JsonLineWorkerSpec> => ({
      argv: await argv(dataRoot), cwd: dataRoot, env: childEnvironment(process.env), readyTimeoutMs: 120_000, logTailBytes: 64 * 1024,
    })

    it('speaks the worker protocol for every method and leaves the scene unchanged after a preview', async () => {
      const worker = await JsonLineWorker.start(await spec())
      const call = async (method: string, params: { [key: string]: JsonValue } = {}): Promise<JsonValue> =>
        await worker.request(method, params, { timeoutMs: 120_000 })
      const python = async (code: string): Promise<JsonValue> => PythonReply.parse(await call('execute_python', { code })).result
      try {
        expect(worker.ready).toMatchObject({ app: 'blender', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string, python: expect.stringMatching(/^3\.\d+\.\d+$/) as string })
        await expect(call('ping')).resolves.toMatchObject({ app: 'blender', file: null })
        await expect(call('new_scene', { empty: false })).resolves.toMatchObject({ empty: false, objects: expect.arrayContaining(['Cube', 'Camera', 'Light']) as string[] })
        await expect(call('scene_info')).resolves.toMatchObject({ render: { camera: 'Camera' }, object_count: 3, objects: expect.arrayContaining([expect.objectContaining({ name: 'Cube', triangles: 12 }) as object]) as object[] })
        await expect(call('object_info', { name: 'Cube' })).resolves.toMatchObject({ mesh: { vertices: 8, faces: 6, triangles: 12 } })
        const missing = call('object_info', { name: 'Cub' })
        await expect(missing).rejects.toBeInstanceOf(WorkerError)
        await expect(missing).rejects.toMatchObject({ code: 'WORKER_REMOTE', remoteType: 'ValueError', message: expect.stringContaining("no object named 'Cub'. Close names: Cube.") as string })

        await expect(call('execute_python', { code: 'print("made")\nresult = {"location": bpy.data.objects["Cube"].location, "cube": bpy.data.objects["Cube"]}' }))
          .resolves.toMatchObject({ result: { location: [0, 0, 0], cube: { type: 'Object', name: 'Cube' } }, output: 'made\n' })
        await expect(call('execute_python', { code: 'def fail():\n    raise RuntimeError("boom")\nfail()' }))
          .resolves.toMatchObject({ error: { type: 'RuntimeError', message: 'boom', traceback: expect.stringContaining('line 2, in fail') as string } })

        const names = 'result = sorted(o.name for o in bpy.data.objects)'
        await call('execute_python', { code: 'bpy.data.objects["Light"].name = "Lamp"' })
        await expect(call('checkpoint')).resolves.toEqual({ checkpoint: 1 })
        await call('execute_python', { code: 'bpy.ops.mesh.primitive_monkey_add(location=(3, 0, 0))' })
        await expect(call('undo')).resolves.toEqual({ checkpoint: 1 })
        await expect(call('undo')).resolves.toEqual({ checkpoint: 0 })
        await expect(call('undo')).rejects.toMatchObject({ code: 'WORKER_REMOTE', message: expect.stringContaining('no earlier checkpoint') as string })
        await expect(python(names)).resolves.toEqual(['Camera', 'Cube', 'Light'])
        await call('execute_python', { code: 'bpy.data.objects["Light"].name = "Lamp"' })
        await expect(call('checkpoint')).resolves.toEqual({ checkpoint: 2 })
        await expect(call('undo')).resolves.toEqual({ checkpoint: 2 })
        await expect(python(names)).resolves.toEqual(['Camera', 'Cube', 'Lamp'])

        const before = 'result = [bpy.context.scene.camera.name, bpy.context.scene.render.engine, bpy.context.scene.render.resolution_x, len(bpy.data.objects), len(bpy.data.cameras), len(bpy.data.worlds), [list(m.diffuse_color) for m in bpy.data.materials]]'
        const settings = await python(before)
        const preview = join(dataRoot, 'previews', 'cube.png')
        await expect(call('render_preview', { path: preview, width: 256, height: 192, view: 'iso', shading: 'solid' }))
          .resolves.toMatchObject({ width: 256, height: 192, objects: 1, image: { path: preview, mime_type: 'image/png' } })
        expect(pngSize(await readFile(preview))).toEqual({ width: 256, height: 192 })
        const range = PixelRange.parse(await python(`PATH = ${JSON.stringify(preview)}\n${PIXEL_RANGE}`))
        expect(range.max - range.min).toBeGreaterThan(0.2)
        expect(range.distinct).toBeGreaterThan(10)
        await expect(call('render_preview', { path: join(dataRoot, 'previews', 'material.png'), width: 128, height: 128, shading: 'material', objects: ['Cube'] }))
          .resolves.toMatchObject({ shading: 'material', objects: 1 })
        await expect(python(before)).resolves.toEqual(settings)

        const glb = join(dataRoot, 'game', 'assets', 'cube.glb')
        await expect(call('export_gltf', { path: glb, format: 'GLB', apply_modifiers: true, animations: true, selection: ['Cube'] }))
          .resolves.toMatchObject({ path: glb, format: 'GLB', objects: 1 })
        expect(new TextDecoder().decode((await readFile(glb)).subarray(0, 4))).toBe('glTF')
        const obj = join(dataRoot, 'exports', 'scene.obj')
        await expect(call('export_file', { path: obj, format: 'obj' })).resolves.toMatchObject({ path: obj, format: 'obj' })
        const blend = join(dataRoot, 'sources', 'cube.blend')
        await expect(call('save_blend', { path: blend })).resolves.toMatchObject({ path: blend })
        await expect(call('new_scene', { empty: true })).resolves.toEqual({ empty: true, objects: [], cleared: ['PATH', 'fail', 'img', 'levels', 'pixels'], cleared_count: 5 })
        await expect(call('import_file', { path: glb })).resolves.toMatchObject({ objects: ['Cube'], count: 1 })
        await expect(call('open_blend', { path: blend })).resolves.toMatchObject({ file: blend, object_count: 3 })

        const shot = join(dataRoot, 'renders', 'shot.png')
        await expect(call('render', { path: shot, width: 96, height: 64, engine: 'WORKBENCH' })).resolves.toMatchObject({ path: shot, width: 96, height: 64, camera: 'Camera' })
        expect(pngSize(await readFile(shot))).toEqual({ width: 96, height: 64 })
        await expect(call('python_api', { identifier: 'bpy.types.Object.location' })).resolves.toMatchObject({ kind: 'property', text: expect.stringContaining('location: float[3]') as string })
        await expect(call('python_api', { identifier: 'bpy.ops.mesh.primitive_cube_add' })).resolves.toMatchObject({ kind: 'operator', text: expect.stringContaining('size: float = 2') as string })
      } finally {
        await worker.close(3000)
      }
      await expect(worker.exited).resolves.toEqual({ code: 0, signal: null })
    }, 240_000)

    it('serves the tools through a supervised worker', async () => {
      const options: BlenderServerOptions = { ...OPTIONS, backend, dataRoot }
      const workerSpec = await spec()
      const workers = new BlenderWorkers(options, {
        host,
        workerScript: async () => await materializePayload(new URL('../py/wasd_blender_worker.py', import.meta.url), dataRoot),
        bundledRoot: BUNDLED_ROOT,
        start: async (startSpec, signal) => await JsonLineWorker.start(startSpec, signal),
      })
      const start = serverWiring
        ? async (signal: AbortSignal, scope: AppWorkerScope) => await workers.start(signal, scope)
        : async (signal: AbortSignal) => await JsonLineWorker.start(workerSpec, signal)
      const pool = new WorkerPool({
        app: 'Blender', root: join(dataRoot, 'workers'), start, takeNotes: () => workers.takeNotes(), maxWorkers: options.maxWorkers,
        idleTimeoutMs: options.workerIdleTimeoutMs, requestTimeoutMs: options.requestTimeoutMs, closeGraceMs: options.graceMs,
      })
      const tools = new Map(blenderTools({
        call: async (method, params, callOptions) => await pool.call(SESSION, method, params, callOptions),
        takeNotes: () => pool.takeNotes(SESSION),
        dataRoot,
        requestTimeoutMs: options.requestTimeoutMs,
        maxTimeoutMs: options.toolCallTimeoutMs,
      }).map(tool => [tool.name, tool]))
      const run = async (tool: string, args: Record<string, unknown> = {}) => await tools.get(tool)!.run(args, new AbortController().signal)
      try {
        const started = new RegExp(`^Blender \\d+\\.\\d+\\.\\d+ started \\(${runtime}, Python 3\\.\\d+\\.\\d+\\) with its default scene\\.\\n\\n`, 'u')
        const first = await run('new_scene', { empty: false })
        expect(first.text.replace(serverWiring ? started : /^/, '')).toBe('Started a new scene with Cube, Light, Camera.')
        if (serverWiring) expect(first.text).toMatch(started)
        await expect(run('execute_python', { code: 'raise ValueError("bad input")' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('ValueError: bad input') as string })
        const preview = await run('render_preview', { width: 200, height: 100, view: 'front' })
        expect(preview.text).toMatch(/^Rendered a 200x100 solid preview \(front view\) of 1 objects\./)
        expect(pngSize(preview.images![0]!.data!)).toEqual({ width: 200, height: 100 })
        const glb = join(dataRoot, 'tool-export', 'scene.glb')
        await expect(run('export_gltf', { path: glb })).resolves.toMatchObject({ text: expect.stringContaining(`to ${glb} (GLB, `) as string })
      } finally {
        await pool.close()
      }
    }, 240_000)

    /** A worker for one test, with request helpers; the caller closes it. */
    const open = async () => {
      const worker = await JsonLineWorker.start(await spec())
      const call = async (method: string, params: { [key: string]: JsonValue } = {}): Promise<JsonValue> =>
        await worker.request(method, params, { timeoutMs: 120_000 })
      const python = async (code: string): Promise<JsonValue> => PythonReply.parse(await call('execute_python', { code })).result
      return { worker, call, python }
    }

    it('clears the names that executed code defined when the scene is replaced, and tracks unsaved changes', async () => {
      const { worker, call, python } = await open()
      const dirty = async (): Promise<boolean> => SceneReply.parse(await call('scene_info')).dirty
      try {
        await call('new_scene', { empty: false })
        expect(await dirty()).toBe(false)
        // Parts of the scene that new_scene frees: reading them returned garbage, and writing crashed Blender.
        await python('render = bpy.context.scene.render\nverts = bpy.data.objects["Cube"].data.vertices\nco = verts[0].co\ndef helper():\n    return 42')
        expect(await dirty()).toBe(true)
        const blend = join(dataRoot, 'names', 'scene.blend')
        await call('save_blend', { path: blend })
        expect(await dirty()).toBe(false)
        await expect(call('new_scene', { empty: true })).resolves.toEqual({ empty: true, objects: [], cleared: ['co', 'helper', 'render', 'verts'], cleared_count: 4 })
        await expect(call('execute_python', { code: 'render.resolution_x = 1234' }))
          .resolves.toMatchObject({ error: { type: 'NameError', message: "name 'render' is not defined" } })
        await python('kept = 2')
        const broken = join(dataRoot, 'names', 'broken.blend')
        await writeFile(broken, 'not a blend file\n')
        await expect(call('open_blend', { path: broken })).rejects.toMatchObject({ code: 'WORKER_REMOTE', remoteType: 'RuntimeError' })
        await expect(python('result = kept')).resolves.toBe(2)
        await expect(call('open_blend', { path: blend })).resolves.toMatchObject({ file: blend, cleared: ['kept'], cleared_count: 1 })
        expect(await dirty()).toBe(false)

        // Blender keeps 32 undo steps, so 34 checkpoints push the opened state and checkpoint 1 out.
        for (let index = 1; index <= 34; index++) await call('checkpoint')
        const restored: JsonValue[] = []
        for (let index = 0; index < 33; index++) restored.push(await call('undo'))
        expect(restored).toEqual(Array.from({ length: 33 }, (_, index) => ({ checkpoint: 34 - index })))
        await expect(call('undo')).rejects.toMatchObject({
          code: 'WORKER_REMOTE',
          message: 'ValueError: undo: no earlier checkpoint is kept; the scene is at checkpoint 2, the oldest one left, because Blender keeps only its 32 most recent undo steps',
        })
        expect(await dirty()).toBe(true)
      } finally {
        await worker.close(3000)
      }
    }, 240_000)

    it('exports the named objects with hidden and unselectable children and never reports an earlier file', async () => {
      const { worker, call, python } = await open()
      try {
        await call('new_scene', { empty: true })
        await python(`${TETRA}
hero = tetra('Hero')
tetra('Hero-col', hero).hide_set(True)
tetra('Locked', hero).hide_select = True
tetra('Unshown', hero).hide_viewport = True
eye = bpy.data.objects.new('Eye', bpy.data.cameras.new('Eye'))
bpy.context.scene.collection.objects.link(eye)
eye.parent = hero
fenced = bpy.data.collections.new('Fenced')
bpy.context.scene.collection.children.link(fenced)
fenced.hide_select = True
tetra('Fenced rock', None, fenced)
lone = bpy.data.objects.new('Lone camera', bpy.data.cameras.new('Lone camera'))
bpy.context.scene.collection.objects.link(lone)
bpy.context.view_layer.update()
`)
        const state = 'result = {o.name: [o.hide_get(), o.hide_viewport, o.hide_select, o.select_get()] for o in bpy.context.view_layer.objects}'
        const before = await python(state)
        const glb = join(dataRoot, 'exports', 'hero.glb')
        await expect(call('export_gltf', { path: glb, format: 'GLB', selection: ['Hero'] })).resolves.toMatchObject({ objects: 4 })
        expect(glbNodeNames(await readFile(glb)).toSorted()).toEqual(['Hero', 'Hero-col', 'Locked', 'Unshown'])
        await expect(python(state)).resolves.toEqual(before)
        await expect(call('export_gltf', { path: join(dataRoot, 'exports', 'fenced.glb'), format: 'GLB', selection: ['Fenced rock'] })).rejects.toMatchObject({
          code: 'WORKER_REMOTE', message: expect.stringContaining('Blender cannot select Fenced rock: a collection that holds them disables selection') as string,
        })
        const earlier = join(dataRoot, 'exports', 'lone.obj')
        await writeFile(earlier, 'o Earlier\n')
        await expect(call('export_file', { path: earlier, format: 'obj', selection: ['Lone camera'] })).rejects.toMatchObject({
          code: 'WORKER_REMOTE', message: expect.stringContaining(`Blender wrote no file at ${earlier}`) as string,
        })
        expect(existsSync(earlier)).toBe(false)
        const collider = join(dataRoot, 'exports', 'collider.obj')
        await expect(call('export_file', { path: collider, format: 'obj', selection: ['Hero-col'] })).resolves.toMatchObject({ path: collider })
        expect((await readFile(collider, 'utf8')).split('\n').filter(line => line.startsWith('o '))).toEqual(['o Hero-col'])
      } finally {
        await worker.close(3000)
      }
    }, 240_000)

    it('keeps the shape keys of an Armature-only mesh, names the meshes that applying modifiers strips, and exports only the current scene', async () => {
      const { worker, call, python } = await open()
      try {
        await call('new_scene', { empty: true })
        await python(`${TETRA}
face = tetra('Face')
face.shape_key_add(name='Basis')
face.shape_key_add(name='Smile').data[3].co.z = 1.5
rig = bpy.data.objects.new('Rig', bpy.data.armatures.new('Rig'))
bpy.context.scene.collection.objects.link(rig)
face.modifiers.new('Rig', 'ARMATURE').object = rig
bpy.data.scenes.new('Elsewhere').collection.objects.link(bpy.data.objects.new('Other scene empty', None))
camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
bpy.context.scene.collection.objects.link(camera)
camera.location = (4, -4, 3)
camera.rotation_euler = (1.1, 0, 0.8)
bpy.context.scene.camera = camera
`)
        const glb = join(dataRoot, 'exports', 'face.glb')
        await expect(call('export_gltf', { path: glb, format: 'GLB' })).resolves.toMatchObject({ applied_modifiers: false, shape_keys_dropped: [] })
        let bytes = await readFile(glb)
        expect(glbMorphTargets(bytes)).toBe(1)
        expect(glbNodeNames(bytes)).not.toContain('Other scene empty')

        await python("bpy.data.objects['Face'].modifiers.new('Bevel', 'BEVEL')")
        await expect(call('export_gltf', { path: glb, format: 'GLB' })).resolves.toMatchObject({ applied_modifiers: true, shape_keys_dropped: ['Face'] })
        bytes = await readFile(glb)
        expect(glbMorphTargets(bytes)).toBe(0)
        await expect(call('export_gltf', { path: glb, format: 'GLB', apply_modifiers: false })).resolves.toMatchObject({ applied_modifiers: false, shape_keys_dropped: [] })
        expect(glbMorphTargets(await readFile(glb))).toBe(1)

        const shot = join(dataRoot, 'renders', 'limited.png')
        await expect(call('render', { path: shot, width: 32, height: 32, engine: 'CYCLES', samples: 2, time_limit: 30 })).resolves.toMatchObject({ engine: 'CYCLES' })
        await expect(python('result = bpy.context.scene.cycles.time_limit')).resolves.toBe(0)
      } finally {
        await worker.close(3000)
      }
    }, 240_000)

    it('frames previews on what renders, also when it is hidden in the viewport, and keeps the color management view', async () => {
      const { worker, call, python } = await open()
      const preview = async (name: string, objects?: string[]): Promise<z.infer<typeof PreviewReply>> => PreviewReply.parse(await call('render_preview', {
        path: join(dataRoot, 'framing', `${name}.png`), width: 64, height: 64, ...objects === undefined ? {} : { objects },
      }))
      try {
        await call('new_scene', { empty: true })
        await python(`${CUBE}
cube('Shown', (0, 0, 0))
cube('Unshown', (10, 0, 0)).hide_viewport = True
cube('Hidden', (0, 10, 0)).hide_set(True)
shelf = collection('Shelf')
cube('On shelf', (0, 0, 10), shelf)
shelf.hide_viewport = True
cube('Behind the eye', (-10, 0, 0), collection('Eye closed'))
bpy.context.view_layer.layer_collection.children['Eye closed'].hide_viewport = True
props = collection('Props')
cube('Prop', (0, -10, 0), props)
props.hide_render = True
view = bpy.context.scene.view_settings
view.view_transform = 'AgX'
view.look = 'AgX - Punchy'
`)
        const state = `result = [{o.name: [o.hide_viewport, o.hide_get(), o.hide_render] for o in bpy.context.view_layer.objects},
    [bpy.data.collections['Shelf'].hide_viewport, bpy.context.view_layer.layer_collection.children['Eye closed'].hide_viewport],
    [bpy.context.scene.view_settings.view_transform, bpy.context.scene.view_settings.look]]`
        const before = await python(state)
        // Every cube but the one in the collection that renders leave out.
        await expect(preview('scene')).resolves.toEqual({ objects: 5, framing: expect.objectContaining({ min: [-11, -1, -1], max: [11, 11, 11] }) as object })
        await expect(preview('unshown', ['Unshown'])).resolves.toMatchObject({ objects: 1, framing: { min: [9, -1, -1], max: [11, 1, 1] } })
        await expect(preview('on-shelf', ['On shelf'])).resolves.toMatchObject({ objects: 1, framing: { min: [-1, -1, 9], max: [1, 1, 11] } })
        await expect(preview('prop', ['Prop'])).resolves.toMatchObject({
          objects: 0,
          note: 'The preview cannot show Prop: no collection of the view layer that renders include holds them. Nothing renderable was found; the preview shows an empty view.',
        })
        await expect(call('render_preview', { path: join(dataRoot, 'framing', 'material.png'), width: 64, height: 64, shading: 'material' })).resolves.toMatchObject({ objects: 5 })
        await expect(python(state)).resolves.toEqual(before)
      } finally {
        await worker.close(3000)
      }
    }, 240_000)

    it('returns large integers as text and bounds printed output and replies without losing the session', async () => {
      const { worker, call, python } = await open()
      try {
        await expect(python('result = [2**53 - 1, -(2**53 - 1), 2**53, -(10**30), 10**5000]'))
          .resolves.toEqual([9007199254740991, -9007199254740991, '9007199254740992', `-1${'0'.repeat(30)}`, '<integer of about 5001 digits>'])
        await expect(python('result = {"n": 10**400}')).resolves.toEqual({ n: `1${'0'.repeat(400)}` })
        const peak = 'import resource, sys\nresult = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)'
        const before = Number(await python(peak))
        const printed = PrintedReply.parse(await call('execute_python', { code: 'import time\nstop = time.time() + 2\nwhile time.time() < stop:\n    print("x" * 1000)\nprint("end")' }))
        expect(printed.output).toHaveLength(20_000)
        expect(printed.output).toMatch(/^x+\n[x\n]*\[\.\.\. \d+ characters omitted \.\.\.\]\n[x\n]+end\n$/)
        // Unbounded capture grew the worker by about 500 MB per second of printing.
        expect(Number(await python(peak)) - before).toBeLessThan(100 * 1024 * 1024)
        await python('big = bpy.data.objects.new("Big", None)\nbpy.context.scene.collection.objects.link(big)\nbig["text"] = "x" * (33 * 1024 * 1024)')
        const tooLong = /^ValueError: the request completed, but its reply is \d+ bytes of JSON, more than the 33554432 bytes/u
        await expect(call('object_info', { name: 'Big' })).rejects.toMatchObject({ code: 'WORKER_REMOTE', message: expect.stringMatching(tooLong) as string })
        await expect(call('execute_python', { code: 'raise ValueError("y" * (33 * 1024 * 1024))' }))
          .resolves.toMatchObject({ error: { type: 'ValueError', message: expect.stringMatching(/^y{9000,}\n\[\.\.\. \d+ characters omitted \.\.\.\]\ny{9000,}$/) as string } })
        await expect(python('result = "alive"')).resolves.toBe('alive')
      } finally {
        await worker.close(3000)
      }
    }, 240_000)

    it('cuts the output of eight threads that print at once as it cuts the same output from one thread', async () => {
      // A switch interval of 1 µs makes the threads switch inside the writes to the output stream.
      const code = `import sys, threading
line = 'x' * 49 + '\\n'
errors = []
start = threading.Barrier(8)
def run():
    try:
        start.wait()
        for _ in range(2500):
            print(line, end='')
    except Exception as error:
        errors.append(repr(error))
interval = sys.getswitchinterval()
sys.setswitchinterval(1e-6)
try:
    threads = [threading.Thread(target=run) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
finally:
    sys.setswitchinterval(interval)
result = errors`
      const { worker, call } = await open()
      try {
        const reply = await call('execute_python', { code })
        expect(PythonReply.parse(reply).result).toEqual([])
        const text = `${'x'.repeat(49)}\n`.repeat(8 * 2500)
        const keep = 20_000 - `\n[... ${String(text.length)} characters omitted ...]\n`.length
        const head = Math.floor(keep / 2)
        expect(PrintedReply.parse(reply).output).toBe(`${text.slice(0, head)}\n[... ${String(text.length - keep)} characters omitted ...]\n${text.slice(text.length - (keep - head))}`)
      } finally {
        await worker.close(3000)
      }
    }, 240_000)

    it('ends with the processes it started when the server dies, idle or during a request', async () => {
      for (const busy of [false, true]) {
        const { argv: [command = '', ...args], cwd, env } = await spec()
        const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true })
        const pid = child.pid!
        onTestFinished(() => { killGroup(pid) })
        const replies = child.stdio[3] as Readable
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        child.stdout.resume()
        await new Promise<void>((resolve) => { replies.once('data', () => { resolve() }) })
        if (busy) {
          // A call that never returns, and a process it starts, which must end with the worker; under uv, uv leads the group.
          const started = leadsGroup ? 'import subprocess\nsubprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])\n' : ''
          const code = `import sys, time\n${started}sys.__stderr__.write("busy\\n")\nsys.__stderr__.flush()\nwhile True:\n    time.sleep(0.05)`
          child.stdin.write(`${JSON.stringify({ id: 1, method: 'execute_python', params: { code } })}\n`)
          await vi.waitFor(() => { expect(stderr).toContain('busy\n') }, { timeout: 60_000 })
        }
        // The server dies: every pipe end it held closes.
        for (const pipe of [child.stdin, child.stdout, child.stderr, replies]) pipe.destroy()
        await vi.waitFor(() => { expect(groupAlive(pid)).toBe(false) }, { timeout: 15_000, interval: 100 })
      }
    }, 240_000)
  })
}

describe.skipIf(!bpyCached)('bpy module worker', () => {
  suite(`bpy ${BPY_VERSION} through uv`, {
    argv: async () => [...uvRun(uv!), '-u', WORKER], serverWiring: false, leadsGroup: false, backend: 'bpy', runtime: 'bpy module',
  })
})

describe.skipIf(shipped?.bpy !== BPY_VERSION)('shipped bpy runtime worker', () => {
  let before = new Map<string, string>()
  beforeAll(async () => { before = await treeState(shipped!.directory) })

  suite(`bpy ${BPY_VERSION} that WASD Engine ships`, {
    argv: async dataRoot => (await resolveWorkerLaunch({ ...OPTIONS, backend: 'bpy', dataRoot }, WORKER, BUNDLED_ROOT, host, new AbortController().signal)).argv,
    serverWiring: true,
    leadsGroup: true,
    backend: 'bpy',
    runtime: 'the bpy module that WASD Engine ships',
  })

  it('leaves every file and folder of the runtime as it found them', async () => {
    expect(await treeState(shipped!.directory)).toEqual(before)
  })
})

describe.skipIf(blender === undefined)('Blender app worker', () => {
  suite('Blender --background', {
    argv: async dataRoot => (await resolveWorkerLaunch({ ...OPTIONS, dataRoot }, WORKER, BUNDLED_ROOT, host, new AbortController().signal))
      .argv,
    serverWiring: true,
    leadsGroup: true,
    backend: 'app',
    runtime: 'Blender app',
  })
})
