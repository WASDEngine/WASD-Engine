extends SceneTree
# A project may treat GDScript warnings as errors, and a warning in this file would then keep the file from compiling.
# Every warning of the Godot release that WASD Engine runs is off for this file only; the project's own scripts keep
# the project's warning settings.
@warning_ignore_start(
	"unassigned_variable", "unassigned_variable_op_assign", "unused_variable", "unused_local_constant",
	"unused_private_class_variable", "unused_parameter", "unused_signal", "shadowed_variable",
	"shadowed_variable_base_class", "shadowed_global_identifier", "unreachable_code", "unreachable_pattern",
	"standalone_expression", "standalone_ternary", "incompatible_ternary", "untyped_declaration",
	"inferred_declaration", "unsafe_property_access", "unsafe_method_access", "unsafe_cast", "unsafe_call_argument",
	"unsafe_void_return", "return_value_discarded", "static_called_on_instance", "missing_tool",
	"redundant_static_unload", "redundant_await", "missing_await", "assert_always_true", "assert_always_false",
	"integer_division", "narrowing_conversion", "int_as_enum_without_cast", "int_as_enum_without_match",
	"enum_variable_without_default", "empty_file", "deprecated_keyword", "confusable_identifier",
	"confusable_local_declaration", "confusable_local_usage", "confusable_capture_reassignment",
	"confusable_temporary_modification", "inference_on_variant", "native_method_override",
	"get_node_default_without_onready", "onready_with_export", "property_used_as_function", "constant_used_as_function",
	"function_used_as_property"
)
## WASD Engine game harness.
##
## The Host runs a game as `--path <project> --script <this file> -- --wasd-port=<port> --wasd-token=<token>
## [--wasd-scene=<res path>] [--wasd-fixed-fps=<fps>]`. As the main loop, the harness loads the project's main scene (or
## --wasd-scene), keeps running while the game is paused, and serves one loopback TCP connection to the Host. Autoloads
## load as usual. `--wasd-fixed-fps` repeats the game's own `--fixed-fps` option, which Godot keeps from the script.
##
## Wire format, both directions: a 4-byte little-endian length N, then N bytes holding a 1-byte kind and its payload.
## Kind 1 is a UTF-8 JSON object. Kind 2 (harness to Host) is a streamed frame: u32 sequence, u16 width, u16 height,
## then the bytes of a PNG or JPEG file. Kind 3 (harness to Host) answers a screenshot or view request: u32 request id,
## then the PNG or JPEG bytes. Kind 4 (harness to Host) is a frame of a recording, as `record` says. Kind 5 (harness to
## Host) answers an `audio` request: u32 request id, then the captured samples as little-endian 32-bit floats, left and
## right interleaved. The first message on the connection is the harness's `hello` JSON, which carries the token, and
## `wasdRuntime`: whether the runtime has the `WASDEngineRuntime` singleton of WASD Engine's LibGodot builds, whose
## script profilers the harness uses. When the game draws into the Core Animation layer of the macOS embedded display
## server, `hello` also carries `layer`: the CAContext id through which another process of the login session can display
## that layer with a CALayerHost, and the game window pixels per layer point (`scale`).
##
## Every message comes from the main loop except `busy`: while the main loop has not reached the harness's `_process` for
## BUSY_REPORT_MS, as in a frame that compiles shaders, builds a large scene, or runs a long `_ready`, a thread of the
## harness sends `busy` every BUSY_REPORT_MS with the frame whose `_process` began last (`frame`) and the milliseconds
## since (`ms`), so the Host can tell such a frame from a game that stopped. A mutex guards the connection and the
## waiting messages, which both threads use.
##
## Screenshots and streamed frames show the game window at its pixel size, scaled down to `maxWidth`: the root
## viewport where the project's stretch settings place it, and black where the window shows bars around it. At
## full size, image pixel (x, y) is window pixel (x, y), the unit of input event coordinates. Frames stream at
## most `fps` times per second of real time, also while the game is paused or Engine.time_scale is 0.
##
## A streamed frame costs the game's main thread little. With a RenderingDevice (the Forward+ and Mobile renderers),
## the root viewport's picture is copied from the GPU without waiting for it, and the copy arrives some frames later;
## the Compatibility renderer, and a picture in a format other than 8-bit RGBA, are read synchronously instead. A
## worker thread converts, scales, frames, and encodes one streamed frame at a time. Frames are JPEG at `quality`.
## With `lossless`, frames are PNG while preparing a PNG frame keeps up with `fps`: the stream starts with JPEG frames
## and a test PNG of its first frame, switches to PNG frames once a test takes at most 1/`fps` seconds, and returns
## to JPEG frames after a PNG frame takes longer. A slow PNG frame and a failed or slow test schedule the next test
## after a delay that starts at 1 second and doubles each time, up to 8 seconds, until the next `stream` request.
##
## Messages to the Host wait in order and leave as fast as the connection takes them, so a slow reader never holds up
## the game, and no frame is captured while earlier messages still wait. At exit the harness sends what is left. No
## message is larger than MAX_MESSAGE_BYTES, which the Host refuses by closing the connection: an answer that would be
## larger becomes an error answer that says so, an image or audio answer too, a frame of the stream is dropped, a frame
## of a recording counts as skipped, and logs go out in batches of at most LOG_BATCH_BYTES. A value that `eval` returns
## keeps at most JSON_MAX_ITEMS items of each array or dictionary, packed arrays included, JSON_MAX_CHARS characters of
## each string, and JSON_MAX_DEPTH levels, and about JSON_BUDGET characters in all; a marker that says how many items or
## characters there were takes the place of the rest. A log entry keeps LOG_MAX_CHARS characters of its message and code
## and LOG_MAX_FRAMES frames of its backtrace.
##
## `wait` and `step` frames count frames that the game ran after the request arrived; `wait` seconds count game
## time while the tree is not paused, which Engine.time_scale scales. Input sequences run one at a time in
## arrival order; their `wait` events and `hold` releases count real time, so a paused game or a time scale of 0
## does not hold them up.
##
## A `wait`, `step`, or `input` request ends early once its optional `timeoutMs` of real time has passed since it
## arrived, not counting the time of a frame beyond BUSY_REPORT_MS, through which the Host waits as `busy` reports it,
## or on a `cancel` request whose `request` is its id; a pending step also ends on `pause`, `resume`, or
## a newer `step`. An early end answers with the usual fields for the part that ran, plus `timedOut: true` after
## the timeout or `cancelled: true` otherwise; a request that runs to its end answers both as false. A step that
## times out or is cancelled pauses the game, and one that `resume` or a newer step ends leaves it running. An
## input sequence that ends early answers `events` as the number of its events that ran; one that ends early or
## fails releases the keys, buttons, and actions it pressed and did not release. `cancel` answers `cancelled`:
## whether a `wait`, `step`, `input`, `performance`, or `audio` request with that id was pending.
##
## A `performance` request samples the game for `seconds` of real time, one sample at a time, and answers with a
## series per measured frame: its milliseconds from start to start (`frame`), in physics steps, in this harness's
## own `_process`, in node processing (`process`, from `process_frame` to `frame_pre_draw`), and in drawing
## (`draw`, from `frame_pre_draw` to `frame_post_draw`); the GPU and render CPU milliseconds that the root
## viewport measured, 0 until a measurement arrives; and the objects, primitives, and draw calls drawn. It adds the
## built-in `Performance` monitors at its start and end, the custom monitors at its end, a census of the scene tree
## from the root, and the settings that limit the frame rate. Like a `wait`, it ends early at its `timeoutMs` or on
## `cancel`, which answer `timedOut` or `cancelled`. While it runs, the root viewport measures its render time;
## afterwards the measurement is off.
##
## With a positive `scriptSeconds`, the sample then continues for that many seconds of real time with the script
## profilers of the `WASDEngineRuntime` singleton, which time every script function, and with `engineCalls` also the
## engine methods that each one calls. Those seconds add nothing to the series, so the profilers' own cost stays out of
## the frame times. The answer lists the profiled entries as `scripts`, [signature, calls, total microseconds, self
## microseconds], without this harness's own functions: each function's entry is followed by the entries of the engine
## methods it called, whose signatures name line 0. The functions with the most own time, their self time plus the time
## of those engine methods, come first, in at most PERFORMANCE_MAX_SCRIPT_ENTRIES entries. The answer also carries the
## `scriptSeconds` and `scriptFrames` of that window, and `engineCalls`, whether engine methods were timed;
## `scriptProfiler` is false, and the window is skipped, when the runtime has no profilers. Engine methods are timed
## only on a runtime whose singleton reports `is_native_call_profiling_thread_safe`: its profiler records them on the
## main thread alone, while earlier runtimes record them on every thread without a lock, which can crash a game that
## runs scripts on other threads.
##
## A `pace` request with a positive `maxFps` caps Engine.max_fps at that rate, or at the game's own cap when that is
## lower; `maxFps` 0 restores the game's own cap. The Host caps a game that nobody shows or uses and lifts the cap
## before the requests it sends to a capped game. Godot applies no frame limit to a game with `--fixed-fps`, so while
## the harness caps such a game, it sleeps at the start of each `_process` until the frame's share of the cap has
## passed, as Godot's frame limiter does at the end of a frame; each frame still advances game time by one fixed step. A
## boolean `present` says whether the game presents its frames to its window. Without presenting, the root viewport
## leaves the screen and draws every frame into its texture, which screenshots and streamed frames read, and the frame
## rate stays at most the screen's refresh rate, as presenting paces it. A game that no view shows then never waits for
## the window server, which takes back the frames that a window presents late while other processes present frames. The
## answer carries the resulting `maxFps` and `presenting`.
##
## An `audio` request captures the mix of the Master bus, as players hear it, for `seconds` of audio: an
## AudioEffectCapture at the end of the bus's effects takes the mix, whose Master volume the answer's `masterVolumes`
## lists as [captured frame, volume dB, muted] at the start and at each change, because the bus applies its volume after
## its effects. One capture runs at a time. It also follows the bus peaks and the audio players that play, and answers
## with them, the mix rate, the audio driver, and the frames that the capture's buffer dropped, then sends the samples
## as kind 5. Like a `wait`, it ends early at its `timeoutMs` or on `cancel`, which answer `timedOut` or `cancelled`
## with the audio captured until then.

const PROTOCOL_VERSION := 2
const KIND_JSON := 1
const KIND_FRAME := 2
const KIND_IMAGE := 3
const KIND_RECORD := 4
const KIND_AUDIO := 5
const MAX_PENDING_LOGS := 4000
const UNKNOWN_REFRESH_FPS := 60  # frame rate of a game that does not present, on a screen that reports no refresh rate
const MAX_MESSAGE_BYTES := 64 * 1024 * 1024  # largest message body, the kind byte included, that either side accepts
const LOG_BATCH_BYTES := 8 * 1024 * 1024  # bytes of entries that one logs message carries at most
const BUSY_REPORT_MS := 1000  # milliseconds without `_process` after which, and between which, the harness sends `busy`
const BUSY_CHECK_MS := 100  # milliseconds between two looks of the heartbeat thread at the main loop
# Characters of a log entry's message, and of its code, that it keeps with the marker of a longer one; the Host keeps as
# many (MAX_LOG_MESSAGE_CHARS of src/run.ts), so the marker reaches it.
const LOG_MAX_CHARS := 4000
const LOG_MAX_FIELD_CHARS := 500  # characters of a log entry's function and file names, and of each backtrace frame's
const LOG_MAX_FRAMES := 32  # backtrace frames a log entry keeps
const JSON_MAX_CHARS := 16384  # characters of one string that an `eval` value keeps
const JSON_MAX_ITEMS := 200  # items of one array or dictionary that an `eval` value keeps
const JSON_MAX_DEPTH := 8  # levels of arrays and dictionaries that an `eval` value keeps
const JSON_BUDGET := 1048576  # characters, about, that one `eval` value holds
const JSON_ARRAY_TYPES := [
	TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY,
	TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY,
	TYPE_PACKED_COLOR_ARRAY, TYPE_PACKED_VECTOR4_ARRAY,
]
const USEC_PER_SECOND := 1000000.0
const LOSSLESS_TEST_DELAY := 1.0  # seconds from a failed or slow PNG test, or a slow PNG frame, to the next test
const LOSSLESS_TEST_MAX_DELAY := 8.0
const PERFORMANCE_SERIES := ["frame", "physics", "harness", "process", "draw", "gpu", "renderCpu", "objects", "primitives", "drawCalls"]
const PERFORMANCE_MAX_FRAMES := 20000  # frames a sample records; later frames count in droppedFrames
const PERFORMANCE_MAX_NODES := 200000  # nodes the census visits
const PERFORMANCE_TOP := 8  # node classes and scripts the census lists
const PERFORMANCE_MAX_CUSTOM := 40  # custom monitors a sample reports
const PERFORMANCE_MAX_SCRIPT_ENTRIES := 400  # profiled functions and engine methods a sample reports
const AUDIO_MAX_SECONDS := 120.0  # longest audio capture
const AUDIO_BUFFER_SECONDS := 4.0  # audio that the capture holds between two frames of the game before it drops frames
const AUDIO_MAX_PLAYERS := 500  # audio players a capture follows
const AUDIO_LISTED_PLAYERS := 40  # players that played, listed in a capture's answer
# The singleton of WASD Engine's LibGodot builds, whose script profilers time each script function.
const RUNTIME_SINGLETON := &"WASDEngineRuntime"
# DisplayServer metadata in which the WASD Engine LibGodot build publishes the CAContext id of the embedded display server's layer.
const LAYER_CONTEXT_META := &"wasd_layer_context_id"
# `eval` code compiles as the body of `run` in a script of its own, under a path that names the script in its errors. The
# names it may use are members, so the code may declare its own of the same names.
const CODE_HEAD := "extends Node\n\n\nvar tree: SceneTree\nvar root: Window\nvar scene: Node\nvar node: Object\n\n\nfunc run():\n"
const CODE_HEAD_LINES := 10
const EVAL_PATH := "res://wasd_eval_%d.gd"
const REGION_MAX_FACTOR := 8  # largest whole factor by which a small screenshot region grows
const VIEW_MAX_SIDE := 4096
const VIEW_FRAMES := 8  # frames a view draws before its capture, so temporal antialiasing and other temporal effects settle
const VIEW_ASSET_FOV := 35.0  # vertical field of view of an asset view, in degrees
const VIEW_BONE_RADIUS := 0.25  # meters a view frames around a bone
const VIEW_YAW := 30.0
const VIEW_PITCH := 10.0
const VIEW_MAX_NODES := 50000  # nodes a view visits to measure its subject
const ISOLATE_LAYER := 20  # the render layer that an isolated view draws alone
const RECORD_MAX_IN_FLIGHT := 6  # frames of a recording being copied or encoded at once
const RECORD_MAX_OUTBOX := 48 * 1024 * 1024  # bytes waiting for the connection beyond which a real-time recording skips frames
# Real seconds after a recording stopped capturing by which frames still being copied from the GPU count as skipped.
const RECORD_FINISH_SECONDS := 10.0

