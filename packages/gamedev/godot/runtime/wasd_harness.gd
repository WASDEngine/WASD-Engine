extends SceneTree
## WASD Engine game harness.
##
## The Host runs a game as `--path <project> --script <this file> -- --wasd-port=<port> --wasd-token=<token> [--wasd-scene=<res path>]`.
## As the main loop, the harness loads the project's main scene (or --wasd-scene), keeps running while the
## game is paused, and serves one loopback TCP connection to the Host. Autoloads load as usual.
##
## Wire format, both directions: a 4-byte little-endian length N, then N bytes holding a 1-byte kind and its payload.
## Kind 1 is a UTF-8 JSON object. Kind 2 (harness to Host) is a streamed frame: u32 sequence, u16 width,
## u16 height, then the bytes of a PNG or JPEG file. Kind 3 (harness to Host) answers a screenshot request:
## u32 request id, then the PNG or JPEG bytes. The first message on the connection is the harness's `hello`
## JSON, which carries the token. When the game draws into the Core Animation layer of the macOS embedded display
## server, `hello` also carries `layer`: the CAContext id through which another process of the login session can
## display that layer with a CALayerHost, and the game window pixels per layer point (`scale`).
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
## the game, and no frame is captured while earlier messages still wait. At exit the harness sends what is left.
##
## `wait` and `step` frames count frames that the game ran after the request arrived; `wait` seconds count game
## time while the tree is not paused, which Engine.time_scale scales. Input sequences run one at a time in
## arrival order; their `wait` events and `hold` releases count real time, so a paused game or a time scale of 0
## does not hold them up.
##
## A `wait`, `step`, or `input` request ends early once its optional `timeoutMs` of real time has passed since it
## arrived, or on a `cancel` request whose `request` is its id; a pending step also ends on `pause`, `resume`, or
## a newer `step`. An early end answers with the usual fields for the part that ran, plus `timedOut: true` after
## the timeout or `cancelled: true` otherwise; a request that runs to its end answers both as false. A step that
## times out or is cancelled pauses the game, and one that `resume` or a newer step ends leaves it running. An
## input sequence that ends early answers `events` as the number of its events that ran; one that ends early or
## fails releases the keys, buttons, and actions it pressed and did not release. `cancel` answers `cancelled`:
## whether a `wait`, `step`, `input`, or `performance` request with that id was pending.
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
## A `pace` request with a positive `maxFps` caps Engine.max_fps at that rate, or at the game's own cap when that is
## lower; `maxFps` 0 restores the game's own cap. The Host caps a game that nobody shows or uses and lifts the cap
## before the requests it sends to a capped game. The answer carries the resulting `maxFps`.

const PROTOCOL_VERSION := 1
const KIND_JSON := 1
const KIND_FRAME := 2
const KIND_IMAGE := 3
const MAX_PENDING_LOGS := 4000
const MAX_MESSAGE_BYTES := 64 * 1024 * 1024
const USEC_PER_SECOND := 1000000.0
const LOSSLESS_TEST_DELAY := 1.0  # seconds from a failed or slow PNG test, or a slow PNG frame, to the next test
const LOSSLESS_TEST_MAX_DELAY := 8.0
const PERFORMANCE_SERIES := ["frame", "physics", "harness", "process", "draw", "gpu", "renderCpu", "objects", "primitives", "drawCalls"]
const PERFORMANCE_MAX_FRAMES := 20000  # frames a sample records; later frames count in droppedFrames
const PERFORMANCE_MAX_NODES := 200000  # nodes the census visits
const PERFORMANCE_TOP := 8  # node classes and scripts the census lists
const PERFORMANCE_MAX_CUSTOM := 40  # custom monitors a sample reports
# DisplayServer metadata in which the WASD Engine LibGodot build publishes the CAContext id of the embedded display server's layer.
const LAYER_CONTEXT_META := &"wasd_layer_context_id"
# `eval` code compiles as the body of `run` in a script of its own, under a path that names the script in its errors. The
# names it may use are members, so the code may declare its own of the same names.
const CODE_HEAD := "extends Node\n\n\nvar tree: SceneTree\nvar root: Window\nvar scene: Node\nvar node: Object\n\n\nfunc run():\n"
const CODE_HEAD_LINES := 10
const EVAL_PATH := "res://wasd_eval_%d.gd"
const KIND_RECORD := 4
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
		_push({"level": "stderr" if error else "stdout", "message": message.trim_suffix("\n")})

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
			"message": rationale if not rationale.is_empty() else code,
			"function": function,
			"file": file,
			"line": line,
		}
		if not code.is_empty() and not rationale.is_empty():
			entry["code"] = code
		var frames: Array[Dictionary] = []
		for backtrace in script_backtraces:
			for i in backtrace.get_frame_count():
				frames.append({"function": backtrace.get_frame_function(i), "file": backtrace.get_frame_file(i), "line": backtrace.get_frame_line(i)})
		if not frames.is_empty():
			entry["backtrace"] = frames
		_push(entry)

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
			_pending.pop_front()
			dropped += 1
		_pending.append(entry)
		_mutex.unlock()

	func take() -> Array[Dictionary]:
		_mutex.lock()
		var taken := _pending
		_pending = []
		_mutex.unlock()
		return taken


