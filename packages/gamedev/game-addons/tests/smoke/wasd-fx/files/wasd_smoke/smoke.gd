extends Node3D
## WASD FX smoke test (render run on the Compatibility renderer, the one every Web build uses): the autoload plays
## an effect by name where it is told, a burst lights the picture and is gone when it is over, the same node plays
## it again without the connections of its last play, a layer that lies flat on the ground draws, a direction, a
## size, a color, and a parent do what they say, a running effect runs until it is stopped, smoke is as bright as the
## scene's light level and is drawn as far as a rising wind carries it, a flash, an outline, and a dissolve on a
## thing undo each other in any order, keep off a blob shadow of WASD Decals, and take a sheet of WASD Cloth like any
## mesh, the wet cover of WASD Weather waits under them and goes with the weather, as the weather's wind does, and
## every effect plays without an error.

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
	# A node used again starts without the connections made for its last play: the same callable connects again
	# without an error, and hears only the plays it was connected for.
	var heard := [0]
	var hear := func() -> void: heard[0] += 1
	var first := fx.play("zap", Vector3(0, 2, 0), {"scale": 0.1})
	first.finished.connect(hear)
	await _wait(0.5)
	var second := fx.play("zap", Vector3(0, 2, 0), {"scale": 0.1})
	second.finished.connect(hear)
	await _wait(0.5)
	fx.play("zap", Vector3(0, 2, 0), {"scale": 0.1})
	await _wait(0.5)
	if second != first or heard[0] != 2:
		return _fail("a zap's node was used again %s, and its connection heard %d plays of 2" % [second == first, heard[0]])

	# 1b. A layer that lies flat on the ground draws by itself: the shockwave's ring, with its dust hidden.
	var wave := fx.play("shockwave", Vector3(0, 0, 4))
	var waves: Array = WasdFxEffects.EFFECTS["shockwave"]["layers"]
	for index: int in waves.size():
		(wave.get_child(index) as Node3D).visible = bool((waves[index] as Dictionary).get("lies_flat", false))
	await _wait(0.15)
	var ring := _changed(await _picture("shockwave_ring.png"), before, whole)
	for index: int in waves.size():
		(wave.get_child(index) as Node3D).visible = true
	if ring["count"] < 150:
		return _fail("the shockwave's ring alone changed %d samples" % [ring["count"]])
	await _wait(0.6)

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

	# 6. The wind carries smoke along and leaves a burst's light where it is; smoke that runs on as the wind rises is
	# drawn as far as the wind carries it.
	var leans: Array[float] = []
	for wind: Vector3 in [Vector3.ZERO, Vector3(6, 0, 0)]:
		fx.set_wind(wind)
		var smoke := fx.play("smoke", Vector3(0, 0, 0), {"scale": 1.5})
		await _wait(2.0)
		leans.append((_changed(await _picture("smoke_wind_%s.png" % [wind.x]), before, whole)["middle"] as Vector2).x)
		smoke.stop(0.05)
		await _wait(0.3)
	if not fx.is_in_group(&"wasd_wind") or leans[1] < leans[0] + whole.size.x * 0.04:
		return _fail("smoke stands at x %f in still air and at %f in a wind toward +X" % [leans[0], leans[1]])
	fx.set_wind(Vector3.ZERO)
	var column := fx.play("smoke", Vector3(0, 0, 0))
	var still := (column.get_child(0) as MultiMeshInstance3D).custom_aabb
	fx.set_wind(Vector3(6, 0, 0))
	await get_tree().process_frame
	await get_tree().process_frame
	var blown := (column.get_child(0) as MultiMeshInstance3D).custom_aabb
	fx.set_wind(Vector3.ZERO)
	column.stop(0.05)
	if blown.size.x < still.size.x + 2.0 * 6.0 * 4.0:
		return _fail("a running smoke is drawn within %s in still air and %s in a wind of 6 m/s" % [still.size, blown.size])
	await _wait(0.3)

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
	# An outline that is cleared while a flash shows over it is gone once the flash is over; one that is not comes back.
	fx.outline(thing)
	fx.flash(thing, Color.WHITE, 0.15)
	fx.clear_outline(thing)
	await _wait(0.3)
	var cleared := thing.material_overlay
	fx.outline(thing)
	var line := thing.material_overlay
	fx.flash(thing, Color.WHITE, 0.15)
	await _wait(0.3)
	var kept := thing.material_overlay
	fx.clear_outline(thing)
	if cleared != null or line == null or kept != line or thing.material_overlay != null:
		return _fail("outline and flash: cleared during the flash %s, kept through it %s of %s, cleared after %s" % [cleared, kept, line, thing.material_overlay])
	# A teleport: an appear before the dissolve is over takes over, and the thing ends seen in its own material.
	fx.dissolve(thing, 0.3)
	await _wait(0.1)
	await fx.appear(thing, 0.3)
	await _wait(0.3)
	if not thing.visible or thing.material_override != paint or thing.get_surface_override_material(0) != null:
		return _fail("after a dissolve and an appear before its end, the thing is visible %s and wears %s and %s" % [thing.visible, thing.material_override, thing.get_surface_override_material(0)])
	# What another hand put over the thing, such as the weather's wet cover, is off while it dissolves and back after.
	var cover := StandardMaterial3D.new()
	thing.material_overlay = cover
	fx.dissolve(thing, 0.2)
	var dissolving := thing.material_overlay
	await _wait(0.3)
	if dissolving != null or thing.material_overlay != cover:
		return _fail("a covered thing has %s over it while it dissolves and %s after" % [dissolving, thing.material_overlay])
	thing.queue_free()
	# A blob shadow of WASD Decals under a body is the pack's own drawing: the effects on the body leave it alone.
	var body := Node3D.new()
	var looks := MeshInstance3D.new()
	looks.mesh = CapsuleMesh.new()
	body.add_child(looks)
	var shadow := WasdBlobShadow3D.new()
	body.add_child(shadow)
	body.position = Vector3(0, 1, 0)
	add_child(body)
	fx.flash(body, Color.WHITE, 0.2)
	fx.outline(body)
	var over_shadow := shadow.material_overlay
	fx.clear_outline(body)
	fx.dissolve(body, 0.2)
	var worn_by_shadow := shadow.get_surface_override_material(0)
	await _wait(0.3)
	if looks.material_overlay != null or over_shadow != null or worn_by_shadow != null:
		return _fail("the blob shadow had %s over it and wore %s; the body has %s over it" % [over_shadow, worn_by_shadow, looks.material_overlay])
	body.queue_free()
	# A sheet of WASD Cloth, a banner, is drawn with the game's own material: the effects take it like any mesh.
	var banner := WasdClothSheet3D.new()
	banner.position = Vector3(-6, 3, 0)
	add_child(banner)
	await get_tree().process_frame
	fx.flash(banner, Color.WHITE, 0.15)
	var flashed_banner := banner.material_overlay
	fx.outline(banner)
	await _wait(0.3)
	var outlined_banner := banner.material_overlay
	fx.clear_outline(banner)
	if flashed_banner == null or outlined_banner == null or outlined_banner == flashed_banner or banner.material_overlay != null:
		return _fail("a cloth banner had %s over it in a flash, %s with an outline, and %s once cleared" % [flashed_banner, outlined_banner, banner.material_overlay])
	banner.queue_free()
	# The wet cover of WASD Weather waits under an outline and a flash, comes and goes under them with the rain, and
	# goes with the weather, as the weather's wind does.
	var weather := WasdWeather3D.new()
	weather.change_seconds = 0.0
	add_child(weather)
	var crate := MeshInstance3D.new()
	crate.mesh = SphereMesh.new()
	crate.position = Vector3(5, 1, 0)
	add_child(crate)
	weather.cover(crate)
	weather.wetness = 1.0
	await get_tree().process_frame
	await get_tree().process_frame
	var wet := crate.material_overlay
	var blowing := fx.wind
	fx.outline(crate)
	var wet_lined := crate.material_overlay
	weather.wetness = 0.0
	await get_tree().process_frame
	await get_tree().process_frame
	var lined_dry := crate.material_overlay
	fx.clear_outline(crate)
	var dried := crate.material_overlay
	weather.wetness = 1.0
	await get_tree().process_frame
	await get_tree().process_frame
	fx.flash(crate, Color.WHITE, 0.1)
	await _wait(0.25)
	var flashed_wet := crate.material_overlay
	fx.outline(crate)
	var lined_wet := crate.material_overlay
	weather.queue_free()
	await get_tree().process_frame
	var lined_left := crate.material_overlay
	fx.clear_outline(crate)
	if wet == null or wet_lined == wet or lined_dry != wet_lined or dried != null or flashed_wet != wet or lined_left != lined_wet or crate.material_overlay != null:
		return _fail("cover and effects: wet %s, outlined %s, dried under the outline %s, cleared %s, after a flash %s, outlined as the weather left %s, cleared %s" % [wet, wet_lined, lined_dry, dried, flashed_wet, lined_left, crate.material_overlay])
	if blowing == Vector3.ZERO or fx.wind != Vector3.ZERO:
		return _fail("WasdFx had the wind %s with the weather and %s once it left" % [blowing, fx.wind])
	crate.queue_free()

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
