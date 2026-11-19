extends Node3D
## Smoke test of the wasd-water catalog entry on Godot 4.7.2 (render run on the Compatibility renderer, which Web
## builds use). The scene holds a tropical lagoon with a property changed after its preset, a disc pond, a river along
## a path with a waterfall, and a crate with a floater. Over a sloping sea bed it draws every preset with the full
## shader and the fast one and checks that each colors the picture, that lava glows and toon water has few colors,
## that the surface queries follow the shapes and the waves, that an infinite sea follows the camera, that the crate
## floats, that rings are stored, that diving tints the view, sets the fog, and puts it back, and that a red
## pillar shows in the water under it with the SCREEN and the PLANAR reflection and not with the SKY one. With the
## environment variable WASD_WATER_SHOTS set to a folder, it saves a picture of each preset there.

var failures: PackedStringArray = []
var environment: Environment
var camera: Camera3D
var submerged := 0
var surfaced := 0


func check(ok: bool, message: String) -> void:
	if not ok:
		failures.append(message)


func _ready() -> void:
	environment = Environment.new()
	var sky := Sky.new()
	sky.sky_material = ProceduralSkyMaterial.new()
	environment.sky = sky
	environment.background_mode = Environment.BG_SKY
	var world := WorldEnvironment.new()
	world.environment = environment
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-40, -160, 0)
	add_child(sun)
	add_child(sea_bed())
	camera = Camera3D.new()
	add_child(camera)
	camera.position = Vector3(-4, 3.0, -9)
	camera.look_at(Vector3(2, 0, 6))
	camera.current = true
	run.call_deferred()


## Sand that slopes from a beach at -Z down to 6 m under the lagoon, so the water has a shore and a depth.
func sea_bed() -> MeshInstance3D:
	var surface := SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)
	var cells := 40
	for z in cells + 1:
		for x in cells + 1:
			var at := Vector2((float(x) / cells - 0.5) * 80.0, (float(z) / cells - 0.5) * 80.0)
			surface.set_normal(Vector3.UP)
			surface.add_vertex(Vector3(at.x, clampf(-0.25 * (at.y + 6.0) + 0.4 * sin(at.x * 0.4), -6.0, 3.0), at.y))
	for z in cells:
		for x in cells:
			var corner := z * (cells + 1) + x
			for index: int in [corner, corner + 1, corner + cells + 1, corner + 1, corner + cells + 2, corner + cells + 1]:
				surface.add_index(index)
	var bed := MeshInstance3D.new()
	bed.mesh = surface.commit()
	var sand := StandardMaterial3D.new()
	sand.albedo_color = Color(0.72, 0.62, 0.42)
	bed.material_override = sand
	return bed


func frames(count: int) -> void:
	for index in count:
		await get_tree().process_frame


func picture() -> Image:
	await frames(6)
	return get_viewport().get_texture().get_image()


## Mean color of the part of the picture where the lagoon lies.
func water_color(image: Image) -> Color:
	var sum := Vector3.ZERO
	var count := 0
	for y in range(int(image.get_height() * 0.5), int(image.get_height() * 0.62), 4):
		for x in range(int(image.get_width() * 0.5), int(image.get_width() * 0.95), 4):
			var pixel := image.get_pixel(x, y)
			sum += Vector3(pixel.r, pixel.g, pixel.b)
			count += 1
	sum /= count
	return Color(sum.x, sum.y, sum.z)


func difference(a: Color, b: Color) -> float:
	return absf(a.r - b.r) + absf(a.g - b.g) + absf(a.b - b.b)