var _logger := HarnessLogger.new()
var _peer := StreamPeerTCP.new()
var _connected := false
var _outbox: Array[PackedByteArray] = []  # messages waiting for the connection, oldest first
var _outbox_offset := 0  # bytes of the first waiting message already sent
var _outbox_bytes := 0  # bytes still to send
var _hello_sent := false
var _port := 0
var _token := ""
var _scene_override := ""
var _rx := PackedByteArray()

var _stream_fps := 0.0
var _own_max_fps := -1  # the game's own Engine.max_fps while the Host caps the frame rate, -1 while it does not
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
# pausedFrames, physicsSteps, streamedFrames, series: {name: values}, monitorsStart, marks}. `marks` holds the tick
# microseconds at which the phases of the current frame began, 0 until they do, and its physics microseconds.
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
	_wait_for_encodings()
	_flush_logs()
	OS.remove_logger(_logger)
	if _connected:
		_drain_outbox()
		_peer.disconnect_from_host()


func _process(delta: float) -> bool:
	if not _sample.is_empty():
		_sample_frame(Time.get_ticks_usec())
	_frame += 1
	if _poll_connection():
		var now := Time.get_ticks_usec() / USEC_PER_SECOND
		_receive(now)
		_release_holds(now)
		_advance_actions(now)
		_advance_waits(now)
		_advance_sample(now)
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
	_peer.poll()
	var status := _peer.get_status()
	if status == StreamPeerTCP.STATUS_CONNECTED:
		if not _connected:
			_connected = true
			_peer.set_no_delay(true)
		if not _hello_sent:
			_hello_sent = true
			_send_json(_hello())
		_flush_outbox()
		return _connected
	if _connected and (status == StreamPeerTCP.STATUS_NONE or status == StreamPeerTCP.STATUS_ERROR):
		# The Host closed the connection: nothing else can observe or stop this game.
		quit()
	return false


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
	}
	var layer_context := int(DisplayServer.get_meta(LAYER_CONTEXT_META, 0))
	if layer_context > 0:
		hello["layer"] = {"context": layer_context, "scale": DisplayServer.screen_get_max_scale()}
	return hello


func _window_size() -> Vector2i:
	return DisplayServer.window_get_size()


func _receive(now: float) -> void:
	var available := _peer.get_available_bytes()
	if available > 0:
		var chunk := _peer.get_data(available)
		if chunk[0] == OK:
			_rx.append_array(chunk[1])
	while _rx.size() >= 4:
		var length := _rx.decode_u32(0)
		if length < 1 or length > MAX_MESSAGE_BYTES:
			push_error("WASD Engine harness: invalid message length %d from the Host." % length)
			_peer.disconnect_from_host()
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
		"view":
			_view(id, message)
		"record":
			_record(id, message, now)
		"quit":
			_reply(id, {"quitting": true})
			quit(int(message.get("exitCode", 0)))
		_:
			_reply_error(id, "unknown request type %s" % str(message.get("type", "")))


## Caps the frame rate at `maxFps` while nobody shows or uses the game, keeping a lower cap of the game's own, or
## restores the game's own cap for a `maxFps` of 0. Game time keeps its pace while physics steps fit the capped frames.
func _pace(id, message: Dictionary) -> void:
	var cap := clampi(int(message.get("maxFps", 0)), 0, 1000)
	if cap > 0:
		if _own_max_fps < 0:
			_own_max_fps = Engine.max_fps
		Engine.max_fps = cap if _own_max_fps == 0 else mini(cap, _own_max_fps)
	elif _own_max_fps >= 0:
		Engine.max_fps = _own_max_fps
		_own_max_fps = -1
	_reply(id, {"maxFps": Engine.max_fps})


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
	_reply(id, facts)
	_send_image(id, image.save_jpg_to_buffer(clampf(float(message.get("quality", 0.85)), 0.1, 1.0)) if format == "jpeg" else image.save_png_to_buffer())


## Sends the image bytes that answer request `id`.
func _send_image(id, bytes: PackedByteArray) -> void:
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
## `wait` lets the recording reach its end, and answers once the captured frames went out.
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
		_send(KIND_RECORD, payload)
		_recording["sent"] += 1
		_recording["size"] = head.encoding.size


