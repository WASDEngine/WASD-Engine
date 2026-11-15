/**
 * The capture tools against the real LibGodot runner, on a 3D scene: launch options that the game reads, GDScript code
 * with lambdas, engine singletons, autoloads, `await`, and its compile and script errors, an expression with
 * singletons, a screenshot of a window region at full size, views of the game camera's picture at another size, of a
 * node from an angle, of a skeleton bone, of a node alone, and of a scene loaded alone whose script sets its material,
 * posed in an animation, and a recording whose frames a window reads and whose upload becomes the video file, also one
 * by game frames that a slow window reads, during which the Host stops reading the game and the game waits for it.
 *
 * Set WASD_LIBGODOT_DIR to a folder holding `godot_runner` and the LibGodot library under the name that
 * `wasdengine/libgodot/build.sh` installs: `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`.
 */
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GodotRun } from '../src/run.ts'
import type { GodotVideoEncodeEvent, GodotVideoEncodeResult } from '../src/types.ts'
import { RECORDINGS_GITIGNORE } from '../src/video.ts'
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

/**
 * A 640x360 window over a lit 3D scene: a red box (Hero) with a one-bone skeleton whose Head bone sits at y 1.6, a blue
 * box beside it, and the GameState autoload. prop.tscn holds a sphere whose script makes it green in `_ready`, and an
 * animation that lifts it from y 0 to y 1 over one second.
 */
const PROJECT = {
  'project.godot': [
    'config_version=5', '', '[application]', '', 'config/name="CaptureTest"', 'run/main_scene="res://main.tscn"', 'config/features=PackedStringArray("4.7")', '',
    '[autoload]', '', 'GameState="*res://game_state.gd"', '',
    '[display]', '', 'window/size/viewport_width=640', 'window/size/viewport_height=360', '',
  ].join('\n'),
  'game_state.gd': 'extends Node\nvar score := 42\n',
  'prop.gd': 'extends Node3D\nfunc _ready():\n\tvar material := StandardMaterial3D.new()\n\tmaterial.albedo_color = Color(0, 1, 0)\n\t$Mesh.material_override = material\n',
  'prop.tscn': [
    '[gd_scene format=3]', '', '[ext_resource type="Script" path="res://prop.gd" id="1"]', '',
    '[sub_resource type="SphereMesh" id="sphere"]', '',
    '[sub_resource type="Animation" id="bob"]', 'resource_name = "bob"', 'length = 1.0',
    'tracks/0/type = "position_3d"', 'tracks/0/imported = false', 'tracks/0/enabled = true', 'tracks/0/path = NodePath("Mesh")',
    'tracks/0/interp = 1', 'tracks/0/loop_wrap = true', 'tracks/0/keys = PackedFloat32Array(0, 1, 0, 0, 0, 1, 1, 0, 1, 0)', '',
    '[sub_resource type="AnimationLibrary" id="library"]', '_data = {&"bob": SubResource("bob")}', '',
    '[node name="Prop" type="Node3D"]', 'script = ExtResource("1")', '',
    '[node name="Mesh" type="MeshInstance3D" parent="."]', 'mesh = SubResource("sphere")', '',
    '[node name="Player" type="AnimationPlayer" parent="."]', 'libraries = {&"": SubResource("library")}', '',
  ].join('\n'),
  'main.tscn': [
    '[gd_scene format=3]', '',
    '[sub_resource type="BoxMesh" id="box"]', '',
    '[sub_resource type="StandardMaterial3D" id="red"]', 'albedo_color = Color(1, 0, 0, 1)', '',
    '[sub_resource type="StandardMaterial3D" id="blue"]', 'albedo_color = Color(0, 0, 1, 1)', '',
    '[sub_resource type="Environment" id="env"]', 'background_mode = 1', 'background_color = Color(0.1, 0.1, 0.1, 1)', 'ambient_light_source = 2', 'ambient_light_color = Color(0.5, 0.5, 0.5, 1)', '',
    '[node name="Main" type="Node3D"]', '',
    '[node name="Camera" type="Camera3D" parent="."]', 'transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 6)', 'current = true', '',
    '[node name="Sun" type="DirectionalLight3D" parent="."]', 'transform = Transform3D(1, 0, 0, 0, 0.5, 0.866, 0, -0.866, 0.5, 0, 5, 0)', '',
    '[node name="World" type="WorldEnvironment" parent="."]', 'environment = SubResource("env")', '',
    '[node name="Hero" type="Node3D" parent="."]', 'transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0.5, 0)', '',
    '[node name="Body" type="MeshInstance3D" parent="Hero"]', 'mesh = SubResource("box")', 'surface_material_override/0 = SubResource("red")', '',
    '[node name="Skeleton" type="Skeleton3D" parent="Hero"]',
    'bones/0/name = "Head"', 'bones/0/parent = -1', 'bones/0/rest = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1.1, 0)', 'bones/0/enabled = true',
    'bones/0/position = Vector3(0, 1.1, 0)', 'bones/0/rotation = Quaternion(0, 0, 0, 1)', 'bones/0/scale = Vector3(1, 1, 1)', '',
    '[node name="Other" type="MeshInstance3D" parent="."]', 'transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1.5, 0.5, 0)', 'mesh = SubResource("box")', 'surface_material_override/0 = SubResource("blue")', '',
  ].join('\n'),
}

