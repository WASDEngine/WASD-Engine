/**
 * The Godot tools against the real LibGodot runner: a static check of a project that was never imported, whose
 * scripts use each other's `class_name` classes, import, windowless run, screenshot, input, logs with a script error,
 * scene inspection, a performance sample and a cancelled one, frame-exact steps, a step that the Game tab ends,
 * lossless PNG frames of a simple scene, input and frames while game time stands still, a bounded game-time wait, a
 * cancelled input sequence, a queued input sequence that its real-time limit ends, a static check that runs no
 * autoload, a letterboxed stretch mode, a game on the Compatibility renderer, JPEG frames of a scene that PNG
 * encoding cannot keep up with, GPU time and a script profile on WASD Engine's own runtime, a windowless game that
 * presents its frames only while a Game tab displays it, a capture of a muted game's audio mix, and games that exit
 * cleanly when they quit by themselves while their reads of frames from the GPU are in flight, or after turning VSync off
 * on the Compatibility renderer; values and printed lines too large for a message, which the game bounds and survives;
 * engine method timing only on request and only where the runtime does it safely, also in a game whose scripts run on
 * worker threads; and a hidden game with `--fixed-fps`, which the harness holds to the hidden frame rate.
 *
 * Set WASD_LIBGODOT_DIR to a folder holding `godot_runner` and the LibGodot library under the name that
 * `wasdengine/libgodot/build.sh` installs: `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`.
 */
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GodotFollowItem, GodotRunView } from '../src/types.ts'
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
  // Its _process spends more time in the engine methods it calls than in its own code.
  'counter.gd': [
    'extends Node', 'var frames := 0', 'var found := 0', 'func _process(_delta):', '\tframes += 1',
    '\tfor _i in 20:', '\t\tfound = get_tree().root.find_children("*", "", true, false).size()', '',
  ].join('\n'),
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

// A game on the Compatibility renderer, which the macOS embedded display server runs on OpenGL.
const COMPATIBILITY_PROJECT = {
  'project.godot': [
    'config_version=5', '', '[application]', '', 'config/name="CompatibilityTest"', 'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.7", "GL Compatibility")', '', '[rendering]', '', 'renderer/rendering_method="gl_compatibility"', '',
  ].join('\n'),
  'main.gd': ['extends Node2D', 'func _draw():', '\tdraw_rect(Rect2(0, 0, 640, 360), Color(0, 0, 1))', '\tdraw_rect(Rect2(500, 40, 60, 60), Color(1, 0, 0))', ''].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
}

// A game whose finish() reads its frame back from the GPU with a GDScript lambda in each of the next 10 frames, as a
// game script may, and then quits while the latest reads are still in flight.
const DOWNLOADS_PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="DownloadsTest"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n',
  'main.gd': [
    'extends Node2D', 'class Pixels extends RefCounted:', '\tvar data := PackedByteArray()', 'var left := 0', 'func finish():', '\tleft = 10',
    'func _process(_delta):', '\tif left == 0:', '\t\treturn', '\tvar pixels := Pixels.new()',
    '\tvar texture := RenderingServer.texture_get_rd_texture(get_viewport().get_texture().get_rid())',
    '\tRenderingServer.get_rendering_device().texture_get_data_async(texture, 0, func(data): pixels.data = data)',
    '\tleft -= 1', '\tif left == 0:', '\t\tget_tree().quit()', '',
  ].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
}

// A Compatibility renderer game whose finish() turns VSync off, as a game's settings may, and quits 10 frames later.
const VSYNC_PROJECT = {
  'project.godot': [
    'config_version=5', '', '[application]', '', 'config/name="VSyncTest"', 'run/main_scene="res://main.tscn"',
    'config/features=PackedStringArray("4.7", "GL Compatibility")', '', '[rendering]', '', 'renderer/rendering_method="gl_compatibility"', '',
  ].join('\n'),
  'main.gd': [
    'extends Node2D', 'var left := 0', 'func finish():', '\tDisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)', '\tleft = 10',
    'func _process(_delta):', '\tif left > 0:', '\t\tleft -= 1', '\t\tif left == 0:', '\t\t\tget_tree().quit()', '',
  ].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
}

// A 1280x720 window of per-pixel value noise: a PNG encode of one frame takes far longer than the 33 ms between
// frames at the default 30 frames per second, so the stream keeps sending JPEG frames.
const NOISE_PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="NoiseTest"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n',
  'main.gd': [
    'extends Node2D', 'func _ready():', '\tvar noise := FastNoiseLite.new()', '\tnoise.noise_type = FastNoiseLite.TYPE_VALUE', '\tnoise.frequency = 1.0',
    '\tvar rect := TextureRect.new()', '\trect.texture = ImageTexture.create_from_image(noise.get_image(1280, 720))', '\tadd_child(rect)', '',
  ].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
}

