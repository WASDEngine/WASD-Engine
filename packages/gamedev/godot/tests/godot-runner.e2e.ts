/**
 * The Godot tools against the real LibGodot runner: import, windowless run, screenshot, input, logs with a
 * script error, scene inspection, frame-exact steps, a step that the Game tab ends, frames, input and frames while
 * game time stands still, a bounded game-time wait, a cancelled input sequence, a queued input sequence that its
 * real-time limit ends, a static check that runs no autoload, and a letterboxed stretch mode.
 *
 * Set WASD_LIBGODOT_DIR to a folder holding `godot_runner` and the LibGodot library under the name that
 * `wasdengine/libgodot/build.sh` installs: `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`.
 */
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { callTool, compose, text, type Composition } from './composition.ts'

const GODOT_PLATFORMS: Partial<Record<NodeJS.Platform, { readonly name: string; readonly suffix: string }>> = {
  darwin: { name: 'macos', suffix: 'dylib' },
  linux: { name: 'linuxbsd', suffix: 'so' },
  win32: { name: 'windows', suffix: 'dll' },
}
const GODOT_ARCHES: Partial<Record<string, string>> = { arm64: 'arm64', x64: 'x86_64' }

const runtimeDir = process.env.WASD_LIBGODOT_DIR
const platform = GODOT_PLATFORMS[process.platform]
const arch = GODOT_ARCHES[process.arch]
const library = runtimeDir === undefined || platform === undefined || arch === undefined
  ? undefined
  : join(runtimeDir, `libgodot.${platform.name}.editor.${arch}.${platform.suffix}`)
const runner = runtimeDir === undefined ? undefined : join(runtimeDir, process.platform === 'win32' ? 'godot_runner.exe' : 'godot_runner')

const AUTOLOAD_MARKER = 'autoload_ran.txt'

const PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="RunnerTest"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n\n[autoload]\n\nGameState="*res://game_state.gd"\n',
  'game_state.gd': [
    'extends Node', 'var score := 42', 'func _init():', `\tFileAccess.open("res://${AUTOLOAD_MARKER}", FileAccess.WRITE).store_string("ran")`,
    'func _ready():', '\tprint("GameState autoload ready")', '',
  ].join('\n'),
  'player.gd': [
    'extends ColorRect', 'var speed := 300.0', 'func _ready():', '\tprint("player ready at ", position)', 'func _process(delta):',
    '\tvar dir := Input.get_axis("ui_left", "ui_right")', '\tposition.x += dir * speed * delta', 'func _unhandled_input(event):',
    '\tif event is InputEventKey and event.pressed and event.keycode == KEY_E:', '\t\tvar missing = null', '\t\tmissing.explode()',
    '\tif event is InputEventMouseButton and event.pressed:', '\t\tprint("click at ", event.position)', '',
  ].join('\n'),
  'counter.gd': 'extends Node\nvar frames := 0\nfunc _process(_delta):\n\tframes += 1\n',
  'keys.gd': [
    'extends Node', 'func _unhandled_input(event):', '\tif event is InputEventKey and event.keycode == KEY_T and event.pressed:',
    '\t\tEngine.time_scale = 0.0 if Engine.time_scale > 0.0 else 1.0', '\t\tprint("time scale ", Engine.time_scale)',
    '\telif event is InputEventKey and event.keycode == KEY_W:', '\t\tprint("W ", "down" if event.pressed else "up")', '',
  ].join('\n'),
  'uses_state.gd': 'extends Node\nfunc total() -> int:\n\treturn GameState.score + 1\n',
  'main.tscn': [
    '[gd_scene format=3]', '', '[ext_resource type="Script" path="res://player.gd" id="1"]',
    '[ext_resource type="Script" path="res://counter.gd" id="2"]', '[ext_resource type="Script" path="res://keys.gd" id="3"]', '',
    '[node name="Main" type="Node2D"]', '',
    '[node name="Bg" type="ColorRect" parent="."]', 'offset_right = 640.0', 'offset_bottom = 360.0', 'color = Color(0.2, 0.4, 0.8, 1)', '',
    '[node name="Label" type="Label" parent="."]', 'offset_left = 100.0', 'offset_top = 100.0', 'text = "Hello from libgodot"', '',
    '[node name="Player" type="ColorRect" parent="."]', 'offset_left = 300.0', 'offset_top = 200.0', 'offset_right = 340.0', 'offset_bottom = 240.0',
    'color = Color(1, 0.8, 0.1, 1)', 'script = ExtResource("1")', '',
    '[node name="Counter" type="Node" parent="."]', 'script = ExtResource("2")', '',
    '[node name="Keys" type="Node" parent="."]', 'script = ExtResource("3")', '',
  ].join('\n'),
  'broken.gd': 'extends Node\nfunc _ready():\n\tif true\n\t\tprint("missing colon")\n',
}