## Where the root viewport's picture shows in an image of the game window: the picture fills `target` of an image of
## `size`, and black fills the rest. A zero `size` keeps the picture as it is. The main thread builds a layout when it
## captures a frame; `apply` reads only the layout, so any thread may run it.
class FrameLayout extends RefCounted:
	var size := Vector2i.ZERO
	var target := Rect2i()

	## Converts `picture` to RGB8 and scales it in place; returns the image of the window.
	func apply(picture: Image) -> Image:
		if picture.get_format() != Image.FORMAT_RGB8:
			picture.convert(Image.FORMAT_RGB8)
		if size == Vector2i.ZERO:
			return picture
		if target.size != picture.get_size():
			var interpolation := Image.INTERPOLATE_BILINEAR if target.size.x < picture.get_width() else Image.INTERPOLATE_NEAREST
			picture.resize(target.size.x, target.size.y, interpolation)
		if target == Rect2i(Vector2i.ZERO, size):
			return picture
		var framed := Image.create_empty(size.x, size.y, false, Image.FORMAT_RGB8)
		framed.blit_rect(picture, Rect2i(Vector2i.ZERO, picture.get_size()), target.position)
		return framed

## A streamed frame being copied from the GPU without waiting for it. `request` runs on the render thread, which is
## the main thread unless the project renders on a thread of its own, and the RenderingDevice calls back there once
## the copy is complete; the main thread polls `take`. The mutex guards the state, the pixels, and their size.
class FrameReadback extends RefCounted:
	enum { PENDING, RECEIVED, FAILED }
	var layout: FrameLayout
	var _mutex := Mutex.new()
	var _state := PENDING
	var _pixels := PackedByteArray()
	var _size := Vector2i.ZERO

	func _init(frame_layout: FrameLayout) -> void:
		layout = frame_layout

	## Requests the copy of `texture`, the root viewport's picture, as 8-bit RGBA. A static function makes a lambda that
	## holds `readback` itself, so a callback that the RenderingDevice delivers while the engine shuts down, after the
	## harness is freed, still has its object.
	static func request(readback: FrameReadback, rd: RenderingDevice, texture: RID) -> void:
		var format := rd.texture_get_format(texture)
		if format == null or (format.format != RenderingDevice.DATA_FORMAT_R8G8B8A8_UNORM and format.format != RenderingDevice.DATA_FORMAT_R8G8B8A8_SRGB):
			readback._finish(FAILED, PackedByteArray(), Vector2i.ZERO)
			return
		var size := Vector2i(format.width, format.height)
		var received := func(pixels: PackedByteArray) -> void: readback._finish(RECEIVED, pixels, size)
		if rd.texture_get_data_async(texture, 0, received) != OK:
			readback._finish(FAILED, PackedByteArray(), Vector2i.ZERO)

	func _finish(state: int, pixels: PackedByteArray, size: Vector2i) -> void:
		_mutex.lock()
		_state = state
		_pixels = pixels
		_size = size
		_mutex.unlock()

	## Returns [state, pixels, size]; pixels are tightly packed rows of `size` once the state is RECEIVED.
	func take() -> Array:
		_mutex.lock()
		var taken := [_state, _pixels, _size]
		_mutex.unlock()
		return taken

## Prepares one streamed frame on a WorkerThreadPool thread: converts, scales, and frames the picture with `layout`,
## then encodes it. The source is `picture`, or `pixels`, 8-bit RGBA rows of `picture_size`; once the task starts,
## no other thread touches them. The main thread reads `bytes`, `size`, and `usec` only after the task completed.
class FrameEncoding extends RefCounted:
	var picture: Image
	var pixels: PackedByteArray
	var picture_size: Vector2i
	var layout: FrameLayout
	var png: bool
	var quality: float
	var bytes := PackedByteArray()  # the PNG or JPEG file; empty when encoding failed
	var size := Vector2i.ZERO  # the encoded image's size
	var usec := 0  # time to prepare and encode the frame

	func _init(source: Image, source_pixels: PackedByteArray, source_size: Vector2i, frame_layout: FrameLayout, as_png: bool, jpeg_quality: float) -> void:
		picture = source
		pixels = source_pixels
		picture_size = source_size
		layout = frame_layout
		png = as_png
		quality = jpeg_quality

	func run() -> void:
		var start := Time.get_ticks_usec()
		var source := picture
		if source == null:
			source = Image.create_from_data(picture_size.x, picture_size.y, false, Image.FORMAT_RGBA8, pixels)
		if not source.is_empty():
			var framed := layout.apply(source)
			size = framed.get_size()
			bytes = framed.save_png_to_buffer() if png else framed.save_jpg_to_buffer(quality)
		usec = Time.get_ticks_usec() - start

## One frame of a recording: copied from the GPU without waiting, or read at once, then encoded on a worker. `time_ms`
## places it in the video: real milliseconds since the recording started, or game frames times their length.
class RecordFrame extends RefCounted:
	var index := 0
	var time_ms := 0
	var readback: FrameReadback = null
	var encoding: FrameEncoding = null
	var task := -1
	var failed := false

class HarnessLogger extends Logger:
	var _mutex := Mutex.new()
	var _pending: Array[Dictionary] = []
	var dropped := 0
	# Entries logged by code that `eval` compiled: {script path: entries}. While `swallow` holds a path, its entries
	# stay out of the log, as the trial compiles of `eval` code do.
	var _watched := {}
	var _swallow := ""

	## Collects the entries that name `path` as their file until `unwatch`; with `swallow`, they also stay out of the log.
	func watch(path: String, swallow: bool) -> void:
		_mutex.lock()
		_watched[path] = []
		if swallow:
			_swallow = path
		_mutex.unlock()

	## Stops collecting the entries of `path`; returns them.
	func unwatch(path: String) -> Array:
		_mutex.lock()
		var entries: Array = _watched.get(path, [])
		_watched.erase(path)
		if _swallow == path:
			_swallow = ""
		_mutex.unlock()
		return entries

	func _log_message(message: String, error: bool) -> void:
		_push({"level": "stderr" if error else "stdout", "message": bounded(message.trim_suffix("\n"), LOG_MAX_CHARS)})

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
		var level := "error"
		match error_type:
			Logger.ERROR_TYPE_WARNING:
				level = "warning"
			Logger.ERROR_TYPE_SCRIPT:
				level = "script_error"
			Logger.ERROR_TYPE_SHADER:
				level = "shader_error"
		var entry := {
			"level": level,
			"message": bounded(rationale if not rationale.is_empty() else code, LOG_MAX_CHARS),
			"function": bounded(function, LOG_MAX_FIELD_CHARS),
			"file": bounded(file, LOG_MAX_FIELD_CHARS),
			"line": line,
		}
		if not code.is_empty() and not rationale.is_empty():
			entry["code"] = bounded(code, LOG_MAX_CHARS)
		var frames: Array[Dictionary] = []
		for backtrace in script_backtraces:
			for i in backtrace.get_frame_count():
				if frames.size() >= LOG_MAX_FRAMES:
					break
				frames.append({
					"function": bounded(backtrace.get_frame_function(i), LOG_MAX_FIELD_CHARS),
					"file": bounded(backtrace.get_frame_file(i), LOG_MAX_FIELD_CHARS),
					"line": backtrace.get_frame_line(i),
				})
		if not frames.is_empty():
			entry["backtrace"] = frames
		_push(entry)

	## Returns `text`, or its start and a marker that names its length, in at most `limit` characters.
	static func bounded(text: String, limit: int) -> String:
		if text.length() <= limit:
			return text
		var marker := "… (%d characters)" % text.length()
		return text.left(limit - marker.length()) + marker

	func _push(entry: Dictionary) -> void:
		entry["time_ms"] = Time.get_ticks_msec()
		_mutex.lock()
		var file: String = entry.get("file", "")
		if _watched.has(file):
			_watched[file].append(entry.duplicate())
			if file == _swallow:
				_mutex.unlock()
				return
		if _pending.size() >= MAX_PENDING_LOGS:
			# A quarter goes at once, so a storm of messages costs a copy per thousand of them, not a shift per message.
			var drop := MAX_PENDING_LOGS / 4
			var kept: Array[Dictionary] = []
			kept.assign(_pending.slice(drop))
			_pending = kept
			dropped += drop
		_pending.append(entry)
		_mutex.unlock()

	func take() -> Array[Dictionary]:
		_mutex.lock()
		var taken := _pending
		_pending = []
		_mutex.unlock()
		return taken


## One capture of the Master bus's mix. The main thread pulls the captured frames once per frame of the game.
class AudioCapture extends RefCounted:
	var id
	var effect := AudioEffectCapture.new()
	var started := 0.0  # real time in seconds
	var deadline := 0.0
	var target := 0  # frames to capture
	var rate := 0.0
	var data := PackedByteArray()  # interleaved 32-bit float stereo samples
	var frames := 0
	var start_frame := 0
	var start_usec := 0
	var volumes: Array = []  # [captured frame, Master volume dB, Master muted]
	var peaks := {}  # bus name: largest peak in dB
	var players := {}  # instance id: {path, class, stream, bus, volumeDb, starts, firstAt, lastAt, playing}
	var bypassed := false

	func _init(request_id, now: float, capture_deadline: float, seconds: float) -> void:
		id = request_id
		started = now
		deadline = capture_deadline
		rate = AudioServer.get_mix_rate()
		target = maxi(1, roundi(seconds * rate))
		start_usec = Time.get_ticks_usec()
		bypassed = AudioServer.is_bus_bypassing_effects(0)
		effect.buffer_length = AUDIO_BUFFER_SECONDS
		AudioServer.add_bus_effect(0, effect)
		note_volume()

	## Moves the frames that the effect captured, up to the target, into `data`.
	func pull() -> void:
		var count := mini(effect.get_frames_available(), target - frames)
		if count <= 0:
			return
		var pairs := effect.get_buffer(count)
		var bytes := pairs.to_byte_array()
		if bytes.size() != count * 8:
			# A build with double precision stores 64-bit vectors.
			var samples := PackedFloat32Array()
			samples.resize(count * 2)
			for i in count:
				samples[i * 2] = pairs[i].x
				samples[i * 2 + 1] = pairs[i].y
			bytes = samples.to_byte_array()
		data.append_array(bytes)
		frames += count

	func note_volume() -> void:
		var volume := AudioServer.get_bus_volume_db(0)
		var muted := AudioServer.is_bus_mute(0)
		if volumes.is_empty() or volumes[-1][1] != volume or volumes[-1][2] != muted:
			volumes.append([frames, volume, muted])

	## Whether the effect still sits on the Master bus; a bus layout that the game set during the capture removes it.
	func attached() -> bool:
		for i in AudioServer.get_bus_effect_count(0):
			if AudioServer.get_bus_effect(0, i) == effect:
				return true
		return false

	func detach() -> void:
		for i in range(AudioServer.get_bus_effect_count(0) - 1, -1, -1):
			if AudioServer.get_bus_effect(0, i) == effect:
				AudioServer.remove_bus_effect(0, i)

	func follow(node: Node) -> void:
		if players.size() >= AUDIO_MAX_PLAYERS or not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
			return
		var key := node.get_instance_id()
		if not players.has(key):
			players[key] = {"path": str(node.get_path()), "class": node.get_class(), "stream": "", "bus": str(node.bus), "volumeDb": node.volume_db,
				"starts": 0, "firstAt": -1.0, "lastAt": -1.0, "playing": false}

	## Records the frame at `seconds` into the capture: bus peaks, and which players play.
	func observe(seconds: float) -> void:
		for bus in AudioServer.bus_count:
			var name := str(AudioServer.get_bus_name(bus))
			var peak := maxf(AudioServer.get_bus_peak_volume_left_db(bus, 0), AudioServer.get_bus_peak_volume_right_db(bus, 0))
			peaks[name] = maxf(float(peaks.get(name, -200.0)), peak)
		for key in players:
			var node := instance_from_id(key) as Node
			if node == null:
				continue
			var entry: Dictionary = players[key]
			var playing: bool = node.is_playing()
			if playing and not entry["playing"]:
				entry["starts"] += 1
				if entry["firstAt"] < 0.0:
					entry["firstAt"] = seconds
				var stream: AudioStream = node.stream
				entry["stream"] = "" if stream == null else (stream.resource_path if not stream.resource_path.is_empty() else stream.get_class())
				entry["bus"] = str(node.bus)
				entry["volumeDb"] = node.volume_db
			if playing:
				entry["lastAt"] = seconds
			entry["playing"] = playing


var _logger := HarnessLogger.new()
var _peer := StreamPeerTCP.new()
var _connected := false
var _outbox: Array[PackedByteArray] = []  # messages waiting for the connection, oldest first
var _outbox_offset := 0  # bytes of the first waiting message already sent
var _outbox_bytes := 0  # bytes still to send
# Guards the connection, `_connected`, the waiting messages, and the main loop's progress below, which the heartbeat
# thread reads.
var _io := Mutex.new()
var _heartbeat: Thread = null  # the thread that sends `busy`, from the hello on
var _beating := false  # false stops the heartbeat thread
var _main_ms := 0  # ticks in milliseconds when the main loop last reached `_process`
var _main_frame := 0  # the frame whose `_process` began then
var _busy_sent_ms := 0  # ticks in milliseconds of the latest `busy` message
var _hello_sent := false
var _port := 0
var _token := ""
var _scene_override := ""
var _rx := PackedByteArray()

var _runtime: Object = null  # the WASDEngineRuntime singleton, when the runtime has it
# Whether the runtime's profiler may time engine methods while scripts run on other threads.
var _engine_calls_safe := false
var _audio: AudioCapture = null  # the running audio capture

var _stream_fps := 0.0
var _own_max_fps := -1  # the game's own Engine.max_fps while the harness caps the frame rate, -1 while it does not
var _fixed_fps := 0  # the game's --fixed-fps, which --wasd-fixed-fps repeats; 0 for none
# Tick microseconds at which the next frame of a capped game with a fixed frame rate may start; 0 while uncapped.
var _frame_due := 0
var _pace_cap := 0  # the Host's frame rate cap, 0 for none
var _presenting := true  # whether the root viewport presents its frames to the window
var _present_cap := 0  # the screen's refresh rate while the game does not present, 0 while it does
var _stream_quality := 0.9
var _stream_max_width := 1280
var _stream_lossless := false
var _next_frame_time := 0.0  # real time in seconds when the next streamed frame is due
var _frame_sequence := 0
var _readback: FrameReadback = null  # the frame being copied from the GPU
var _readback_refused := false  # whether this run's picture cannot be copied asynchronously, so frames are read synchronously
var _encoding: FrameEncoding = null  # the frame being prepared for sending
var _encoding_task := -1
var _queued: FrameEncoding = null  # a captured frame that waits for the worker to finish `_encoding`
var _lossless_test: FrameEncoding = null  # a test PNG encode of a frame sent as JPEG; never sent
var _lossless_test_task := -1
var _lossless_frames := false  # whether streamed frames are PNG
var _lossless_test_at := 0.0  # real time in seconds from which the next test may start
var _lossless_test_delay := LOSSLESS_TEST_DELAY

