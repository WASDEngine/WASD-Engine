extends Node3D
## WASD UI smoke test (render run on the Compatibility renderer, the one every Web build uses): the autoload puts a
## look on Godot's own controls wherever they stand, changes it by name, takes an accent and a scale, and gives
## Godot's own back; a bar glides, shows on screen, and tells when it is empty; toasts come and go; numbers rise
## from places before the camera and not from behind it; the prompt, the hurt flash, the fades, and a menu over a
## dimmed game show and leave; a label placed in a corner reads over the game; the crosshair and the radar draw.

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


func _picture(file: String) -> Image:
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


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

	# 2. An accent of the game's own, and a scale.
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
	button.queue_free()

	# 3. A bar: it shows in its corner in its color, glides to a new value, and tells when it is empty.
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

	# 4. Toasts come and go, four at the most.
	var toasts: Node = ui.get(&"_toasts")
	for index: int in 6:
		ui.toast("Message %d" % [index], {"seconds": 0.2})
	if toasts.get_child_count() != 4:
		return _fail("six toasts left %d on screen" % [toasts.get_child_count()])
	await _wait(1.0)
	if toasts.get_child_count() != 0:
		return _fail("%d toasts stayed" % [toasts.get_child_count()])

	# 5. Numbers rise from places before the camera, in 3D and in 2D, and not from behind it.
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

	# 6. The prompt shows a key and a word, and leaves.
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

	# 7. The hurt flash reddens the screen's edges and not its middle, and dies away.
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

	# 8. Fades cover the screen and uncover it.
	await ui.fade(Color.BLACK, 0.1).finished
	var covered := await _picture("covered.png")
	if covered.get_pixelv(middle).get_luminance() > 0.02:
		return _fail("a fade to black left %s in the middle" % [covered.get_pixelv(middle)])
	await ui.clear(0.1).finished
	await get_tree().process_frame
	var shown := await _picture("uncovered.png")
	if shown.get_pixelv(middle).g < 0.15:
		return _fail("after clear() the middle shows %s" % [shown.get_pixelv(middle)])

	# 9. A menu opens in the middle over a dimmed game, takes the focus, and closes.
	var menu := PanelContainer.new()
	var start := Button.new()
	start.text = "Resume"
	menu.add_child(start)
	ui.open(menu)
	await _wait(0.3)
	var dimmed := await _picture("menu.png")
	var menu_middle := menu.get_global_rect().get_center()
	if (dimmed.get_pixelv(corner).g > shown.get_pixelv(corner).g * 0.7 or menu_middle.distance_to(Vector2(middle)) > 20.0
			or get_viewport().gui_get_focus_owner() != start):
		return _fail("menu: the corner shows %s (before %s), the menu's middle is %s, focus is on %s" % [dimmed.get_pixelv(corner), shown.get_pixelv(corner), menu_middle, get_viewport().gui_get_focus_owner()])
	ui.close(menu)
	await _wait(0.1)
	if is_instance_valid(menu) or (ui.get(&"_dim") as Control).visible:
		return _fail("the closed menu or its dim stayed")

	# 10. A label placed in a corner reads over the game; the crosshair and the radar draw without an error.
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
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
