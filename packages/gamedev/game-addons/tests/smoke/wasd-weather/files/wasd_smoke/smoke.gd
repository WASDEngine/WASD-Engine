extends Node3D
## WASD Weather smoke test (render run on the Compatibility renderer, the one every Web build uses): rain and snow
## show in the air and stop under a roof, a weather comes over the seconds it is given, rain wets and snow covers
## what the node was told to cover and nothing else, a character's model and CSG shapes too but no see-through CSG
## shape, a mesh that comes and goes in one frame leaves no error, what stands beyond the middle of covered ground,
## such as a fire, shows over the snow and the wet, and WASD Decals' marks show on the snow, the cover comes off when
## things are dry, lightning flashes and dies away, also at once when the game pauses or the weather leaves, the sky,
## the fog, and the wind are handed to the nodes that ask for them, also to one that asks later, and the weather takes
## back all it gave when it leaves: the sky, the fog, the wind, and the cover, while a material of the game's own over
## a mesh is never covered over, and the cover comes back once the game takes it off, unless the mesh is to stay bare
## by then. The weather's own cards and light are children that a walk through the scene does not reach.

const ID := "wasd-weather"

## Stands in for a WASD Look node: the weather finds it by its group and sets these.
class Look extends Node:
	var overcast := 0.0
	var added_fog := 0.0

	func get_light_level() -> float:
		return 1.0

## Stands in for anything that takes the wind.
class Vane extends Node:
	var wind := Vector3.ZERO

	func set_wind(value: Vector3) -> void:
		wind = value

## Stands in for SimpleGrassTextured's autoload, whose wind the weather sets and gives back.
class Grass extends Node:
	var wind_direction := Vector3(0, 0, 1)
	var wind_strength := 0.15

	func set_wind_direction(value: Vector3) -> void:
		wind_direction = value

	func set_wind_strength(value: float) -> void:
		wind_strength = value

var camera: Camera3D


func _ready() -> void:
	get_tree().create_timer(90.0).timeout.connect(func() -> void: _fail("timed out"))
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


## How many sampled pixels of two pictures differ.
func _changed(now: Image, before: Image) -> int:
	var count := 0
	for y: int in range(0, now.get_height(), 2):
		for x: int in range(0, now.get_width(), 2):
			var a := now.get_pixel(x, y)
			var b := before.get_pixel(x, y)
			if absf(a.r - b.r) + absf(a.g - b.g) + absf(a.b - b.b) > 0.09:
				count += 1
	return count


## The mean color of the picture round a place in the world.
func _color(image: Image, place: Vector3) -> Color:
	var at := Vector2i(camera.unproject_position(place) * Vector2(image.get_size()) / get_viewport().get_visible_rect().size)
	var total := Color(0, 0, 0, 0)
	for y: int in range(at.y - 4, at.y + 5):
		for x: int in range(at.x - 4, at.x + 5):
			total += image.get_pixel(x, y)
	return total / 81.0