var _frame := 0
var _frame_seconds := 0.0  # game time that the nodes ran in the frame of the latest _process
var _process_at := 0.0  # real time in seconds when the latest connected _process began, 0 before the first
# Input sequences in arrival order; the first one runs. {id, sequence, events, index, frames, started,
# wait_until, deadline, pressed: {press identity: press event}}; times are real seconds.
var _actions: Array[Dictionary] = []
var _sequences := 0  # serial number of the latest input sequence; holds name their sequence by it
# Pending wait and step requests: {id, kind, frames, seconds, start_frame, game_seconds, deadline}.
var _waits: Array[Dictionary] = []
# Scheduled hold releases: {sequence, identity, press, at}.
var _holds: Array[Dictionary] = []
var _last_status_ms := 0
var _eval_serial := 0
# Views being drawn: {id, viewport, frames left, layers to restore, format, quality, facts}.
var _views: Array[Dictionary] = []
var _view_holder: Node = null
# The running recording, or empty: {id, fps, maxWidth, quality, step, frameMs, maxFrames, started, next, frame0, until,
# captured, sent, skipped, frames: Array[RecordFrame] in capture order, stop: the stop request's id or null, size}.
var _recording := {}
# The answer of the latest recording that ended before its stop request arrived.
var _ended_recording := {}
# `eval` code that awaits: {request id: real time in seconds at which its answer stops waiting, 0 for never}.
var _evals := {}
var _last_mouse_mode := -1
var _last_scene := ""
# The running performance sample, or empty: {id, started, end, deadline (real seconds), frames, droppedFrames,
# pausedFrames, physicsSteps, streamedFrames, series: {name: values}, monitorsStart, marks, phase, scriptSeconds,
# scriptStart, scriptEnd, scriptFrames, engineCalls}, and, once the frame window ended, {framesEnded, monitorsEnd,
# custom}. `marks` holds the tick microseconds at which the phases of the current frame began, 0 until they do, and its
# physics microseconds. `phase` is "frames" during the frame window and "scripts" during the script window.
var _sample := {}


func _init() -> void:
	OS.add_logger(_logger)
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--wasd-port="):
			_port = arg.trim_prefix("--wasd-port=").to_int()
		elif arg.begins_with("--wasd-token="):
			_token = arg.trim_prefix("--wasd-token=")
		elif arg.begins_with("--wasd-scene="):
			_scene_override = arg.trim_prefix("--wasd-scene=")
		elif arg.begins_with("--wasd-fixed-fps="):
			_fixed_fps = maxi(0, arg.trim_prefix("--wasd-fixed-fps=").to_int())
	if Engine.has_singleton(RUNTIME_SINGLETON):
		_runtime = Engine.get_singleton(RUNTIME_SINGLETON)
		_engine_calls_safe = (_runtime.has_method(&"is_native_call_profiling_thread_safe")
				and _runtime.call(&"is_native_call_profiling_thread_safe") == true)
	if _port > 0:
		_peer.connect_to_host("127.0.0.1", _port)


func _initialize() -> void:
	var scene := _scene_override
	if scene.is_empty():
		scene = ResourceUID.ensure_path(str(ProjectSettings.get_setting("application/run/main_scene", "")))
	if scene.is_empty():
		push_error("WASD Engine harness: the project has no main scene; set application/run/main_scene or pass a scene.")
		return
	var err := change_scene_to_file(scene)
	if err != OK:
		push_error("WASD Engine harness: cannot open scene %s (%s)." % [scene, error_string(err)])


func _finalize() -> void:
	_stop_heartbeat()
	if _audio != null:
		_audio.detach()
	_wait_for_encodings()
	_flush_logs()
	OS.remove_logger(_logger)
	if _connected:
		_drain_outbox()
		_peer.disconnect_from_host()


func _process(delta: float) -> bool:
	var physics_end := Time.get_ticks_usec()
	var start := _hold_frame_cap(physics_end)
	if not _sample.is_empty():
		_sample_frame(start, physics_end)
	_frame += 1
	if _poll_connection():
		var now := Time.get_ticks_usec() / USEC_PER_SECOND
		# Before the requests that arrive now, which have spent no time yet.
		_spare_deadlines(now)
		_receive(now)
		_release_holds(now)
		_advance_actions(now)
		_advance_waits(now)
		_advance_sample(now)
		_advance_audio(now)
		_advance_evals(now)
		_flush_logs()
		_send_status_if_changed()
		_stream_frame(now)
		_advance_recording(now)
		_advance_views()
	# The main loop processes before the nodes do, so the nodes run this frame with the pause state set above.
	_frame_seconds = 0.0 if paused else delta
	if not _sample.is_empty():
		_sample["marks"]["paused"] = paused
	return false


func _poll_connection() -> bool:
	if _port <= 0:
		return false
	_io.lock()
	_main_ms = Time.get_ticks_msec()
	_main_frame = _frame
	_peer.poll()
	var status := _peer.get_status()
	var connected := false
	if status == StreamPeerTCP.STATUS_CONNECTED:
		if not _connected:
			_connected = true
			_peer.set_no_delay(true)
		if not _hello_sent:
			_hello_sent = true
			_send_json(_hello())
			_start_heartbeat()
		_flush_outbox()
		connected = _connected
	elif _connected and (status == StreamPeerTCP.STATUS_NONE or status == StreamPeerTCP.STATUS_ERROR):
		# The Host closed the connection: nothing else can observe or stop this game.
		quit()
	_io.unlock()
	return connected


## Starts the heartbeat thread; the main loop calls this once, holding `_io`, after it sent hello.
func _start_heartbeat() -> void:
	_heartbeat = Thread.new()
	_beating = true
	if _heartbeat.start(_beat) != OK:
		_beating = false
		_heartbeat = null


## Stops the heartbeat thread and waits for it to end.
func _stop_heartbeat() -> void:
	if _heartbeat == null:
		return
	_io.lock()
	_beating = false
	_io.unlock()
	_heartbeat.wait_to_finish()
	_heartbeat = null


## Runs on the heartbeat thread until `_beating` turns false: sends `busy` while the main loop has not reached
## `_process` for BUSY_REPORT_MS, once every BUSY_REPORT_MS. It touches only the harness's own state, under `_io`, and
## nothing of the engine's but the clock, so a main loop that is busy anywhere never holds it up.
func _beat() -> void:
	while true:
		_io.lock()
		if not _beating:
			_io.unlock()
			return
		var now := Time.get_ticks_msec()
		if _connected and now - _main_ms >= BUSY_REPORT_MS and now - _busy_sent_ms >= BUSY_REPORT_MS:
			_busy_sent_ms = now
			_send_json({"type": "busy", "frame": _main_frame, "ms": now - _main_ms})
		_io.unlock()
		OS.delay_msec(BUSY_CHECK_MS)


func _hello() -> Dictionary:
	var size := _window_size()
	var hello := {
		"type": "hello",
		"protocol": PROTOCOL_VERSION,
		"token": _token,
		"pid": OS.get_process_id(),
		"godot": Engine.get_version_info().get("string", ""),
		"project": str(ProjectSettings.get_setting("application/config/name", "")),
		"mainScene": str(ProjectSettings.get_setting("application/run/main_scene", "")),
		"displayServer": DisplayServer.get_name(),
		"renderingDriver": RenderingServer.get_current_rendering_driver_name(),
		"renderingMethod": RenderingServer.get_current_rendering_method(),
		"width": size.x,
		"height": size.y,
		"wasdRuntime": _runtime != null,
	}
	var layer_context := int(DisplayServer.get_meta(LAYER_CONTEXT_META, 0))
	if layer_context > 0:
		hello["layer"] = {"context": layer_context, "scale": DisplayServer.screen_get_max_scale()}
	return hello


func _window_size() -> Vector2i:
	return DisplayServer.window_get_size()


func _receive(now: float) -> void:
	_io.lock()
	var available := _peer.get_available_bytes()
	if available > 0:
		var chunk := _peer.get_data(available)
		if chunk[0] == OK:
			_rx.append_array(chunk[1])
	_io.unlock()
	while _rx.size() >= 4:
		var length := _rx.decode_u32(0)
		if length < 1 or length > MAX_MESSAGE_BYTES:
			push_error("WASD Engine harness: invalid message length %d from the Host." % length)
			_io.lock()
			_peer.disconnect_from_host()
			_io.unlock()
			return
		if _rx.size() < 4 + length:
			return
		var kind := _rx[4]
		var payload := _rx.slice(5, 4 + length)
		_rx = _rx.slice(4 + length)
		if kind == KIND_JSON:
			var parsed = JSON.parse_string(payload.get_string_from_utf8())
			if parsed is Dictionary:
				_handle(parsed, now)


func _handle(message: Dictionary, now: float) -> void:
	var id = message.get("id", null)
	match str(message.get("type", "")):
		"stream":
			_stream_fps = clampf(float(message.get("fps", 0)), 0.0, 60.0)
			_stream_quality = clampf(float(message.get("quality", _stream_quality)), 0.1, 1.0)
			_stream_max_width = clampi(int(message.get("maxWidth", _stream_max_width)), 64, 4096)
			_stream_lossless = message.get("lossless", false) == true
			_next_frame_time = 0.0
			_lossless_frames = false
			_lossless_test_at = 0.0
			_lossless_test_delay = LOSSLESS_TEST_DELAY
			_reply(id, {"fps": _stream_fps, "quality": _stream_quality, "maxWidth": _stream_max_width, "lossless": _stream_lossless})
		"pace":
			_pace(id, message)
		"screenshot":
			_screenshot(id, message)
		"input":
			var events = message.get("events", [])
			if not events is Array:
				_reply_error(id, "input.events must be an array")
				return
			var deadline := _deadline(id, message, now)
			if deadline >= 0.0:
				_sequences += 1
				_actions.append({
					"id": id, "sequence": _sequences, "events": events, "index": 0, "frames": 0, "started": 0.0,
					"wait_until": 0.0, "deadline": deadline, "pressed": {},
				})
		"pause":
			paused = true
			_end_steps(true)
			_reply(id, {"paused": true, "frame": _frame})
		"resume":
			paused = false
			_end_steps(false)
			_reply(id, {"paused": false, "frame": _frame})
		"step":
			var deadline := _deadline(id, message, now)
			if deadline >= 0.0:
				_end_steps(false)
				paused = false
				_waits.append(_pending_wait(id, "step", clampi(int(message.get("frames", 1)), 1, 100000), -1.0, deadline))
		"wait":
			var wait_frames := int(message.get("frames", -1))
			var wait_seconds := float(message.get("seconds", -1.0))
			if wait_frames < 0 and wait_seconds < 0.0:
				_reply_error(id, "wait needs frames or seconds")
				return
			var deadline := _deadline(id, message, now)
			if deadline >= 0.0:
				_waits.append(_pending_wait(id, "wait", wait_frames, wait_seconds, deadline))
		"cancel":
			var request = message.get("request", null)
			if request is int or request is float:
				_reply(id, {"cancelled": _cancel(request, now)})
			else:
				_reply_error(id, "cancel.request must be the id of a wait, step, or input request")
		"eval":
			_eval(id, message, now)
		"tree":
			_tree(id, message)
		"performance":
			_start_sample(id, message, now)
		"audio":
			_start_audio(id, message, now)
		"view":
			_view(id, message)
		"record":
			_record(id, message, now)
		"quit":
			_reply(id, {"quitting": true})
			quit(int(message.get("exitCode", 0)))
		_:
			_reply_error(id, "unknown request type %s" % str(message.get("type", "")))


## Applies the Host's pacing: a frame rate cap of `maxFps` (0 for none) and, with a boolean `present`, whether the game
## presents its frames to its window. Game time keeps its pace while physics steps fit the capped frames.
func _pace(id, message: Dictionary) -> void:
	_pace_cap = clampi(int(message.get("maxFps", 0)), 0, 1000)
	var present = message.get("present", null)
	if present is bool and present != _presenting:
		_set_presenting(present)
	_apply_frame_cap()
	_reply(id, {"maxFps": Engine.max_fps, "presenting": _presenting})


func _set_presenting(on: bool) -> void:
	_presenting = on
	if on:
		RenderingServer.frame_pre_draw.disconnect(_leave_screen)
		RenderingServer.viewport_set_update_mode(root.get_viewport_rid(), RenderingServer.VIEWPORT_UPDATE_WHEN_VISIBLE)
		# Setting the content scale mode makes the window attach its viewport to the screen where its settings place it.
		root.content_scale_mode = root.content_scale_mode
		_present_cap = 0
		return
	_leave_screen()
	# The window attaches its viewport again when its size or content scale changes, so it leaves before every frame.
	RenderingServer.frame_pre_draw.connect(_leave_screen)
	var refresh := DisplayServer.screen_get_refresh_rate()
	_present_cap = roundi(refresh) if refresh > 0.0 else UNKNOWN_REFRESH_FPS


## Detaches the root viewport from the screen and has it draw every frame into its texture anyway.
func _leave_screen() -> void:
	var viewport := root.get_viewport_rid()
	RenderingServer.viewport_attach_to_screen(viewport, Rect2(), DisplayServer.INVALID_WINDOW_ID)
	RenderingServer.viewport_set_update_mode(viewport, RenderingServer.VIEWPORT_UPDATE_ALWAYS)


## Holds a capped game that has a fixed frame rate, which Godot does not limit, to Engine.max_fps: waits until the
## frame's share of the cap has passed since the previous frame's start. Like Godot's frame limiter, the next start is
## due one share later, but never more than one share before or after now, so a slow frame neither delays the following
## ones nor lets them hurry. Returns the tick microseconds after the wait.
func _hold_frame_cap(now_usec: int) -> int:
	if _fixed_fps <= 0 or _own_max_fps < 0 or Engine.max_fps <= 0:
		_frame_due = 0
		return now_usec
	var share := int(USEC_PER_SECOND / Engine.max_fps)
	if _frame_due > now_usec:
		OS.delay_usec(_frame_due - now_usec)
		now_usec = Time.get_ticks_usec()
	_frame_due = clampi((_frame_due if _frame_due > 0 else now_usec) + share, now_usec - share, now_usec + share)
	return now_usec


## Caps Engine.max_fps at the lowest of the Host's cap, the screen's refresh rate while the game does not present, and
## the game's own cap; without a cap of the Host or the harness, it restores the game's own.
func _apply_frame_cap() -> void:
	var cap := 0
	for limit in [_pace_cap, _present_cap]:
		if limit > 0 and (cap == 0 or limit < cap):
			cap = limit
	if cap == 0:
		if _own_max_fps >= 0:
			Engine.max_fps = _own_max_fps
			_own_max_fps = -1
		return
	if _own_max_fps < 0:
		_own_max_fps = Engine.max_fps
	Engine.max_fps = cap if _own_max_fps == 0 else mini(cap, _own_max_fps)


## Returns the real time in seconds at which a request's `timeoutMs` ends it, 0 when it has none, or -1 after
## answering an invalid one with an error.
func _deadline(id, message: Dictionary, now: float) -> float:
	var timeout = message.get("timeoutMs", null)
	if timeout == null:
		return 0.0
	if not (timeout is int or timeout is float) or float(timeout) <= 0.0:
		_reply_error(id, "timeoutMs must be a positive number of milliseconds")
		return -1.0
	return now + float(timeout) / 1000.0


## Moves the deadlines of the pending waits, steps, and input sequences by the real time that the previous frame took
## beyond BUSY_REPORT_MS, during which the harness reported the main loop busy, so such a frame uses up none of the time
## that they allow.
func _spare_deadlines(now: float) -> void:
	var busy := now - _process_at - BUSY_REPORT_MS / 1000.0
	var first := _process_at == 0.0
	_process_at = now
	if first or busy <= 0.0:
		return
	for pending in _waits + _actions:
		if pending["deadline"] > 0.0:
			pending["deadline"] += busy


