extends Node3D
## WASD FX smoke test (render run on the Compatibility renderer, the one every Web build uses): the autoload plays
## an effect by name where it is told, a burst lights the picture and is gone when it is over, the same node plays
## it again, a direction, a size, a color, and a parent do what they say, a running effect runs until it is
## stopped, smoke is as bright as the scene's light level, and every effect plays without an error.

const ID := "wasd-fx"

var camera: Camera3D


func _ready() -> void:
	get_tree().create_timer(80.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _picture(file: String) -> Image:
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


func _wait(seconds: float) -> void:
	await get_tree().create_timer(seconds).timeout


## How many sampled pixels of a part of the picture differ from the same pixels of another picture, and where their
## middle lies, in pixels.
func _changed(now: Image, before: Image, part: Rect2i) -> Dictionary:
	var count := 0
	var middle := Vector2.ZERO
	var redder := 0.0
	for y: int in range(part.position.y, part.end.y, 2):
		for x: int in range(part.position.x, part.end.x, 2):
			var a := now.get_pixel(x, y)
			var b := before.get_pixel(x, y)
			if absf(a.r - b.r) + absf(a.g - b.g) + absf(a.b - b.b) > 0.09:
				count += 1
				middle += Vector2(x, y)
				redder += a.r - a.b
	return {"count": count, "middle": middle / maxf(count, 1.0), "redder": redder / maxf(count, 1.0)}


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var fx: WasdFxLibrary = get_node_or_null("/root/WasdFx")
	if fx == null:
		return _fail("the installation added no autoload named WasdFx")
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.2, 0.22, 0.25)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color(0.4, 0.4, 0.4)
	add_child(world)
	camera = Camera3D.new()
	camera.position = Vector3(0, 2, 12)
	add_child(camera)
	var ground := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(60, 60)
	ground.mesh = plane
	add_child(ground)
	await _wait(0.2)
	var whole := Rect2i(Vector2i.ZERO, get_viewport().get_texture().get_size())
	var before := await _picture("before.png")

	# 1. A burst shows where it is played, is over by itself, and its node is used again.
	if fx.names().size() < 18 or fx.play("no such effect", Vector3.ZERO) != null:
		return _fail("names() has %d effects, or an unknown name still played" % [fx.names().size()])
	var at := Vector3(-3, 0, 0)
	var burst := fx.play("explosion", at)
	var over := [false]
	burst.finished.connect(func() -> void: over[0] = true)
	await _wait(0.12)
	var flash := await _picture("explosion.png")
	var lit := _changed(flash, before, whole)
	var expected := camera.unproject_position(at) * Vector2(whole.size) / get_viewport().get_visible_rect().size
	if lit["count"] < 400 or (lit["middle"] as Vector2).distance_to(expected) > whole.size.x * 0.2:
		return _fail("the explosion changed %d samples round %s; it was played at %s" % [lit["count"], lit["middle"], expected])
	await _wait(3.4)
	var after := await _picture("after.png")
	if not over[0] or burst.visible or _changed(after, before, whole)["count"] > 20:
		return _fail("after the explosion: finished %s, visible %s, %d samples still differ" % [over[0], burst.visible, _changed(after, before, whole)["count"]])
	if fx.play("explosion", at, {"scale": 0.01}) != burst:
		return _fail("a second explosion did not use the first one's node again")
	await _wait(0.3)

	# 2. A direction turns an effect, and a scale makes it larger.
	fx.gravity = Vector3.ZERO
	fx.play("sparks", Vector3(0, 2, 0), {"normal": Vector3.RIGHT, "scale": 4.0})
	await _wait(0.2)
	var sideways := _changed(await _picture("sparks_right.png"), before, whole)
	var origin := camera.unproject_position(Vector3(0, 2, 0)) * Vector2(whole.size) / get_viewport().get_visible_rect().size
	if sideways["count"] < 8 or (sideways["middle"] as Vector2).x < origin.x + 4.0:
		return _fail("sparks along +X changed %d samples round %s; they began at %s" % [sideways["count"], sideways["middle"], origin])
	fx.gravity = Vector3(0, -9.8, 0)
	await _wait(1.0)
	var sizes: Array[int] = []
	for size: float in [1.0, 2.5]:
		fx.play("poof", Vector3(0, 2, 0), {"scale": size})
		await _wait(0.35)
		sizes.append(_changed(await _picture("poof_%s.png" % [size]), before, whole)["count"])
		await _wait(1.0)
	if sizes[1] < sizes[0] * 2:
		return _fail("a poof of scale 2.5 changed %d samples, one of scale 1 %d" % [sizes[1], sizes[0]])

	# 3. A color tints an effect, and a parent carries it along.
	fx.play("magic", Vector3(0, 2, 0), {"color": Color(1.0, 0.1, 0.1)})
	await _wait(0.12)
	var red := _changed(await _picture("magic_red.png"), before, whole)
	if red["count"] < 50 or red["redder"] < 0.1:
		return _fail("a red magic burst changed %d samples that are redder than blue by %f" % [red["count"], red["redder"]])
	await _wait(1.2)
	var carrier := Node3D.new()
	add_child(carrier)
	var carried := fx.play("muzzle_flash", Vector3(1, 2, 0), {"parent": carrier, "normal": Vector3.FORWARD})
	carrier.position = Vector3(2, 0, 0)
	if carried.get_parent() != carrier or not carried.global_position.is_equal_approx(Vector3(3, 2, 0)):
		return _fail("an effect with a parent is at %s under %s" % [carried.global_position, carried.get_parent()])
	await _wait(0.8)

	# 4. A running effect runs until it is stopped.
	var fire := fx.play("fire", Vector3(3, 0, 0))
	await _wait(1.3)
	var burning := _changed(await _picture("fire.png"), before, whole)
	if not fire.looping or not fire.visible or burning["count"] < 60:
		return _fail("after 1.3 seconds the fire is looping %s, visible %s, and changes %d samples" % [fire.looping, fire.visible, burning["count"]])
	var out := [false]
	fire.finished.connect(func() -> void: out[0] = true)
	fire.stop(0.2)
	await _wait(0.6)
	if not out[0] or _changed(await _picture("fire_out.png"), before, whole)["count"] > 20:
		return _fail("a stopped fire is finished %s and still changes the picture" % [out[0]])

	# 5. Smoke is as bright as the scene's light level says.
	var shades: Array[float] = []
	for level: float in [1.0, 0.1]:
		fx.light_level = level
		fx.play("smoke", Vector3(0, 0, 0), {"scale": 1.5})
		await _wait(2.2)
		var smoky := await _picture("smoke_%s.png" % [level])
		var place := Vector2i(camera.unproject_position(Vector3(0, 2.2, 0)) * Vector2(whole.size) / get_viewport().get_visible_rect().size)
		shades.append(smoky.get_pixelv(place).get_luminance())
		for node: Node in fx.get_children():
			if node is WasdFxInstance3D and (node as WasdFxInstance3D).effect == "smoke":
				(node as WasdFxInstance3D).stop(0.05)
		await _wait(0.3)
	if shades[0] < shades[1] + 0.03:
		return _fail("smoke shows %f at light level 1 and %f at 0.1" % [shades[0], shades[1]])
	fx.light_level = -1.0

	# 6. The wind carries smoke along and leaves a burst's light where it is.
	var leans: Array[float] = []
	for wind: Vector3 in [Vector3.ZERO, Vector3(6, 0, 0)]:
		fx.set_wind(wind)
		var smoke := fx.play("smoke", Vector3(0, 0, 0), {"scale": 1.5})
		await _wait(2.0)
		leans.append((_changed(await _picture("smoke_wind_%s.png" % [wind.x]), before, whole)["middle"] as Vector2).x)
		smoke.stop(0.05)
		await _wait(0.3)
	fx.set_wind(Vector3.ZERO)
	if not fx.is_in_group(&"wasd_wind") or leans[1] < leans[0] + whole.size.x * 0.04:
		return _fail("smoke stands at x %f in still air and at %f in a wind toward +X" % [leans[0], leans[1]])

	# 7. Effects on things: a flash whitens a thing and then gives it back as it was, an outline stays until it is
	# cleared, a dissolve hides the thing at its end, and appear() brings it back in its own material.
	var thing := MeshInstance3D.new()
	var ball := SphereMesh.new()
	ball.radius = 1.0
	ball.height = 2.0
	var paint := StandardMaterial3D.new()
	paint.albedo_color = Color(0.8, 0.1, 0.1)
	thing.mesh = ball
	thing.material_override = paint
	thing.position = Vector3(-5, 4, 2)
	add_child(thing)
	await _wait(0.3)
	var at_thing := Vector2i(camera.unproject_position(thing.position) * Vector2(whole.size) / get_viewport().get_visible_rect().size)
	var plain := (await _picture("thing.png")).get_pixelv(at_thing)
	fx.flash(thing, Color.WHITE, 0.4)
	await get_tree().process_frame
	await get_tree().process_frame
	var flashed := (await _picture("thing_flash.png")).get_pixelv(at_thing)
	if plain.r < plain.g * 2.0 or flashed.g < plain.g + 0.3 or thing.material_overlay == null:
		return _fail("the thing shows %s and in a flash %s, with %s over it" % [plain, flashed, thing.material_overlay])
	await _wait(0.6)
	if thing.material_overlay != null:
		return _fail("the flash stayed on the thing")
	fx.outline(thing, Color(0.0, 1.0, 0.0), 6.0)
	await _wait(0.2)
	var lined := await _picture("thing_outline.png")
	var green := 0
	for y: int in range(maxi(at_thing.y - 90, 0), mini(at_thing.y + 90, whole.size.y)):
		for x: int in range(maxi(at_thing.x - 90, 0), mini(at_thing.x + 90, whole.size.x)):
			var pixel := lined.get_pixel(x, y)
			if pixel.g > 0.7 and pixel.r < 0.4 and pixel.b < 0.4:
				green += 1
	fx.clear_outline(thing)
	if green < 30 or thing.material_overlay != null:
		return _fail("the outline drew %d green pixels; cleared, the thing has %s over it" % [green, thing.material_overlay])
	await fx.dissolve(thing, 0.4)
	if thing.visible or thing.material_override != paint or thing.get_surface_override_material(0) != null:
		return _fail("dissolved, the thing is visible %s and wears %s" % [thing.visible, thing.material_override])
	await fx.appear(thing, 0.3)
	await get_tree().process_frame
	var back := (await _picture("thing_back.png")).get_pixelv(at_thing)
	if not thing.visible or thing.material_override != paint or back.r < back.g * 2.0:
		return _fail("after appear() the thing is visible %s and shows %s" % [thing.visible, back])
	thing.queue_free()

	# 8. Every effect plays, and the warm-up runs.
	for name: String in fx.names():
		var playing := fx.play(name, Vector3(0, 1, 0), {"scale": 0.5})
		if playing == null:
			return _fail("%s did not play" % [name])
		await get_tree().process_frame
		if playing.looping:
			playing.stop(0.05)
	await fx.warm_up()
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
