extends SceneTree
## WASD Engine game harness.
##
## The Host runs a game as `--path <project> --script <this file> -- --wasd-port=<port> --wasd-token=<token> [--wasd-scene=<res path>]`.
## As the main loop, the harness loads the project's main scene (or --wasd-scene), keeps running while the
## game is paused, and serves one loopback TCP connection to the Host. Autoloads load as usual.
##
## Wire format, both directions: a 4-byte little-endian length N, then N bytes holding a 1-byte kind and its payload.
## Kind 1 is a UTF-8 JSON object. Kind 2 (harness to Host) is a streamed JPEG frame: u32 sequence, u16 width,
## u16 height, then the JPEG bytes. Kind 3 (harness to Host) answers a screenshot request: u32 request id,
## then the PNG or JPEG bytes. The first message on the connection is the harness's `hello` JSON, which carries the token.
##
## Screenshots and streamed frames show the game window at its pixel size, scaled down to `maxWidth`: the root
## viewport where the project's stretch settings place it, and black where the window shows bars around it. At
## full size, image pixel (x, y) is window pixel (x, y), the unit of input event coordinates. Frames stream at
## most `fps` times per second of real time, also while the game is paused or Engine.time_scale is 0.
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

const PROTOCOL_VERSION := 1
const KIND_JSON := 1
const KIND_FRAME := 2
const KIND_IMAGE := 3
const MAX_PENDING_LOGS := 4000
const MAX_MESSAGE_BYTES := 64 * 1024 * 1024
const USEC_PER_SECOND := 1000000.0
const PERFORMANCE_SERIES := ["frame", "physics", "harness", "process", "draw", "gpu", "renderCpu", "objects", "primitives", "drawCalls"]
const PERFORMANCE_MAX_FRAMES := 20000  # frames a sample records; later frames count in droppedFrames
const PERFORMANCE_MAX_NODES := 200000  # nodes the census visits
const PERFORMANCE_TOP := 8  # node classes and scripts the census lists
const PERFORMANCE_MAX_CUSTOM := 40  # custom monitors a sample reports

class HarnessLogger extends Logger:
	var _mutex := Mutex.new()
	var _pending: Array[Dictionary] = []
	var dropped := 0

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
var _hello_sent := false
var _port := 0
var _token := ""
var _scene_override := ""
var _rx := PackedByteArray()

var _stream_fps := 0.0
var _stream_quality := 0.75
var _stream_max_width := 1280
var _next_frame_time := 0.0  # real time in seconds when the next streamed frame is due
var _frame_sequence := 0

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
	_flush_logs()
	OS.remove_logger(_logger)
	if _connected:
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
		_flush_logs()
		_send_status_if_changed()
		_stream_frame(now)
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
		return true
	if _connected and (status == StreamPeerTCP.STATUS_NONE or status == StreamPeerTCP.STATUS_ERROR):
		# The Host closed the connection: nothing else can observe or stop this game.
		quit()
	return false