// A game that plays a looping 440 Hz tone at about -12 dBFS through an AudioStreamPlayer at -6 dB on the Master bus.
const AUDIO_PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="AudioTest"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n',
  'tone.gd': [
    'extends AudioStreamPlayer', 'func _ready():', '\tvar wav := AudioStreamWAV.new()', '\twav.format = AudioStreamWAV.FORMAT_16_BITS', '\twav.mix_rate = 44100',
    '\tvar data := PackedByteArray()', '\tdata.resize(44100 * 2)', '\tfor i in 44100:', '\t\tdata.encode_s16(i * 2, int(sin(TAU * 440.0 * i / 44100.0) * 8000.0))',
    '\twav.data = data', '\twav.loop_mode = AudioStreamWAV.LOOP_FORWARD', '\twav.loop_end = 44100', '\tstream = wav', '\tvolume_db = -6.0', '\tplay()', '',
  ].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://tone.gd" id="1"]\n\n[node name="Main" type="Node"]\n\n[node name="Tone" type="AudioStreamPlayer" parent="."]\nscript = ExtResource("1")\n',
}

// Two scripts whose classes Godot finds only through the class cache that an import writes: player.gd extends Node2D
// and uses art.gd's Art class.
const CLASS_PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="ClassTest"\nconfig/features=PackedStringArray("4.7")\n',
  'art.gd': ['class_name Art', 'extends RefCounted', '', 'static func tint() -> Color:', '\treturn Color.RED', ''].join('\n'),
  'player.gd': ['class_name Player', 'extends Node2D', '', 'var tint: Color = Art.tint()', ''].join('\n'),
}

/**
 * An add-on laid out like Dialogue Manager's editor: the plugin preloads a view scene that holds a scene whose script
 * uses the plugin's class, so the view script loads only after the plugin; and a scene that names a missing script. A
 * second add-on with the same layout sits one folder deeper, in `addons/vendor/nested/`, where the editor's plugin
 * search also finds its `plugin.cfg`.
 */
const ADDON_PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="AddonTest"\nconfig/features=PackedStringArray("4.7")\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/views/plugin.cfg")\n',
  'addons/views/plugin.cfg': '[plugin]\n\nname="Views"\ndescription="Views"\nauthor="Test"\nversion="1.0"\nscript="views_plugin.gd"\n',
  'addons/views/views_plugin.gd': ['@tool', 'class_name ViewsPlugin', 'extends EditorPlugin', '', 'const View: PackedScene = preload("./view.tscn")', ''].join('\n'),
  'addons/views/code_edit.gd': ['@tool', 'class_name ViewsCodeEdit', 'extends Control', '', 'func host() -> void:', '\tprint(ViewsPlugin)', ''].join('\n'),
  'addons/views/code_edit.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://addons/views/code_edit.gd" id="1_edit"]\n\n[node name="CodeEdit" type="Control"]\nscript = ExtResource("1_edit")\n',
  'addons/views/view.tscn': '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://addons/views/code_edit.tscn" id="1_edit"]\n\n[node name="View" type="Control"]\n\n[node name="CodeEdit" parent="." instance=ExtResource("1_edit")]\n',
  'addons/views/lost_view.gd': ['@tool', 'extends Control', '', 'const Lost: PackedScene = preload("./lost.tscn")', ''].join('\n'),
  'addons/views/lost.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://addons/views/lost.gd" id="1_lost"]\n\n[node name="Lost" type="Control"]\nscript = ExtResource("1_lost")\n',
  'addons/vendor/nested/plugin.cfg': '[plugin]\n\nname="Nested"\ndescription="Nested"\nauthor="Test"\nversion="1.0"\nscript="nested_plugin.gd"\n',
  'addons/vendor/nested/nested_plugin.gd': ['@tool', 'class_name NestedPlugin', 'extends EditorPlugin', '', 'const View: PackedScene = preload("./view.tscn")', ''].join('\n'),
  'addons/vendor/nested/code_edit.gd': ['@tool', 'class_name NestedCodeEdit', 'extends Control', '', 'func host() -> void:', '\tprint(NestedPlugin)', ''].join('\n'),
  'addons/vendor/nested/code_edit.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://addons/vendor/nested/code_edit.gd" id="1_edit"]\n\n[node name="CodeEdit" type="Control"]\nscript = ExtResource("1_edit")\n',
  'addons/vendor/nested/view.tscn': '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://addons/vendor/nested/code_edit.tscn" id="1_edit"]\n\n[node name="View" type="Control"]\n\n[node name="CodeEdit" parent="." instance=ExtResource("1_edit")]\n',
}