func _pending_wait(id, kind: String, frames: int, seconds: float, deadline: float) -> Dictionary:
	return {"id": id, "kind": kind, "frames": frames, "seconds": seconds, "start_frame": _frame, "game_seconds": 0.0, "deadline": deadline}


func _advance_waits(now: float) -> void:
	var remaining: Array[Dictionary] = []
	for wait in _waits:
		var frames := _frame - int(wait["start_frame"])
		if frames > 0:
			wait["game_seconds"] += _frame_seconds
		var done: bool = (frames >= wait["frames"]) if wait["frames"] >= 0 else (wait["game_seconds"] >= wait["seconds"])
		if done:
			_answer_wait(wait, false, false, true)
		elif wait["deadline"] > 0.0 and now >= wait["deadline"]:
			_answer_wait(wait, true, false, true)
		else:
			remaining.append(wait)
	_waits = remaining


## Answers a wait or step that ended; a step pauses the game when `pause_step` is true.
func _answer_wait(wait: Dictionary, timed_out: bool, cancelled: bool, pause_step: bool) -> void:
	if wait["kind"] == "step" and pause_step:
		paused = true
	_reply(wait["id"], {
		"frames": _frame - int(wait["start_frame"]),
		"seconds": wait["game_seconds"],
		"frame": _frame,
		"paused": paused,
		"timedOut": timed_out,
		"cancelled": cancelled,
	})


## Ends every pending step as cancelled; `pause_step` false leaves the game running.
func _end_steps(pause_step: bool) -> void:
	var remaining: Array[Dictionary] = []
	for wait in _waits:
		if wait["kind"] == "step":
			_answer_wait(wait, false, true, pause_step)
		else:
			remaining.append(wait)
	_waits = remaining


## Ends the pending wait, step, input, or performance request whose id is `request`; returns whether one was pending.
func _cancel(request, now: float) -> bool:
	if not _sample.is_empty() and _sample["id"] == request:
		_finish_sample(now, false, true)
		return true
	if _audio != null and _audio.id == request:
		_finish_audio(now, false, true)
		return true
	if _evals.has(request):
		_evals.erase(request)
		_reply_error(request, "cancelled")
		return true
	for i in _waits.size():
		if _waits[i]["id"] == request:
			var wait: Dictionary = _waits[i]
			_waits.remove_at(i)
			_answer_wait(wait, false, true, true)
			return true
	for i in _actions.size():
		if _actions[i]["id"] == request:
			var action: Dictionary = _actions[i]
			_actions.remove_at(i)
			_end_sequence(action, now, false, true)
			return true
	return false


func _advance_actions(now: float) -> void:
	var queued: Array[Dictionary] = []
	for action in _actions:
		if action["deadline"] > 0.0 and now >= action["deadline"]:
			_end_sequence(action, now, true, false)
		else:
			queued.append(action)
	_actions = queued
	if _actions.is_empty():
		return
	var action: Dictionary = _actions[0]
	if action["frames"] == 0:
		action["started"] = now
	action["frames"] += 1
	if now < action["wait_until"]:
		return
	if action["wait_until"] > 0.0:
		action["wait_until"] = 0.0
		action["index"] += 1
	var events: Array = action["events"]
	while action["index"] < events.size():
		var event = events[action["index"]]
		if not event is Dictionary:
			_fail_sequence(action, "input event %d is not an object" % action["index"])
			return
		if event.has("wait"):
			var seconds := float(event["wait"])
			if seconds > 0.0:
				action["wait_until"] = now + seconds
				return
			action["index"] += 1
			continue
		var error := _inject(event, action, now)
		if not error.is_empty():
			_fail_sequence(action, "input event %d: %s" % [action["index"], error])
			return
		action["index"] += 1
	_actions.pop_front()
	_reply(action["id"], _sequence_result(action, now, false, false))


func _sequence_result(action: Dictionary, now: float, timed_out: bool, cancelled: bool) -> Dictionary:
	return {
		"events": action["index"],
		"frames": action["frames"],
		"seconds": now - float(action["started"]) if action["frames"] > 0 else 0.0,
		"frame": _frame,
		"timedOut": timed_out,
		"cancelled": cancelled,
	}


## Ends an input sequence before its last event: releases what it holds down, then answers with what ran.
func _end_sequence(action: Dictionary, now: float, timed_out: bool, cancelled: bool) -> void:
	_release_presses(action)
	_reply(action["id"], _sequence_result(action, now, timed_out, cancelled))


## Fails the running input sequence after releasing what it holds down; earlier events keep their effect.
func _fail_sequence(action: Dictionary, message: String) -> void:
	_actions.pop_front()
	_release_presses(action)
	_reply_error(action["id"], message)


func _release_presses(action: Dictionary) -> void:
	var pressed: Dictionary = action["pressed"]
	for identity in pressed:
		Input.parse_input_event(_release_of(pressed[identity]))
	pressed.clear()
	var holds: Array[Dictionary] = []
	for hold in _holds:
		if hold["sequence"] != action["sequence"]:
			holds.append(hold)
	_holds = holds


func _release_holds(now: float) -> void:
	var holds: Array[Dictionary] = []
	for hold in _holds:
		if now < hold["at"]:
			holds.append(hold)
			continue
		Input.parse_input_event(_release_of(hold["press"]))
		for action in _actions:
			if action["sequence"] == hold["sequence"]:
				action["pressed"].erase(hold["identity"])
	_holds = holds


## Delivers a key, mouse button, action, or joypad button event, and records for the input sequence `action`
## which presses it holds down and when a `hold` releases them.
func _deliver(action: Dictionary, input_event: InputEvent, source: Dictionary, now: float) -> void:
	Input.parse_input_event(input_event)
	var identity := _press_identity(input_event)
	var pressed: Dictionary = action["pressed"]
	if not input_event.is_pressed():
		pressed.erase(identity)
		var holds: Array[Dictionary] = []
		for hold in _holds:
			if hold["sequence"] != action["sequence"] or hold["identity"] != identity:
				holds.append(hold)
		_holds = holds
		return
	pressed[identity] = input_event
	if source.has("hold"):
		_holds.append({"sequence": action["sequence"], "identity": identity, "press": input_event, "at": now + maxf(float(source["hold"]), 0.0)})


func _press_identity(input_event: InputEvent) -> String:
	if input_event is InputEventKey:
		return "key %d" % input_event.keycode
	if input_event is InputEventMouseButton:
		return "mouse %d" % input_event.button_index
	if input_event is InputEventAction:
		return "action %s" % input_event.action
	return "joy %d %d" % [input_event.device, input_event.button_index]


func _release_of(press: InputEvent) -> InputEvent:
	var release := press.duplicate() as InputEvent
	release.set("pressed", false)
	if release is InputEventKey:
		release.echo = false
	elif release is InputEventMouseButton:
		release.double_click = false
		release.button_mask = Input.get_mouse_button_mask() & ~(1 << (release.button_index - 1))
	elif release is InputEventAction:
		release.strength = 0.0
	elif release is InputEventJoypadButton:
		release.pressure = 0.0
	return release


func _inject(event: Dictionary, action: Dictionary, now: float) -> String:
	match str(event.get("kind", "")):
		"key":
			var key := InputEventKey.new()
			var keycode := int(event.get("keycode", 0))
			if keycode == 0 and event.has("key"):
				keycode = OS.find_keycode_from_string(str(event["key"]))
				if keycode == KEY_NONE:
					return "unknown key %s" % str(event["key"])
			if keycode == 0:
				return "key events need key or keycode"
			key.keycode = keycode
			key.physical_keycode = keycode
			key.key_label = keycode
			key.pressed = bool(event.get("pressed", true))
			key.echo = bool(event.get("echo", false))
			if event.has("unicode"):
				key.unicode = int(event["unicode"])
			_apply_modifiers(key, event)
			_deliver(action, key, event, now)
		"text":
			for character in str(event.get("text", "")):
				var down := InputEventKey.new()
				down.unicode = character.unicode_at(0)
				down.keycode = OS.find_keycode_from_string(character.to_upper()) if character.length() == 1 else KEY_NONE
				down.pressed = true
				Input.parse_input_event(down)
				var up := down.duplicate()
				up.pressed = false
				Input.parse_input_event(up)
		"mouse_button":
			var button := InputEventMouseButton.new()
			button.button_index = _mouse_button(event.get("button", "left"))
			if button.button_index == MOUSE_BUTTON_NONE:
				return "unknown mouse button %s" % str(event.get("button"))
			button.pressed = bool(event.get("pressed", true))
			button.double_click = bool(event.get("double", false))
			button.position = Vector2(float(event.get("x", 0)), float(event.get("y", 0)))
			button.global_position = button.position
			button.factor = float(event.get("factor", 1.0))
			var mask := Input.get_mouse_button_mask()
			var bit := 1 << (button.button_index - 1)
			button.button_mask = (mask | bit) if button.pressed else (mask & ~bit)
			_apply_modifiers(button, event)
			_deliver(action, button, event, now)
		"mouse_motion":
			var motion := InputEventMouseMotion.new()
			motion.position = Vector2(float(event.get("x", 0)), float(event.get("y", 0)))
			motion.global_position = motion.position
			motion.relative = Vector2(float(event.get("dx", 0)), float(event.get("dy", 0)))
			motion.screen_relative = motion.relative
			motion.button_mask = Input.get_mouse_button_mask()
			_apply_modifiers(motion, event)
			Input.parse_input_event(motion)
		"action":
			var name := StringName(str(event.get("action", "")))
			if not InputMap.has_action(name):
				return "unknown input action %s" % name
			var action_event := InputEventAction.new()
			action_event.action = name
			action_event.pressed = bool(event.get("pressed", true))
			action_event.strength = float(event.get("strength", 1.0)) if action_event.pressed else 0.0
			_deliver(action, action_event, event, now)
		"joy_button":
			var joy_button := InputEventJoypadButton.new()
			joy_button.device = int(event.get("device", 0))
			joy_button.button_index = int(event.get("button", 0))
			joy_button.pressed = bool(event.get("pressed", true))
			joy_button.pressure = 1.0 if joy_button.pressed else 0.0
			_deliver(action, joy_button, event, now)
		"joy_axis":
			var joy_axis := InputEventJoypadMotion.new()
			joy_axis.device = int(event.get("device", 0))
			joy_axis.axis = int(event.get("axis", 0))
			joy_axis.axis_value = clampf(float(event.get("value", 0.0)), -1.0, 1.0)
			Input.parse_input_event(joy_axis)
		"focus":
			notification(NOTIFICATION_APPLICATION_FOCUS_IN if bool(event.get("focused", true)) else NOTIFICATION_APPLICATION_FOCUS_OUT)
		_:
			return "unknown event kind %s" % str(event.get("kind", ""))
	return ""


func _apply_modifiers(event: InputEventWithModifiers, source: Dictionary) -> void:
	event.shift_pressed = bool(source.get("shift", false))
	event.ctrl_pressed = bool(source.get("ctrl", false))
	event.alt_pressed = bool(source.get("alt", false))
	event.meta_pressed = bool(source.get("meta", false))


func _mouse_button(value) -> MouseButton:
	if value is int or value is float:
		return int(value) as MouseButton
	match str(value):
		"left":
			return MOUSE_BUTTON_LEFT
		"right":
			return MOUSE_BUTTON_RIGHT
		"middle":
			return MOUSE_BUTTON_MIDDLE
		"wheel_up":
			return MOUSE_BUTTON_WHEEL_UP
		"wheel_down":
			return MOUSE_BUTTON_WHEEL_DOWN
		"wheel_left":
			return MOUSE_BUTTON_WHEEL_LEFT
		"wheel_right":
			return MOUSE_BUTTON_WHEEL_RIGHT
	return MOUSE_BUTTON_NONE


## Returns where the root viewport's picture shows in an image of the game window scaled down to at most
## `max_width` pixels wide (0 keeps the window size).
func _frame_layout(max_width: int) -> FrameLayout:
	var layout := FrameLayout.new()
	var window := _window_size()
	if window.x <= 0 or window.y <= 0:
		return layout
	var scale := minf(1.0, float(max_width) / window.x) if max_width > 0 else 1.0
	layout.size = Vector2i(maxi(1, roundi(window.x * scale)), maxi(1, roundi(window.y * scale)))
	# The window shows the root viewport's picture in its visible rect mapped through the window's letterbox and
	# stretch transforms, which are the final transform without the global canvas transform; black fills the rest.
	var shown := root.get_final_transform() * root.global_canvas_transform.affine_inverse() * root.get_visible_rect()
	layout.target = Rect2i(Vector2i((shown.position * scale).round()), Vector2i((shown.size * scale).round()).maxi(1))
	return layout


## Returns the picture the game window shows, scaled down to at most `max_width` pixels wide (0 keeps the window
## size), or null before the root viewport has an image. It reads the picture synchronously.
func _capture(max_width: int) -> Image:
	var picture := root.get_texture().get_image()
	if picture == null or picture.is_empty():
		return null
	return _frame_layout(max_width).apply(picture)


func _screenshot(id, message: Dictionary) -> void:
	var max_width := int(message.get("maxWidth", 0))
	var region = message.get("region", null)
	var facts := {}
	var image: Image
	if region is Dictionary:
		var window_image := _capture(0)
		if window_image == null:
			_reply_error(id, "the root viewport has no image yet")
			return
		var bounds := Rect2i(Vector2i.ZERO, window_image.get_size())
		var rect := Rect2i(int(region.get("x", 0)), int(region.get("y", 0)), int(region.get("width", 0)), int(region.get("height", 0))).intersection(bounds)
		if rect.size.x <= 0 or rect.size.y <= 0:
			_reply_error(id, "the region lies outside the %dx%d window" % [bounds.size.x, bounds.size.y])
			return
		image = window_image.get_region(rect)
		if max_width > 0 and image.get_width() > max_width:
			image.resize(max_width, maxi(1, roundi(image.get_height() * float(max_width) / image.get_width())), Image.INTERPOLATE_LANCZOS)
		else:
			# A small region grows by the largest whole factor that keeps it within minWidth, each window pixel a square, so a
			# model sees its detail.
			var factor := clampi(int(message.get("minWidth", 0)) / image.get_width(), 1, REGION_MAX_FACTOR)
			if factor > 1:
				image.resize(image.get_width() * factor, image.get_height() * factor, Image.INTERPOLATE_NEAREST)
		facts = {"x": rect.position.x, "y": rect.position.y, "regionWidth": rect.size.x, "regionHeight": rect.size.y}
	else:
		image = _capture(max_width)
	if image == null:
		_reply_error(id, "the root viewport has no image yet")
		return
	var format := str(message.get("format", "png"))
	var window := _window_size()
	facts.merge({"format": "jpeg" if format == "jpeg" else "png", "width": image.get_width(), "height": image.get_height(), "windowWidth": window.x, "windowHeight": window.y, "frame": _frame, "paused": paused})
	var quality := clampf(float(message.get("quality", 0.85)), 0.1, 1.0)
	_answer_image(id, facts, image.save_jpg_to_buffer(quality) if format == "jpeg" else image.save_png_to_buffer())


