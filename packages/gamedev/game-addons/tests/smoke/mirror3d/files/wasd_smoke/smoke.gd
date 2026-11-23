extends Node3D
## Mirror3D smoke test (render run on the Compatibility renderer): a red ball behind the camera shows only in the
## mirror, on a wall and lying flat as a floor, and not once the mirror is hidden.

const ID := "mirror3d"
const MIRROR := preload("res://addons/Mirror3D/Mirror3D.tscn")


func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


## The share of the frame's pixels that are clearly red.
func _red_share(file: String) -> float:
	for _i: int in 8:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	var red := 0
	var total := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			total += 1
			if pixel.r > 0.55 and pixel.g < 0.25 and pixel.b < 0.25:
				red += 1
	return float(red) / float(total)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.1, 0.2, 0.5)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	add_child(world)
	var camera := Camera3D.new()
	add_child(camera)
	var ball := MeshInstance3D.new()
	var sphere := SphereMesh.new()
	sphere.radius = 0.9
	sphere.height = 1.8
	var paint := StandardMaterial3D.new()
	paint.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	paint.albedo_color = Color(1, 0, 0)
	sphere.material = paint
	ball.mesh = sphere
	add_child(ball)
	var mirror := MIRROR.instantiate() as Mirror3D
	mirror.size = Vector2(3, 3)
	mirror.pixels_per_unit = 128
	add_child(mirror)

	# A wall mirror at the origin facing +Z; the ball sits behind the camera, so only the mirror shows it.
	camera.position = Vector3(0, 0, 3)
	ball.position = Vector3(0.4, 0.2, 5.5)
	var wall := await _red_share("wall.png")
	if wall < 0.003:
		return _fail("the wall mirror shows no red ball (share %f)" % [wall])
	mirror.visible = false
	var hidden := await _red_share("hidden.png")
	if hidden > 0.0005:
		return _fail("the ball shows without the mirror (share %f)" % [hidden])

	# The same mirror lying flat as a polished floor, seen from above; the ball hangs over it, above the camera's view.
	mirror.visible = true
	mirror.rotation_degrees = Vector3(-90, 0, 0)
	camera.position = Vector3(0, 1.2, 2.2)
	camera.look_at(Vector3(0, 0, 0.3))
	ball.position = Vector3(0.2, 3.2, -1.0)
	var floor_share := await _red_share("floor.png")
	if floor_share < 0.003:
		return _fail("the floor mirror shows no red ball (share %f)" % [floor_share])
	print("wall ", wall, " hidden ", hidden, " floor ", floor_share)
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