## The brightness of the picture round a place in the world.
func _shade(image: Image, place: Vector3) -> float:
	var at := Vector2i(camera.unproject_position(place) * Vector2(image.get_size()) / get_viewport().get_visible_rect().size)
	var total := 0.0
	for y: int in range(at.y - 4, at.y + 5):
		for x: int in range(at.x - 4, at.x + 5):
			total += image.get_pixel(x, y).get_luminance()
	return total / 81.0


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var grass := Grass.new()
	grass.name = "SimpleGrass"
	get_tree().root.add_child.call_deferred(grass)
	await get_tree().process_frame
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.2, 0.22, 0.25)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color(0.4, 0.4, 0.4)
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55, 30, 0)
	sun.light_energy = 0.8
	add_child(sun)
	camera = Camera3D.new()
	camera.position = Vector3(0, 4, 12)
	camera.rotation_degrees = Vector3(-14, 0, 0)
	add_child(camera)
	var look := Look.new()
	look.add_to_group(&"wasd_look")
	add_child(look)
	var vane := Vane.new()
	vane.add_to_group(&"wasd_wind")
	add_child(vane)
	# A level: gray ground and a crate; beside it a pane of glass, a marked statue, and a rock outside the level.
	var gray := StandardMaterial3D.new()
	gray.albedo_color = Color(0.5, 0.5, 0.5)
	var level := Node3D.new()
	add_child(level)
	var ground := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(60, 60)
	plane.material = gray
	ground.mesh = plane
	level.add_child(ground)
	var crate := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = Vector3(2, 2, 2)
	box.material = gray
	crate.mesh = box
	crate.position = Vector3(0, 1, 0)
	level.add_child(crate)
	var glass := MeshInstance3D.new()
	var pane := BoxMesh.new()
	pane.size = Vector3(1, 1, 1)
	var clear := StandardMaterial3D.new()
	clear.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	clear.albedo_color = Color(0.6, 0.8, 1.0, 0.3)
	pane.material = clear
	glass.mesh = pane
	glass.position = Vector3(-4, 0.5, 0)
	level.add_child(glass)
	var statue := MeshInstance3D.new()
	statue.mesh = box
	statue.position = Vector3(4, 1, 0)
	statue.add_to_group(WasdWeather3D.BARE_GROUP)
	level.add_child(statue)
	# A tree whose second surface is a cut-out leaf card, drawn by a shader that writes ALPHA, as WASD Materials' are.
	var tree_mesh := ArrayMesh.new()
	tree_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, box.get_mesh_arrays())
	tree_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, QuadMesh.new().get_mesh_arrays())
	tree_mesh.surface_set_material(0, gray)
	var cut := ShaderMaterial.new()
	cut.shader = Shader.new()
	cut.shader.code = "shader_type spatial;\nvoid fragment() {\n\tALBEDO = vec3(0.2, 0.5, 0.2);\n\tALPHA = step(0.5, fract(UV.x * 4.0));\n\tALPHA_SCISSOR_THRESHOLD = 0.5;\n}\n"
	tree_mesh.surface_set_material(1, cut)
	var tree := MeshInstance3D.new()
	tree.mesh = tree_mesh
	tree.position = Vector3(-8, 1, 0)
	level.add_child(tree)
	var rock := MeshInstance3D.new()
	rock.mesh = box
	rock.position = Vector3(8, 1, -4)
	add_child(rock)
	# CSG shapes take the cover, unless they are see-through.
	var block := CSGBox3D.new()
	block.material = gray
	block.position = Vector3(5, 0.5, 5)
	level.add_child(block)
	var window := CSGBox3D.new()
	window.material = clear
	window.position = Vector3(-5, 0.5, 5)
	level.add_child(window)

	var weather := WasdWeather3D.new()
	weather.change_seconds = 0.0
	weather.wind_heading = 90.0
	add_child(weather)
	weather.cover(level)
	await _wait(0.3)
	var before := await _picture("clear.png")

	# 1. The weathers by name; an unknown one is clear weather.
	var heard: Array[String] = []
	weather.weather_changed.connect(func(now: String) -> void: heard.append(now))
	if WasdWeather3D.names().size() != 8 or not WasdWeather3D.names().has("blizzard"):
		return _fail("names() is %s" % [WasdWeather3D.names()])
	weather.weather = "sharknado"
	if weather.weather != "clear" or weather.get_rain() != 0.0:
		return _fail("an unknown weather gave %s with rain %f" % [weather.weather, weather.get_rain()])

	# 2. Rain shows in the air, and not under a roof.
	weather.weather = "rain"
	await _wait(0.3)
	var rain := _changed(await _picture("rain.png"), before)
	if heard != ["clear", "rain"] or rain < 200 or weather.get_rain() < 0.69:
		return _fail("rain changed %d samples at %f; the signal said %s" % [rain, weather.get_rain(), heard])
	weather.sheltered = true
	weather.wetness = 0.0
	await _wait(0.2)
	var roofed := _changed(await _picture("rain_sheltered.png"), before)
	if roofed > 40:
		return _fail("under a roof the rain still changed %d samples" % [roofed])
	weather.sheltered = false

	# 3. Snow shows too.
	weather.weather = "blizzard"
	weather.wetness = 0.0
	await _wait(0.3)
	var snowing := await _picture("blizzard.png")
	weather.snow_cover = 0.0
	if _changed(snowing, before) < 200 or weather.get_snow() != 1.0:
		return _fail("a blizzard changed %d samples at %f" % [_changed(snowing, before), weather.get_snow()])

	# 4. A weather comes over the seconds it is given.
	weather.weather = "clear"
	weather.fade_to("snow", 0.6)
	await _wait(0.3)
	var halfway := weather.get_snow()
	await _wait(0.5)
	if halfway <= 0.02 or halfway >= 0.58 or not is_equal_approx(weather.get_snow(), 0.6) or weather.change_seconds != 0.0:
		return _fail("a change over 0.6 seconds was at %f after 0.3 and at %f after 0.8" % [halfway, weather.get_snow()])

	# 5. Snow settles on what faces up of what the node covers, and only there.
	weather.weather = "clear"
	weather.snow_cover = 1.0
	await _wait(0.2)
	var snowed := await _picture("snow_cover.png")
	var bare := [_shade(before, Vector3(0, 0, 5)), _shade(before, Vector3(0, 2, 0)), _shade(before, Vector3(0, 1, 1))]
	var white := [_shade(snowed, Vector3(0, 0, 5)), _shade(snowed, Vector3(0, 2, 0)), _shade(snowed, Vector3(0, 1, 1))]
	if white[0] < bare[0] + 0.12 or white[1] < bare[1] + 0.08 or absf(white[2] - bare[2]) > 0.05:
		return _fail("with snow the ground, the crate's top, and its side went from %s to %s" % [bare, white])
	if ground.material_overlay == null or glass.material_overlay != null or statue.material_overlay != null or rock.material_overlay != null or tree.material_overlay != null:
		return _fail("covered: ground %s, glass %s, marked statue %s, rock outside %s, cut-out tree %s" % [ground.material_overlay, glass.material_overlay, statue.material_overlay, rock.material_overlay, tree.material_overlay])
	if block.material_overlay == null or window.material_overlay != null:
		return _fail("covered: a CSG block %s, a see-through CSG window %s" % [block.material_overlay, window.material_overlay])
	# A mesh that comes into the level and is freed in the same frame is let go without an error.
	var fleeting := MeshInstance3D.new()
	fleeting.mesh = box
	level.add_child(fleeting)
	fleeting.free()
	await get_tree().process_frame
	# What comes into the level later is covered too, also the model of a WASD Character, which draws nothing itself.
	var late := MeshInstance3D.new()
	late.mesh = box
	late.position = Vector3(-8, 1, -4)
	level.add_child(late)
	var hero := WasdCharacter3D.new()
	hero.controlled = false
	var model := MeshInstance3D.new()
	model.mesh = CapsuleMesh.new()
	hero.add_child(model)
	hero.position = Vector3(-6, 0, 3)
	level.add_child(hero)
	await _wait(0.1)
	if late.material_overlay == null or model.material_overlay == null:
		return _fail("what came into the level later took no cover: a mesh %s, a character's model %s" % [late.material_overlay, model.material_overlay])
	late.queue_free()
	hero.queue_free()

	# 5b. What stands on covered ground further off than the ground's middle, such as a fire, is drawn over the snow and
	# the wet: the cover is drawn before every other see-through thing. WASD Decals' marks still show on the snow.
	var flame := MeshInstance3D.new()
	var card := QuadMesh.new()
	card.size = Vector2(2, 2)
	var glow := StandardMaterial3D.new()
	glow.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	glow.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	glow.albedo_color = Color(1.0, 0.45, 0.05, 0.9)
	card.material = glow
	flame.mesh = card
	flame.position = Vector3(-3, 1, -6)
	add_child(flame)
	var soot := WasdDecals3D.new()
	soot.mark = "scorch"
	soot.lifetime = 0.0
	add_child(soot)
	soot.add(Vector3(3, 0, 4), Vector3.UP, 2.5, 0.0, 3)
	weather.snow_cover = 1.0
	await _wait(0.2)
	var fire_on_snow := _color(await _picture("flame_snow.png"), flame.position)
	var mark_on_snow := _shade(await _picture("mark_snow.png"), Vector3(3, 0, 4))
	weather.snow_cover = 0.0
	weather.wetness = 1.0
	await _wait(0.2)
	var fire_on_wet := _color(await _picture("flame_wet.png"), flame.position)
	flame.queue_free()
	soot.queue_free()
	weather.wetness = 0.0
	if fire_on_snow.r - fire_on_snow.b < 0.6 or fire_on_wet.r - fire_on_wet.b < 0.6:
		return _fail("a flame beyond the ground's middle shows %s on snow and %s on wet ground" % [fire_on_snow, fire_on_wet])
	if mark_on_snow > white[0] - 0.2:
		return _fail("a scorch mark on the snow shows %f, the snow %f" % [mark_on_snow, white[0]])
	await _wait(0.2)

	# 6. Rain wets: the ground darkens, and the cover comes off when all is dry and clear.
	weather.snow_cover = 0.0
	weather.wetness = 1.0
	await _wait(0.2)
	var soaked := await _picture("wet.png")
	if _shade(soaked, Vector3(0, 2, 0)) > bare[1] - 0.03:
		return _fail("the wet crate's top shows %f, dry it showed %f" % [_shade(soaked, Vector3(0, 2, 0)), bare[1]])
	weather.wetness = 0.0
	await _wait(0.2)
	if ground.material_overlay != null or _changed(await _picture("dry.png"), before) > 40:
		return _fail("dry and clear again, the ground kept its cover %s or the picture differs" % [ground.material_overlay])
	# Rain soaks the ground by itself, as fast as it is told.
	weather.settle_seconds = 1.0
	weather.weather = "rain"
	await _wait(1.0)
	var soaking := weather.wetness
	weather.weather = "clear"
	weather.uncover(level)
	await _wait(0.2)
	if soaking < 0.4 or weather.wetness <= 0.0 or weather.wetness >= soaking or ground.material_overlay != null:
		return _fail("a second of rain wetted to %f, then %f; uncovered ground has %s" % [soaking, weather.wetness, ground.material_overlay])
	weather.wetness = 0.0

	# 7. Lightning: a flash that dies away, and the seconds to its thunder.
	await _wait(0.2)
	var dark := await _picture("before_flash.png")
	var thunder := [-1.0]
	weather.lightning.connect(func(seconds: float) -> void: thunder[0] = seconds)
	weather.strike()
	await get_tree().process_frame
	var flashed := await _picture("flash.png")
	await _wait(0.8)
	var gone := await _picture("after_flash.png")
	if thunder[0] < 0.3 or _shade(flashed, Vector3(0, 0, 5)) < _shade(dark, Vector3(0, 0, 5)) + 0.05 or _changed(gone, dark) > 40 or not is_equal_approx(world.environment.background_energy_multiplier, 1.0):
		return _fail("lightning: thunder after %f, ground %f before, %f in the flash, %d samples differ afterwards, sky energy %f" % [thunder[0], _shade(dark, Vector3(0, 0, 5)), _shade(flashed, Vector3(0, 0, 5)), _changed(gone, dark), world.environment.background_energy_multiplier])
	# A flash in progress when the game pauses ends at once, rather than stand at its height while the game waits.
	if weather.get_child_count() != 0:
		return _fail("the weather's cards and light are among the %d children that a walk through the scene reaches" % [weather.get_child_count()])
	var bolt: DirectionalLight3D
	for child: Node in weather.get_children(true):
		if child is DirectionalLight3D:
			bolt = child
	weather.strike()
	await get_tree().process_frame
	await get_tree().process_frame
	var raised := world.environment.background_energy_multiplier
	get_tree().paused = true
	var paused := [world.environment.background_energy_multiplier, bolt.light_energy]
	get_tree().paused = false
	if raised <= 1.05 or not is_equal_approx(paused[0], 1.0) or paused[1] != 0.0:
		return _fail("lightning as the game paused: sky energy %f in the flash, then %f with the light at %f" % [raised, paused[0], paused[1]])

	# 8. The sky, the fog, and the wind go to whoever asks; they are given back when the weather leaves.
	weather.weather = "fog"
	await _wait(0.2)
	if not is_equal_approx(look.overcast, 0.7) or not is_equal_approx(look.added_fog, 0.03):
		return _fail("in fog the look was told overcast %f and added fog %f" % [look.overcast, look.added_fog])
	weather.weather = "storm"
	await _wait(0.2)
	var gust := weather.get_wind()
	if vane.wind.distance_to(Vector3(10, 0, 0)) > 0.05 or gust.x < 5.5 or gust.x > 14.5 or absf(gust.z) > 0.05 or look.overcast != 1.0:
		return _fail("in a storm blowing toward +X the vane was told %s, the gusts are %s, overcast %f" % [vane.wind, gust, look.overcast])
	# A node that joins the group later is told the wind too, and SimpleGrassTextured's autoload has it.
	var newcomer := Vane.new()
	newcomer.add_to_group(&"wasd_wind")
	add_child(newcomer)
	await _wait(0.7)
	if newcomer.wind.distance_to(Vector3(10, 0, 0)) > 0.05 or not grass.wind_direction.is_equal_approx(Vector3(1, 0, 0)) or not is_equal_approx(grass.wind_strength, 0.5):
		return _fail("in a storm a vane that came later was told %s, and the grass blows toward %s at %f" % [newcomer.wind, grass.wind_direction, grass.wind_strength])
	# A material that the game puts over a mesh is never covered over when the rain comes.
	weather.weather = "clear"
	weather.cover(level)
	weather.wetness = 0.0
	await get_tree().process_frame
	await get_tree().process_frame
	var own := StandardMaterial3D.new()
	crate.material_overlay = own
	weather.wetness = 1.0
	await get_tree().process_frame
	await get_tree().process_frame
	if ground.material_overlay == null or crate.material_overlay != own:
		return _fail("the rain came: the ground has %s over it, and the crate %s over it in place of its own %s" % [ground.material_overlay, crate.material_overlay, own])
	# Once the game takes its own material off again, the cover comes back while things are wet.
	crate.material_overlay = null
	await get_tree().process_frame
	await get_tree().process_frame
	if crate.material_overlay == null or crate.material_overlay != ground.material_overlay:
		return _fail("the game took its material off the wet crate, which now has %s over it" % [crate.material_overlay])
	crate.material_overlay = own
	# It does not come back on a mesh that the rules leave bare by then: one that joined the bare group, and one that
	# turned see-through, as a wall the camera fades.
	var joining := MeshInstance3D.new()
	joining.mesh = box
	joining.position = Vector3(2, 1, 6)
	level.add_child(joining)
	var fading := MeshInstance3D.new()
	fading.mesh = box
	fading.position = Vector3(-2, 1, 6)
	level.add_child(fading)
	await get_tree().process_frame
	await get_tree().process_frame
	var both_covered := joining.material_overlay != null and fading.material_overlay != null
	joining.add_to_group(WasdWeather3D.BARE_GROUP)
	joining.material_overlay = null
	var faded := StandardMaterial3D.new()
	faded.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	faded.albedo_color = Color(1, 1, 1, 0.3)
	fading.material_override = faded
	fading.material_overlay = null
	for _frame: int in 3:
		await get_tree().process_frame
	if not both_covered or joining.material_overlay != null or fading.material_overlay != null:
		return _fail("covered at first %s; then a mesh in the bare group has %s over it, and a see-through one %s" % [both_covered, joining.material_overlay, fading.material_overlay])
	joining.queue_free()
	fading.queue_free()
	# The weather leaves wet and in the middle of a flash: the sky, the fog, the wind, and the cover are taken back, the
	# grass gets its own wind again, the sky is as bright as before the flash, and the crate keeps its own material.
	weather.strike()
	await get_tree().process_frame
	weather.queue_free()
	await _wait(0.2)
	if look.overcast != 0.0 or look.added_fog != 0.0:
		return _fail("with the weather gone the look kept overcast %f and added fog %f" % [look.overcast, look.added_fog])
	if vane.wind != Vector3.ZERO or newcomer.wind != Vector3.ZERO or grass.wind_direction != Vector3(0, 0, 1) or grass.wind_strength != 0.15 or not is_equal_approx(world.environment.background_energy_multiplier, 1.0):
		return _fail("with the weather gone the vanes keep %s and %s, the grass blows toward %s at %f, and the sky energy is %f" % [vane.wind, newcomer.wind, grass.wind_direction, grass.wind_strength, world.environment.background_energy_multiplier])
	if ground.material_overlay != null or crate.material_overlay != own:
		return _fail("with the weather gone the ground keeps %s over it, and the crate %s in place of its own %s" % [ground.material_overlay, crate.material_overlay, own])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