## Sends the waiting messages, waiting for the connection; a game-frame recording does this rather than skip a frame.
func _flush_outbox_waiting() -> void:
	while _connected and _outbox_bytes > RECORD_MAX_OUTBOX:
		_peer.poll()
		_flush_outbox()
		if _outbox_bytes > RECORD_MAX_OUTBOX:
			OS.delay_msec(1)


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
	_reply(id, {"value": _to_json(value, 0), "valueType": type_string(typeof(value))})


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
	_reply(id, {"value": _to_json(value, 0), "valueType": type_string(typeof(value))})


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
		_reply(view["id"], facts)
		_send_image(view["id"], image.save_jpg_to_buffer(view["quality"]) if view["format"] == "jpeg" else image.save_png_to_buffer())
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
	}
	RenderingServer.viewport_set_measure_render_time(root.get_viewport_rid(), true)
	physics_frame.connect(_on_sample_physics_frame)
	process_frame.connect(_on_sample_process_frame)
	RenderingServer.frame_pre_draw.connect(_on_sample_pre_draw)
	RenderingServer.frame_post_draw.connect(_on_sample_post_draw)


## Records the frame that ended at `now_usec`, the start of this `_process`, and starts the marks of the next one.
## A frame's physics steps run before its `_process`, so their time is known when the frame starts.
func _sample_frame(now_usec: int) -> void:
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
	marks["physicsUsec"] = now_usec - physics_first if physics_first > 0 else 0
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


## Ends the running performance sample once its window has passed, or at its `timeoutMs` with `timedOut`.
func _advance_sample(now: float) -> void:
	if _sample.is_empty():
		return
	if now >= float(_sample["end"]):
		_finish_sample(now, false, false)
	elif float(_sample["deadline"]) > 0.0 and now >= float(_sample["deadline"]):
		_finish_sample(now, true, false)


func _finish_sample(now: float, timed_out: bool, cancelled: bool) -> void:
	var sample := _sample
	_sample = {}
	physics_frame.disconnect(_on_sample_physics_frame)
	process_frame.disconnect(_on_sample_process_frame)
	RenderingServer.frame_pre_draw.disconnect(_on_sample_pre_draw)
	RenderingServer.frame_post_draw.disconnect(_on_sample_post_draw)
	RenderingServer.viewport_set_measure_render_time(root.get_viewport_rid(), false)
	_reply(sample["id"], {
		"seconds": now - float(sample["started"]),
		"frames": sample["frames"],
		"droppedFrames": sample["droppedFrames"],
		"pausedFrames": sample["pausedFrames"],
		"physicsSteps": sample["physicsSteps"],
		"streamedFrames": sample["streamedFrames"],
		"series": sample["series"],
		"monitorsStart": sample["monitorsStart"],
		"monitorsEnd": _monitors(),
		"custom": _custom_monitors(),
		"nodes": _node_census(),
		"context": _performance_context(),
		"timedOut": timed_out,
		"cancelled": cancelled,
	})


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
		"maxFps": Engine.max_fps,
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


func _to_json(value, depth: int):
	if depth > 8:
		return str(value)
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return value
		TYPE_FLOAT:
			return value if is_finite(value) else str(value)
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(value)
		TYPE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY:
			var items := []
			for item in value:
				if items.size() >= 200:
					items.append("…")
					break
				items.append(_to_json(item, depth + 1))
			return items
		TYPE_DICTIONARY:
			var result := {}
			for key in value:
				if result.size() >= 200:
					break
				result[str(key)] = _to_json(value[key], depth + 1)
			return result
		TYPE_OBJECT:
			if value == null:
				return null
			if value is Node:
				return {"node": str(value.get_path()), "class": value.get_class()}
			return {"object": value.get_class(), "id": value.get_instance_id()}
	return var_to_str(value)


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


func _flush_logs() -> void:
	if not _connected:
		return
	var entries := _logger.take()
	if not entries.is_empty():
		_send_json({"type": "logs", "entries": entries})


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


func _send_json(body: Dictionary) -> void:
	_send(KIND_JSON, JSON.stringify(body).to_utf8_buffer())


## Queues one message and sends as much as the connection takes now.
func _send(kind: int, payload: PackedByteArray) -> void:
	if not _connected:
		return
	var message := PackedByteArray()
	message.resize(5)
	message.encode_u32(0, payload.size() + 1)
	message[4] = kind
	message.append_array(payload)
	_outbox.append(message)
	_outbox_bytes += message.size()
	_flush_outbox()


## Sends waiting messages, in order, as far as the connection takes them without waiting for it.
func _flush_outbox() -> void:
	while _connected and not _outbox.is_empty():
		var message: PackedByteArray = _outbox[0]
		var result := _peer.put_partial_data(message if _outbox_offset == 0 else message.slice(_outbox_offset))
		if result[0] != OK:
			_connected = false
			quit()
			return
		var sent: int = result[1]
		_outbox_offset += sent
		_outbox_bytes -= sent
		if _outbox_offset < message.size():
			return
		_outbox.pop_front()
		_outbox_offset = 0


## Sends every waiting message, waiting for the connection; the harness does this only as it exits.
func _drain_outbox() -> void:
	for message in _outbox:
		if not _connected:
			break
		if _peer.put_data(message if _outbox_offset == 0 else message.slice(_outbox_offset)) != OK:
			_connected = false
		_outbox_offset = 0
	_outbox.clear()
	_outbox_bytes = 0
