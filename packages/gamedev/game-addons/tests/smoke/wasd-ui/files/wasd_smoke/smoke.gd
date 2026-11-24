extends Node3D
## WASD UI smoke test (render run on the Compatibility renderer, the one every Web build uses): the autoload puts a
## look on Godot's own controls wherever they stand, changes it by name, takes an accent and a scale, and gives
## Godot's own back; it builds a look again only when something it is built from changes, with a scale worked out
## from the window in steps, and leaves no panel smaller than what it holds; keyboard focus shows on every kind of
## control that takes it, in every look; a bar glides, shows on screen, tells when it is empty, and keeps its value
## within its most; toasts come and go, also over the panels of a theme of the game's own (the project's theme/custom,
## empty until the test fills it); numbers rise from places before the camera and not from behind it; the prompt, the
## hurt flash, the fades, and menus over a dimmed game show and leave, show a captured mouse pointer, and give the
## focus and the pointer back unless the game, another menu, or a change of scene takes them first; a menu whose first
## button is hidden gives the focus to its first button that shows, also when a menu over it closes; a hidden menu of
## a scene shows while it is open and, kept, goes back to its place there, hidden, laid out as it was on the Center
## and the Full Rect presets, with the scene's `%` names, and when its scene leaves the tree it goes back into it while
## a menu made in code is freed, and the dim goes and the pointer stays shown; a label placed in a corner reads over
## the game; the crosshair and the radar draw, and the radar follows a center that turns only its model and looks
## through a camera rig, as a WasdCharacter3D does.

const ID := "wasd-ui"

var camera: Camera3D