// A game whose _process starts 64 worker tasks a frame that call engine methods and waits for them in the next frame, as
// games that build or simulate on WorkerThreadPool do, so the tasks run while each frame ends, when the profiler moves
// and clears every function's engine method calls.
const THREADS_PROJECT = {
  'project.godot': 'config_version=5\n\n[application]\n\nconfig/name="ThreadsTest"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n',
  'main.gd': [
    'extends Node2D', 'var frames := 0', 'var task := -1', 'func _process(_delta):', '\tframes += 1',
    '\tif task >= 0:', '\t\tWorkerThreadPool.wait_for_group_task_completion(task)', '\ttask = WorkerThreadPool.add_group_task(_work, 64)',
    'func _exit_tree():', '\tif task >= 0:', '\t\tWorkerThreadPool.wait_for_group_task_completion(task)', '\t\ttask = -1',
    'func _work(index: int) -> void:', '\tvar node := Node.new()', '\tfor i in 200:', '\t\tnode.set_name("n%d_%d" % [index, i])', '\t\tnode.get_name()',
    '\tnode.free()', '',
  ].join('\n'),
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The first item of a Session's follow stream: the run and its logs as they are, without a request to the game. */
async function snapshot(c: Composition): Promise<Extract<GodotFollowItem, { type: 'snapshot' }>> {
  const following = new AbortController()
  try {
    for await (const item of c.godot.follow(c.owner.agent.id, following.signal)) {
      if (item.type === 'snapshot') return item
    }
    throw new Error('the follow stream ended without a snapshot')
  } finally {
    following.abort()
  }
}

/** Whether the runtime's profiler times engine methods on the main thread alone, as WASD Engine's do from patch 0004 on. */
async function engineCallsSafe(c: Composition): Promise<boolean> {
  const answer = await callTool(c, 'godot_eval', {
    code: 'return Engine.has_singleton("WASDEngineRuntime") and Engine.get_singleton("WASDEngineRuntime").has_method("is_native_call_profiling_thread_safe")',
  })
  return text(answer) === 'bool: true'
}

/** The file format of a frame record's image. */
function recordFormat(record: Buffer): 'png' | 'jpeg' | 'other' {
  const image = record.subarray(12)
  if (image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png'
  return image[0] === 0xff && image[1] === 0xd8 ? 'jpeg' : 'other'
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

/** Read frame records from a run's frame route until `enough` holds for the records read, for at most `timeoutMs`. */
async function readFrames(
  route: ConnectionFetchRoute, runId: string, enough: (records: readonly Buffer[]) => boolean, timeoutMs: number,
): Promise<Buffer[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const records: Buffer[] = []
  try {
    const response = await route.fetch(new Request(`http://127.0.0.1/api/godot.frames?session=owner&run=${runId}`, { signal: controller.signal }))
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    let buffered = Buffer.alloc(0)
    while (!enough(records)) {
      const { value, done } = await reader.read()
      if (done) break
      buffered = Buffer.concat([buffered, value])
      while (buffered.length >= 12 && buffered.length >= 12 + buffered.readUInt32LE(0) && !enough(records)) {
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
  const addProject = async (name: string, files: Record<string, string>): Promise<void> => {
    const dir = join(c.dir.root, 'work', name)
    await mkdir(dir, { recursive: true })
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content)
  }
  const endedRun = async (): Promise<GodotRunView> => {
    const following = new AbortController()
    try {
      for await (const item of c.godot.follow(c.owner.agent.id, following.signal)) {
        const run = item.type === 'snapshot' || item.type === 'run' ? item.run : null
        if (run !== null && (run.phase === 'exited' || run.phase === 'crashed' || run.phase === 'failed')) return run
      }
      throw new Error('the follow stream ended before the run')
    } finally {
      following.abort()
    }
  }

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

  it('checks a project that was never imported, its class_name classes included, and imports again only after a change', async () => {
    // The folder sorts after game/, so the calls without project that follow still find the main test project first.
    const dir = join(c.dir.root, 'work', 'named-classes')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(CLASS_PROJECT)) await writeFile(join(dir, name), content)
    const cache = join(dir, '.godot', 'global_script_class_cache.cfg')
    expect(existsSync(cache)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50))
    const checked = await callTool(c, 'godot_check', { project: 'named-classes' })
    expect(text(checked)).toBe(`Checked 2 scripts in ${dir}: no errors.`)
    expect(await readFile(cache, 'utf8')).toContain('"class": &"Player"')
    const imported = (await stat(cache)).mtimeMs
    expect(text(await callTool(c, 'godot_check', { project: 'named-classes' }))).toBe(`Checked 2 scripts in ${dir}: no errors.`)
    expect((await stat(cache)).mtimeMs).toBe(imported)
    await writeFile(join(dir, 'enemy.gd'), ['class_name Enemy', 'extends Player', '', 'func _ready() -> void:', '\tprint(Artt.tint())', ''].join('\n'))
    const broken = await callTool(c, 'godot_check', { project: 'named-classes' })
    expect(text(broken)).toBe(`Checked 3 scripts in ${dir}; 1 have problems:\n[script_error] res://enemy.gd:5: Parse Error: Identifier "Artt" not declared in the current scope.`)
    expect(await readFile(cache, 'utf8')).toContain('"class": &"Enemy"')
  }, 240_000)

  it('checks an add-on\'s scripts after its editor plugin, and still reports a missing script and a broken plugin', async () => {
    // The folder sorts after game/, so the calls without project that follow still find the main test project first.
    const dir = join(c.dir.root, 'work', 'with-addon')
    for (const [name, content] of Object.entries(ADDON_PROJECT)) {
      await mkdir(join(dir, name, '..'), { recursive: true })
      await writeFile(join(dir, name), content)
    }
    // The view script alone: loaded first, it would meet its own scene through the plugin's preload.
    expect(text(await callTool(c, 'godot_check', { project: 'with-addon', paths: ['res://addons/views/code_edit.gd'] }))).toBe(`Checked 1 scripts in ${dir}: no errors.`)
    // The same for the add-on whose plugin.cfg sits one folder deeper.
    expect(text(await callTool(c, 'godot_check', { project: 'with-addon', paths: ['res://addons/vendor/nested/code_edit.gd'] }))).toBe(`Checked 1 scripts in ${dir}: no errors.`)
    const whole = await callTool(c, 'godot_check', { project: 'with-addon' })
    expect(text(whole)).toBe(`Checked 5 scripts in ${dir}; 1 have problems:\n[error] res://addons/views/lost_view.gd: Attempt to open script 'res://addons/views/lost.gd' resulted in error 'File not found'.`)
    // An error in the view script shows once, though the plugin's load and the view script's own load both meet it.
    await writeFile(join(dir, 'addons', 'views', 'code_edit.gd'), ADDON_PROJECT['addons/views/code_edit.gd'].replace('print(ViewsPlugin)', 'print(ViewsPlugin.missing_member)'))
    expect(text(await callTool(c, 'godot_check', { project: 'with-addon', paths: ['res://addons/views/code_edit.gd'] }))).toBe(
      `Checked 1 scripts in ${dir}; 1 have problems:\n[script_error] res://addons/views/code_edit.gd:6: Parse Error: Cannot find member "missing_member" in base "ViewsPlugin".`,
    )
    // A broken plugin shows once, against the plugin script: after the view script whose check loaded it, in its own
    // check, and in a check of the whole project.
    await writeFile(join(dir, 'addons', 'views', 'code_edit.gd'), ADDON_PROJECT['addons/views/code_edit.gd'])
    await writeFile(join(dir, 'addons', 'views', 'views_plugin.gd'), [...ADDON_PROJECT['addons/views/views_plugin.gd'].split('\n').slice(0, -1), '', 'func _enter_tree() -> void:', '\tundefined_call()', ''].join('\n'))
    const plugin = '[script_error] res://addons/views/views_plugin.gd:8: Parse Error: Function "undefined_call()" not found in base self.'
    const once = (output: string): number => output.split('\n').filter(line => line === plugin).length
    const viewOnly = text(await callTool(c, 'godot_check', { project: 'with-addon', paths: ['res://addons/views/code_edit.gd'] }))
    expect(viewOnly, viewOnly).toMatch(/^Checked 2 scripts in .*; 1 have problems:\n/u)
    expect(once(viewOnly), viewOnly).toBe(1)
    const pluginOnly = text(await callTool(c, 'godot_check', { project: 'with-addon', paths: ['res://addons/views/views_plugin.gd'] }))
    expect(once(pluginOnly), pluginOnly).toBe(1)
    const wholeBroken = text(await callTool(c, 'godot_check', { project: 'with-addon' }))
    expect(once(wholeBroken), wholeBroken).toBe(1)
  }, 480_000)

  it('runs the game windowless and reports startup facts', async () => {
    const result = await callTool(c, 'godot_run', { width: 640, height: 360 })
    expect(result.isError, text(result)).toBe(false)
    expect(text(result)).toContain('The game is running: RunnerTest')
    expect(result.value).toMatchObject({ phase: 'running', width: 640, height: 360 })
    runId = (result.value as { runId: string }).runId
    if (process.platform === 'darwin') {
      expect(result.value).toMatchObject({ windowless: true, renderer: expect.stringContaining('metal') as string })
      // The patched LibGodot publishes the layer that the macOS Desktop app shows in the Game tab.
      const view = await c.godot.control(c.owner.agent.id, { action: 'resume' }, new AbortController().signal)
      expect(view.layer?.context).toBeGreaterThan(0)
      expect(view.layer?.scale).toBe(2)
    }
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

  it('bounds values that eval returns and lines that the game prints, and keeps running', async () => {
    // As text, 80 MiB of bytes made a message larger than the Host takes, which closed the connection and ended the game.
    const bytes = await callTool(c, 'godot_eval', { code: 'var bytes := PackedByteArray()\nbytes.resize(80 * 1024 * 1024)\nreturn bytes' })
    expect(bytes.isError, text(bytes)).toBe(false)
    const items = (bytes.value as { value: unknown[]; valueType: string }).value
    expect((bytes.value as { valueType: string }).valueType).toBe('PackedByteArray')
    expect(items).toHaveLength(201)
    expect(items.slice(0, 3)).toEqual([0, 0, 0])
    expect(items[200]).toBe('… (83886080 items in all)')
    const long = await callTool(c, 'godot_eval', { expression: '"x".repeat(20000000)' })
    expect((long.value as { value: string }).value).toBe(`${'x'.repeat(16_384)}… (20000000 characters)`)
    const rows = await callTool(c, 'godot_eval', { code: 'var rows := []\nfor i in 300:\n\trows.append(PackedVector3Array([Vector3.ONE]))\nreturn rows' })
    const listed = (rows.value as { value: unknown[] }).value
    expect(listed).toHaveLength(201)
    expect(listed[0]).toEqual(['Vector3(1, 1, 1)'])
    expect(listed[200]).toBe('… (300 items in all)')
    await callTool(c, 'godot_eval', { code: 'print("y".repeat(5000000))\nreturn 1' })
    await callTool(c, 'godot_wait', { frames: 2 })
    const printed = (await snapshot(c)).logs.findLast(entry => entry.message.startsWith('yyyy'))
    expect(printed?.message).toHaveLength(4000)
    expect(printed?.message.endsWith('… (5000000 characters)')).toBe(true)
    expect(text(await callTool(c, 'godot_eval', { expression: 'scene.get_node("Player").position.x' }))).toMatch(/^float: /u)
  }, 60_000)

  it('measures frame times, drawing, memory, and the scene census over real time', async () => {
    const measured = await callTool(c, 'godot_performance', { seconds: 1 })
    expect(measured.isError, text(measured)).toBe(false)
    expect(measured.value).toMatchObject({
      timedOut: false,
      frames: expect.any(Number) as number,
      context: { width: 640, height: 360, paused: false },
      sceneTree: {
        scripts: [
          { path: 'res://counter.gd', nodes: 1, processing: 1, physicsProcessing: 0 },
          { path: 'res://game_state.gd', nodes: 1, processing: 0, physicsProcessing: 0 },
          { path: 'res://keys.gd', nodes: 1, processing: 0, physicsProcessing: 0 },
          { path: 'res://player.gd', nodes: 1, processing: 1, physicsProcessing: 0 },
        ],
      },
    })
    const value = measured.value as {
      frames: number
      fps: number
      seconds: number
      sceneTree: { nodes: number }
      drawn: { drawCalls: { max: number } }
    }
    expect(value.frames).toBeGreaterThan(10)
    expect(value.fps).toBeGreaterThan(10)
    expect(value.seconds).toBeGreaterThanOrEqual(1)
    expect(value.sceneTree.nodes).toBeGreaterThanOrEqual(8)
    expect(value.drawn.drawCalls.max).toBeGreaterThan(0)
    expect(text(measured)).toMatch(/^Measured 1\.\d\d s of real time: \d+ frames at [\d.]+ FPS; the forward_plus renderer on /u)
    expect(text(measured)).not.toContain('New errors since your last Godot call')
    // A cancelled call ends the game's sample, so the next one can start at once.
    const controller = new AbortController()
    const abandoned = callTool(c, 'godot_performance', { seconds: 10 }, controller.signal)
    setTimeout(() => { controller.abort() }, 300)
    expect((await abandoned).isError).toBe(true)
    const next = await callTool(c, 'godot_performance', { seconds: 0.25 })
    expect(next.isError, text(next)).toBe(false)
  }, 60_000)

  it('measures GPU time and profiles the scripts on WASD Engine\'s own runtime, timing engine methods on request', async () => {
    type Profiled = {
      gpuMs?: { mean: number }
      context: { wasdRuntime: boolean }
      scriptProfile?: {
        frames: number
        engineCalls: boolean
        scripts: { path: string; functions: { name: string; engineCalls: { method: string }[] }[] }[]
      }
    }
    const measured = await callTool(c, 'godot_performance', { seconds: 1 })
    expect(measured.isError, text(measured)).toBe(false)
    const value = measured.value as Profiled
    if (!value.context.wasdRuntime) {
      expect(text(measured)).toContain('Scripts: this Godot runtime has no script profiler;')
      return
    }
    // WASD Engine's runtime takes GPU timestamps on Metal, as Vulkan does elsewhere.
    expect(value.gpuMs?.mean, text(measured)).toBeGreaterThan(0)
    expect(value.scriptProfile?.frames).toBeGreaterThan(10)
    const scripts = value.scriptProfile?.scripts ?? []
    expect(scripts.map(script => script.path)).toEqual(expect.arrayContaining(['res://player.gd', 'res://counter.gd']))
    expect(scripts.some(script => script.path.endsWith('wasd_harness.gd'))).toBe(false)
    // Without engine_calls, functions list no engine methods.
    expect(value.scriptProfile?.engineCalls).toBe(false)
    expect(scripts.every(script => script.functions.every(entry => entry.engineCalls.length === 0))).toBe(true)
    expect(text(measured)).toContain('engine_calls: true also lists the costliest engine methods of each function.')
    // A function's line is the first line of its body.
    expect(text(measured)).toMatch(/\nres:\/\/player\.gd [\d.]+: [^\n]*_process \(line 6\)/u)
    const timed = await callTool(c, 'godot_performance', { seconds: 1, engine_calls: true })
    expect(timed.isError, text(timed)).toBe(false)
    const profile = (timed.value as Profiled).scriptProfile
    if (!await engineCallsSafe(c)) {
      // A runtime that records engine methods on every thread without a lock leaves them out.
      expect(profile?.engineCalls).toBe(false)
      expect(text(timed)).toContain('Engine methods: this Godot runtime\'s profiler times them on every thread without a lock')
      return
    }
    expect(profile?.engineCalls).toBe(true)
    const profiled = profile?.scripts ?? []
    const processing = profiled.find(script => script.path === 'res://player.gd')?.functions.find(entry => entry.name === '_process')
    expect(processing?.engineCalls.map(call => call.method)).toContain('Input.get_axis')
    // An engine method that takes longer than the code of the function that calls it still counts toward that function.
    const counting = profiled.find(script => script.path === 'res://counter.gd')?.functions
    expect(counting?.map(entry => entry.name)).toEqual(['_process'])
    expect(counting?.[0]?.engineCalls.map(call => call.method)).toContain('Node.find_children')
  }, 60_000)

  it('draws a windowless game without presenting it while no Game tab displays it, and presents it while one does', async () => {
    const context = async (): Promise<{ presenting: boolean; frameCap: number; refreshRate: number }> => {
      const measured = await callTool(c, 'godot_performance', { seconds: 0.25, scripts: false })
      return (measured.value as { context: { presenting: boolean; frameCap: number; refreshRate: number } }).context
    }
    if (process.platform !== 'darwin') {
      // A game with a window always presents.
      expect(await context()).toMatchObject({ presenting: true })
      return
    }
    const hidden = await context()
    expect(hidden).toMatchObject({ presenting: false, frameCap: Math.round(hidden.refreshRate) })
    const viewing = new AbortController()
    const stream = c.godot.view(c.owner.agent.id, runId, viewing.signal)[Symbol.asyncIterator]()
    await stream.next()
    expect(await context()).toMatchObject({ presenting: true, frameCap: 0 })
    const ended = stream.next()
    viewing.abort()
    await ended
    expect(await context()).toMatchObject({ presenting: false })
    // Screenshots still read the frames the game draws while it does not present.
    const shot = await callTool(c, 'godot_screenshot')
    expect(shot.isError, text(shot)).toBe(false)
    expect(decodePng(Buffer.from(c.saved.at(-1)?.data as Uint8Array)).pixel(320, 20)).toEqual([51, 102, 204])
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

  it('streams frames to the Game tab, lossless PNG ones that match the screenshot once preparing a PNG frame keeps up', async () => {
    const controller = new AbortController()
    const response = await frameRoute().fetch(new Request(`http://127.0.0.1/api/godot.frames?session=owner&run=${runId}`, { signal: controller.signal }))
    expect(response.status).toBe(200)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const record = Buffer.from((await reader.read()).value as Uint8Array)
    expect(record.readUInt32LE(0)).toBe(record.length - 12)
    expect([record.readUInt16LE(4), record.readUInt16LE(6)]).toEqual([640, 360])
    expect(recordFormat(record)).toBe('jpeg')
    controller.abort()
    expect(await reader.read()).toMatchObject({ done: true })

    const shot = await callTool(c, 'godot_screenshot')
    expect(shot.isError, text(shot)).toBe(false)
    const screenshot = decodePng(Buffer.from(c.saved.at(-1)?.data as Uint8Array))
    const records = await readFrames(frameRoute(), runId, read => read.some(entry => recordFormat(entry) === 'png'), 10_000)
    expect(records.map(recordFormat).filter(format => format === 'other')).toEqual([])
    const png = records.find(entry => recordFormat(entry) === 'png')
    expect(png, `formats ${records.map(recordFormat).join(', ')}`).toBeDefined()
    const frame = decodePng((png as Buffer).subarray(12))
    expect([frame.width, frame.height]).toEqual([screenshot.width, screenshot.height])
    const differing: number[][] = []
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        if (frame.pixel(x, y).join() !== screenshot.pixel(x, y).join()) differing.push([x, y])
      }
    }
    expect(differing.slice(0, 5)).toEqual([])
  }, 60_000)

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
    expect(await readFrames(frameRoute(), runId, read => read.length >= 3, 5000)).toHaveLength(3)
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

  it('runs a project script with user arguments after an import, and imports the project for other plugins', async () => {
    await mkdir(join(c.project, 'tests'), { recursive: true })
    await writeFile(join(c.project, 'tests', 'hello.gd'), [
      'extends SceneTree',
      '',
      'func _init() -> void:',
      '\tprint("SCRIPT_E2E ", OS.get_cmdline_user_args())',
      '\tquit(3)',
      '',
    ].join('\n'))
    const result = await callTool(c, 'godot_script', { script: 'res://tests/hello.gd', args: ['--alpha', 'beta'] })
    expect(result.isError, text(result)).toBe(false)
    expect(text(result)).toMatch(/^res:\/\/tests\/hello\.gd finished after \d+\.\d s\. /u)
    expect(result.value).toMatchObject({ script: 'res://tests/hello.gd', timedOut: false, output: expect.stringContaining('SCRIPT_E2E ["--alpha", "beta"]') as string })
    // The runner does not pass on the code the script gave quit().
    expect(result.value).toMatchObject({ exitCode: 0 })
    // A class added after the last import is known once importProject imported the project.
    await writeFile(join(c.project, 'tests', 'probe.gd'), 'class_name ImportProbe\nextends Node\n')
    const report = await c.godot.importProject(c.project, new AbortController().signal)
    expect(report?.issues).toEqual(expect.any(Array))
    expect(await readFile(join(c.project, '.godot', 'global_script_class_cache.cfg'), 'utf8')).toContain('ImportProbe')
  }, 240_000)

  it('imports the other files of a project that holds a .blend file, after turning off the Blender importer', async () => {
    await mkdir(join(c.project, 'art'), { recursive: true })
    await writeFile(join(c.project, 'art', 'ship.blend'), 'BLENDER-v502 placeholder')
    await writeFile(join(c.project, 'art', 'flag.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>')
    const report = await c.godot.importProject(c.project, new AbortController().signal)
    expect(report?.issues[0]?.message).toContain('because of res://art/ship.blend')
    expect(report?.issues.some(issue => issue.message.includes('Blender path is invalid'))).toBe(false)
    expect(await readFile(join(c.project, 'project.godot'), 'utf8')).toContain('import/blender/enabled=false')
    expect(existsSync(join(c.project, 'art', 'flag.svg.import'))).toBe(true)
  }, 240_000)

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

  it('times the engine methods of a game whose scripts call them on worker threads as frames end, and the game keeps running', async () => {
    await addProject('threads', THREADS_PROJECT)
    const started = await callTool(c, 'godot_run', { project: 'threads', width: 320, height: 180 })
    expect(started.isError, text(started)).toBe(false)
    const safe = await engineCallsSafe(c)
    for (let round = 0; round < 3; round += 1) {
      const measured = await callTool(c, 'godot_performance', { seconds: 0.5, engine_calls: true })
      expect(measured.isError, text(measured)).toBe(false)
      const profile = (measured.value as { scriptProfile?: { engineCalls: boolean } }).scriptProfile
      if ((measured.value as { context: { wasdRuntime: boolean } }).context.wasdRuntime) expect(profile?.engineCalls).toBe(safe)
    }
    const frames = Number(text(await callTool(c, 'godot_eval', { expression: 'scene.frames' })).replace('int: ', ''))
    expect(frames).toBeGreaterThan(10)
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)

  it('runs a Compatibility renderer game at its window size, paced by the display, with full-size frames', async () => {
    const dir = join(c.dir.root, 'work', 'compatibility')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(COMPATIBILITY_PROJECT)) await writeFile(join(dir, name), content)
    const started = await callTool(c, 'godot_run', { project: 'compatibility', width: 640, height: 360 })
    expect(started.isError, text(started)).toBe(false)
    expect(started.value).toMatchObject({ width: 640, height: 360, renderer: expect.stringContaining('gl_compatibility') as string })
    await callTool(c, 'godot_wait', { frames: 5 })
    await callTool(c, 'godot_screenshot')
    const image = decodePng(Buffer.from(c.saved.at(-1)?.data as Uint8Array))
    expect([image.width, image.height]).toEqual([640, 360])
    expect([image.pixel(530, 70), image.pixel(100, 300)]).toEqual([[255, 0, 0], [0, 0, 255]])
    const records = await readFrames(frameRoute(), (started.value as { runId: string }).runId, read => read.length >= 5, 15_000)
    expect([records[0]?.readUInt16LE(4), records[0]?.readUInt16LE(6)]).toEqual([640, 360])
    // VSync is on, as in a new project, so the display paces the frames.
    const measured = await callTool(c, 'godot_performance', { seconds: 1 })
    expect((measured.value as { fps: number }).fps).toBeLessThan(500)
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)

  it('runs a Forward+ project with the Compatibility renderer of its Web builds', async () => {
    const started = await callTool(c, 'godot_run', { width: 640, height: 360, web: true })
    expect(started.isError, text(started)).toBe(false)
    expect(started.value).toMatchObject({ web: true, renderer: expect.stringContaining('gl_compatibility') as string })
    expect(text(started)).toMatch(/renderer [^,]+ \/ gl_compatibility as on the Web,/u)
    await callTool(c, 'godot_wait', { frames: 5 })
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)

  it('captures a muted game\'s audio mix as players hear it, with the player that played it, and saves it as WAV', async () => {
    const dir = join(c.dir.root, 'work', 'audio')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(AUDIO_PROJECT)) await writeFile(join(dir, name), content)
    const started = await callTool(c, 'godot_run', { project: 'audio' })
    expect(started.isError, text(started)).toBe(false)
    expect(started.value).toMatchObject({ muted: true })
    await callTool(c, 'godot_wait', { seconds: 0.2 })
    const captured = await callTool(c, 'godot_audio', { seconds: 1, path: join(c.dir.root, 'data', 'tone.wav'), replace: true })
    expect(captured.isError, text(captured)).toBe(false)
    const value = captured.value as {
      seconds: number
      peakDb: number
      dominantHz: number
      muted: boolean
      players: { path: string; stream: string; bus: string; starts: number }[]
    }
    expect(value).toMatchObject({ seconds: 1, muted: true, players: [{ path: '/root/Main/Tone', stream: 'AudioStreamWAV', bus: 'Master', starts: 1 }] })
    // 8000 of 32767 at -6 dB: about -18.3 dBFS.
    expect(value.peakDb).toBeGreaterThan(-19.5)
    expect(value.peakDb).toBeLessThan(-17)
    expect(Math.abs(value.dominantHz - 440)).toBeLessThan(15)
    expect(text(captured)).toContain('The game runs muted (Dummy audio driver)')
    expect((await stat(join(c.dir.root, 'data', 'tone.wav'))).size).toBe(44 + 44100 * 4)
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)

  it('keeps streaming JPEG frames of a scene whose PNG encoding cannot keep up with the frame rate', async () => {
    const dir = join(c.dir.root, 'work', 'noise')
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(NOISE_PROJECT)) await writeFile(join(dir, name), content)
    const started = await callTool(c, 'godot_run', { project: 'noise', width: 1280, height: 720 })
    expect(started.isError, text(started)).toBe(false)
    // Two seconds of frames span the test encode of the first frame and the next one a second later.
    const records = await readFrames(frameRoute(), (started.value as { runId: string }).runId, read => read.length >= 60, 15_000)
    expect(records).toHaveLength(60)
    expect([records[0]?.readUInt16LE(4), records[0]?.readUInt16LE(6)]).toEqual([1280, 720])
    expect(records.map(recordFormat).filter(format => format !== 'jpeg')).toEqual([])
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)

  it('ends a game that quits by itself while its own reads of frames from the GPU are in flight as exited', async () => {
    await addProject('downloads', DOWNLOADS_PROJECT)
    const started = await callTool(c, 'godot_run', { project: 'downloads', width: 640, height: 360 })
    expect(started.isError, text(started)).toBe(false)
    await callTool(c, 'godot_eval', { expression: 'scene.finish()' })
    expect(await endedRun()).toMatchObject({ phase: 'exited', exitCode: 0 })
  }, 240_000)

  it('ends a Compatibility renderer game that turns VSync off and then quits by itself as exited', async () => {
    await addProject('vsync', VSYNC_PROJECT)
    const started = await callTool(c, 'godot_run', { project: 'vsync', width: 640, height: 360 })
    expect(started.isError, text(started)).toBe(false)
    // While a Game tab displays the game, each frame's swap waits for the display.
    const viewing = new AbortController()
    const stream = c.godot.view(c.owner.agent.id, (started.value as { runId: string }).runId, viewing.signal)[Symbol.asyncIterator]()
    await stream.next()
    await callTool(c, 'godot_wait', { seconds: 1.5 })
    await callTool(c, 'godot_eval', { expression: 'scene.finish()' })
    expect(await endedRun()).toMatchObject({ phase: 'exited', exitCode: 0 })
    const closed = stream.next()
    viewing.abort()
    await closed
  }, 240_000)
})

describe.skipIf(runner === undefined || library === undefined || !existsSync(runner) || !existsSync(library))('a game with a fixed frame rate on the real LibGodot runner', () => {
  let c: Composition

  beforeAll(async () => {
    c = await compose({
      game: {},
      config: {
        runnerPath: runner as string, libgodotPath: library as string, importBeforeRun: true,
        startTimeoutMs: 60_000, requestTimeoutMs: 5000, stopGraceMs: 3000, hiddenFps: 10, hiddenDelayMs: 500,
      },
    })
    for (const [name, content] of Object.entries(PROJECT)) await writeFile(join(c.project, name), content)
  }, 60_000)

  afterAll(async () => { await c?.cleanup() }, 30_000)

  it('holds a windowless game with --fixed-fps that nobody shows to the hidden frame rate, and to the refresh rate while used', async () => {
    const started = await callTool(c, 'godot_run', { width: 640, height: 360, engine_args: ['--fixed-fps', '60'] })
    expect(started.isError, text(started)).toBe(false)
    if (process.platform !== 'darwin') {
      // A game with a window keeps its own frame rate.
      expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
      return
    }
    // Godot applies no frame limit to a game with --fixed-fps, so such a game ran as fast as it could draw.
    await new Promise(resolve => setTimeout(resolve, 3000))
    const hidden = (await snapshot(c)).run as GodotRunView
    expect(hidden.fps).toBeGreaterThan(4)
    expect(hidden.fps).toBeLessThanOrEqual(13)
    // A request lifts the hidden cap; the game, which no Game tab displays, still presents nothing and draws at most at
    // the display's refresh rate.
    const measured = await callTool(c, 'godot_performance', { seconds: 1, scripts: false })
    const value = measured.value as { fps: number; context: { refreshRate: number; presenting: boolean } }
    expect(value.context.presenting).toBe(false)
    expect(value.fps).toBeLessThan(Math.max(60, value.context.refreshRate) * 1.25)
    expect(text(await callTool(c, 'godot_stop'))).toBe('Stopped the game.')
  }, 240_000)
})