// A 320x180 base size that stretch mode canvas_items keeps at its aspect: an 800x800 window shows it as 800x450
// between 175-pixel bars, and the red target at (40, 30, 20, 20) at window pixels (100, 250) to (150, 300).
const STRETCH_PROJECT = {
  'project.godot': [
    'config_version=5', '', '[application]', '', 'config/name="StretchTest"', 'run/main_scene="res://main.tscn"', 'config/features=PackedStringArray("4.7")', '',
    '[display]', '', 'window/size/viewport_width=320', 'window/size/viewport_height=180', 'window/stretch/mode="canvas_items"', 'window/stretch/aspect="keep"', '',
  ].join('\n'),
  'main.gd': [
    'extends Node2D', 'const TARGET := Rect2(40, 30, 20, 20)', 'func _draw():', '\tdraw_rect(Rect2(0, 0, 320, 180), Color(0.1, 0.5, 0.2))',
    '\tdraw_rect(TARGET, Color(1, 0, 0))', 'func _input(event):', '\tif event is InputEventMouseButton and event.pressed:',
    '\t\tprint("click hit=", TARGET.has_point(event.position))', '',
  ].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
}

/** Pixels of a decoded PNG. */
interface DecodedPng {
  readonly width: number
  readonly height: number
  pixel(x: number, y: number): number[]
}

function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner
  const [toLeft, toUp, toCorner] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)]
  if (toLeft <= toUp && toLeft <= toCorner) return left
  return toUp <= toCorner ? up : corner
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG, the kind Godot's `Image.save_png_to_buffer` writes. */
function decodePng(png: Buffer): DecodedPng {
  const data: Buffer[] = []
  let [width, height, channels] = [0, 0, 0]
  for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
    const body = png.subarray(offset + 8, offset + 8 + png.readUInt32BE(offset))
    const type = png.toString('latin1', offset + 4, offset + 8)
    if (type === 'IHDR') {
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) throw new Error('expected an 8-bit non-interlaced RGB or RGBA PNG')
      ;[width, height, channels] = [body.readUInt32BE(0), body.readUInt32BE(4), body[9] === 6 ? 4 : 3]
    } else if (type === 'IDAT') {
      data.push(body)
    }
  }
  const filtered = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  const at = (buffer: Buffer, index: number): number => buffer[index] as number
  for (let y = 0; y < height; y += 1) {
    const filter = at(filtered, y * (stride + 1))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? at(pixels, y * stride + x - channels) : 0
      const up = y > 0 ? at(pixels, (y - 1) * stride + x) : 0
      const corner = x >= channels && y > 0 ? at(pixels, (y - 1) * stride + x - channels) : 0
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter] as number
      pixels[y * stride + x] = (at(filtered, y * (stride + 1) + 1 + x) + predictor) & 0xff
    }
  }
  return { width, height, pixel: (x, y) => [...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3)] }
}