## Answers request `id` with `facts`, then sends the image bytes; an image too large for a message is an error answer.
func _answer_image(id, facts: Dictionary, bytes: PackedByteArray) -> void:
	if not _fits(bytes.size() + 4):
		var image := "the %dx%d image" % [int(facts["width"]), int(facts["height"])]
		_reply_error(id, _too_large(image, bytes.size()) + "; ask for a smaller image or JPEG")
		return
	_reply(id, facts)
	var header := PackedByteArray()
	header.resize(4)
	header.encode_u32(0, int(id) if id != null else 0)
	header.append_array(bytes)
	_send(KIND_IMAGE, header)


func _stream_frame(now: float) -> void:
	_finish_lossless_test(now)
	_finish_encoding(now)
	_finish_readback(now)
	# The next frame's copy overlaps the previous frame's preparation, and one frame at most waits between them, which
	# keeps a slow stage from piling up frames; nothing is captured while messages still wait for the connection.
	if _stream_fps <= 0.0 or now < _next_frame_time or _readback != null or _queued != null or _outbox_bytes > 0:
		return
	var interval := 1.0 / _stream_fps
	# Keep the cadence while the loop keeps up; after a stall, restart it instead of sending a burst.
	_next_frame_time = _next_frame_time + interval if now - _next_frame_time < interval else now + interval
	var layout := _frame_layout(_stream_max_width)
	var rd := RenderingServer.get_rendering_device()
	if rd != null and not _readback_refused:
		var texture := RenderingServer.texture_get_rd_texture(root.get_texture().get_rid())
		if texture.is_valid():
			_readback = FrameReadback.new(layout)
			RenderingServer.call_on_render_thread(FrameReadback.request.bind(_readback, rd, texture))
			return
	var picture := root.get_texture().get_image()
	if picture == null or picture.is_empty():
		return
	_queue_frame(FrameEncoding.new(picture, PackedByteArray(), Vector2i.ZERO, layout, false, _stream_quality), now)


## Starts or stops a recording. `start` records the game window, scaled down to at most `maxWidth`, as JPEG frames at
## `quality`: `fps` times per second of real time, or with a positive `frameStep` every that many game frames, each
## frame `frameMs` of video, never skipping one; it captures no further frame after `frames` frames when that is
## positive, or after `seconds` of real time. Frames go out as kind 4: u32 recording id, u32 frame index, u32
## milliseconds into the video, u16 width, u16 height, then the JPEG file. `stop` captures no further frames, or with
## `wait` lets the recording reach its end, and answers once the captured frames went out; a frame whose copy from the
## GPU has not arrived RECORD_FINISH_SECONDS after the recording stopped capturing counts as skipped, so a recording
## ends even while the GPU delivers no copies, and the next one can start.
func _record(id, message: Dictionary, now: float) -> void:
	var recording := int(message.get("recording", 0))
	match str(message.get("action", "")):
		"start":
			if not _recording.is_empty():
				_reply_error(id, "a recording is already running")
				return
			_recording = {
				"id": recording,
				"fps": clampf(float(message.get("fps", 30.0)), 1.0, 60.0),
				"maxWidth": clampi(int(message.get("maxWidth", 1920)), 64, 4096),
				"quality": clampf(float(message.get("quality", 0.9)), 0.1, 1.0),
				"step": clampi(int(message.get("frameStep", 0)), 0, 1000),
				"maxFrames": maxi(int(message.get("frames", 0)), 0),
				"frameMs": maxf(float(message.get("frameMs", 0.0)), 0.0),
				"started": now, "next": now, "frame0": _frame,
				"until": now + clampf(float(message.get("seconds", 60.0)), 0.1, 3600.0),
				"captured": 0, "sent": 0, "skipped": 0, "frames": [], "stop": null, "size": Vector2i.ZERO,
			}
			_ended_recording = {}
			_reply(id, {"recording": recording, "frame": _frame})
		"stop":
			if not _recording.is_empty() and _recording["id"] == recording:
				_recording["stop"] = id
				if message.get("wait", false) != true:
					_recording["until"] = minf(_recording["until"], now)
			elif not _ended_recording.is_empty() and _ended_recording["recording"] == recording:
				_reply(id, _ended_recording)
				_ended_recording = {}
			else:
				_reply_error(id, "no recording %d is running" % recording)
		_:
			_reply_error(id, "record.action must be start or stop")


## Captures the recording's due frame, hands copied frames to workers, sends encoded frames in order, and ends the
## recording once it stopped capturing and its last frame went out. A real-time recording skips a frame while its
## frames in flight or the waiting messages are full; a game-frame recording waits for them instead.
func _advance_recording(now: float) -> void:
	if _recording.is_empty():
		return
	var frames: Array = _recording["frames"]
	if now >= float(_recording["until"]) + RECORD_FINISH_SECONDS:
		_skip_record_readbacks(frames)
	_finish_record_frames(frames)
	var step: int = _recording["step"]
	if now < float(_recording["until"]) and _record_due(now, step):
		if step > 0:
			while frames.size() >= RECORD_MAX_IN_FLIGHT:
				WorkerThreadPool.wait_for_task_completion((frames[0] as RecordFrame).task)
				(frames[0] as RecordFrame).task = -2
				_finish_record_frames(frames)
			if _outbox_bytes > RECORD_MAX_OUTBOX:
				_flush_outbox_waiting()
			_capture_record_frame(now, step)
		elif frames.size() >= RECORD_MAX_IN_FLIGHT or _outbox_bytes > RECORD_MAX_OUTBOX:
			_recording["skipped"] += 1
		else:
			_capture_record_frame(now, step)
		var wanted: int = _recording["maxFrames"]
		if wanted > 0 and int(_recording["captured"]) >= wanted:
			_recording["until"] = now
	if now >= float(_recording["until"]) and frames.is_empty():
		var recording := _recording
		_recording = {}
		var size: Vector2i = recording["size"]
		var answer := {
			"recording": recording["id"], "frames": recording["sent"], "skipped": recording["skipped"],
			"seconds": now - float(recording["started"]), "width": size.x, "height": size.y,
		}
		if recording["stop"] != null:
			_reply(recording["stop"], answer)
		else:
			_ended_recording = answer


## Drops the frames whose copies from the GPU have not arrived, counting them as skipped.
func _skip_record_readbacks(frames: Array) -> void:
	for index in range(frames.size() - 1, -1, -1):
		var frame := frames[index] as RecordFrame
		if frame.readback != null and frame.readback.take()[0] == FrameReadback.PENDING:
			frames.remove_at(index)
			_recording["skipped"] += 1


func _record_due(now: float, step: int) -> bool:
	if step > 0:
		return (_frame - int(_recording["frame0"])) % step == 0
	if now < float(_recording["next"]):
		return false
	var interval := 1.0 / float(_recording["fps"])
	var next := float(_recording["next"])
	_recording["next"] = next + interval if now - next < interval else now + interval
	return true


func _capture_record_frame(now: float, step: int) -> void:
	var frame := RecordFrame.new()
	frame.index = _recording["captured"]
	frame.time_ms = roundi(frame.index * step * float(_recording["frameMs"])) if step > 0 else roundi((now - float(_recording["started"])) * 1000.0)
	var layout := _frame_layout(int(_recording["maxWidth"]))
	var rd := RenderingServer.get_rendering_device()
	if step == 0 and rd != null and not _readback_refused:
		var texture := RenderingServer.texture_get_rd_texture(root.get_texture().get_rid())
		if texture.is_valid():
			frame.readback = FrameReadback.new(layout)
			RenderingServer.call_on_render_thread(FrameReadback.request.bind(frame.readback, rd, texture))
			_recording["captured"] += 1
			_recording["frames"].append(frame)
			return
	var picture := root.get_texture().get_image()
	if picture == null or picture.is_empty():
		_recording["skipped"] += 1
		return
	_recording["captured"] += 1
	_encode_record_frame(frame, FrameEncoding.new(picture, PackedByteArray(), Vector2i.ZERO, layout, false, _recording["quality"]))
	_recording["frames"].append(frame)


func _encode_record_frame(frame: RecordFrame, encoding: FrameEncoding) -> void:
	frame.encoding = encoding
	frame.task = WorkerThreadPool.add_task(encoding.run, false, "WASD Engine recording frame")


## Hands the frames the GPU copied to workers and sends the encoded frames at the head of the queue, in order.
func _finish_record_frames(frames: Array) -> void:
	for item in frames:
		var frame := item as RecordFrame
		if frame.readback == null:
			continue
		var taken := frame.readback.take()
		if taken[0] == FrameReadback.PENDING:
			continue
		var layout := frame.readback.layout
		frame.readback = null
		if taken[0] == FrameReadback.FAILED:
			_readback_refused = true
			frame.failed = true
		else:
			_encode_record_frame(frame, FrameEncoding.new(null, taken[1], taken[2], layout, false, _recording["quality"]))
	while not frames.is_empty():
		var head := frames[0] as RecordFrame
		if head.failed:
			frames.pop_front()
			_recording["skipped"] += 1
			continue
		if head.encoding == null or (head.task >= 0 and not WorkerThreadPool.is_task_completed(head.task)):
			return
		if head.task >= 0:
			WorkerThreadPool.wait_for_task_completion(head.task)
		frames.pop_front()
		if head.encoding.bytes.is_empty():
			_recording["skipped"] += 1
			continue
		var payload := PackedByteArray()
		payload.resize(16)
		payload.encode_u32(0, int(_recording["id"]))
		payload.encode_u32(4, head.index)
		payload.encode_u32(8, head.time_ms)
		payload.encode_u16(12, head.encoding.size.x)
		payload.encode_u16(14, head.encoding.size.y)
		payload.append_array(head.encoding.bytes)
		if not _send(KIND_RECORD, payload):
			_recording["skipped"] += 1
			continue
		_recording["sent"] += 1
		_recording["size"] = head.encoding.size


## Sends the waiting messages, waiting for the connection; a game-frame recording does this rather than skip a frame.
func _flush_outbox_waiting() -> void:
	_io.lock()
	while _connected and _outbox_bytes > RECORD_MAX_OUTBOX:
		_peer.poll()
		_flush_outbox()
		if _outbox_bytes > RECORD_MAX_OUTBOX:
			_io.unlock()
			OS.delay_msec(1)
			_io.lock()
	_io.unlock()


## Prepares a captured frame now, or after the frame that the worker prepares.
func _queue_frame(frame: FrameEncoding, now: float) -> void:
	if _encoding == null:
		_prepare_frame(frame, now)
	else:
		_queued = frame


## Starts preparing a streamed frame, and a test PNG of it when one is due.
func _prepare_frame(frame: FrameEncoding, now: float) -> void:
	frame.png = _stream_lossless and _lossless_frames
	frame.quality = _stream_quality
	_encoding = frame
	_encoding_task = WorkerThreadPool.add_task(_encoding.run, false, "WASD Engine frame encoding")
	if _stream_lossless and not _lossless_frames and _lossless_test == null and now >= _lossless_test_at:
		# Preparing a frame changes its picture, so the test prepares a copy of its own.
		var copy: Image = frame.picture.duplicate() if frame.picture != null else null
		_lossless_test = FrameEncoding.new(copy, frame.pixels, frame.picture_size, frame.layout, true, _stream_quality)
		_lossless_test_task = WorkerThreadPool.add_task(_lossless_test.run, false, "WASD Engine lossless frame test")


## Hands the frame that the GPU copied to a worker. A run whose picture cannot be copied asynchronously, such as one
## that renders in high dynamic range, reads its next frames synchronously.
func _finish_readback(now: float) -> void:
	if _readback == null:
		return
	var taken := _readback.take()
	var state: int = taken[0]
	if state == FrameReadback.PENDING:
		return
	var layout := _readback.layout
	_readback = null
	if state == FrameReadback.FAILED:
		_readback_refused = true
		return
	if _stream_fps > 0.0:
		_queue_frame(FrameEncoding.new(null, taken[1], taken[2], layout, false, _stream_quality), now)


## Sends the frame whose preparation finished and starts preparing the queued one. A PNG frame that took longer than
## the frame interval to prepare returns the stream to JPEG frames.
func _finish_encoding(now: float) -> void:
	if _encoding == null or not WorkerThreadPool.is_task_completed(_encoding_task):
		return
	WorkerThreadPool.wait_for_task_completion(_encoding_task)
	var done := _encoding
	_encoding = null
	if _stream_fps > 0.0 and not done.bytes.is_empty():
		if done.png and done.usec > USEC_PER_SECOND / _stream_fps:
			_lossless_frames = false
			_schedule_lossless_test(now)
		_frame_sequence += 1
		var payload := PackedByteArray()
		payload.resize(8)
		payload.encode_u32(0, _frame_sequence)
		payload.encode_u16(4, done.size.x)
		payload.encode_u16(6, done.size.y)
		payload.append_array(done.bytes)
		_send(KIND_FRAME, payload)
		if not _sample.is_empty():
			_sample["streamedFrames"] += 1
	if _queued != null:
		var next := _queued
		_queued = null
		if _stream_fps > 0.0:
			_prepare_frame(next, now)


## Applies a finished test PNG: frames become PNG when preparing it took at most the frame interval.
func _finish_lossless_test(now: float) -> void:
	if _lossless_test == null or not WorkerThreadPool.is_task_completed(_lossless_test_task):
		return
	WorkerThreadPool.wait_for_task_completion(_lossless_test_task)
	var done := _lossless_test
	_lossless_test = null
	if _stream_fps <= 0.0 or not _stream_lossless:
		return
	if not done.bytes.is_empty() and done.usec <= USEC_PER_SECOND / _stream_fps:
		_lossless_frames = true
	else:
		_schedule_lossless_test(now)


func _schedule_lossless_test(now: float) -> void:
	_lossless_test_at = now + _lossless_test_delay
	_lossless_test_delay = minf(_lossless_test_delay * 2.0, LOSSLESS_TEST_MAX_DELAY)


## Waits for the frames being prepared; every WorkerThreadPool task must be waited for. A copy from the GPU that is still
## pending stays with its callback.
func _wait_for_encodings() -> void:
	for frame in _recording.get("frames", []):
		if (frame as RecordFrame).task >= 0:
			WorkerThreadPool.wait_for_task_completion((frame as RecordFrame).task)
			(frame as RecordFrame).task = -1
	if _encoding != null:
		WorkerThreadPool.wait_for_task_completion(_encoding_task)
		_encoding = null
	if _lossless_test != null:
		WorkerThreadPool.wait_for_task_completion(_lossless_test_task)
		_lossless_test = null


func _eval(id, message: Dictionary, now: float) -> void:
	var base: Object = current_scene
	var path := str(message.get("node", ""))
	if not path.is_empty():
		base = root.get_node_or_null(NodePath(path))
		if base == null:
			_reply_error(id, "no node at %s" % path)
			return
	if message.has("code"):
		var deadline := _deadline(id, message, now)
		if deadline >= 0.0:
			# A coroutine called through a Callable: the code may await, and its answer follows when it returns.
			_run_code.call(id, str(message["code"]), base, deadline)
		return
	var names := PackedStringArray(["tree", "root", "scene"])
	var values: Array = [self, root, current_scene]
	_add_global_names(names, values)
	var expression := Expression.new()
	var error := expression.parse(str(message.get("expression", "")), names)
	if error != OK:
		_reply_error(id, expression.get_error_text())
		return
	var value = expression.execute(values, base, false)
	if expression.has_execute_failed():
		_reply_error(id, expression.get_error_text())
		return
	_reply(id, {"value": _json_value(value), "valueType": type_string(typeof(value))})