func run() -> void:
	var lagoon := $Lagoon as WasdWater3D
	var pond := $Pond as WasdWater3D
	var river := $River as WasdWater3D
	var crate := $Crate as RigidBody3D
	lagoon.camera_submerged.connect(func() -> void: submerged += 1)
	lagoon.camera_surfaced.connect(func() -> void: surfaced += 1)

	# The scene's own values: the preset first, then the property stored after it.
	check(lagoon.preset == "tropical" and is_equal_approx(lagoon.wave_height, 0.5), "the lagoon's wave_height %.2f was not kept after its preset" % lagoon.wave_height)
	check(lagoon.shallow_color.is_equal_approx(WasdWaterPresets.values("tropical")["shallow_color"]), "the lagoon does not have the tropical preset's colors")
	check(WasdWaterPresets.names().size() == 16, "there are %d presets instead of 16" % WasdWaterPresets.names().size())
	for look in WasdWaterPresets.names():
		for key: String in WasdWaterPresets.values(look):
			check(key in lagoon, "preset %s sets %s, which WasdWater3D does not have" % [look, key])
	check(WasdWaterPresets.values("no such look").is_empty(), "an unknown preset has values")

	# Every preset draws with both shaders, over the sea bed and unlike the bare bed.
	lagoon.visible = false
	var bare := water_color(await picture())
	lagoon.visible = true
	var shots := OS.get_environment("WASD_WATER_SHOTS")
	var colors := {}
	for quality: int in [WasdWater3D.Quality.FULL, WasdWater3D.Quality.FAST]:
		lagoon.quality = quality
		for look in WasdWaterPresets.names():
			lagoon.preset = look
			var image: Image = await picture()
			var color := water_color(image)
			check(difference(color, bare) > 0.08, "%s with quality %d looks like the bare sea bed (%s)" % [look, quality, color])
			if quality == WasdWater3D.Quality.FULL:
				colors[look] = color
				if shots != "":
					image.save_png(shots.path_join(look + ".png"))
			elif shots != "":
				image.save_png(shots.path_join(look + "_fast.png"))
	lagoon.quality = WasdWater3D.Quality.FULL
	var lava: Color = colors["lava"]
	var toxic: Color = colors["toxic"]
	var ocean: Color = colors["ocean"]
	check(lava.r > 0.6 and lava.r > lava.b * 2.0, "lava is not orange: %s" % lava)
	check(toxic.g > toxic.r and toxic.g > toxic.b * 1.5, "toxic water is not green: %s" % toxic)
	check(ocean.b > ocean.r, "the ocean is not blue: %s" % ocean)
	print("colors ", colors)

	# Queries: outlines, levels, and waves.
	lagoon.preset = "lake"
	lagoon.wave_height = 0.0
	check(is_equal_approx(lagoon.height_at(Vector3(3, 0, 4)), 0.0), "flat water is at %.3f instead of its level 0" % lagoon.height_at(Vector3(3, 0, 4)))
	lagoon.preset = "ocean"
	var lowest := INF
	var highest := -INF
	for index in 400:
		var height := lagoon.height_at(Vector3(index * 1.7 - 300.0, 0, index * 0.9))
		lowest = minf(lowest, height)
		highest = maxf(highest, height)
	# The larger waves are `wave_height` from trough to crest, so the surface strays about a quarter of it and
	# its highest points reach three times that.
	var tall := lagoon.wave_height
	check(highest > tall * 0.25 and lowest < -tall * 0.25 and highest < tall * 1.2 and lowest > -tall * 1.2, "%.1f m ocean waves reach from %.2f to %.2f" % [tall, lowest, highest])
	check(ResourceLoader.exists("res://addons/wasd_water/foam.png") and not ((lagoon.material_override as ShaderMaterial).get_shader_parameter("foam_noise") is NoiseTexture2D), "the foam does not use the add-on's foam.png")
	check(lagoon.wave_count == 24 and (lagoon.material_override as ShaderMaterial).get_shader_parameter("wave_count") == 24, "the ocean does not send its 24 waves to the shader")
	var before := lagoon.height_at(Vector3(5, 0, 5))
	await frames(20)
	check(absf(lagoon.height_at(Vector3(5, 0, 5)) - before) > 0.001, "the waves do not move")
	check(lagoon.contains(Vector3(29, 9, -29)) and not lagoon.contains(Vector3(31, 0, 0)), "the rectangle's outline is wrong")
	check(lagoon.is_underwater(Vector3(0, -3, 0)) and not lagoon.is_underwater(Vector3(0, 3, 0)) and not lagoon.is_underwater(Vector3(0, -60, 0)), "is_underwater is wrong for the lagoon")
	check(pond.contains(Vector3(104.5, 0, 0)) and not pond.contains(Vector3(104.5, 0, 2.5)) and not pond.contains(Vector3(100, 0, 3.5)), "the disc's outline is wrong")
	check(is_equal_approx(pond.height_at(Vector3(100, 0, 0)), 3.0) or absf(pond.height_at(Vector3(100, 0, 0)) - 3.0) < 0.02, "the pond is not at its level 3")
	check(WasdWater3D.find(get_tree(), Vector3(100, 2, 0)) == pond and WasdWater3D.find(get_tree(), Vector3(0, -2, 0)) == lagoon and WasdWater3D.find(get_tree(), Vector3(500, 0, 500)) == null, "find() returns the wrong water")

	# The river: a ribbon 4 m wide on its path, level across, that falls at the end and flows along the path.
	check(river.mesh != null and river.mesh.get_aabb().size.x > 3.9 and river.mesh.get_aabb().size.y > 3.5, "the river's ribbon is missing or has the wrong size")
	check(absf(river.height_at(Vector3(30, 0, -30)) - 6.0) < 0.05, "the river is at %.2f instead of 6 on its path" % river.height_at(Vector3(30, 0, -30)))
	var current := river.flow_at(Vector3(30, 6, -30))
	check(current.z > 1.4 and absf(current.x) < 0.05, "the river flows %s instead of 1.5 m/s along +Z" % current)
	check(river.contains(Vector3(31.5, 6, -30)) and not river.contains(Vector3(33, 6, -30)), "the river's outline is wrong")

	# Rings are kept for the shader, the newest eight.
	for index in 10:
		lagoon.add_ripple(Vector3(index, 0, 2), 1.0)
	var rings: PackedVector4Array = (lagoon.material_override as ShaderMaterial).get_shader_parameter("rings")
	var kept: Array[int] = []
	for ring in rings:
		kept.append(roundi(ring.x))
	kept.sort()
	check(kept == [2, 3, 4, 5, 6, 7, 8, 9], "the rings are %s instead of the newest eight" % [kept])

	# The crate fell in and floats at the surface.
	lagoon.preset = "lake"
	await frames(240)
	var floater := crate.get_node("Floater") as WasdWaterFloater3D
	var surface := lagoon.height_at(crate.global_position)
	check(floater.is_in_water() and absf(crate.global_position.y - surface) < 0.6, "the crate is at %.2f, not floating at the surface %.2f" % [crate.global_position.y, surface])

	# Diving tints the view and sets the fog; surfacing puts the fog back.
	check(not environment.fog_enabled, "the fog is on before the dive")
	camera.position = Vector3(0, -2.0, 6)
	camera.look_at(Vector3(4, -3, 14))
	var under: Image = await picture()
	check(submerged == 1 and environment.fog_enabled and environment.fog_light_color.is_equal_approx(lagoon.underwater_color), "diving did not set the fog (submerged %d)" % submerged)
	var middle := under.get_pixel(under.get_width() / 2, under.get_height() / 2)
	check(middle.b > middle.r, "the view under water is not tinted: %s" % middle)
	if shots != "":
		under.save_png(shots.path_join("underwater.png"))
	camera.position = Vector3(-4, 3.0, -9)
	camera.look_at(Vector3(2, 0, 6))
	await frames(3)
	check(surfaced == 1 and not environment.fog_enabled, "surfacing did not put the fog back (surfaced %d)" % surfaced)

	# Reflections: a red pillar behind the lagoon shows in the still water under it when the scene is mirrored.
	lagoon.preset = "lake"
	lagoon.wave_height = 0.0
	lagoon.surface_strength = 0.0
	lagoon.shore_foam = 0.0
	# The rings from the ripples above have faded by this time.
	lagoon.set("_time", lagoon.water_time() + 60.0)
	var pillar := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = Vector3(5, 14, 5)
	pillar.mesh = box
	var red := StandardMaterial3D.new()
	red.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	red.albedo_color = Color(1, 0, 0)
	pillar.material_override = red
	pillar.position = Vector3(6, 7, 24)
	add_child(pillar)
	camera.position = Vector3(6, 3.0, -4)
	camera.look_at(Vector3(6, 1.0, 24))
	var seen := {}
	for mode: int in [WasdWater3D.Reflection.SKY, WasdWater3D.Reflection.SCREEN, WasdWater3D.Reflection.PLANAR]:
		lagoon.reflection = mode
		await frames(10)
		var image: Image = await picture()
		# The pillar's mirror image lies where a pillar under the water would be seen. A block of pixels is read,
		# because the mirrored rays of single pixels start at different depths.
		var at := Vector2i(camera.unproject_position(Vector3(6, -3, 24)) * Vector2(image.get_size()) / get_viewport().get_visible_rect().size)
		var redness := 0.0
		for y in range(-4, 5):
			for x in range(-4, 5):
				var pixel := image.get_pixel(at.x + x, at.y + y)
				redness += pixel.r - maxf(pixel.g, pixel.b)
		seen[mode] = redness / 81.0
		if shots != "":
			image.save_png(shots.path_join("reflection_%d.png" % mode))
	# Water mirrors about a sixth of the light at this angle, so the pillar reddens the water without covering it.
	var plain: float = seen[WasdWater3D.Reflection.SKY]
	check(plain < 0.05, "the pillar shows in the water without a scene reflection: %s" % [seen])
	check(seen[WasdWater3D.Reflection.SCREEN] - plain > 0.1, "the SCREEN reflection does not mirror the pillar: %s" % [seen])
	check(seen[WasdWater3D.Reflection.PLANAR] - plain > 0.1, "the PLANAR reflection does not mirror the pillar: %s" % [seen])
	check(lagoon.layers == 1 << 19 and lagoon.get_node_or_null("^Mirror") == null, "a PLANAR water is not on render layer 20")
	lagoon.reflection = WasdWater3D.Reflection.SKY
	check(lagoon.layers == 1, "the water did not return to render layer 1 after PLANAR")
	pillar.queue_free()
	print("reflections ", seen)

	# An infinite sea stays under the camera.
	lagoon.shape = WasdWater3D.Shape.INFINITE
	lagoon.size = Vector2(1000, 1000)
	camera.position = Vector3(400, 5, 300)
	await frames(3)
	check(lagoon.global_position.distance_to(Vector3(400, 0, 300)) < 1.0 and lagoon.contains(Vector3(9000, 0, 0)), "the infinite sea did not follow the camera: %s" % lagoon.global_position)
	check(lagoon.mesh.get_aabb().size.x > 990.0, "the infinite sea is %.0f m across instead of 1000" % lagoon.mesh.get_aabb().size.x)

	if failures.is_empty():
		print("SMOKE_PASS wasd-water")
		get_tree().quit(0)
	else:
		for failure in failures:
			print("SMOKE_FAIL wasd-water: " + failure)
		get_tree().quit(1)
