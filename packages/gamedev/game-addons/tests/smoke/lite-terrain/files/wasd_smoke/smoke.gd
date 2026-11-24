extends Node3D
## LiteTerrain smoke test (render run on the Compatibility renderer): a ChunkTerrain builds its ground from a seed,
## answers height queries, carries a rigid body, takes a flattened pad, and fills most of the frame.

const ID := "lite-terrain"


func _ready() -> void:
	get_tree().create_timer(90.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(1, 0, 1)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color(0.5, 0.5, 0.5)
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	add_child(sun)
	var camera := Camera3D.new()
	camera.position = Vector3(0, 80, 0)
	camera.rotation_degrees = Vector3(-20, 0, 0)
	camera.far = 3000
	add_child(camera)

	var terrain := ChunkTerrain.new()
	terrain.forced_seed = 7
	add_child(terrain)
	await terrain.terrain_ready
	# WASD Weather flattens the lifted grass under snow through the ground's material, and WASD Look's guide hands
	# the haze to these two shader globals: both rely on these names.
	var ground := terrain.get(&"_mat") as ShaderMaterial
	if ground == null or ground.get_shader_parameter(&"grass_height") == null or ProjectSettings.get_setting("shader_globals/world_haze") == null or ProjectSettings.get_setting("shader_globals/haze_range") == null:
		return _fail("the ground's material %s has no grass_height, or the haze globals are not declared" % [ground])
	var here := terrain.terrain_height_at(Vector3.ZERO)
	var there := terrain.terrain_height_at(Vector3(300, 0, -500))
	if not is_finite(here) or absf(here) > terrain.world_height() * 2.0 or is_equal_approx(here, there):
		return _fail("heights %f at the origin and %f far away" % [here, there])
	var sample := terrain.ground_sample(Vector3(10, 0, 10))
	if not is_equal_approx(sample.x, terrain.terrain_height_at(Vector3(10, 0, 10))):
		return _fail("ground_sample and terrain_height_at disagree")
	var same := ChunkTerrain.new()
	same.forced_seed = 7
	same.position = Vector3(0, -5000, 0)
	add_child(same)
	await same.terrain_ready
	if absf(same.terrain_height_at(Vector3(0, -5000, 0)) + 5000.0 - here) > 0.01:
		return _fail("one seed gave two grounds")
	same.stop_generation()
	same.queue_free()

	camera.position = Vector3(0, here + 12.0, 0)
	var ball := RigidBody3D.new()
	var shape := CollisionShape3D.new()
	shape.shape = SphereShape3D.new()
	ball.add_child(shape)
	ball.freeze = true
	ball.position = Vector3(2, terrain.terrain_height_at(Vector3(2, 0, -4)) + 3.0, -4)
	add_child(ball)
	while not terrain.has_collision_at(ball.global_position):
		await get_tree().physics_frame
	ball.freeze = false
	await get_tree().create_timer(3.0).timeout
	var rest := ball.global_position.y - terrain.terrain_height_at(ball.global_position)
	if rest < 0.2 or rest > 1.2:
		return _fail("the ball rests %f above the ground" % [rest])

	var pad := Vector3(60, 0, 40)
	var level := terrain.terrain_height_at(pad) + 3.0
	terrain.flatten_area(pad, Vector2(6, 6), level)
	await get_tree().create_timer(1.0).timeout
	for offset: Vector3 in [Vector3.ZERO, Vector3(5, 0, 5), Vector3(-5, 0, 4)]:
		if absf(terrain.terrain_height_at(pad + offset) - level) > 0.05:
			return _fail("the pad is at %f, not %f" % [terrain.terrain_height_at(pad + offset), level])
	if terrain.ground_edits().size() != 1:
		return _fail("%d ground edits recorded" % [terrain.ground_edits().size()])

	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/terrain.png"))
	var sky := 0
	var total := 0
	for y: int in range(0, image.get_height(), 4):
		for x: int in range(0, image.get_width(), 4):
			var pixel := image.get_pixel(x, y)
			total += 1
			if pixel.r > 0.9 and pixel.g < 0.1 and pixel.b > 0.9:
				sky += 1
	var share := float(sky) / float(total)
	if share > 0.6:
		return _fail("the ground covers too little of the frame (sky share %f)" % [share])
	terrain.stop_generation()
	print("height ", here, " rest ", rest, " sky share ", share)
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