func _ready() -> void:
	get_tree().create_timer(80.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _wait(seconds: float) -> void:
	await get_tree().create_timer(seconds).timeout


func _frames(count: int) -> void:
	for _i in count:
		await get_tree().process_frame


func _picture(file: String) -> Image:
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	if file != "":
		image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


## How many pixels of a rectangle differ clearly between two pictures.
func _changed(before: Image, after: Image, rect: Rect2i) -> int:
	var count := 0
	var inside := rect.intersection(Rect2i(Vector2i.ZERO, before.get_size()))
	for y: int in range(inside.position.y, inside.end.y):
		for x: int in range(inside.position.x, inside.end.x):
			var was := before.get_pixel(x, y)
			var now := after.get_pixel(x, y)
			if absf(was.r - now.r) + absf(was.g - now.g) + absf(was.b - now.b) > 0.15:
				count += 1
	return count


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var ui: WasdUiKit = get_node_or_null("/root/WasdUi")
	if ui == null:
		return _fail("the installation added no autoload named WasdUi")
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.1, 0.3, 0.1)
	add_child(world)
	camera = Camera3D.new()
	camera.position = Vector3(0, 1, 5)
	add_child(camera)
	await _wait(0.2)

	# 1. The look reaches Godot's own controls even under a CanvasLayer, changes by name, and can be taken off.
	var layer := CanvasLayer.new()
	add_child(layer)
	var button := Button.new()
	button.text = "Play"
	layer.add_child(button)
	var looks := ui.names()
	var clean := button.get_theme_stylebox(&"normal") as StyleBoxFlat
	if looks.size() != 6 or ui.look != "clean" or clean == null or not clean.bg_color.is_equal_approx(WasdUiLooks.LOOKS["clean"]["button"]):
		return _fail("%d looks; the look is %s; a button's box is %s" % [looks.size(), ui.look, clean])
	ui.look = "fantasy"
	var wooden := button.get_theme_stylebox(&"normal") as StyleBoxFlat
	if wooden == null or not wooden.bg_color.is_equal_approx(WasdUiLooks.LOOKS["fantasy"]["button"]) or wooden.border_width_left < 2:
		return _fail("in the fantasy look a button's box is %s" % [wooden.bg_color if wooden != null else null])
	ui.look = "no such look"
	if ui.look != "clean":
		return _fail("an unknown look left %s" % [ui.look])
	for variation: StringName in [&"AccentButton", &"HeaderMedium", &"MutedLabel", &"HudLabel"]:
		if ThemeDB.get_default_theme().get_type_variation_base(variation) == &"":
			return _fail("the look has no %s" % [variation])
	ui.look = ""
	var godot := button.get_theme_stylebox(&"normal") as StyleBoxFlat
	if godot != null and godot.bg_color.is_equal_approx(WasdUiLooks.LOOKS["clean"]["button"]):
		return _fail("with no look a button still has the clean look's box")
	ui.look = "clean"

	# 2. An accent of the game's own, and a scale. A resize that keeps the scale builds nothing again, and a menu that
	# stands while the accent changes stays as large as what it holds.
	ui.accent = Color(0.1, 0.8, 0.3)
	button.theme_type_variation = &"AccentButton"
	var green := button.get_theme_stylebox(&"normal") as StyleBoxFlat
	if not green.bg_color.is_equal_approx(Color(0.1, 0.8, 0.3)) or ui.values()["accent"] != Color(0.1, 0.8, 0.3):
		return _fail("with a green accent the accent button's box is %s" % [green.bg_color])
	ui.accent = null
	ui.scale_by = 1.0
	var plain_size := button.get_theme_font_size(&"font_size")
	ui.scale_by = 2.0
	if button.get_theme_font_size(&"font_size") != plain_size * 2 or not is_equal_approx(ui.get_ui_scale(), 2.0):
		return _fail("at a scale of 2 the text is %d, at 1 it was %d" % [button.get_theme_font_size(&"font_size"), plain_size])
	ui.scale_by = 1.0
	var rebuilt := [0]
	var count_builds := func() -> void: rebuilt[0] += 1
	ui.look_changed.connect(count_builds)
	var kept := button.get_theme_stylebox(&"normal")
	get_tree().root.size_changed.emit()
	ui.look = "clean"
	ui.look_changed.disconnect(count_builds)
	if rebuilt[0] != 0 or button.get_theme_stylebox(&"normal") != kept:
		return _fail("a resize that kept the scale, and the look set to the one on, built the look %d times" % [rebuilt[0]])
	# Worked out from the window, the scale goes in steps: a window dragged through 40 heights builds the look once or
	# twice, not 40 times.
	ui.scale_by = 0.0
	var window := get_window()
	window.size = Vector2i(640, 600)
	await _frames(2)
	ui.look_changed.connect(count_builds)
	for height: int in range(600, 640):
		window.size = Vector2i(640, height)
		await _frames(1)
	ui.look_changed.disconnect(count_builds)
	window.size = Vector2i(640, 360)
	ui.scale_by = 1.0
	await _frames(2)
	if rebuilt[0] > 2:
		return _fail("a window dragged through 40 heights built the look %d times" % [rebuilt[0]])
	button.queue_free()
	var standing := PanelContainer.new()
	layer.add_child(standing)
	var rows := VBoxContainer.new()
	standing.add_child(rows)
	for kind: String in ["Label", "CheckBox", "Button", "Button"]:
		var row: Control = ClassDB.instantiate(kind)
		row.set(&"text", kind)
		rows.add_child(row)
	ui.look = "fantasy"
	await _frames(3)
	ui.accent = Color(0.2, 0.8, 0.3)
	await _frames(3)
	var held_size := standing.size
	var least := standing.get_combined_minimum_size()
	ui.accent = null
	ui.look = "clean"
	standing.queue_free()
	if held_size.x < least.x or held_size.y < least.y:
		return _fail("after an accent change a menu panel is %s, smaller than the %s it holds" % [held_size, least])

	# 3. Keyboard and gamepad focus shows on every kind of control that takes it, in every look: a ring in the accent
	# round a button, a check box, a switch, and a tab, and a halo round a slider's knob.
	for look: String in looks:
		var made := WasdUiLooks.make(look)
		for item: Array in [["focus", "Button"], ["focus", "CheckBox"], ["focus", "CheckButton"], ["tab_focus", "TabBar"], ["tab_focus", "TabContainer"]]:
			var ring := made.get_stylebox(item[0], item[1]) as StyleBoxFlat
			if ring == null or ring.border_width_top < 2 or ring.border_color.a < 0.9:
				return _fail("in the %s look the %s of a %s is %s" % [look, item[0], item[1], made.get_stylebox(item[0], item[1])])
		if made.get_icon("grabber_highlight", "HSlider") == made.get_icon("grabber", "HSlider"):
			return _fail("in the %s look a focused slider's knob is its plain one" % [look])
	var settings := PanelContainer.new()
	settings.position = Vector2(16, 16)
	layer.add_child(settings)
	var lines := VBoxContainer.new()
	settings.add_child(lines)
	var check := CheckBox.new()
	check.text = "Subtitles"
	lines.add_child(check)
	var toggle := CheckButton.new()
	toggle.text = "Music"
	lines.add_child(toggle)
	var slider := HSlider.new()
	slider.custom_minimum_size = Vector2(200, 0)
	slider.value = 60.0
	lines.add_child(slider)
	var tabs := TabBar.new()
	tabs.add_tab("Video")
	tabs.add_tab("Audio")
	lines.add_child(tabs)
	for look: String in looks:
		ui.look = look
		await _frames(2)
		var calm := await _picture("")
		for control: Control in [check, toggle, slider, tabs]:
			control.grab_focus()
			await _frames(2)
			var focused := await _picture("focus_%s_%s.png" % [look, control.get_class()] if control == check else "")
			var shown := _changed(calm, focused, Rect2i(control.get_global_rect().grow(4.0)))
			control.release_focus()
			if shown < 40:
				return _fail("in the %s look focus on a %s changes %d pixels" % [look, control.get_class(), shown])
	ui.look = "clean"
	settings.queue_free()

	# 4. A bar: it shows in its corner in its color, glides to a new value, and tells when it is empty.
	var health := ui.bar("HP", Color(1.0, 0.0, 0.0))
	health.numbers = true
	await _wait(0.3)
	var with_bar := await _picture("bar.png")
	var red := 0
	for y: int in range(10, 60):
		for x: int in range(20, 330):
			var pixel := with_bar.get_pixel(x, y)
			if pixel.r > 0.7 and pixel.g < 0.3 and pixel.b < 0.3:
				red += 1
	var emptied := [false]
	health.emptied.connect(func() -> void: emptied[0] = true)
	health.value = 40.0
	await _wait(0.6)
	var after_hit := await _picture("bar_hit.png")
	var red_after := 0
	for y: int in range(10, 60):
		for x: int in range(20, 330):
			var pixel := after_hit.get_pixel(x, y)
			if pixel.r > 0.7 and pixel.g < 0.3 and pixel.b < 0.3:
				red_after += 1
	health.value = 0.0
	if red < 1500 or red_after > red * 0.6 or red_after < red * 0.2 or not emptied[0]:
		return _fail("the bar showed %d red pixels full and %d at 40 of 100; emptied %s" % [red, red_after, emptied[0]])
	# The value stays within the most: a lower one takes it down. A value given before a bar is in play is no hit.
	health.max_value = 120.0
	health.value = 120.0
	health.max_value = 50.0
	var waiting := WasdBar.new()
	waiting.value = 30.0
	var flashed := float(waiting.get(&"_flash"))
	waiting.free()
	if not is_equal_approx(health.value, 50.0) or flashed != 0.0:
		return _fail("with its most lowered to 50 a bar holds %f; a bar not yet in play flashed %f" % [health.value, flashed])

	# 5. Toasts come and go, four at the most, also over the panels of a theme of the game's own: one drawn from a
	# texture stays as it is, and over one that draws nothing the line reads over the game.
	var toasts: Node = ui.get(&"_toasts")
	for index: int in 6:
		ui.toast("Message %d" % [index], {"seconds": 0.2})
	if toasts.get_child_count() != 4:
		return _fail("six toasts left %d on screen" % [toasts.get_child_count()])
	await _wait(1.0)
	if toasts.get_child_count() != 0:
		return _fail("%d toasts stayed" % [toasts.get_child_count()])
	var own := ThemeDB.get_project_theme()
	if own == null:
		return _fail("the project has no theme of its own")
	own.set_stylebox(&"panel", &"PanelContainer", StyleBoxTexture.new())
	ui.toast("Framed", {"seconds": 0.2})
	var framed := toasts.get_child_count() == 1 and (toasts.get_child(0) as Control).get_theme_stylebox(&"panel") is StyleBoxTexture
	own.set_stylebox(&"panel", &"PanelContainer", StyleBoxEmpty.new())
	ui.toast("Bare", {"seconds": 0.2})
	var bare := toasts.get_child_count() == 2 and (toasts.get_child(1).get_child(0) as Label).theme_type_variation == &"HudLabel"
	own.clear_stylebox(&"panel", &"PanelContainer")
	if not framed or not bare:
		return _fail("over a theme of the game's own %d toasts show; the framed one kept its panel %s, the bare one reads %s" % [toasts.get_child_count(), framed, bare])
	await _wait(1.0)
	if toasts.get_child_count() != 0:
		return _fail("%d toasts over the game's own panels stayed" % [toasts.get_child_count()])

	# 6. Numbers rise from places before the camera, in 3D and in 2D, and not from behind it.
	var pops: Node = ui.get(&"_pops")
	ui.pop("-25", Vector3(0, 1, 0), Color.YELLOW)
	ui.pop("+5", Vector2(100, 100))
	ui.pop("behind", Vector3(0, 1, 20))
	var marker := Node3D.new()
	marker.position = Vector3(1, 1, 0)
	add_child(marker)
	ui.pop("node", marker)
	if pops.get_child_count() != 3:
		return _fail("four pops, one behind the camera, made %d numbers" % [pops.get_child_count()])
	var first := pops.get_child(0) as Label
	var where := camera.unproject_position(Vector3(0, 1, 0))
	if (first.position + first.size * 0.5).distance_to(where) > 40.0:
		return _fail("a number for %s stands at %s" % [where, first.position + first.size * 0.5])
	await _wait(1.2)
	if pops.get_child_count() != 0:
		return _fail("%d numbers stayed" % [pops.get_child_count()])

	# 7. The prompt shows a key and a word, and leaves.
	var prompt: Control = ui.get(&"_prompt")
	ui.prompt("E", "Open")
	await _wait(0.3)
	if not prompt.visible or prompt.modulate.a < 0.9 or (ui.get(&"_prompt_key") as Label).text != "E" or (ui.get(&"_prompt_text") as Label).text != "Open":
		return _fail("the prompt is visible %s at %f" % [prompt.visible, prompt.modulate.a])
	# A picture of a key in place of its letter.
	var gradient := GradientTexture2D.new()
	gradient.width = 32
	gradient.height = 32
	ui.prompt(gradient, "Jump")
	var prompt_icon := ui.get(&"_prompt_icon") as TextureRect
	if not prompt_icon.visible or prompt_icon.texture != gradient or (ui.get(&"_prompt_key") as Label).visible or (ui.get(&"_prompt_text") as Label).text != "Jump":
		return _fail("the prompt did not take a picture for its key")
	ui.prompt("F", "Use")
	if prompt_icon.visible or not (ui.get(&"_prompt_key") as Label).visible:
		return _fail("the prompt kept the picture when given a letter")
	ui.prompt()
	await _wait(0.3)
	if prompt.visible:
		return _fail("the prompt stayed")

	# 8. The hurt flash reddens the screen's edges and not its middle, and dies away.
	var calm := await _picture("calm.png")
	ui.hurt(1.0)
	await get_tree().process_frame
	await get_tree().process_frame
	var hurt := await _picture("hurt.png")
	var corner := Vector2i(20, hurt.get_height() - 20)
	var middle := hurt.get_size() / 2
	if hurt.get_pixelv(corner).r < calm.get_pixelv(corner).r + 0.25 or absf(hurt.get_pixelv(middle).r - calm.get_pixelv(middle).r) > 0.08:
		return _fail("hurt: the corner went from %s to %s, the middle from %s to %s" % [calm.get_pixelv(corner), hurt.get_pixelv(corner), calm.get_pixelv(middle), hurt.get_pixelv(middle)])
	await _wait(1.3)
	if (ui.get(&"_hurt") as Control).visible:
		return _fail("the hurt flash stayed")

	# 9. Fades cover the screen and uncover it.
	await ui.fade(Color.BLACK, 0.1).finished
	var covered := await _picture("covered.png")
	if covered.get_pixelv(middle).get_luminance() > 0.02:
		return _fail("a fade to black left %s in the middle" % [covered.get_pixelv(middle)])
	await ui.clear(0.1).finished
	await get_tree().process_frame
	var shown := await _picture("uncovered.png")
	if shown.get_pixelv(middle).g < 0.15:
		return _fail("after clear() the middle shows %s" % [shown.get_pixelv(middle)])

	# 10. A menu opens in the middle over a dimmed game, takes the focus, and shows the mouse pointer that the game
	# captured. A menu opened from it takes the focus unless the game gives it to one of its controls, and gives it
	# back to its button when it closes unless the game gives it elsewhere; the last one closed gives the focus and
	# the captured pointer back to the game. A menu that gives way to another in one go leaves the pointer shown, and
	# a scene changed to after the last close, as a title screen, keeps the pointer as it is.
	var playing := Button.new()
	playing.text = "Map"
	layer.add_child(playing)
	playing.grab_focus()
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	var menu := PanelContainer.new()
	var choices := VBoxContainer.new()
	menu.add_child(choices)
	var start := Button.new()
	start.text = "Resume"
	choices.add_child(start)
	var options := Button.new()
	options.text = "Options"
	choices.add_child(options)
	ui.open(menu)
	await _wait(0.3)
	var dimmed := await _picture("menu.png")
	var menu_middle := menu.get_global_rect().get_center()
	if (dimmed.get_pixelv(corner).g > shown.get_pixelv(corner).g * 0.7 or menu_middle.distance_to(Vector2(middle)) > 20.0
			or get_viewport().gui_get_focus_owner() != start or Input.mouse_mode != Input.MOUSE_MODE_VISIBLE):
		return _fail("menu: the corner shows %s (before %s), the menu's middle is %s, focus is on %s, the mouse mode is %d" % [dimmed.get_pixelv(corner), shown.get_pixelv(corner), menu_middle, get_viewport().gui_get_focus_owner(), Input.mouse_mode])
	options.grab_focus()
	var more := PanelContainer.new()
	var audio := VBoxContainer.new()
	more.add_child(audio)
	var back := Button.new()
	back.text = "Back"
	audio.add_child(back)
	var volume := HSlider.new()
	volume.custom_minimum_size = Vector2(120, 0)
	audio.add_child(volume)
	ui.open(more)
	volume.grab_focus()
	await _frames(2)
	var chosen := get_viewport().gui_get_focus_owner()
	ui.close(more, true)
	await _frames(2)
	var given_back := get_viewport().gui_get_focus_owner()
	ui.open(more)
	await _frames(2)
	var in_more := get_viewport().gui_get_focus_owner()
	ui.close(more)
	start.grab_focus()
	await _frames(2)
	if (chosen != volume or given_back != options or in_more != back or get_viewport().gui_get_focus_owner() != start
			or Input.mouse_mode != Input.MOUSE_MODE_VISIBLE):
		return _fail("a second menu: the focus is on %s after the game chose its slider, on %s when it closed, on %s when it opened again, and on %s after the game chose Resume as it closed; the mouse mode is %d" % [chosen, given_back, in_more, get_viewport().gui_get_focus_owner(), Input.mouse_mode])
	ui.close(menu)
	await _wait(0.1)
	if is_instance_valid(menu) or (ui.get(&"_dim") as Control).visible:
		return _fail("the closed menu or its dim stayed")
	if get_viewport().gui_get_focus_owner() != playing or Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
		return _fail("after the last menu the focus is on %s and the mouse mode is %d" % [get_viewport().gui_get_focus_owner(), Input.mouse_mode])
	var pause := PanelContainer.new()
	pause.add_child(Button.new())
	ui.open(pause)
	await _frames(2)
	ui.close(pause)
	var closing := Input.mouse_mode
	var sound := PanelContainer.new()
	sound.add_child(Button.new())
	ui.open(sound)
	var between := Input.mouse_mode
	await _frames(2)
	var after := Input.mouse_mode
	ui.close(sound)
	await _frames(2)
	var resumed := Input.mouse_mode
	var last := PanelContainer.new()
	last.add_child(Button.new())
	ui.open(last)
	await _frames(2)
	var title := Node.new()
	get_tree().root.add_child(title)
	var here := get_tree().current_scene
	ui.close(last)
	get_tree().current_scene = title
	await _frames(2)
	var on_title := Input.mouse_mode
	get_tree().current_scene = here
	title.queue_free()
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	playing.queue_free()
	if (closing != Input.MOUSE_MODE_VISIBLE or between != Input.MOUSE_MODE_VISIBLE or after != Input.MOUSE_MODE_VISIBLE
			or resumed != Input.MOUSE_MODE_CAPTURED or on_title != Input.MOUSE_MODE_VISIBLE):
		return _fail("mouse modes: %d as one menu closed, %d as another opened in its place, %d after, %d once both closed, and %d on a scene changed to after the last close" % [closing, between, after, resumed, on_title])

	# 11. A menu whose first button is hidden, as a Continue with no save to continue, gives the focus to its first button
	# that shows, and ui_down moves it on; a menu closed over it gives the focus to that button again when no control had
	# the focus as it opened, and when the button that had it is hidden by then.
	var title_menu := PanelContainer.new()
	var title_rows := VBoxContainer.new()
	title_menu.add_child(title_rows)
	var continue_button := Button.new()
	continue_button.text = "Continue"
	continue_button.visible = false
	title_rows.add_child(continue_button)
	var new_game := Button.new()
	new_game.text = "New game"
	title_rows.add_child(new_game)
	var quit_button := Button.new()
	quit_button.text = "Quit"
	title_rows.add_child(quit_button)
	var focused := func() -> String:
		var owner_now := get_viewport().gui_get_focus_owner() as Button
		return owner_now.text if owner_now != null else "nothing"
	ui.open(title_menu)
	await _frames(2)
	var first_shown: String = focused.call()
	var down := InputEventAction.new()
	down.action = &"ui_down"
	down.pressed = true
	Input.parse_input_event(down)
	await _frames(2)
	var moved_on: String = focused.call()
	var let_go := down.duplicate() as InputEventAction
	let_go.pressed = false
	Input.parse_input_event(let_go)
	get_viewport().gui_release_focus()
	var over := PanelContainer.new()
	var over_button := Button.new()
	over_button.text = "Over"
	over.add_child(over_button)
	ui.open(over)
	await _frames(2)
	ui.close(over)
	await _frames(2)
	var beneath: String = focused.call()
	# The button that had the focus before a menu over it opened is hidden when that menu closes.
	quit_button.grab_focus()
	var over_again := PanelContainer.new()
	over_again.add_child(Button.new())
	ui.open(over_again)
	await _frames(2)
	quit_button.hide()
	ui.close(over_again)
	await _frames(2)
	var instead_of_hidden: String = focused.call()
	ui.close(title_menu)
	await _frames(2)
	if [first_shown, moved_on, beneath, instead_of_hidden] != ["New game", "Quit", "New game", "New game"]:
		return _fail("a menu whose first button is hidden gave the focus to %s, ui_down to %s, a menu closed over it to %s, and one closed after the button that had the focus was hidden to %s" % [first_shown, moved_on, beneath, instead_of_hidden])

	# 12. A menu of a scene, hidden there until it opens, shows while it is open; closed to be kept, it goes back to its
	# place, hidden, laid out as it was, on the Center preset, as a menu on the Full Rect preset does too, and the
	# scene's `%` names reach it again. When its scene leaves the tree, as on a change of scene, the menu goes back into
	# it, a menu made in code over it is freed, the dim goes, and the pointer that the menus showed stays shown for the
	# next scene.
	var level := Node.new()
	var first_child := Node.new()
	level.add_child(first_child)
	var pause_menu := PanelContainer.new()
	pause_menu.name = "PauseMenu"
	pause_menu.visible = false
	pause_menu.set_anchors_preset(Control.PRESET_CENTER)
	for side: Side in [SIDE_LEFT, SIDE_TOP, SIDE_RIGHT, SIDE_BOTTOM]:
		pause_menu.set_offset(side, [-100.0, -60.0, 100.0, 60.0][side])
	level.add_child(pause_menu)
	var pause_rows := VBoxContainer.new()
	pause_menu.add_child(pause_rows)
	var resume := Button.new()
	resume.name = "Resume"
	resume.text = "Resume"
	pause_rows.add_child(resume)
	level.add_child(Node.new())
	var full_menu := Control.new()
	full_menu.visible = false
	full_menu.set_anchors_preset(Control.PRESET_FULL_RECT)
	var full_box := PanelContainer.new()
	full_box.set_anchors_preset(Control.PRESET_CENTER)
	full_box.add_child(Button.new())
	full_menu.add_child(full_box)
	level.add_child(full_menu)
	for part: Node in [first_child, pause_menu, pause_rows, resume]:
		part.owner = level
	resume.unique_name_in_owner = true
	get_tree().root.add_child(level)
	var smoke_scene := get_tree().current_scene
	get_tree().current_scene = level
	var menus: Control = ui.get(&"_menus")
	var dim_sheet: Control = ui.get(&"_dim")
	var layout_of := func(control: Control) -> String:
		return "anchors %s offsets %s rect %s" % [[control.anchor_left, control.anchor_top, control.anchor_right, control.anchor_bottom], [control.offset_left, control.offset_top, control.offset_right, control.offset_bottom], control.get_rect()]
	await _frames(1)
	var laid_out := [layout_of.call(pause_menu), layout_of.call(full_menu)]
	ui.open(pause_menu)
	await _frames(2)
	var while_open := [pause_menu.is_visible_in_tree(), get_viewport().gui_get_focus_owner() == resume]
	ui.close(pause_menu, true)
	await _frames(2)
	var returned := [pause_menu.get_parent() == level, pause_menu.get_index(), pause_menu.visible, level.get_node_or_null("%Resume") == resume, dim_sheet.visible]
	ui.open(full_menu)
	await _frames(2)
	ui.close(full_menu, true)
	await _frames(2)
	var laid_out_again := [layout_of.call(pause_menu), layout_of.call(full_menu)]
	if laid_out_again != laid_out:
		get_tree().current_scene = smoke_scene
		level.free()
		return _fail("menus of a scene kept and closed are laid out as %s, not as before, %s" % [laid_out_again, laid_out])
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	ui.open(pause_menu)
	var options_menu := PanelContainer.new()
	options_menu.add_child(Button.new())
	ui.open(options_menu)
	await _frames(2)
	get_tree().root.remove_child(level)
	await _frames(2)
	var scene_left := [pause_menu.get_parent() == level, pause_menu.visible, is_instance_valid(options_menu), menus.get_child_count(), dim_sheet.visible, Input.mouse_mode]
	get_tree().current_scene = smoke_scene
	level.free()
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	if while_open != [true, true] or returned != [true, 1, false, true, false] or scene_left != [true, false, false, 0, false, Input.MOUSE_MODE_VISIBLE]:
		return _fail("a menu of a scene: while open %s, kept and closed %s, after its scene left %s" % [while_open, returned, scene_left])

	# 13. A label placed in a corner reads over the game; the crosshair and the radar draw without an error.
	var score := Label.new()
	score.text = "Score 10"
	ui.place(score, CORNER_BOTTOM_RIGHT)
	var crosshair := WasdCrosshair.new()
	layer.add_child(crosshair)
	crosshair.spread = 4.0
	crosshair.hit(true)
	var radar := WasdRadar.new()
	radar.center = camera
	ui.place(radar, CORNER_TOP_RIGHT)
	radar.track(marker, Color.RED, true)
	await _wait(0.3)
	var hud := await _picture("hud.png")
	var radar_middle := Vector2i(radar.get_global_rect().get_center())
	if score.theme_type_variation != &"HudLabel" or score.get_global_rect().end.x > hud.get_width() or hud.get_pixelv(radar_middle).is_equal_approx(shown.get_pixelv(radar_middle)):
		return _fail("the score is a %s ending at %f; the radar's middle shows %s" % [score.theme_type_variation, score.get_global_rect().end.x, hud.get_pixelv(radar_middle)])
	radar.untrack(marker)
	# The radar turns with a center that turns only its model, as a WasdCharacter3D does, and with its camera rig: a
	# goal to the east shows ahead, at the top, while the model faces east, and at the left once the rig looks south.
	var walker := GDScript.new()
	walker.source_code = "extends Node3D\nvar model: Node3D\nvar model_turn := 180.0\nvar camera_rig: Node3D\n"
	walker.reload()
	var hero: Node3D = walker.new()
	var body := Node3D.new()
	hero.add_child(body)
	hero.set(&"model", body)
	add_child(hero)
	# A model that faces -Z, turned by `model_turn` on top of facing east.
	body.rotation.y = PI * 1.5
	var goal := Node3D.new()
	goal.position = Vector3(20, 0, 0)
	add_child(goal)
	radar.center = hero
	radar.track(goal, Color(1, 0, 1), true)
	await _frames(2)
	var ahead := await _picture("radar_ahead.png")
	var rig := Node3D.new()
	add_child(rig)
	rig.rotation.y = PI
	hero.set(&"camera_rig", rig)
	await _frames(2)
	var aside := await _picture("radar_aside.png")
	var disc := radar.get_global_rect()
	var halfway := (minf(disc.size.x, disc.size.y) * 0.5 - 2.0 - 4.0 * ui.get_ui_scale()) * 0.5
	var top := ahead.get_pixelv(Vector2i(disc.get_center() + Vector2(0, -halfway)))
	var left := aside.get_pixelv(Vector2i(disc.get_center() + Vector2(-halfway, 0)))
	if top.r < 0.8 or top.g > 0.3 or top.b < 0.8 or left.r < 0.8 or left.g > 0.3 or left.b < 0.8:
		return _fail("a goal east of a center whose model faces east shows %s at the radar's top; with its camera rig looking south, %s at its left" % [top, left])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