func _hello() -> Dictionary:
	var size := _window_size()
	return {
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
			_next_frame_time = 0.0
			_reply(id, {"fps": _stream_fps, "quality": _stream_quality, "maxWidth": _stream_max_width})
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
			_eval(id, message)
		"tree":
			_tree(id, message)
		"performance":
			_start_sample(id, message, now)
		"quit":
			_reply(id, {"quitting": true})
			quit(int(message.get("exitCode", 0)))
		_:
			_reply_error(id, "unknown request type %s" % str(message.get("type", "")))


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


## Returns the picture the game window shows, scaled down to at most `max_width` pixels wide (0 keeps the window
## size), or null before the root viewport has an image.
func _capture(max_width: int) -> Image:
	var picture := root.get_texture().get_image()
	if picture == null or picture.is_empty():
		return null
	if picture.get_format() != Image.FORMAT_RGB8:
		picture.convert(Image.FORMAT_RGB8)
	var window := _window_size()
	if window.x <= 0 or window.y <= 0:
		return picture
	var scale := minf(1.0, float(max_width) / window.x) if max_width > 0 else 1.0
	var size := Vector2i(maxi(1, roundi(window.x * scale)), maxi(1, roundi(window.y * scale)))
	# The window shows the root viewport's picture in its visible rect mapped through the window's letterbox and
	# stretch transforms, which are the final transform without the global canvas transform; black fills the rest.
	var shown :=root.get_final_transform() * root.global_canvas_transform.affine_inverse() * root.get_visible_rect()
	var target := Rect2i(Vector2i((shown.position * scale).round()), Vector2i((shown.size * scale).round()).maxi(1))
	if target.size != picture.get_size():
		var interpolation := Image.INTERPOLATE_BILINEAR if target.size.x < picture.get_width() else Image.INTERPOLATE_NEAREST
		picture.resize(target.size.x, target.size.y, interpolation)
	if target == Rect2i(Vector2i.ZERO, size):
		return picture
	var framed := Image.create_empty(size.x, size.y, false, Image.FORMAT_RGB8)
	framed.blit_rect(picture, Rect2i(Vector2i.ZERO, picture.get_size()), target.position)
	return framed


func _screenshot(id, message: Dictionary) -> void:
	var image := _capture(int(message.get("maxWidth", 0)))
	if image == null:
		_reply_error(id, "the root viewport has no image yet")
		return
	var format := str(message.get("format", "png"))
	var bytes := image.save_jpg_to_buffer(clampf(float(message.get("quality", 0.85)), 0.1, 1.0)) if format == "jpeg" else image.save_png_to_buffer()
	var window := _window_size()
	_reply(id, {"format": "jpeg" if format == "jpeg" else "png", "width": image.get_width(), "height": image.get_height(), "windowWidth": window.x, "windowHeight": window.y, "frame": _frame, "paused": paused})
	var header := PackedByteArray()
	header.resize(4)
	header.encode_u32(0, int(id) if id != null else 0)
	header.append_array(bytes)
	_send(KIND_IMAGE, header)


func _stream_frame(now: float) -> void:
	if _stream_fps <= 0.0 or now < _next_frame_time:
		return
	var interval := 1.0 / _stream_fps
	# Keep the cadence while the loop keeps up; after a stall, restart it instead of sending a burst.
	_next_frame_time = _next_frame_time + interval if now - _next_frame_time < interval else now + interval
	var image := _capture(_stream_max_width)
	if image == null:
		return
	var jpeg := image.save_jpg_to_buffer(_stream_quality)
	_frame_sequence += 1
	var payload := PackedByteArray()
	payload.resize(8)
	payload.encode_u32(0, _frame_sequence)
	payload.encode_u16(4, image.get_width())
	payload.encode_u16(6, image.get_height())
	payload.append_array(jpeg)
	_send(KIND_FRAME, payload)
	if not _sample.is_empty():
		_sample["streamedFrames"] += 1


func _eval(id, message: Dictionary) -> void:
	var expression := Expression.new()
	var names := PackedStringArray(["tree", "root", "scene"])
	var error := expression.parse(str(message.get("expression", "")), names)
	if error != OK:
		_reply_error(id, expression.get_error_text())
		return
	var base: Object = current_scene
	var path := str(message.get("node", ""))
	if not path.is_empty():
		base = root.get_node_or_null(NodePath(path))
		if base == null:
			_reply_error(id, "no node at %s" % path)
			return
	var value = expression.execute([self, root, current_scene], base, false)
	if expression.has_execute_failed():
		_reply_error(id, expression.get_error_text())
		return
	_reply(id, {"value": _to_json(value, 0), "valueType": type_string(typeof(value))})


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


func _send(kind: int, payload: PackedByteArray) -> void:
	if not _connected:
		return
	var header := PackedByteArray()
	header.resize(5)
	header.encode_u32(0, payload.size() + 1)
	header[4] = kind
	header.append_array(payload)
	var error := _peer.put_data(header)
	if error != OK:
		_connected = false
		quit()