/** Read up to `count` frame records from a run's frame route, for at most `timeoutMs`. */
async function readFrames(route: ConnectionFetchRoute, runId: string, count: number, timeoutMs: number): Promise<Buffer[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const records: Buffer[] = []
  try {
    const response = await route.fetch(new Request(`http://127.0.0.1/api/godot.frames?session=owner&run=${runId}`, { signal: controller.signal }))
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    let buffered = Buffer.alloc(0)
    while (records.length < count) {
      const { value, done } = await reader.read()
      if (done) break
      buffered = Buffer.concat([buffered, value])
      while (buffered.length >= 12 && buffered.length >= 12 + buffered.readUInt32LE(0)) {
        const length = 12 + buffered.readUInt32LE(0)
        records.push(buffered.subarray(0, length))
        buffered = buffered.subarray(length)
      }
    }
  } catch (error) {
    // Reaching `timeoutMs` aborts the read; the caller asserts on the records that arrived before it.
    if (!controller.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return records
}

describe.skipIf(runner === undefined || library === undefined || !existsSync(runner) || !existsSync(library))('godot tools on the real LibGodot runner', () => {
  let c: Composition
  let runId = ''
  const frameRoute = (): ConnectionFetchRoute => {
    const route = [...c.routes][0]
    if (route === undefined) throw new Error('expected the frames route')
    return route
  }
  const counted = async (): Promise<number> => Number(text(await callTool(c, 'godot_eval', { expression: 'scene.get_node("Counter").frames' })).replace('int: ', ''))

  beforeAll(async () => {
    c = await compose({
      game: {},
      config: {
        runnerPath: runner as string, libgodotPath: library as string, importBeforeRun: true,
        startTimeoutMs: 60_000, requestTimeoutMs: 5000, stopGraceMs: 3000,
      },
    })
    for (const [name, content] of Object.entries(PROJECT)) await writeFile(join(c.project, name), content)
    await mkdir(join(c.dir.root, 'data'), { recursive: true })
  }, 60_000)

  afterAll(async () => { await c?.cleanup() }, 30_000)

  it('runs the game windowless and reports startup facts', async () => {
    const result = await callTool(c, 'godot_run', { width: 640, height: 360 })
    expect(result.isError, text(result)).toBe(false)
    expect(text(result)).toContain('The game is running: RunnerTest')
    expect(result.value).toMatchObject({ phase: 'running', width: 640, height: 360 })
    runId = (result.value as { runId: string }).runId
    if (process.platform === 'darwin') expect(result.value).toMatchObject({ windowless: true, renderer: expect.stringContaining('metal') as string })
  }, 240_000)

  it('captures a PNG screenshot and inspects the scene', async () => {
    const shot = await callTool(c, 'godot_screenshot')
    expect(shot.isError, text(shot)).toBe(false)
    expect(shot.value).toMatchObject({ windowWidth: 640, windowHeight: 360 })
    expect(Buffer.from(c.saved.at(-1)?.data as Uint8Array).subarray(0, 4).toString('latin1')).toBe('\u0089PNG')
    const tree = await callTool(c, 'godot_scene_tree', { depth: 2 })
    expect(text(tree)).toContain('Player (ColorRect) res://player.gd position (300, 200)')
    const position = await callTool(c, 'godot_eval', { expression: 'scene.get_node("Player").position.x' })
    expect(text(position)).toBe('float: 300')
  }, 60_000)

  it('moves the player with an input action and reports the script error a key causes', async () => {
    const moved = await callTool(c, 'godot_input', { events: [{ kind: 'action', action: 'ui_right', pressed: true, hold: 0.3 }, { wait: 0.5 }] })
    expect(moved.isError, text(moved)).toBe(false)
    const position = await callTool(c, 'godot_eval', { expression: 'scene.get_node("Player").position.x' })
    expect(Number(text(position).replace('float: ', ''))).toBeGreaterThan(330)
    const pressed = await callTool(c, 'godot_input', { events: [{ kind: 'key', key: 'E', pressed: true }, { kind: 'key', key: 'E', pressed: false }, { wait: 0.2 }] })
    expect(text(pressed)).toContain('New errors since your last Godot call:')
    expect(text(pressed)).toContain("res://player.gd:11 (_unhandled_input): Invalid call. Nonexistent function 'explode' in base 'Nil'.")
    const logs = await callTool(c, 'godot_logs', { since: 0 })
    expect(text(logs)).toContain('player ready at (300.0, 200.0)')
    expect(text(logs)).toContain('GameState autoload ready')
    expect(existsSync(join(c.project, AUTOLOAD_MARKER))).toBe(true)
  }, 60_000)

  it('pauses, steps exactly the requested frames, and resumes', async () => {
    expect(text(await callTool(c, 'godot_control', { action: 'pause' }))).toMatch(/paused/u)
    const before = await counted()
    expect(text(await callTool(c, 'godot_control', { action: 'step', frames: 1 }))).toMatch(/^Ran 1 frames\. The game is paused/u)
    expect(await counted()).toBe(before + 1)
    expect(text(await callTool(c, 'godot_control', { action: 'step', frames: 3 }))).toMatch(/^Ran 3 frames\. The game is paused/u)
    expect(await counted()).toBe(before + 4)
    expect(text(await callTool(c, 'godot_control', { action: 'resume' }))).toMatch(/running/u)
  }, 60_000)

  it('ends a step when the Game tab resumes the game, and the game stays running', async () => {
    await callTool(c, 'godot_control', { action: 'pause' })
    const step = callTool(c, 'godot_control', { action: 'step', frames: 100_000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    await c.godot.control(c.owner.agent.id, { action: 'resume' }, new AbortController().signal)
    expect(text(await step)).toMatch(/^Ran \d+ frames\b.*\. The game is running/u)
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(text(await callTool(c, 'godot_eval', { expression: 'tree.paused' }))).toBe('bool: false')
  }, 60_000)

  it('streams JPEG frames to the Game tab', async () => {
    const controller = new AbortController()
    const response = await frameRoute().fetch(new Request(`http://127.0.0.1/api/godot.frames?session=owner&run=${runId}`, { signal: controller.signal }))
    expect(response.status).toBe(200)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const record = Buffer.from((await reader.read()).value as Uint8Array)
    expect(record.readUInt32LE(0)).toBe(record.length - 12)
    expect([record.readUInt16LE(4), record.readUInt16LE(6)]).toEqual([640, 360])
    expect(record.subarray(12, 14)).toEqual(Buffer.from([0xff, 0xd8]))
    controller.abort()
    expect(await reader.read()).toMatchObject({ done: true })
  }, 30_000)

  it('runs input waits, holds, and frames in real time while game time stands still', async () => {
    const toggleTimeScale = [{ kind: 'key', key: 'T', pressed: true }, { kind: 'key', key: 'T', pressed: false }]
    await callTool(c, 'godot_input', { events: toggleTimeScale })
    const started = Date.now()
    const held = await callTool(c, 'godot_input', { events: [{ kind: 'key', key: 'W', pressed: true, hold: 0.2 }, { wait: 0.4 }] })
    expect(held.isError, text(held)).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
    const logs = text(await callTool(c, 'godot_logs', { since: 0 }))
    expect(logs).toMatch(/time scale 0/u)
    expect(logs).toContain('W up')
    expect(await readFrames(frameRoute(), runId, 3, 5000)).toHaveLength(3)
    await callTool(c, 'godot_input', { events: toggleTimeScale })
  }, 60_000)

  it('ends a game-time wait at its real-time limit, and drops an abandoned input sequence and its presses', async () => {
    const toggleTimeScale = [{ kind: 'key', key: 'T', pressed: true }, { kind: 'key', key: 'T', pressed: false }]
    await callTool(c, 'godot_input', { events: toggleTimeScale })
    const waited = await callTool(c, 'godot_wait', { seconds: 0.5 })
    expect(waited.isError, text(waited)).toBe(false)
    expect(waited.value).toMatchObject({ timedOut: true, frames: expect.any(Number) as number })
    await callTool(c, 'godot_logs')
    const controller = new AbortController()
    const abandoned = callTool(c, 'godot_input', { events: [{ kind: 'key', key: 'W', pressed: true }, { wait: 60 }] }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 300))
    controller.abort()
    await Promise.allSettled([abandoned])
    const next = await callTool(c, 'godot_input', { events: [...toggleTimeScale, { wait: 0.2 }] })
    expect(next.isError, text(next)).toBe(false)
    expect(text(await callTool(c, 'godot_logs'))).toMatch(/W down[\s\S]*W up[\s\S]*time scale 1/u)
  }, 60_000)

  it('ends an input sequence at its real-time limit while it waits behind a longer one', async () => {
    // The second sequence's limit is its 0.1 s wait, two frames at 10 per second, and the 5 s requestTimeoutMs,
    // which runs out while the first sequence still holds the queue for 6 s.
    const long = callTool(c, 'godot_input', { events: [{ wait: 6 }] })
    await new Promise(resolve => setTimeout(resolve, 100))
    const queued = await callTool(c, 'godot_input', { events: [{ kind: 'key', key: 'W', pressed: true }, { wait: 0.1 }, { kind: 'key', key: 'W', pressed: false }] })
    expect(queued.value).toMatchObject({ events: 0, timedOut: true })
    expect(text(queued)).toMatch(/^The input ended at its real-time limit after 0 of its events/u)
    expect((await long).value).toMatchObject({ events: 1, timedOut: false })
  }, 60_000)

  it('checks scripts without running autoload code and stops the game', async () => {
    await rm(join(c.project, AUTOLOAD_MARKER), { force: true })
    const checked = await callTool(c, 'godot_check')
    expect(checked.isError, text(checked)).toBe(false)
    expect(text(checked)).toContain('[script_error] res://broken.gd:3: Parse Error: Expected ":" after "if" condition.')
    expect(checked.value).toMatchObject({ checked: 6, total: 6, files: [{ path: 'res://broken.gd' }] })
    expect(existsSync(join(c.project, AUTOLOAD_MARKER))).toBe(false)
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 120_000)

  it('shows a letterboxed stretch mode where the window shows it, so a click at a screenshot pixel lands there', async () => {
    const dir = join(c.dir.root, 'work', 'stretch')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(STRETCH_PROJECT)) await writeFile(join(dir, name), content)
    const started = await callTool(c, 'godot_run', { project: 'stretch', width: 800, height: 800 })
    expect(started.isError, text(started)).toBe(false)
    await callTool(c, 'godot_wait', { frames: 5 })
    const shot = await callTool(c, 'godot_screenshot')
    expect(shot.value).toMatchObject({ windowWidth: 800, windowHeight: 800 })
    // The fake attachment store reports a fixed model image size, so this reads the harness's PNG, and the click
    // below names window pixels.
    const image = decodePng(Buffer.from(c.saved.at(-1)?.data as Uint8Array))
    expect([image.width, image.height]).toEqual([800, 800])
    expect([image.pixel(400, 100), image.pixel(400, 700)]).toEqual([[0, 0, 0], [0, 0, 0]])
    expect(image.pixel(400, 400)).not.toEqual([0, 0, 0])
    const red = { left: image.width, top: image.height, right: -1, bottom: -1 }
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const [r, g, b] = image.pixel(x, y) as [number, number, number]
        if (r <= 200 || g >= 60 || b >= 60) continue
        red.left = Math.min(red.left, x)
        red.top = Math.min(red.top, y)
        red.right = Math.max(red.right, x)
        red.bottom = Math.max(red.bottom, y)
      }
    }
    expect(red).toEqual({ left: 100, top: 250, right: 149, bottom: 299 })
    const click = { kind: 'mouse_button', button: 'left', x: (red.left + red.right + 1) / 2, y: (red.top + red.bottom + 1) / 2 }
    await callTool(c, 'godot_input', { coordinate_space: 'window', events: [{ ...click, pressed: true }, { ...click, pressed: false }, { wait: 0.1 }] })
    expect(text(await callTool(c, 'godot_logs', { since: 0 }))).toContain('click hit=true')
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)
})