## Adds the engine singletons, such as Input, OS, and ResourceLoader, and the project's autoloads to an Expression's
## inputs by name; a name that is already an input keeps its value.
func _add_global_names(names: PackedStringArray, values: Array) -> void:
	for name in Engine.get_singleton_list():
		if not names.has(name):
			names.append(name)
			values.append(Engine.get_singleton(name))
	for property in ProjectSettings.get_property_list():
		var key := str(property["name"])
		if not key.begins_with("autoload/"):
			continue
		var name := key.trim_prefix("autoload/")
		var node := root.get_node_or_null(NodePath(name))
		if node != null and not names.has(name):
			names.append(name)
			values.append(node)


## Runs `code` as the body of a GDScript function, which may use lambdas, the engine singletons, the autoloads, and
## `await`, and answers with the value it returns, or with its compile or script errors. Its answer waits for an
## `await` until `deadline` (real seconds, 0 for none), when it answers that the code did not finish.
func _run_code(id, code: String, base: Object, deadline: float) -> void:
	_eval_serial += 1
	var path := EVAL_PATH % _eval_serial
	var compiled := _compile_code(code, path)
	var script: GDScript = compiled[0]
	if script == null:
		_reply_error(id, "the code does not compile:\n%s" % _code_errors(compiled[2], compiled[1]))
		return
	var runner: Node = script.new()
	runner.name = "WASDEngineEval%d" % _eval_serial
	runner.process_mode = Node.PROCESS_MODE_ALWAYS
	runner.set("tree", self)
	runner.set("root", root)
	runner.set("scene", current_scene)
	runner.set("node", base)
	# An internal child is not one of the root's children, so the game's own lookups do not meet it.
	root.add_child(runner, false, Node.INTERNAL_MODE_BACK)
	_evals[id] = deadline
	_logger.watch(path, false)
	var value = await runner.call("run")
	var errors := _logger.unwatch(path)
	runner.queue_free()
	if not _evals.has(id):
		return
	_evals.erase(id)
	if not errors.is_empty():
		_reply_error(id, "the code stopped at an error:\n%s" % _code_errors(errors, compiled[1]))
		return
	_reply(id, {"value": _json_value(value), "valueType": type_string(typeof(value))})


## Compiles `code` as `run`'s body under `path`: first as one expression whose value `run` returns, then as statements.
## Returns [script or null, the lines before the code, and the statements' errors when neither compiles]; the
## errors of these compiles stay out of the log.
func _compile_code(code: String, path: String) -> Array:
	var body := code.dedent().strip_edges(false, true)
	var unit := "\t"
	for line in body.split("\n"):
		if line.begins_with(" "):
			unit = "    "
			break
	var statements := ""
	for line in body.split("\n"):
		statements += unit + line + "\n"
	var errors: Array = []
	for form in [[unit + "return (\n" + body + "\n)\n", CODE_HEAD_LINES + 1], [statements, CODE_HEAD_LINES]]:
		var script := GDScript.new()
		script.source_code = CODE_HEAD + form[0]
		script.take_over_path(path)
		_logger.watch(path, true)
		var error := script.reload()
		errors = _logger.unwatch(path)
		if error == OK:
			return [script, form[1], []]
	return [null, CODE_HEAD_LINES, errors]


## Lists log entries of `eval` code as lines of the code: `line N: message`.
func _code_errors(entries: Array, offset: int) -> String:
	var lines := PackedStringArray()
	for entry in entries:
		var line := int(entry.get("line", 0)) - offset
		lines.append(("line %d: %s" % [line, entry.get("message", "")]) if line > 0 else str(entry.get("message", "")))
	return "\n".join(lines) if not lines.is_empty() else "Godot reported no details."


## Answers the `eval` code still awaiting past its deadline; the code keeps running, and its value is dropped.
func _advance_evals(now: float) -> void:
	for id in _evals.keys():
		var deadline: float = _evals[id]
		if deadline > 0.0 and now >= deadline:
			_evals.erase(id)
			_reply_error(id, "the code did not finish within its time limit; it keeps running in the game")


func _tree(id, message: Dictionary) -> void:
	var path := str(message.get("node", ""))
	var start: Node = current_scene if path.is_empty() else root.get_node_or_null(NodePath(path))
	if start == null:
		_reply_error(id, "no node at %s" % (path if not path.is_empty() else "the current scene"))
		return
	var limit := {"left": clampi(int(message.get("maxNodes", 400)), 1, 5000)}
	_reply(id, {"tree": _describe(start, clampi(int(message.get("depth", 6)), 0, 64), limit), "truncated": limit["left"] <= 0})


func _describe(node: Node, depth: int, limit: Dictionary) -> Dictionary:
	limit["left"] -= 1
	var entry := {"name": str(node.name), "class": node.get_class(), "path": str(node.get_path())}
	var script: Script = node.get_script()
	if script != null and not script.resource_path.is_empty():
		entry["script"] = script.resource_path
	if node is Node2D:
		entry["position"] = [node.position.x, node.position.y]
		entry["visible"] = node.visible
	elif node is Node3D:
		entry["position"] = [node.position.x, node.position.y, node.position.z]
		entry["visible"] = node.visible
	elif node is Control:
		entry["position"] = [node.position.x, node.position.y]
		entry["size"] = [node.size.x, node.size.y]
		entry["visible"] = node.visible
		if node is Label or node is Button:
			entry["text"] = node.text
	if node.process_mode == Node.PROCESS_MODE_DISABLED:
		entry["processDisabled"] = true
	var count := node.get_child_count()
	if count > 0:
		if depth <= 0 or limit["left"] <= 0:
			entry["childCount"] = count
		else:
			var children: Array[Dictionary] = []
			for child in node.get_children():
				if limit["left"] <= 0:
					entry["childCount"] = count
					break
				children.append(_describe(child, depth - 1, limit))
			entry["children"] = children
	return entry


func _start_audio(id, message: Dictionary, now: float) -> void:
	if _audio != null:
		_reply_error(id, "an audio capture is already running")
		return
	var deadline := _deadline(id, message, now)
	if deadline < 0.0:
		return
	_audio = AudioCapture.new(id, now, deadline, clampf(float(message.get("seconds", 3.0)), 0.05, AUDIO_MAX_SECONDS))
	_audio.start_frame = _frame
	var stack: Array[Node] = [root]
	var visited := 0
	while not stack.is_empty() and visited < PERFORMANCE_MAX_NODES:
		var node: Node = stack.pop_back()
		visited += 1
		_audio.follow(node)
		stack.append_array(node.get_children())
	node_added.connect(_on_audio_node_added)


func _on_audio_node_added(node: Node) -> void:
	if _audio != null:
		_audio.follow(node)


## Moves the captured frames along, and ends the capture once it holds its audio or at its `timeoutMs`.
func _advance_audio(now: float) -> void:
	if _audio == null:
		return
	_audio.pull()
	_audio.note_volume()
	_audio.observe(now - _audio.started)
	if _audio.frames >= _audio.target:
		_finish_audio(now, false, false)
	elif _audio.deadline > 0.0 and now >= _audio.deadline:
		_finish_audio(now, true, false)


func _finish_audio(_now: float, timed_out: bool, cancelled: bool) -> void:
	var capture := _audio
	_audio = null
	node_added.disconnect(_on_audio_node_added)
	capture.pull()
	var attached := capture.attached()
	capture.detach()
	var played: Array[Dictionary] = []
	for key in capture.players:
		var entry: Dictionary = capture.players[key]
		if entry["starts"] > 0:
			played.append(entry)
	played.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["firstAt"] < b["firstAt"])
	if not _fits(capture.data.size() + 4):
		_reply_error(capture.id, _too_large("the captured audio", capture.data.size()) + "; capture fewer seconds")
		return
	_reply(capture.id, {
		"sampleRate": capture.rate,
		"channels": 2,
		"frames": capture.frames,
		"seconds": capture.frames / capture.rate,
		"droppedFrames": capture.effect.get_discarded_frames(),
		"masterVolumes": capture.volumes,
		"masterBypassed": capture.bypassed,
		"detached": not attached,
		"driver": AudioServer.get_driver_name(),
		"outputLatencyMs": AudioServer.get_output_latency() * 1000.0,
		"startFrame": capture.start_frame,
		"frame": _frame,
		"buses": _audio_buses(capture.peaks),
		"players": played.slice(0, AUDIO_LISTED_PLAYERS),
		"morePlayers": maxi(0, played.size() - AUDIO_LISTED_PLAYERS),
		"timedOut": timed_out,
		"cancelled": cancelled,
	})
	if capture.id == null:
		return
	var payload := PackedByteArray()
	payload.resize(4)
	payload.encode_u32(0, int(capture.id))
	payload.append_array(capture.data)
	_send(KIND_AUDIO, payload)


## Describes the audio buses: their settings, effects as [class, enabled], and the largest peak in `peaks`.
func _audio_buses(peaks: Dictionary) -> Array:
	var buses := []
	for bus in AudioServer.bus_count:
		var name := str(AudioServer.get_bus_name(bus))
		var effects := []
		for i in AudioServer.get_bus_effect_count(bus):
			var effect := AudioServer.get_bus_effect(bus, i)
			if effect != null:
				effects.append([effect.get_class(), AudioServer.is_bus_effect_enabled(bus, i)])
		buses.append({
			"name": name,
			"volumeDb": AudioServer.get_bus_volume_db(bus),
			"mute": AudioServer.is_bus_mute(bus),
			"solo": AudioServer.is_bus_solo(bus),
			"bypass": AudioServer.is_bus_bypassing_effects(bus),
			"send": str(AudioServer.get_bus_send(bus)) if bus > 0 else "",
			"effects": effects,
			"peakDb": float(peaks.get(name, -200.0)),
		})
	return buses


## Starts drawing a view: the game's 3D world, or an asset loaded alone, from a camera of the view's own, in a
## SubViewport of `width` × `height` with the root viewport's render settings. The camera frames `node` or the asset
## from `yaw` and `pitch` degrees around its heading, takes `camera.position` and `camera.target`, or takes the game
## camera's place. The view draws VIEW_FRAMES frames, so temporal effects settle, and answers like a screenshot.
func _view(id, message: Dictionary) -> void:
	var window := _window_size()
	var width := int(message.get("width", 0))
	var height := int(message.get("height", 0))
	var size := Vector2i(clampi(width if width > 0 else window.x, 16, VIEW_MAX_SIDE), clampi(height if height > 0 else window.y, 16, VIEW_MAX_SIDE))
	var game_camera := _game_camera()
	var explicit = message.get("camera", null)
	var viewport := SubViewport.new()
	viewport.size = size
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	_copy_render_settings(viewport)
	var camera := Camera3D.new()
	var asset := str(message.get("asset", ""))
	var game_look := str(message.get("lighting", "studio")) == "game"
	if game_camera != null:
		_copy_camera(game_camera, camera)
	if not asset.is_empty():
		# An asset alone is seen through a lens of its own, in the game's environment only with game lighting.
		camera.projection = Camera3D.PROJECTION_PERSPECTIVE
		camera.fov = VIEW_ASSET_FOV
		camera.cull_mask = 0xFFFFF
		if not game_look:
			camera.environment = null
			camera.attributes = null
			camera.compositor = null
	if message.has("fov"):
		camera.fov = clampf(float(message["fov"]), 1.0, 179.0)
	var subject: Node3D = null
	if not asset.is_empty():
		var made = _instance_asset(asset)
		if made is String:
			viewport.free()
			camera.free()
			_reply_error(id, made)
			return
		subject = made
		viewport.own_world_3d = true
		viewport.add_child(subject)
		_light_view(viewport, camera, game_look)
	else:
		var path := str(message.get("node", ""))
		if not path.is_empty():
			var node := root.get_node_or_null(NodePath(path))
			if not node is Node3D:
				viewport.free()
				camera.free()
				_reply_error(id, "no 3D node at %s; views draw the game's 3D world" % path if node == null else "%s is a %s, not a 3D node; views draw the game's 3D world" % [path, node.get_class()])
				return
			subject = node
		var world: World3D = subject.get_world_3d() if subject != null else (game_camera.get_world_3d() if game_camera != null else root.find_world_3d())
		if world == null or (subject == null and game_camera == null and not explicit is Dictionary):
			viewport.free()
			camera.free()
			_reply_error(id, "the game shows no 3D world with a camera; name a node, a camera, or an asset")
			return
		viewport.world_3d = world
	viewport.add_child(camera)
	if _view_holder == null:
		_view_holder = Node.new()
		_view_holder.name = "WASDEngineViews"
		_view_holder.process_mode = Node.PROCESS_MODE_ALWAYS
		root.add_child(_view_holder, false, Node.INTERNAL_MODE_BACK)
	_view_holder.add_child(viewport)
	camera.current = true
	if not asset.is_empty() and message.has("animation"):
		var posed := _pose_asset(subject, str(message["animation"]), float(message.get("time", 0.0)))
		if not posed.is_empty():
			viewport.queue_free()
			_reply_error(id, posed)
			return
	var facts := {}
	if explicit is Dictionary:
		var position = _vector(explicit.get("position", null))
		var target = _vector(explicit.get("target", null))
		if position == null or target == null or (position as Vector3).is_equal_approx(target):
			viewport.queue_free()
			_reply_error(id, "camera needs position and target, two different points [x, y, z]")
			return
		camera.global_position = position
		camera.look_at(target, Vector3.UP if absf((target - position).normalized().y) < 0.999 else Vector3.FORWARD)
		camera.far = maxf(camera.far, position.distance_to(target) * 4.0)
	elif subject != null:
		var framed := _frame_view(camera, subject, message, float(size.x) / size.y)
		if framed.has("error"):
			viewport.queue_free()
			_reply_error(id, framed["error"])
			return
		facts["subject"] = framed
	else:
		camera.global_transform = game_camera.global_transform
	var layers := []
	if message.get("isolate", false) == true and subject != null and asset.is_empty():
		layers = _isolate(subject)
		camera.cull_mask = 1 << (ISOLATE_LAYER - 1)
	var forward := -camera.global_basis.z
	facts["camera"] = {"position": _array(camera.global_position), "direction": _array(forward), "fov": camera.fov}
	var format := "jpeg" if str(message.get("format", "png")) == "jpeg" else "png"
	_views.append({
		"id": id, "viewport": viewport, "frames": clampi(int(message.get("frames", VIEW_FRAMES)), 1, 120), "layers": layers,
		"format": format, "quality": clampf(float(message.get("quality", 0.9)), 0.1, 1.0), "facts": facts,
	})