/** A 1920x1080 window of per-pixel value noise, whose JPEG frames are large. */
const NOISE_PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="NoiseTest"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n',
  'main.gd': [
    'extends Node2D', 'func _ready():', '\tvar noise := FastNoiseLite.new()', '\tnoise.noise_type = FastNoiseLite.TYPE_VALUE', '\tnoise.frequency = 1.0',
    '\tvar rect := TextureRect.new()', '\trect.texture = ImageTexture.create_from_image(noise.get_image(1920, 1080))', '\tadd_child(rect)', '',
  ].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
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

/** The count of each dominant color among an image's pixels: red, green, or blue. */
function dominant(image: DecodedPng): { readonly red: number; readonly green: number; readonly blue: number } {
  const counts = { red: 0, green: 0, blue: 0 }
  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      const [r, g, b] = image.pixel(x, y) as [number, number, number]
      if (r > 100 && r > 2 * g && r > 2 * b) counts.red += 1
      else if (g > 100 && g > 2 * r && g > 2 * b) counts.green += 1
      else if (b > 100 && b > 2 * r && b > 2 * g) counts.blue += 1
    }
  }
  return counts
}

describe.skipIf(runner === undefined || library === undefined || !existsSync(runner) || !existsSync(library))('capture tools on the real LibGodot runner', () => {
  let c: Composition
  /** The image bytes the composition's attachment store saved last. */
  const lastImage = (): Buffer => Buffer.from((c.saved.at(-1) as { readonly data: Uint8Array }).data)

  beforeAll(async () => {
    c = await compose({
      game: {},
      config: {
        runnerPath: runner as string, libgodotPath: library as string, importBeforeRun: true,
        startTimeoutMs: 60_000, requestTimeoutMs: 10_000, stopGraceMs: 3000, hiddenFps: 0,
      },
    })
    for (const [name, content] of Object.entries(PROJECT)) await writeFile(join(c.project, name), content)
    await mkdir(join(c.dir.root, 'data'), { recursive: true })
  }, 60_000)

  afterAll(async () => { await c?.cleanup() }, 30_000)

  it('starts the game with launch options it reads, and runs GDScript code with lambdas, singletons, autoloads, and await', async () => {
    const started = await callTool(c, 'godot_run', { args: ['--capture-mode', 'level=3'], engine_args: ['--max-fps', '30'] })
    expect(started.isError, text(started)).toBe(false)
    expect(text(started)).toContain('Godot options --max-fps 30, game arguments ["--capture-mode","level=3"]')
    const args = await callTool(c, 'godot_eval', { code: 'return OS.get_cmdline_user_args().slice(0, 2)' })
    expect(text(args)).toBe('PackedStringArray: ["--capture-mode","level=3"]')
    const code = [
      'var doubled = [1, 2, 3].map(func(value): return value * 2)',
      'await get_tree().process_frame',
      'return {"doubled": doubled, "fps": Engine.max_fps, "score": GameState.score, "hero": scene.get_node("Hero").position.x}',
    ].join('\n')
    expect(text(await callTool(c, 'godot_eval', { code }))).toBe('Dictionary: {"doubled":[2,4,6],"fps":30,"hero":-1,"score":42}')
    expect(text(await callTool(c, 'godot_eval', { code: '[4, 5].map(func(value): return value + node.position.y)', node: '/root/Main/Hero' }))).toBe('Array: [4.5,5.5]')
    expect(text(await callTool(c, 'godot_eval', { expression: 'Engine.get_version_info()["major"] + GameState.score' }))).toBe('int: 46')
    // The code may name its own variables after the names it is given.
    expect(text(await callTool(c, 'godot_eval', { code: 'var names = []\nfor node in scene.get_children():\n\tnames.append(str(node.name))\nreturn names' })))
      .toBe('Array: ["Camera","Sun","World","Hero","Other"]')
    const broken = await callTool(c, 'godot_eval', { code: 'var value := 1\nreturn value +' })
    expect(broken.isError).toBe(true)
    expect(text(broken)).toMatch(/^Error: the code does not compile:\nline 2: Parse Error: Expected expression after "\+" operator\.$/u)
    const failing = await callTool(c, 'godot_eval', { code: 'var missing = null\nmissing.explode()\nreturn 1' })
    expect(failing.isError).toBe(true)
    expect(text(failing)).toMatch(/^Error: the code stopped at an error:\nline 2: .*explode/u)
    const waiting = await callTool(c, 'godot_eval', { code: 'await get_tree().create_timer(30.0).timeout\nreturn 1', timeout_seconds: 1 })
    expect(text(waiting)).toContain('the code did not finish within its time limit')
  }, 240_000)

  it('captures a region of the window at its own pixels, grown by a whole factor', async () => {
    const shot = await callTool(c, 'godot_screenshot', { region: { x: 100, y: 50, width: 200, height: 150 }, coordinate_space: 'window' })
    expect(shot.isError, text(shot)).toBe(false)
    expect(text(shot)).toContain('showing the 200x150 px region at (100, 50) of a 640x360 px game window')
    const image = decodePng(lastImage())
    expect([image.width, image.height]).toEqual([600, 450])
  }, 60_000)

  it('draws views: the game camera at another size, a node from an angle, a bone, a node alone, and a scene alone', async () => {
    const wide = await callTool(c, 'godot_view', { width: 1280, height: 720 })
    expect(wide.isError, text(wide)).toBe(false)
    const camera = decodePng(lastImage())
    expect([camera.width, camera.height]).toEqual([1280, 720])
    expect(dominant(camera).red).toBeGreaterThan(100)
    expect(dominant(camera).blue).toBeGreaterThan(100)

    const hero = await callTool(c, 'godot_view', { node: '/root/Main/Hero', yaw: 0, pitch: 0, width: 400, height: 400 })
    expect(text(hero)).toMatch(/^View of \/root\/Main\/Hero at frame \d+: 400x400 px; camera at \(-1, 0\.5, [\d.]+\) /u)
    expect(text(hero)).toContain('looking along (0, 0, -1)')
    const framed = dominant(decodePng(lastImage()))
    expect(framed.red).toBeGreaterThan(framed.blue)

    const head = await callTool(c, 'godot_view', { node: '/root/Main/Hero', bone: 'Head', yaw: 0, pitch: 0, width: 200, height: 200 })
    expect(text(head)).toContain('Framed 0.250 m around (-1, 1.6, 0)')

    const alone = await callTool(c, 'godot_view', { node: '/root/Main/Hero', isolate: true, yaw: 90, pitch: 0, distance: 3, width: 400, height: 400 })
    expect(alone.isError, text(alone)).toBe(false)
    expect(dominant(decodePng(lastImage())).blue).toBe(0)

    const prop = await callTool(c, 'godot_view', { asset: 'res://prop.tscn', animation: 'bob', time: 0.5, width: 320, height: 320 })
    expect(text(prop), text(prop)).toMatch(/Framed [\d.]+ m around \(0, 0\.5, 0\)/u)
    expect(dominant(decodePng(lastImage())).green).toBeGreaterThan(200)

    const missing = await callTool(c, 'godot_view', { asset: 'res://prop.tscn', animation: 'spin' })
    expect(text(missing)).toContain('the asset has no animation spin; it has bob')
  }, 120_000)

  it('records the game while a window reads its frames, and saves the window\'s upload', async () => {
    const route = [...c.routes].find(candidate => candidate.path === '/api/godot.recording') as ConnectionFetchRoute
    const upload = [...c.routes].find(candidate => candidate.path === '/api/godot.video') as ConnectionFetchRoute
    const read: Array<{ readonly index: number; readonly timeMs: number; readonly width: number; readonly height: number }> = []
    const stop = c.ctx.on('godot/record', async (request: GodotVideoEncodeEvent): Promise<GodotVideoEncodeResult> => {
      const url = `http://127.0.0.1/api/godot.recording?session=${request.sessionId}&run=${request.runId}&recording=${request.recording}`
      const response = await route.fetch(new Request(url))
      const bytes = Buffer.from(await response.arrayBuffer())
      let first: Buffer | undefined
      for (let offset = 0; offset < bytes.length;) {
        const length = bytes.readUInt32LE(offset)
        read.push({
          index: bytes.readUInt32LE(offset + 4),
          timeMs: bytes.readUInt32LE(offset + 8),
          width: bytes.readUInt16LE(offset + 12),
          height: bytes.readUInt16LE(offset + 14),
        })
        first ??= bytes.subarray(offset + 16, offset + 16 + length)
        offset += 16 + length
      }
      const video = Buffer.from(`video of ${read.length} frames`)
      const uploaded = await upload.fetch(new Request(url.replace('godot.recording', 'godot.video'), { method: 'POST', body: new Uint8Array(video) }))
      expect(uploaded.status).toBe(204)
      const last = read.at(-1) as { readonly timeMs: number }
      return {
        codec: 'H.264', frames: read.length, seconds: last.timeMs / 1000, width: 640, height: 360, bytes: video.length,
        sheet: { data: (first as Buffer).toString('base64'), width: 640, height: 360, times: [0, last.timeMs / 1000] },
      }
    })
    try {
      const recorded = await callTool(c, 'godot_record', { seconds: 1.5, fps: 20, sheet_frames: 2, events: [{ kind: 'key', key: 'W', pressed: true, hold: 0.5 }] })
      expect(recorded.isError, text(recorded)).toBe(false)
      const path = join(c.project, 'recordings')
      expect(text(recorded)).toMatch(new RegExp(`^Recorded [\\d.]+ s at 20 fps, at real time: \\d+ frames of 640x360 px in H\\.264, saved to ${path.replaceAll('/', '\\/')}\\/CaptureTest_[\\d_-]+\\.mp4`, 'u'))
      expect(read.length).toBeGreaterThanOrEqual(20)
      expect(read.every((frame, index) => frame.index === index && frame.width === 640 && frame.height === 360)).toBe(true)
      expect(read.every((frame, index) => index === 0 || frame.timeMs > (read[index - 1] as { readonly timeMs: number }).timeMs)).toBe(true)
      expect(existsSync(join(path, '.gdignore'))).toBe(true)
      expect(await readFile(join(path, '.gitignore'), 'utf8')).toBe(RECORDINGS_GITIGNORE)
      const saved = (recorded.value as { readonly path: string }).path
      expect(await readFile(saved, 'utf8')).toBe(`video of ${read.length} frames`)
      expect((await stat(saved)).size).toBe((recorded.value as { readonly bytes: number }).bytes)
      expect(c.saved.at(-1)?.mediaType).toBe('image/jpeg')
      const refused = await callTool(c, 'godot_record', { seconds: 0.5, path: saved })
      expect(text(refused)).toContain('exists; pass replace: true to replace it')
    } finally {
      stop()
    }
  }, 120_000)

  it('records every game frame of a run with a fixed frame rate', async () => {
    expect((await callTool(c, 'godot_run', { engine_args: ['--fixed-fps', '30'] })).isError).toBe(false)
    const route = [...c.routes].find(candidate => candidate.path === '/api/godot.recording') as ConnectionFetchRoute
    const upload = [...c.routes].find(candidate => candidate.path === '/api/godot.video') as ConnectionFetchRoute
    const times: number[] = []
    const stop = c.ctx.on('godot/record', async (request: GodotVideoEncodeEvent): Promise<GodotVideoEncodeResult> => {
      const url = `http://127.0.0.1/api/godot.recording?session=${request.sessionId}&run=${request.runId}&recording=${request.recording}`
      const bytes = Buffer.from(await (await route.fetch(new Request(url))).arrayBuffer())
      for (let offset = 0; offset < bytes.length; offset += 16 + bytes.readUInt32LE(offset)) times.push(bytes.readUInt32LE(offset + 8))
      await upload.fetch(new Request(url.replace('godot.recording', 'godot.video'), { method: 'POST', body: new TextEncoder().encode('fixed') }))
      return { codec: 'H.264', frames: times.length, seconds: times.length / 30, width: 640, height: 360, bytes: 5 }
    })
    try {
      const recorded = await callTool(c, 'godot_record', { seconds: 1, sheet_frames: 0, path: 'fixed.mp4' })
      expect(recorded.isError, text(recorded)).toBe(false)
      expect(text(recorded)).toContain('at 30 fps, every frame advancing the game by the same time')
      // Each frame is 1/30 s of game time, rounded to milliseconds, and one second of video is 30 frames however fast the game draws.
      expect(times.slice(0, 4)).toEqual([0, 33, 67, 100])
      expect(times).toHaveLength(30)
    } finally {
      stop()
    }
  }, 120_000)

  it('stops reading a game that records by game frames while the window falls behind, and the game waits without losing a frame', async () => {
    const dir = join(c.dir.root, 'work', 'noise')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(NOISE_PROJECT)) await writeFile(join(dir, name), content)
    const started = await callTool(c, 'godot_run', { project: 'noise', width: 1920, height: 1080, engine_args: ['--fixed-fps', '30'] })
    expect(started.isError, text(started)).toBe(false)
    const holds = vi.spyOn(GodotRun.prototype, 'holdReading')
    const route = [...c.routes].find(candidate => candidate.path === '/api/godot.recording') as ConnectionFetchRoute
    const upload = [...c.routes].find(candidate => candidate.path === '/api/godot.video') as ConnectionFetchRoute
    const frames: Array<{ readonly index: number; readonly timeMs: number; readonly bytes: number }> = []
    const stop = c.ctx.on('godot/record', async (request: GodotVideoEncodeEvent): Promise<GodotVideoEncodeResult> => {
      const url = `http://127.0.0.1/api/godot.recording?session=${request.sessionId}&run=${request.runId}&recording=${request.recording}`
      const reader = ((await route.fetch(new Request(url))).body as ReadableStream<Uint8Array>).getReader()
      // A window that reads about 12 MB a second, far less than the game sends.
      const chunks: Buffer[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
        await new Promise(resolve => setTimeout(resolve, Math.ceil(value.byteLength / 12_000)))
      }
      const bytes = Buffer.concat(chunks)
      for (let offset = 0; offset < bytes.length; offset += 16 + bytes.readUInt32LE(offset)) {
        frames.push({ index: bytes.readUInt32LE(offset + 4), timeMs: bytes.readUInt32LE(offset + 8), bytes: bytes.readUInt32LE(offset) })
      }
      await upload.fetch(new Request(url.replace('godot.recording', 'godot.video'), { method: 'POST', body: new TextEncoder().encode('noise') }))
      return { codec: 'H.264', frames: frames.length, seconds: frames.length / 30, width: 1920, height: 1080, bytes: 5 }
    })
    try {
      const recorded = await callTool(c, 'godot_record', { seconds: 3, fps: 30, max_width: 1920, sheet_frames: 0, path: 'noise.mp4' })
      expect(recorded.isError, text(recorded)).toBe(false)
      expect((recorded.value as { readonly skipped: number }).skipped).toBe(0)
      // The frames are large enough that the Host kept 32 MiB of them unread and stopped reading the game.
      expect(frames.reduce((total, frame) => total + frame.bytes, 0)).toBeGreaterThan(64 * 1024 * 1024)
      expect(holds).toHaveBeenCalled()
      expect(frames.map(frame => frame.index)).toEqual(Array.from({ length: 90 }, (_unused, index) => index))
      expect(frames.slice(0, 3).map(frame => frame.timeMs)).toEqual([0, 33, 67])
      expect(text(await callTool(c, 'godot_eval', { expression: '1 + 1' }))).toBe('int: 2')
    } finally {
      stop()
      holds.mockRestore()
    }
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)
})
