extends Node3D
## SO FLUFFY smoke test (render run on the Compatibility renderer): a Fur node on a ball makes it larger on screen
## by the fur's length and shows the fur's color; longer fur reaches farther; the ball still moves; and freeing the
## fur gives the bare ball back.

const ID := "sofluffy"
const FUR := preload("res://addons/so_fluffy/so_fluffy.gd")


func _ready() -> void:
	get_tree().create_timer(90.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frame(file: String) -> Image:
	for _i: int in 6:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


## How many samples of the picture are not the sky, and how many of those are orange.
func _covered(image: Image) -> Vector2i:
	var covered := 0
	var orange := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			if absf(pixel.r - 0.1) + absf(pixel.g - 0.3) + absf(pixel.b - 0.8) > 0.25:
				covered += 1
				if pixel.r > 0.5 and pixel.r > pixel.b * 1.6 and pixel.g > pixel.b:
					orange += 1
	return Vector2i(covered, orange)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.1, 0.3, 0.8)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	add_child(world)
	var camera := Camera3D.new()
	camera.position = Vector3(0, 0, 3)
	add_child(camera)
	var ball := MeshInstance3D.new()
	var sphere := SphereMesh.new()
	sphere.radius = 0.5
	sphere.height = 1.0
	ball.mesh = sphere
	var skin := StandardMaterial3D.new()
	skin.albedo_color = Color(0.2, 0.2, 0.2)
	ball.material_override = skin
	add_child(ball)
	var bare := _covered(await _frame("bare.png"))
	if bare.x < 500 or bare.y > 5:
		return _fail("the bare ball covers %d samples, %d of them orange" % [bare.x, bare.y])

	var fur := FUR.new()
	fur.number_of_shells = 24
	fur.length = 0.15
	fur.density = 0.8
	fur.albedo_color = Color(1.0, 0.55, 0.1)
	ball.add_child(fur)
	var short := _covered(await _frame("short.png"))
	if short.x < bare.x * 1.25 or short.y < bare.x * 0.4:
		return _fail("fur of 0.15 m covers %d samples against the bare ball's %d, %d of them orange" % [short.x, bare.x, short.y])
	fur.length = 0.4
	var long := _covered(await _frame("long.png"))
	if long.x < short.x * 1.25:
		return _fail("fur of 0.4 m covers %d samples against %d at 0.15 m" % [long.x, short.x])
	# The furry ball moves like any node, and its fur comes along.
	ball.position.x = 0.8
	for _i: int in 20:
		await get_tree().physics_frame
	var moved := await _frame("moved.png")
	var left := 0
	var right := 0
	for y: int in range(0, moved.get_height(), 4):
		for x: int in range(0, moved.get_width(), 4):
			var pixel := moved.get_pixel(x, y)
			if pixel.r > 0.5 and pixel.r > pixel.b * 1.6:
				if x < moved.get_width() / 2:
					left += 1
				else:
					right += 1
	if right < left * 3 or right < 100:
		return _fail("the moved ball's fur shows %d samples on the left and %d on the right" % [left, right])
	ball.position.x = 0.0
	# Freeing the fur leaves the bare ball.
	fur.queue_free()
	var after := _covered(await _frame("after.png"))
	if absi(after.x - bare.x) > bare.x * 0.05 or after.y > 5:
		return _fail("after its fur is freed the ball covers %d samples, %d of them orange, against %d bare" % [after.x, after.y, bare.x])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