## Captures the views that drew their frames, answers them, and frees their viewports.
func _advance_views() -> void:
	if _views.is_empty():
		return
	var remaining: Array[Dictionary] = []
	for view in _views:
		view["frames"] -= 1
		if view["frames"] > 0:
			remaining.append(view)
			continue
		var viewport: SubViewport = view["viewport"]
		var image := viewport.get_texture().get_image()
		_restore_layers(view["layers"])
		viewport.queue_free()
		if image == null or image.is_empty():
			_reply_error(view["id"], "the view drew no image")
			continue
		if image.get_format() != Image.FORMAT_RGB8:
			image.convert(Image.FORMAT_RGB8)
		var facts: Dictionary = view["facts"]
		facts.merge({"format": view["format"], "width": image.get_width(), "height": image.get_height(), "frame": _frame, "paused": paused})
		var bytes := image.save_jpg_to_buffer(view["quality"]) if view["format"] == "jpeg" else image.save_png_to_buffer()
		_answer_image(view["id"], facts, bytes)
	_views = remaining


## Returns the camera the game draws its 3D world with: the root viewport's, or that of a SubViewport the game draws in.
func _game_camera() -> Camera3D:
	var camera := root.get_camera_3d()
	if camera != null:
		return camera
	for node in root.find_children("*", "SubViewport", true, false):
		var found := (node as SubViewport).get_camera_3d()
		if found != null:
			return found
	return null


## Gives a view the root viewport's antialiasing, scaling, level of detail, and shadow settings, which the game may set.
func _copy_render_settings(viewport: SubViewport) -> void:
	for property in ["msaa_3d", "screen_space_aa", "use_taa", "use_debanding", "use_occlusion_culling", "mesh_lod_threshold",
			"scaling_3d_mode", "scaling_3d_scale", "fsr_sharpness", "texture_mipmap_bias", "anisotropic_filtering_level",
			"positional_shadow_atlas_size", "positional_shadow_atlas_16_bits"]:
		if property in root:
			viewport.set(property, root.get(property))
	for quadrant in 4:
		viewport.set_positional_shadow_atlas_quadrant_subdiv(quadrant, root.get_positional_shadow_atlas_quadrant_subdiv(quadrant))


## Gives a view's camera the game camera's projection, clip planes, layers, environment, attributes, and compositor.
func _copy_camera(source: Camera3D, camera: Camera3D) -> void:
	for property in ["projection", "fov", "size", "keep_aspect", "near", "far", "cull_mask", "environment", "attributes", "compositor"]:
		camera.set(property, source.get(property))


## Loads a scene or mesh for a view: a PackedScene's 3D root, as the project imports a model, or a mesh in a
## MeshInstance3D. Returns the node, or why it cannot.
func _instance_asset(path: String) -> Variant:
	if not ResourceLoader.exists(path):
		return "no resource at %s; import the project first, as godot_run does" % path
	var resource := ResourceLoader.load(path)
	if resource is PackedScene:
		var instance := (resource as PackedScene).instantiate()
		if instance is Node3D:
			return instance
		var kind := instance.get_class()
		instance.free()
		return "%s is a scene whose root is a %s, not a 3D node" % [path, kind]
	if resource is Mesh:
		var mesh_instance := MeshInstance3D.new()
		mesh_instance.mesh = resource
		return mesh_instance
	return "%s is a %s, not a 3D scene or mesh" % [path, resource.get_class() if resource != null else "resource that does not load"]


## Poses an asset's AnimationPlayer at `time` seconds into `animation`, held there; returns why it cannot, or "".
func _pose_asset(subject: Node, animation: String, time: float) -> String:
	var players := subject.find_children("*", "AnimationPlayer", true, false)
	if subject is AnimationPlayer:
		players.push_front(subject)
	for node in players:
		var player := node as AnimationPlayer
		if player.has_animation(animation):
			player.play(animation)
			player.seek(clampf(time, 0.0, player.get_animation(animation).length), true)
			player.pause()
			return ""
	var names := PackedStringArray()
	for node in players:
		for name in (node as AnimationPlayer).get_animation_list():
			names.append(name)
	return "the asset has no animation %s%s" % [animation, "; it has %s" % ", ".join(names) if not names.is_empty() else "; it has no AnimationPlayer animations"]


## Lights an asset view: the game's environment and directional lights with `game_look`, else a neutral studio, whose
## key, fill, and rim lights follow the camera.
func _light_view(viewport: SubViewport, camera: Camera3D, game_look: bool) -> void:
	var environment: Environment = null
	if game_look:
		var game_camera := _game_camera()
		if game_camera != null and game_camera.environment != null:
			environment = game_camera.environment
		elif root.find_world_3d() != null:
			environment = root.find_world_3d().environment
		if current_scene != null:
			for node in current_scene.find_children("*", "DirectionalLight3D", true, false):
				var light := node as DirectionalLight3D
				if light.is_visible_in_tree():
					var copy := light.duplicate(0) as DirectionalLight3D
					copy.transform = light.global_transform
					viewport.add_child(copy)
	if environment == null:
		var sky_material := ProceduralSkyMaterial.new()
		sky_material.sky_top_color = Color(0.56, 0.6, 0.68)
		sky_material.sky_horizon_color = Color(0.74, 0.75, 0.78)
		sky_material.ground_horizon_color = Color(0.74, 0.75, 0.78)
		sky_material.ground_bottom_color = Color(0.24, 0.24, 0.26)
		var sky := Sky.new()
		sky.sky_material = sky_material
		environment = Environment.new()
		environment.background_mode = Environment.BG_COLOR
		environment.background_color = Color(0.3, 0.31, 0.34)
		environment.sky = sky
		environment.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
		environment.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
		environment.tonemap_mode = Environment.TONE_MAPPER_FILMIC
		for light in [[Vector3(-35.0, 40.0, 0.0), 1.6, true], [Vector3(-10.0, -55.0, 0.0), 0.45, false], [Vector3(-25.0, 160.0, 0.0), 0.9, false]]:
			var studio := DirectionalLight3D.new()
			studio.rotation_degrees = light[0]
			studio.light_energy = light[1]
			studio.shadow_enabled = light[2]
			camera.add_child(studio)
	var world_environment := WorldEnvironment.new()
	world_environment.environment = environment
	viewport.add_child(world_environment)


## Places `camera` to frame `subject`: its visible bounds, or `radius` meters around its skeleton's `bone`, seen from
## `yaw` degrees around its heading (0 looks at its +Z side) and `pitch` degrees above, at the distance that fits them
## times `distance`. Returns the framed center and radius, or {"error": why}.
func _frame_view(camera: Camera3D, subject: Node3D, message: Dictionary, aspect: float) -> Dictionary:
	var bounds := _visual_bounds(subject)
	var center := bounds.get_center()
	var radius := maxf(bounds.size.length() * 0.5, 0.01)
	var bone := str(message.get("bone", ""))
	if not bone.is_empty():
		var skeletons := subject.find_children("*", "Skeleton3D", true, false)
		if subject is Skeleton3D:
			skeletons.push_front(subject)
		var found := false
		for node in skeletons:
			var skeleton := node as Skeleton3D
			var index := skeleton.find_bone(bone)
			if index >= 0:
				center = (skeleton.global_transform * skeleton.get_bone_global_pose(index)).origin
				radius = VIEW_BONE_RADIUS
				found = true
				break
		if not found:
			return {"error": "no bone %s in a Skeleton3D under %s" % [bone, subject.name]}
	if message.has("radius"):
		radius = maxf(float(message["radius"]), 0.001)
	var heading := Vector3(subject.global_basis.z.x, 0.0, subject.global_basis.z.z)
	var turn := (atan2(heading.x, heading.z) if heading.length() > 0.0001 else 0.0) + deg_to_rad(float(message.get("yaw", VIEW_YAW)))
	var pitch := deg_to_rad(clampf(float(message.get("pitch", VIEW_PITCH)), -89.0, 89.0))
	var direction := Vector3(sin(turn) * cos(pitch), sin(pitch), cos(turn) * cos(pitch))
	var factor := maxf(float(message.get("distance", 1.0)), 0.01)
	var distance: float
	if camera.projection == Camera3D.PROJECTION_ORTHOGONAL:
		camera.size = radius * 2.0 * factor * (1.0 if aspect >= 1.0 else 1.0 / aspect)
		distance = radius * 4.0
	else:
		var half := deg_to_rad(camera.fov) * 0.5
		var half_width := atan(tan(half) * aspect)
		distance = radius / sin(minf(half, half_width)) * factor
	camera.global_position = center + direction * distance
	camera.look_at(center, Vector3.UP if absf(direction.y) < 0.999 else Vector3.FORWARD)
	camera.near = minf(camera.near, maxf(0.002, (distance - radius) * 0.5))
	camera.far = maxf(camera.far, distance + radius * 4.0)
	return {"center": _array(center), "radius": snappedf(radius, 0.0001), "distance": snappedf(distance, 0.0001)}


## Returns the world bounds of the meshes and other geometry under `subject` that are visible, without particles,
## or a 1 meter box at its origin when it has none.
func _visual_bounds(subject: Node3D) -> AABB:
	var bounds := AABB()
	var found := false
	var stack: Array[Node] = [subject]
	var visited := 0
	while not stack.is_empty() and visited < VIEW_MAX_NODES:
		var node: Node = stack.pop_back()
		visited += 1
		if node is GeometryInstance3D and not (node is GPUParticles3D or node is CPUParticles3D) and (node as Node3D).is_visible_in_tree():
			var box: AABB = (node as GeometryInstance3D).global_transform * (node as GeometryInstance3D).get_aabb()
			bounds = bounds.merge(box) if found else box
			found = true
		stack.append_array(node.get_children())
	return bounds if found else AABB(subject.global_position - Vector3(0.5, 0.5, 0.5), Vector3.ONE)


## Adds ISOLATE_LAYER to the geometry under `subject` and to every light, so a camera that draws that layer alone
## draws the subject lit as the game lights it; returns [[node, its former layers]] to restore.
func _isolate(subject: Node3D) -> Array:
	var changed := []
	var bit := 1 << (ISOLATE_LAYER - 1)
	var nodes: Array = subject.find_children("*", "GeometryInstance3D", true, false)
	if subject is GeometryInstance3D:
		nodes.push_front(subject)
	nodes.append_array(root.find_children("*", "Light3D", true, false))
	for node in nodes:
		var instance := node as VisualInstance3D
		if instance.layers & bit == 0:
			changed.append([instance, instance.layers])
			instance.layers |= bit
	return changed


func _restore_layers(changed: Array) -> void:
	for entry in changed:
		if is_instance_valid(entry[0]):
			(entry[0] as VisualInstance3D).layers = entry[1]


## Reads [x, y, z] as a Vector3, or null.
func _vector(value) -> Variant:
	if value is Array and value.size() == 3 and (value as Array).all(func(item) -> bool: return item is int or item is float):
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return null


func _array(vector: Vector3) -> Array:
	return [snappedf(vector.x, 0.0001), snappedf(vector.y, 0.0001), snappedf(vector.z, 0.0001)]


func _start_sample(id, message: Dictionary, now: float) -> void:
	if not _sample.is_empty():
		_reply_error(id, "a performance sample is already running")
		return
	var deadline := _deadline(id, message, now)
	if deadline < 0.0:
		return
	var series := {}
	for name in PERFORMANCE_SERIES:
		series[name] = []
	_sample = {
		"id": id, "started": now, "end": now + clampf(float(message.get("seconds", 2.0)), 0.1, 60.0), "deadline": deadline,
		"frames": 0, "droppedFrames": 0, "pausedFrames": 0, "physicsSteps": 0, "streamedFrames": 0,
		"series": series, "monitorsStart": _monitors(),
		"marks": {"process": 0, "physicsFirst": 0, "physicsUsec": 0, "nodes": 0, "draw": 0, "drawn": 0, "paused": paused},
		"phase": "frames", "scriptSeconds": clampf(float(message.get("scriptSeconds", 0.0)), 0.0, 60.0),
		"scriptStart": 0.0, "scriptEnd": 0.0, "scriptFrames": 0,
		"engineCalls": message.get("engineCalls", false) == true and _engine_calls_safe,
	}
	RenderingServer.viewport_set_measure_render_time(root.get_viewport_rid(), true)
	physics_frame.connect(_on_sample_physics_frame)
	process_frame.connect(_on_sample_process_frame)
	RenderingServer.frame_pre_draw.connect(_on_sample_pre_draw)
	RenderingServer.frame_post_draw.connect(_on_sample_post_draw)


## Records the frame that ended at `now_usec`, the start of this `_process`, and starts the marks of the next one.
## A frame's physics steps run before its `_process`, so their time, until `physics_end_usec`, is known when the
## frame starts. The wait for the frame cap of a game with a fixed frame rate, from `physics_end_usec` to `now_usec`,
## counts in the frame that ended, where Godot's own frame limiter waits.
func _sample_frame(now_usec: int, physics_end_usec: int) -> void:
	if _sample["phase"] == "scripts":
		_sample["scriptFrames"] += 1
		return
	var marks: Dictionary = _sample["marks"]
	var begun: int = marks["process"]
	if begun > 0:
		_sample["frames"] += 1
		if marks["paused"]:
			_sample["pausedFrames"] += 1
		var series: Dictionary = _sample["series"]
		if (series["frame"] as Array).size() >= PERFORMANCE_MAX_FRAMES:
			_sample["droppedFrames"] += 1
		else:
			var nodes: int = marks["nodes"]
			var draw: int = marks["draw"]
			var drawn: int = marks["drawn"]
			var viewport := root.get_viewport_rid()
			series["frame"].append(_ms(now_usec - begun))
			series["physics"].append(_ms(marks["physicsUsec"]))
			series["harness"].append(_ms(nodes - begun) if nodes >= begun else 0.0)
			series["process"].append(_ms(draw - nodes) if nodes >= begun and draw >= nodes else 0.0)
			series["draw"].append(_ms(drawn - draw) if draw >= begun and drawn >= draw else 0.0)
			series["gpu"].append(snappedf(RenderingServer.viewport_get_measured_render_time_gpu(viewport), 0.001))
			series["renderCpu"].append(snappedf(RenderingServer.viewport_get_measured_render_time_cpu(viewport) + RenderingServer.get_frame_setup_time_cpu(), 0.001))
			series["objects"].append(int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)))
			series["primitives"].append(int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)))
			series["drawCalls"].append(int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)))
	var physics_first: int = marks["physicsFirst"]
	marks["physicsUsec"] = physics_end_usec - physics_first if physics_first > 0 else 0
	marks["physicsFirst"] = 0
	marks["process"] = now_usec
	marks["nodes"] = 0
	marks["draw"] = 0
	marks["drawn"] = 0


func _ms(usec: int) -> float:
	return snappedf(usec / 1000.0, 0.001)


func _on_sample_physics_frame() -> void:
	_sample["physicsSteps"] += 1
	if _sample["marks"]["physicsFirst"] == 0:
		_sample["marks"]["physicsFirst"] = Time.get_ticks_usec()


func _on_sample_process_frame() -> void:
	_sample["marks"]["nodes"] = Time.get_ticks_usec()


func _on_sample_pre_draw() -> void:
	_sample["marks"]["draw"] = Time.get_ticks_usec()


func _on_sample_post_draw() -> void:
	_sample["marks"]["drawn"] = Time.get_ticks_usec()


