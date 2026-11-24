extends Node3D
## SimpleGrassTextured smoke test (render run on the Compatibility renderer): grass added from game code shows as a
## green field that the wind moves, settles onto a slope's collider, and leaves a clearing where it is erased.

const ID := "simple-grass-textured"
const GRASS := preload("res://addons/simplegrasstextured/grass.gd")


func _ready() -> void:
	get_tree().create_timer(90.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frame() -> Image:
	await RenderingServer.frame_post_draw
	return get_viewport().get_texture().get_image()


func _green_share(image: Image) -> float:
	var green := 0
	var total := 0
	for y: int in range(0, image.get_height(), 3):
		for x: int in range(0, image.get_width(), 3):
			var pixel := image.get_pixel(x, y)
			total += 1
			if pixel.g > pixel.r * 1.15 and pixel.g > pixel.b * 1.15:
				green += 1
	return float(green) / float(total)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	if get_node_or_null("/root/SimpleGrass") == null:
		return _fail("the SimpleGrass autoload is missing")
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.5, 0.7, 1.0)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color(0.6, 0.6, 0.6)
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	add_child(sun)
	var camera := Camera3D.new()
	camera.position = Vector3(0, 1.6, 6)
	camera.rotation_degrees = Vector3(-10, 0, 0)
	add_child(camera)
	# A slope of bare earth with a collider, which the grass settles onto.
	var ground := StaticBody3D.new()
	var slab := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(40, 1, 40)
	slab.shape = box
	slab.position = Vector3(0, -0.5, 0)
	ground.add_child(slab)
	var earth := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(40, 40)
	var dirt := StandardMaterial3D.new()
	dirt.albedo_color = Color(0.35, 0.25, 0.15)
	plane.material = dirt
	earth.mesh = plane
	ground.add_child(earth)
	ground.rotation_degrees = Vector3(0, 0, 8)
	add_child(ground)
	var bare := _green_share(await _frame())
	if bare > 0.01:
		return _fail("the bare scene is green (share %f)" % [bare])

	var grass := MultiMeshInstance3D.new()
	grass.set_script(GRASS)
	add_child(grass)
	var transforms: Array = []
	var rng := RandomNumberGenerator.new()
	rng.seed = 5
	for _i: int in 4000:
		var at := Vector3(rng.randf_range(-12, 12), 5.0, rng.randf_range(-12, 4))
		transforms.append(grass.eval_grass_transform(at, Vector3.UP, Vector3.ONE * rng.randf_range(0.7, 1.2), rng.randf() * TAU))
	grass.add_grass_batch(transforms)
	grass.set_process(true)
	for _i: int in 4:
		await get_tree().process_frame
	if grass.multimesh.instance_count != 4000:
		return _fail("%d grass instances after adding 4000" % [grass.multimesh.instance_count])
	await grass.snap_to_terrain()
	var worst := 0.0
	for index: int in range(0, 4000, 97):
		var origin := grass.to_global(grass.multimesh.get_instance_transform(index).origin)
		worst = maxf(worst, absf(origin.y - origin.x * tan(deg_to_rad(8.0))))
	if worst > 0.05:
		return _fail("grass sits %f m off the slope after snap_to_terrain" % [worst])

	for _i: int in 6:
		await get_tree().process_frame
	var first := await _frame()
	first.save_png(ProjectSettings.globalize_path("res://wasd_smoke/grass.png"))
	var field := _green_share(first)
	if field < 0.15:
		return _fail("the grass covers too little of the frame (share %f)" % [field])
	await get_tree().create_timer(0.7).timeout
	var second := await _frame()
	var moved := 0
	var total := 0
	for y: int in range(0, first.get_height(), 3):
		for x: int in range(0, first.get_width(), 3):
			var a := first.get_pixel(x, y)
			var b := second.get_pixel(x, y)
			total += 1
			if absf(a.r - b.r) + absf(a.g - b.g) + absf(a.b - b.b) > 0.08:
				moved += 1
	if float(moved) / float(total) < 0.02:
		return _fail("the wind does not move the grass (share %f)" % [float(moved) / float(total)])

	grass.erase(grass.to_global(grass.multimesh.get_instance_transform(0).origin), 3.0)
	for _i: int in 4:
		await get_tree().process_frame
	var left: int = grass.multimesh.instance_count
	if left >= 4000 or left < 3000:
		return _fail("%d instances left after erasing a 3 m circle" % [left])
	print("field ", field, " moved ", float(moved) / float(total), " left ", left)
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
