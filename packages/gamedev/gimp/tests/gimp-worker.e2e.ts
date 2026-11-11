/**
 * The GIMP worker and tools against a real GIMP 3 (`gimp-console`): the runtime in the package's
 * `runtime/` folder, which `wasdengine/gimp/build.sh --install` puts there, or else an installed
 * GIMP 3, which `GIMP_CONSOLE` can name. The suite skips when neither exists on this machine. It
 * owns a temporary data directory, whose fresh GIMP profile makes the first start take about 15 s,
 * and every GIMP process it starts.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JsonLineWorker, WorkerError, WorkerPool, materializePayload, shippedRuntimeRoot } from '@deepseek-ai/dsh-app-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { findGimp, GimpWorkers, gimpProfileDirectory, gimpWorkerArgv, nodeGimpSetupHost, workerEnvironment } from '../src/environment.ts'
import { gimpTools } from '../src/tools.ts'
import type { GimpServerOptions } from '../src/types.ts'

const WORKER = fileURLToPath(new URL('../py/wasd_gimp_worker.py', import.meta.url))
const host = nodeGimpSetupHost(64 * 1024)
const BUNDLED_ROOT = shippedRuntimeRoot(fileURLToPath(new URL('..', import.meta.url)))
// A packed runtime, which only the Windows app ships, would unpack into this data directory.
const installation = await findGimp({ gimpConsolePath: '', dataRoot: join(tmpdir(), 'dsh-gimp-e2e-data') }, BUNDLED_ROOT, host, new AbortController().signal)

const READY_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 120_000

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Babl format of 8-bit sRGB pixels with alpha, in which the tests read pixels. */
const RGBA_U8 = "R'G'B'A u8"

const ImageInfo = z.object({ id: z.int(), layers: z.array(z.object({ id: z.int(), name: z.string() })) })
const PythonReply = z.object({ result: z.json() })
const PythonError = z.object({ error: z.object({ type: z.string(), message: z.string() }) })
const PrintedReply = z.object({ output: z.string(), result: z.int() })
const Pixel = z.array(z.int()).length(4)
const Procedures = z.object({ procedures: z.array(z.object({ name: z.string(), summary: z.string() })) })
const UnitValue = z.object({ values: z.object({ unit: z.string() }) })
/** Largest channel difference between wrap-around neighbors across and down, and between neighbors inside the layer. */
const Seams = z.object({ across: z.int(), down: z.int(), inside: z.int() })

/** Python that measures {@link Seams} of the bottom layer of `image`. */
function seamsCode(image: number): string {
  return [
    `layer = images[${String(image)}].get_layers()[-1]`,
    'w, h = layer.get_width(), layer.get_height()',
    // A JSON string literal is also a valid Python string literal.
    `data = bytes(layer.get_buffer().get(Gegl.Rectangle.new(0, 0, w, h), 1.0, ${JSON.stringify(RGBA_U8)}, Gegl.AbyssPolicy.NONE))`,
    'px = lambda x, y: data[(y * w + x) * 4:(y * w + x) * 4 + 4]',
    'gap = lambda a, b: max(abs(p - q) for p, q in zip(a, b))',
    'inside = max(max(gap(px(x, y), px(x + 1, y)) for y in range(h) for x in range(w - 1)), max(gap(px(x, y), px(x, y + 1)) for y in range(h - 1) for x in range(w)))',
    "result = {'across': max(gap(px(w - 1, y), px(0, y)) for y in range(h)), 'down': max(gap(px(x, h - 1), px(x, 0)) for x in range(w)), 'inside': inside}",
  ].join('\n')
}

/** Resolve whether no process of group `pgid` is left within `ms`. */
async function groupEnds(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0)
    } catch {
      // ESRCH: no process of the group is left.
      return true
    }
    await sleep(100)
  }
  return false
}