## Moves the running performance sample from its frame window to its script window, and ends it after both, or at its
## `timeoutMs` with `timedOut`.
func _advance_sample(now: float) -> void:
	if _sample.is_empty():
		return
	if _sample["phase"] == "frames" and now >= float(_sample["end"]):
		if float(_sample["scriptSeconds"]) > 0.0 and _runtime != null:
			_end_frame_window(_sample, now)
			_sample["phase"] = "scripts"
			_sample["scriptStart"] = now
			_sample["scriptEnd"] = now + float(_sample["scriptSeconds"])
			_runtime.call(&"start_script_profiling", _sample["engineCalls"])
		else:
			_finish_sample(now, false, false)
	elif _sample["phase"] == "scripts" and now >= float(_sample["scriptEnd"]):
		_finish_sample(now, false, false)
	elif float(_sample["deadline"]) > 0.0 and now >= float(_sample["deadline"]):
		_finish_sample(now, true, false)


## Stops the measurements of the frame window and keeps its end state in the sample.
func _end_frame_window(sample: Dictionary, now: float) -> void:
	physics_frame.disconnect(_on_sample_physics_frame)
	process_frame.disconnect(_on_sample_process_frame)
	RenderingServer.frame_pre_draw.disconnect(_on_sample_pre_draw)
	RenderingServer.frame_post_draw.disconnect(_on_sample_post_draw)
	RenderingServer.viewport_set_measure_render_time(root.get_viewport_rid(), false)
	sample["framesEnded"] = now
	sample["monitorsEnd"] = _monitors()
	sample["custom"] = _custom_monitors()


func _finish_sample(now: float, timed_out: bool, cancelled: bool) -> void:
	var sample := _sample
	_sample = {}
	var scripts := []
	if sample["phase"] == "frames":
		_end_frame_window(sample, now)
	else:
		scripts = _script_profile()
		_runtime.call(&"stop_script_profiling")
	_reply(sample["id"], {
		"seconds": float(sample["framesEnded"]) - float(sample["started"]),
		"frames": sample["frames"],
		"droppedFrames": sample["droppedFrames"],
		"pausedFrames": sample["pausedFrames"],
		"physicsSteps": sample["physicsSteps"],
		"streamedFrames": sample["streamedFrames"],
		"series": sample["series"],
		"monitorsStart": sample["monitorsStart"],
		"monitorsEnd": sample["monitorsEnd"],
		"custom": sample["custom"],
		"nodes": _node_census(),
		"context": _performance_context(),
		"scriptProfiler": _runtime != null,
		"scripts": scripts,
		"scriptSeconds": now - float(sample["scriptStart"]) if sample["phase"] == "scripts" else 0.0,
		"scriptFrames": sample["scriptFrames"],
		"engineCalls": sample["engineCalls"] and sample["phase"] == "scripts",
		"timedOut": timed_out,
		"cancelled": cancelled,
	})


## Returns the script profile since the script window started, without this harness's own functions. The runtime lists
## each function's entry before the entries of the engine methods it called; those stay together, the functions with
## the most own time first and each one's costliest engine methods first, in at most PERFORMANCE_MAX_SCRIPT_ENTRIES
## entries.
func _script_profile() -> Array:
	var own := (get_script() as Script).resource_path + "::"
	var functions: Array[Dictionary] = []
	for entry in _runtime.call(&"get_script_profile"):
		if not (entry is Array and entry.size() >= 4) or str(entry[0]).begins_with(own):
			continue
		var parts := str(entry[0]).rsplit("::", true, 2)
		var engine_method := parts.size() == 3 and parts[1] == "0" and not parts[2].begins_with("@")
		if engine_method and not functions.is_empty() and functions[-1]["path"] == parts[0]:
			var caller := functions[-1]
			(caller["calls"] as Array).append(entry)
			caller["time"] = int(caller["time"]) + int(entry[2])
		else:
			functions.append({"path": parts[0], "entry": entry, "calls": [], "time": int(entry[3])})
	functions.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a["time"]) > int(b["time"]))
	var kept := []
	for profiled in functions:
		if kept.size() >= PERFORMANCE_MAX_SCRIPT_ENTRIES:
			break
		kept.append(profiled["entry"])
		var calls: Array = profiled["calls"]
		calls.sort_custom(func(a: Array, b: Array) -> bool: return int(a[2]) > int(b[2]))
		kept.append_array(calls.slice(0, PERFORMANCE_MAX_SCRIPT_ENTRIES - kept.size()))
	return kept


## Returns every built-in `Performance` monitor by its constant name, so other Godot 4 versions report theirs.
func _monitors() -> Dictionary:
	var values := {}
	for name in ClassDB.class_get_enum_constants("Performance", "Monitor", true):
		if name != "MONITOR_MAX":
			var value := Performance.get_monitor(ClassDB.class_get_integer_constant("Performance", name))
			values[name] = value if is_finite(value) else 0.0
	return values


func _custom_monitors() -> Dictionary:
	var values := {}
	for name in Performance.get_custom_monitor_names():
		if values.size() >= PERFORMANCE_MAX_CUSTOM:
			break
		var value = Performance.get_custom_monitor(name)
		if (value is int or value is float) and is_finite(float(value)):
			values[str(name)] = value
	return values


## Counts the nodes below the root, those processing and physics processing this frame, and the most common
## classes and scripts, as [class, nodes] and [script path, nodes, processing, physics processing].
func _node_census() -> Dictionary:
	var classes := {}
	var scripts := {}
	var total := 0
	var processing := 0
	var physics := 0
	var stack: Array[Node] = [root]
	while not stack.is_empty() and total < PERFORMANCE_MAX_NODES:
		var node: Node = stack.pop_back()
		total += 1
		var name := node.get_class()
		classes[name] = int(classes.get(name, 0)) + 1
		var runs := node.can_process()
		var processes := runs and node.is_processing()
		var steps := runs and node.is_physics_processing()
		processing += 1 if processes else 0
		physics += 1 if steps else 0
		var script: Script = node.get_script()
		if script != null:
			var path := script.resource_path if not script.resource_path.is_empty() else "(built-in script)"
			var counts: Array = scripts.get(path, [0, 0, 0])
			counts[0] += 1
			counts[1] += 1 if processes else 0
			counts[2] += 1 if steps else 0
			scripts[path] = counts
		stack.append_array(node.get_children())
	return {
		"total": total, "processing": processing, "physicsProcessing": physics, "truncated": not stack.is_empty(),
		"classes": _top(classes), "scripts": _top(scripts),
	}


## Returns the PERFORMANCE_TOP entries of {key: count or [count, ...]} with the highest count, as [key, count, ...].
func _top(counts: Dictionary) -> Array:
	var entries := []
	for key in counts:
		var value = counts[key]
		entries.append([key] + (value if value is Array else [value]))
	entries.sort_custom(func(a, b): return a[1] > b[1] or (a[1] == b[1] and str(a[0]) < str(b[0])))
	return entries.slice(0, PERFORMANCE_TOP)


func _performance_context() -> Dictionary:
	var size := _window_size()
	return {
		"paused": paused,
		"timeScale": Engine.time_scale,
		"maxFps": _own_max_fps if _own_max_fps >= 0 else Engine.max_fps,
		"frameCap": Engine.max_fps,
		"presenting": _presenting,
		"refreshRate": DisplayServer.screen_get_refresh_rate(),
		"wasdRuntime": _runtime != null,
		"physicsTicksPerSecond": Engine.physics_ticks_per_second,
		"vsyncMode": int(ProjectSettings.get_setting("display/window/vsync/vsync_mode", 1)),
		"lowProcessorMode": OS.low_processor_usage_mode,
		"renderingMethod": RenderingServer.get_current_rendering_method(),
		"renderingDriver": RenderingServer.get_current_rendering_driver_name(),
		"adapter": RenderingServer.get_video_adapter_name(),
		"adapterVendor": RenderingServer.get_video_adapter_vendor(),
		"width": size.x,
		"height": size.y,
		"streamFps": _stream_fps,
	}


## Converts a value that `eval` returns for its JSON answer, within the bounds that the header describes.
func _json_value(value) -> Variant:
	return _to_json(value, 0, {"left": JSON_BUDGET})


## Converts `value`, `depth` levels into a value, for JSON. `budget.left` counts down the characters left for the whole
## value: once none are left, every further item is a marker, and each array and dictionary says how many it holds.
func _to_json(value, depth: int, budget: Dictionary):
	if budget["left"] <= 0:
		return "…"
	var kind := typeof(value)
	match kind:
		TYPE_NIL, TYPE_BOOL, TYPE_INT:
			budget["left"] -= 8
			return value
		TYPE_FLOAT:
			budget["left"] -= 16
			return value if is_finite(value) else str(value)
		TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH:
			return _json_string(str(value), budget)
		TYPE_DICTIONARY:
			var size: int = value.size()
			if depth >= JSON_MAX_DEPTH:
				return "… (a Dictionary of %d entries)" % size
			var result := {}
			for key in value:
				if result.size() >= JSON_MAX_ITEMS or budget["left"] <= 0:
					break
				result[_json_string(str(key), budget)] = _to_json(value[key], depth + 1, budget)
			if result.size() < size:
				result["…"] = "%d entries in all" % size
			return result
		TYPE_OBJECT:
			if value == null:
				return null
			budget["left"] -= 40
			if value is Node:
				return {"node": _json_string(str(value.get_path()), budget), "class": value.get_class()}
			return {"object": value.get_class(), "id": value.get_instance_id()}
	if kind in JSON_ARRAY_TYPES:
		var size: int = value.size()
		if depth >= JSON_MAX_DEPTH:
			return "… (%s of %d items)" % [type_string(kind), size]
		var items := []
		for index in mini(size, JSON_MAX_ITEMS):
			if budget["left"] <= 0:
				break
			budget["left"] -= 2
			items.append(_to_json(value[index], depth + 1, budget))
		if items.size() < size:
			items.append("… (%d items in all)" % size)
		return items
	# The other types, such as vectors, transforms, and colors, have a fixed size.
	return _json_string(var_to_str(value), budget)


## Returns `text`, or its first JSON_MAX_CHARS characters and a marker that names its length, and counts it in `budget`.
func _json_string(text: String, budget: Dictionary) -> String:
	var kept := text
	if text.length() > JSON_MAX_CHARS:
		kept = "%s… (%d characters)" % [text.left(JSON_MAX_CHARS), text.length()]
	budget["left"] -= kept.length() + 2
	return kept


func _send_status_if_changed() -> void:
	var now := Time.get_ticks_msec()
	var scene_name := str(current_scene.scene_file_path) if current_scene != null else ""
	var mouse_mode := Input.mouse_mode
	if now - _last_status_ms < 1000 and mouse_mode == _last_mouse_mode and scene_name == _last_scene:
		return
	_last_status_ms = now
	_last_mouse_mode = mouse_mode
	_last_scene = scene_name
	_send_json({
		"type": "status",
		"frame": _frame,
		"fps": Engine.get_frames_per_second(),
		"paused": paused,
		"scene": scene_name,
		"mouseMode": mouse_mode,
		"width": _window_size().x,
		"height": _window_size().y,
		"droppedLogs": _logger.dropped,
	})


## Sends the pending log entries, in messages of at most LOG_BATCH_BYTES of entries each.
func _flush_logs() -> void:
	if not _connected:
		return
	var batch := PackedStringArray()
	var bytes := 0
	for entry in _logger.take():
		var json := JSON.stringify(entry)
		var size := json.to_utf8_buffer().size() + 1
		if not batch.is_empty() and bytes + size > LOG_BATCH_BYTES:
			_send_logs(batch)
			batch = PackedStringArray()
			bytes = 0
		batch.append(json)
		bytes += size
	if not batch.is_empty():
		_send_logs(batch)


## Sends one logs message of entries that JSON.stringify wrote.
func _send_logs(entries: PackedStringArray) -> void:
	_send(KIND_JSON, ('{"type":"logs","entries":[%s]}' % ",".join(entries)).to_utf8_buffer())


func _reply(id, body: Dictionary) -> void:
	if id == null:
		return
	body["type"] = "result"
	body["id"] = id
	body["ok"] = true
	_send_json(body)


func _reply_error(id, message: String) -> void:
	if id == null:
		push_warning("WASD Engine harness: " + message)
		return
	_send_json({"type": "result", "id": id, "ok": false, "error": message})


## Sends a JSON message. One larger than MAX_MESSAGE_BYTES, which the Host would refuse, is not sent: an answer becomes
## an error answer that says how large it was, and other messages are dropped with a warning in the log.
func _send_json(body: Dictionary) -> void:
	var payload := JSON.stringify(body).to_utf8_buffer()
	if _fits(payload.size()):
		_send(KIND_JSON, payload)
	elif body.get("type") == "result" and body.get("id") != null:
		_send_json({"type": "result", "id": body["id"], "ok": false, "error": _too_large("the answer", payload.size())})
	else:
		var kind := str(body.get("type", ""))
		push_warning("WASD Engine harness: dropped a %s message: %s" % [kind, _too_large("it", payload.size())])


## Whether a message with a payload of `bytes` fits within MAX_MESSAGE_BYTES, its kind byte included.
func _fits(bytes: int) -> bool:
	return bytes + 1 <= MAX_MESSAGE_BYTES


## Says that `what` of `bytes` is larger than a message to the Host may be.
func _too_large(what: String, bytes: int) -> String:
	var limit := MAX_MESSAGE_BYTES - 1
	return "%s takes %d bytes, more than the %d bytes that a message to WASD Engine may hold" % [what, bytes, limit]


## Queues one message and sends as much as the connection takes now. Returns false, sending nothing, without a
## connection and for a payload larger than MAX_MESSAGE_BYTES, which the Host would refuse. Both threads use it.
func _send(kind: int, payload: PackedByteArray) -> bool:
	var fits := _fits(payload.size())
	var message := PackedByteArray()
	if fits:
		message.resize(5)
		message.encode_u32(0, payload.size() + 1)
		message[4] = kind
		message.append_array(payload)
	_io.lock()
	var queued := _connected and fits
	if queued:
		_outbox.append(message)
		_outbox_bytes += message.size()
		_flush_outbox()
	elif _connected:
		push_warning("WASD Engine harness: dropped a message of kind %d: %s" % [kind, _too_large("it", payload.size())])
	_io.unlock()
	return queued


## Sends waiting messages, in order, as far as the connection takes them without waiting for it; callers hold `_io`. A
## failed write quits the game, since nothing else can observe or stop it then; the heartbeat thread leaves the quit to
## the main loop.
func _flush_outbox() -> void:
	while _connected and not _outbox.is_empty():
		var message: PackedByteArray = _outbox[0]
		var result := _peer.put_partial_data(message if _outbox_offset == 0 else message.slice(_outbox_offset))
		if result[0] != OK:
			_connected = false
			if OS.get_thread_caller_id() == OS.get_main_thread_id():
				quit()
			else:
				quit.call_deferred()
			return
		var sent: int = result[1]
		_outbox_offset += sent
		_outbox_bytes -= sent
		if _outbox_offset < message.size():
			return
		_outbox.pop_front()
		_outbox_offset = 0


## Sends every waiting message, waiting for the connection; the harness does this only as it exits, after the heartbeat
## thread ended.
func _drain_outbox() -> void:
	for message in _outbox:
		if not _connected:
			break
		if _peer.put_data(message if _outbox_offset == 0 else message.slice(_outbox_offset)) != OK:
			_connected = false
		_outbox_offset = 0
	_outbox.clear()
	_outbox_bytes = 0
