extends Control
## Controller Icons smoke test (render run on the Compatibility renderer): the autoload is there; an input action's
## picture draws in a TextureRect and is a key while the keyboard is in use; after a gamepad button it is that pad's
## button, the signal has told so, and the picture on screen has changed; fixed paths give a key and a gamepad button.

const ID := "controller-icons"

var changes := 0


func _ready() -> void:
	get_tree().create_timer(90.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frame(file: String) -> Image:
	for _i: int in 4:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


## How many pixels of a part of the picture differ from the dark background.
func _drawn(image: Image, part: Rect2i) -> int:
	var found := 0
	for y: int in range(part.position.y, part.end.y):
		for x: int in range(part.position.x, part.end.x):
			var pixel := image.get_pixel(x, y)
			if absf(pixel.r - 0.1) + absf(pixel.g - 0.1) + absf(pixel.b - 0.1) > 0.15:
				found += 1
	return found


func _run() -> void:
	var icons := get_node_or_null(^"/root/ControllerIcons")
	if icons == null:
		return _fail("the autoload ControllerIcons is missing")
	icons.input_type_changed.connect(func(_type: int, _controller: int) -> void: changes += 1)
	var back := ColorRect.new()
	back.color = Color(0.1, 0.1, 0.1)
	back.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(back)
	# The run's own action "smoke_jump" is Space on the keyboard and the bottom face button on a gamepad.
	var action := TextureRect.new()
	var action_icon := ControllerIconTexture.new()
	action_icon.path = "smoke_jump"
	action.texture = action_icon
	action.position = Vector2(40, 40)
	add_child(action)
	var key := TextureRect.new()
	var key_icon := ControllerIconTexture.new()
	key_icon.path = "key/e"
	key.texture = key_icon
	key.position = Vector2(240, 40)
	add_child(key)
	# The keyboard is in use.
	var tap := InputEventKey.new()
	tap.keycode = KEY_SHIFT
	tap.pressed = true
	Input.parse_input_event(tap)
	var with_keys := await _frame("keyboard.png")
	if icons.get_last_input_type() != 0:
		return _fail("after a key the input type is %d" % [icons.get_last_input_type()])
	var for_keys: Texture2D = icons.parse_path("smoke_jump")
	if for_keys == null or not for_keys.resource_path.contains("/assets/key/"):
		return _fail("smoke_jump on the keyboard is %s" % [for_keys.resource_path if for_keys != null else "nothing"])
	var action_part := Rect2i(40, 40, 100, 100)
	var key_part := Rect2i(240, 40, 100, 100)
	if _drawn(with_keys, action_part) < 800 or _drawn(with_keys, key_part) < 800:
		return _fail("the pictures drew %d and %d pixels" % [_drawn(with_keys, action_part), _drawn(with_keys, key_part)])
	# A gamepad button: the action's picture becomes that pad's button, and the fixed key stays.
	var press := InputEventJoypadButton.new()
	press.button_index = JOY_BUTTON_A
	press.pressed = true
	press.device = 0
	Input.parse_input_event(press)
	var with_pad := await _frame("gamepad.png")
	if icons.get_last_input_type() != 1 or changes < 1:
		return _fail("after a gamepad button the input type is %d, with %d changes told" % [icons.get_last_input_type(), changes])
	var for_pad: Texture2D = icons.parse_path("smoke_jump")
	if for_pad == null or for_pad.resource_path.contains("/assets/key/") or not for_pad.resource_path.ends_with("/a.png"):
		return _fail("smoke_jump on a gamepad is %s" % [for_pad.resource_path if for_pad != null else "nothing"])
	var changed := 0
	var same := 0
	for y: int in range(40, 140):
		for x: int in range(40, 140):
			if with_keys.get_pixel(x, y) != with_pad.get_pixel(x, y):
				changed += 1
			if with_keys.get_pixel(x + 200, y) != with_pad.get_pixel(x + 200, y):
				same += 1
	if changed < 500 or same > 0:
		return _fail("%d pixels of the action's picture changed and %d of the fixed key's" % [changed, same])
	# Fixed paths: a gamepad's left trigger and the mouse's left button.
	for fixed: String in ["joypad/lt", "mouse/left", "key/space"]:
		if icons.parse_path(fixed) == null:
			return _fail("no picture for %s" % [fixed])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