describe.skipIf(installation === undefined)('GIMP 3 worker', () => {
  let dataRoot = ''
  beforeAll(async () => { dataRoot = await mkdtemp(join(tmpdir(), 'dsh-gimp-e2e-')) })
  afterAll(async () => { await rm(dataRoot, { recursive: true, force: true }) })

  it('speaks the worker protocol for every kind of method and leaves images unchanged by snapshots and exports', async () => {
    const profile = gimpProfileDirectory(dataRoot, process.platform)
    const worker = await JsonLineWorker.start({
      argv: gimpWorkerArgv(installation!.console, WORKER),
      cwd: dataRoot,
      env: workerEnvironment(process.env, profile, installation!.environment),
      readyTimeoutMs: READY_TIMEOUT_MS, logTailBytes: 64 * 1024,
    })
    const call = async (method: string, params: { [key: string]: JsonValue } = {}): Promise<JsonValue> =>
      await worker.request(method, params, { timeoutMs: REQUEST_TIMEOUT_MS })
    const python = async (code: string): Promise<JsonValue> => PythonReply.parse(await call('execute_python', { code })).result
    const pixel = async (image: number, x: number, y: number): Promise<number[]> => Pixel.parse(await python(
      `layer = images[${String(image)}].get_layers()[0]\nresult = list(layer.get_pixel(${String(x)}, ${String(y)}).get_bytes(Babl.format(${JSON.stringify(RGBA_U8)})).get_data())`,
    ))
    try {
      expect(worker.ready).toMatchObject({ app: 'gimp', version: expect.stringMatching(/^3\.\d+\.\d+$/) as string, python: expect.stringMatching(/^3\.\d+\.\d+$/) as string })
      await expect(call('ping')).resolves.toMatchObject({ pong: true, images: 0 })

      const created = ImageInfo.parse(await call('new_image', { width: 64, height: 32, fill: 'white', name: 'e2e' }))
      const image = created.id
      await expect(pixel(image, 3, 3)).resolves.toEqual([255, 255, 255, 255])
      await expect(call('draw', { image, action: 'gradient', color: '#ff0000', color2: '#0000ff00' })).resolves.toMatchObject({ layer: { name: 'Background' } })
      // The gradient fades from opaque red to transparent blue over the white layer.
      const [left, right] = [await pixel(image, 0, 16), await pixel(image, 63, 16)]
      expect(left[0]).toBeGreaterThan(240)
      expect(Math.max(left[1]!, left[2]!)).toBeLessThan(48)
      expect(Math.min(right[0]!, right[1]!, right[2]!)).toBeGreaterThan(240)
      await expect(call('select', { image, mode: 'rect', x: 8, y: 8, width: 8, height: 8 })).resolves.toMatchObject({ selection: { x: 8, y: 8, width: 8, height: 8 } })
      await call('draw', { image, action: 'fill', color: '#00ff00' })
      await expect(pixel(image, 10, 10)).resolves.toEqual([0, 255, 0, 255])
      await expect(call('select', { image, mode: 'none' })).resolves.toMatchObject({ selection: null })
      await expect(call('layer', { image, action: 'add', name: 'Ink', opacity: 50, mode: 'multiply' }))
        .resolves.toMatchObject({ layer: { name: 'Ink', opacity: 50, mode: 'multiply' }, layer_count: 2 })
      await expect(call('layer', { image, action: 'move', layer: 'Ink' })).rejects.toMatchObject({
        code: 'WORKER_REMOTE', remoteType: 'ValueError', message: "ValueError: layer action 'move' requires position",
      })
      await expect(call('draw', { image, action: 'text', text: 'Hi', size: 12, color: '#000000', x: 2.4, y: 2 }))
        .resolves.toMatchObject({ layer: { kind: 'text', text: 'Hi', x: 2, y: 2 } })

      const before = await call('image_info', { image })
      const stem = join(dataRoot, 'snapshots', 'protocol')
      await expect(call('snapshot', { image, max_size: 512, stem })).resolves.toMatchObject({
        path: `${stem}.png`, mime_type: 'image/png', width: 256, height: 128, scale: 4, transparency: 'none',
      })
      expect(pngSize(await readFile(`${stem}.png`))).toEqual({ width: 256, height: 128 })
      const png = join(dataRoot, 'game', 'art', 'e2e.png')
      await expect(call('export_image', { image, path: png })).resolves.toMatchObject({ path: png, format: 'png', flattened: false })
      expect(pngSize(await readFile(png))).toEqual({ width: 64, height: 32 })
      const jpeg = join(dataRoot, 'game', 'art', 'e2e.jpg')
      await expect(call('export_image', { image, path: jpeg, quality: 80 })).resolves.toMatchObject({ format: 'jpeg', flattened: true })
      expect([...(await readFile(jpeg)).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
      await expect(call('image_info', { image })).resolves.toEqual(before)

      // A selection limits edits, not snapshots: transparency outside it still shows as the checkerboard.
      const marked = ImageInfo.parse(await call('new_image', { width: 32, height: 32 })).id
      await call('select', { image: marked, mode: 'rect', x: 0, y: 0, width: 8, height: 8 })
      await call('draw', { image: marked, action: 'fill', color: '#ff0000' })
      const markedStem = join(dataRoot, 'snapshots', 'marked')
      await expect(call('snapshot', { image: marked, max_size: 32, stem: markedStem })).resolves.toMatchObject({ scale: 1, transparency: 'checkerboard' })
      await expect(call('image_info', { image: marked })).resolves.toMatchObject({ selection: { x: 0, y: 0, width: 8, height: 8 } })
      const markedShown = ImageInfo.parse(await call('open_image', { path: `${markedStem}.png` })).id
      await expect(pixel(markedShown, 4, 4)).resolves.toEqual([255, 0, 0, 255])
      expect([[153, 153, 153, 255], [102, 102, 102, 255]]).toContainEqual(await pixel(markedShown, 20, 20))
      for (const done of [markedShown, marked]) await call('close_image', { image: done })

      const xcf = join(dataRoot, 'game', 'art', 'e2e.xcf')
      await expect(call('save_xcf', { image, path: xcf })).resolves.toMatchObject({ path: xcf, image })
      // GIMP names a saved image after its file, in place of the name new_image gave it.
      await expect(call('list_images')).resolves.toMatchObject({ images: [{ id: image, name: 'e2e.xcf', file: xcf }] })
      await expect(call('close_image', { image })).resolves.toEqual({ closed: image, discarded_unsaved_changes: false })
      const reopened = ImageInfo.parse(await call('open_image', { path: xcf }))
      expect(reopened.layers.map(layer => layer.name)).toEqual(['Hi', 'Ink', 'Background'])
      await expect(call('image_info', { image })).rejects.toMatchObject({ code: 'WORKER_REMOTE', remoteType: 'NotFoundError' })

      // Enum properties once crashed GIMP's Python through PyGObject's ParamSpecEnum.enum_class; describe and apply them repeatedly.
      await expect(call('filter_info', { operation: 'gimp:levels' })).resolves.toMatchObject({
        properties: expect.arrayContaining([expect.objectContaining({ name: 'channel', type: 'enum', default: 'value' })]) as object[],
      })
      for (let round = 0; round < 3; round++) {
        await expect(call('apply_filter', { image: reopened.id, layer: 'Background', operation: 'gimp:levels', properties: { channel: 'red', 'high-input': 0.9 } }))
          .resolves.toMatchObject({ operation: 'gimp:levels', properties: { channel: 'red', 'high-input': 0.9 } })
        await python('import gc\nresult = gc.collect() >= 0')
      }
      await expect(call('apply_filter', { image: reopened.id, layer: 'Background', operation: 'gegl:gaussian-blur', properties: { std_dev_x: 2, 'std-dev-y': 2 } }))
        .resolves.toMatchObject({ properties: { 'std-dev-x': 2, 'std-dev-y': 2 } })
      await expect(call('apply_filter', { image: reopened.id, operation: 'gegl:gausian-blur' }))
        .rejects.toMatchObject({ remoteType: 'NotFoundError', message: expect.stringContaining('gegl:gaussian-blur') as string })

      // A layer group has no pixels of its own: filters and make_seamless refuse it, and resize_canvas resizes the layers inside it.
      const grouped = ImageInfo.parse(await call('new_image', { width: 8, height: 8, fill: '#204080' })).id
      await python(`img = images[${String(grouped)}]\ngroup = Gimp.GroupLayer.new(img, 'Group')\nimg.insert_layer(group, None, 0)\nimg.reorder_item(img.get_layers()[1], group, 0)\nresult = True`)
      const refused = { code: 'WORKER_REMOTE', remoteType: 'ValueError', message: expect.stringMatching(/'Group' .*is a layer group.*pass a layer inside it/) as string }
      await expect(call('apply_filter', { image: grouped, layer: 'Group', operation: 'gegl:invert-gamma' })).rejects.toMatchObject(refused)
      await expect(call('make_seamless', { image: grouped, layer: 'Group' })).rejects.toMatchObject(refused)
      await call('transform', { image: grouped, action: 'resize_canvas', width: 16, height: 16, x: 4, y: 4 })
      await expect(call('image_info', { image: grouped })).resolves.toMatchObject({
        layers: [{ name: 'Group', kind: 'group', children: [{ name: 'Background', x: 0, y: 0, width: 16, height: 16 }] }],
      })
      await call('close_image', { image: grouped })

      await expect(call('pdb_search', { query: 'scale' })).resolves.toMatchObject({ procedures: expect.arrayContaining([expect.objectContaining({ name: 'gimp-image-scale' })]) as object[] })
      // Every procedure has a summary string, an empty one where GIMP has none, as for extension-gimp-help.
      expect(Procedures.parse(await call('pdb_search', { query: 'help' })).procedures.length).toBeGreaterThan(0)
      await expect(call('pdb_run', { procedure: 'gimp-image-scale', arguments: { image: reopened.id, 'new-width': 32, new_height: 16 } }))
        .resolves.toEqual({ procedure: 'gimp-image-scale', status: 'success', values: {} })
      await expect(call('pdb_run', { procedure: 'gimp-gradient-get-uniform-samples', arguments: { gradient: 'FG to BG (RGB)', 'num-samples': 2 } }))
        .resolves.toMatchObject({ values: { 'color-samples': [expect.any(String), expect.any(String)] } })
      // Unit names pdb_run returns are accepted back; a unit the argument refuses fails before GIMP runs the procedure.
      await call('pdb_run', { procedure: 'gimp-image-set-unit', arguments: { image: reopened.id, unit: 'mm' } })
      const { unit } = UnitValue.parse(await call('pdb_run', { procedure: 'gimp-image-get-unit', arguments: { image: reopened.id } })).values
      expect(unit).toBe('millimeters')
      await expect(call('pdb_run', { procedure: 'gimp-image-set-unit', arguments: { image: reopened.id, unit } })).resolves.toMatchObject({ status: 'success' })
      await expect(call('pdb_run', { procedure: 'gimp-image-set-unit', arguments: { image: reopened.id, unit: 'pixel' } }))
        .rejects.toMatchObject({ remoteType: 'ValueError', message: expect.stringContaining('unit must be one of inches, millimeters,') as string })

      await expect(call('execute_python', { code: 'print("made")\nresult = [images[1] if 1 in images else None, float("nan")]' }))
        .resolves.toMatchObject({ output: 'made\n', result: [null, 'nan'] })
      await expect(call('execute_python', { code: 'def fail():\n    raise RuntimeError("boom")\nfail()' }))
        .resolves.toMatchObject({ error: { type: 'RuntimeError', message: 'boom', traceback: expect.stringContaining('line 2, in fail') as string } })
      // Printed output keeps its start and end around the omission marker, and the worker holds no more of it while the code prints.
      const printed = PrintedReply.parse(await call('execute_python', {
        code: 'import tracemalloc\ntracemalloc.start()\nfor _ in range(200_000):\n    print("x" * 1000)\nprint("end")\nresult = tracemalloc.get_traced_memory()[1]\ntracemalloc.stop()',
      }))
      const line = `${'x'.repeat(1000)}\n`
      const marker = `\n[... ${String(200_000 * line.length + 'end\n'.length - 20_000)} characters omitted ...]\n`
      const head = Math.floor((20_000 - marker.length) / 2)
      const tail = 20_000 - marker.length - head
      expect(printed.output).toBe(line.repeat(10).slice(0, head) + marker + `${line.repeat(10)}end\n`.slice(-tail))
      // result is tracemalloc's peak while the loop ran; capturing all of the output took about 225 MiB.
      expect(printed.result).toBeLessThan(1024 * 1024)
      // Integers JavaScript cannot hold exactly arrive as their digits, and an exception message arrives clipped.
      await expect(python('result = [2**53 - 1, 2**53, -10**400]')).resolves.toEqual([9_007_199_254_740_991, '9007199254740992', `-1${'0'.repeat(400)}`])
      const huge = PythonError.parse(await call('execute_python', { code: "raise ValueError('x' * (33 * 1024 * 1024))" })).error
      expect(huge.type).toBe('ValueError')
      expect(huge.message.length).toBeLessThanOrEqual(20_000)

      const frames: string[] = []
      for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
        const frame = ImageInfo.parse(await call('new_image', { width: 16, height: 16 + 2 * index, fill: color })).id
        const path = join(dataRoot, 'frames', `frame${String(index)}.png`)
        await call('export_image', { image: frame, path })
        await call('close_image', { image: frame })
        frames.push(path)
      }
      const sheet = join(dataRoot, 'game', 'art', 'sheet.png')
      await expect(call('make_sprite_sheet', { paths: frames, columns: 2, output: sheet, padding: 1 })).resolves.toMatchObject({
        width: 36, height: 44, rows: 2, frames: [{ index: 0, x: 1, y: 3 }, { index: 1, x: 19, y: 2 }, { index: 2, x: 1, y: 23 }],
      })
      expect(pngSize(await readFile(sheet))).toEqual({ width: 36, height: 44 })

      // After make_seamless, wrap-around neighbors of a diagonal gradient differ no more than neighbors inside it.
      const tile = ImageInfo.parse(await call('new_image', { width: 64, height: 32, fill: 'white' })).id
      await call('draw', { image: tile, action: 'gradient', color: '#ff0000', color2: '#00ff00', x: 0, y: 0, x2: 64, y2: 32 })
      const unblended = Seams.parse(await python(seamsCode(tile)))
      expect(Math.min(unblended.across, unblended.down)).toBeGreaterThan(25)
      await expect(call('make_seamless', { image: tile })).resolves.toMatchObject({ layer: { name: 'Background' } })
      const blended = Seams.parse(await python(seamsCode(tile)))
      expect(blended.inside).toBeLessThanOrEqual(8)
      expect(Math.max(blended.across, blended.down)).toBeLessThanOrEqual(blended.inside + 2)
    } finally {
      await worker.close(3000)
    }
    await expect(worker.exited).resolves.toEqual({ code: 0, signal: null })
  }, 300_000)

  it('serves the tools through a supervised worker and restarts GIMP after its Python process dies', async () => {
    const options: GimpServerOptions = {
      dataRoot, gimpConsolePath: '', readyTimeoutMs: READY_TIMEOUT_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS, toolCallTimeoutMs: 300_000,
      graceMs: 3000, maxLogBytes: 64 * 1024, maxWorkers: 4, workerMemoryBytes: 0, workerCores: 0, minAvailableMemoryBytes: 0,
      workerIdleTimeoutMs: 600_000,
    }
    const workers = new GimpWorkers(options, {
      host,
      bundledRoot: BUNDLED_ROOT,
      workerScript: async () => await materializePayload(new URL('../py/wasd_gimp_worker.py', import.meta.url), dataRoot),
      start: async (spec, signal) => await JsonLineWorker.start(spec, signal),
    })
    const session = 'session:e2e'
    const pool = new WorkerPool({
      app: 'GIMP', root: join(dataRoot, 'workers'), start: async (signal, scope) => await workers.start(signal, scope),
      takeNotes: () => workers.takeNotes(), maxWorkers: options.maxWorkers, idleTimeoutMs: options.workerIdleTimeoutMs,
      minAvailableMemoryBytes: options.minAvailableMemoryBytes, requestTimeoutMs: options.requestTimeoutMs, closeGraceMs: options.graceMs,
    })
    const tools = new Map(gimpTools({
      call: async (method, params, callOptions) => await pool.call(session, method, params, callOptions),
      takeNotes: () => pool.takeNotes(session),
      dataRoot,
      requestTimeoutMs: options.requestTimeoutMs,
      maxTimeoutMs: options.toolCallTimeoutMs,
    }).map(tool => [tool.name, tool]))
    const run = async (tool: string, args: Record<string, unknown> = {}) => await tools.get(tool)!.run(args, new AbortController().signal)
    try {
      const created = await run('new_image', { width: 20, height: 10, fill: '#336699' })
      const shipped = installation!.shipped ? 'the runtime that WASD Engine ships, ' : ''
      const started = new RegExp(`^GIMP 3\\.\\d+\\.\\d+ started \\(${shipped}Python 3\\.\\d+\\.\\d+\\) with no images open\\.\\n\\n`, 'u')
      expect(created.text).toMatch(started)
      expect(created.text.replace(started, '')).toMatch(/^Created image \d+, 20x10 with layer "Background" \(id \d+\), filled #336699\.$/)
      const image = Number(/Created image (\d+)/.exec(created.text)![1])
      const shown = await run('snapshot', { image, max_size: 100 })
      expect(shown.text).toBe(`Image ${String(image)} (20x10) shown at 100x50 (enlarged 5x without smoothing).`)
      expect(pngSize(shown.images![0]!.data!)).toEqual({ width: 100, height: 50 })
      const clear = Number(/Created image (\d+)/.exec((await run('new_image', { width: 8, height: 8 })).text)![1])
      await expect(run('snapshot', { image: clear })).resolves.toMatchObject({
        text: `Image ${String(clear)} (8x8) shown at 256x256 (enlarged 32x without smoothing). Transparent areas show as a gray checkerboard.`,
      })
      const webp = join(dataRoot, 'tool-export', 'tile.webp')
      await expect(run('export_image', { image, path: webp, quality: 90 })).resolves.toMatchObject({ text: expect.stringContaining(`to ${webp} (WEBP, 20x10, `) as string })
      await expect(run('pdb_search', { query: 'help' })).resolves.toMatchObject({ text: expect.stringMatching(/^\d+ procedures match "help"\.\n/) as string })
      await expect(run('execute_python', { code: 'raise ValueError("bad input")' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('ValueError: bad input') as string })

      const crashedAt = Date.now()
      const crash = run('execute_python', { code: 'import os\nos._exit(3)' })
      await expect(crash).rejects.toBeInstanceOf(WorkerError)
      await expect(crash).rejects.toMatchObject({ code: 'WORKER_EXITED', message: expect.stringContaining('state') as string })
      expect(Date.now() - crashedAt).toBeLessThan(30_000)
      const fresh = await run('list_images')
      expect(fresh.text).toMatch(started)
      expect(fresh.text.replace(started, '')).toBe('{"images":[],"count":0}')
    } finally {
      await pool.close()
    }
  }, 300_000)

  it.skipIf(process.platform === 'win32')('stops GIMP when the server dies during a request', async () => {
    const [command, ...args] = gimpWorkerArgv(installation!.console, WORKER)
    const gimp = spawn(command, args, {
      cwd: dataRoot, env: workerEnvironment(process.env, gimpProfileDirectory(dataRoot, process.platform), installation!.environment),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true,
    })
    const pid = gimp.pid!
    const exited = new Promise<NodeJS.Signals | null>((resolve) => { gimp.once('exit', (_code, signal) => { resolve(signal) }) })
    const [stdin, stdout, stderr, replies] = gimp.stdio
    try {
      stdout.resume()
      stderr.resume()
      const ready = new Promise<boolean>((resolve) => {
        replies!.once('data', () => { resolve(true) })
        void exited.then(() => { resolve(false) })
      })
      await expect(Promise.race([ready, sleep(READY_TIMEOUT_MS, false, { ref: false })])).resolves.toBe(true)
      stdin.write(`${JSON.stringify({ id: 1, method: 'execute_python', params: { code: 'while True: pass' } })}\n`)
      await sleep(1000)
      // The server is gone: every pipe to GIMP closes while the request runs.
      for (const pipe of [stdin, stdout, stderr, replies]) pipe!.destroy()
      await expect(Promise.race([exited, sleep(15_000, 'still running', { ref: false })])).resolves.toBe('SIGKILL')
      await expect(groupEnds(pid, 5000)).resolves.toBe(true)
    } finally {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // ESRCH: the watchdog already stopped the whole group.
      }
    }
  }, 300_000)
})
