extends Node3D
## SO FLUFFY smoke test (render run on the Compatibility renderer): a Fur node on a ball makes it larger on screen
## by the fur's length and shows the fur's color; longer fur reaches farther; the ball still moves; and freeing the
## fur gives the bare ball back. Fur on target_surfaces grows over the material that lives on the Mesh, leaves that
## shared material without fur, and keeps what the game changed on the surface when it rebuilds; fur lags behind a body
## that carries its mesh; and the level of detail counts the distance from a camera that is the child of a rig.

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
	ball.visible = false

	# A square whose material lives on its Mesh, as in an imported .glb, and a second instance of that Mesh. Fur on
	# target_surfaces grows over that material, so the background does not show between the strands, and the other
	# instance stays bare.
	var red := StandardMaterial3D.new()
	red.albedo_color = Color(0.8, 0.1, 0.1)
	var quad := QuadMesh.new()
	quad.size = Vector2(1.2, 1.2)
	quad.material = red
	var square := MeshInstance3D.new()
	square.mesh = quad
	add_child(square)
	var twin := MeshInstance3D.new()
	twin.mesh = quad
	twin.position.y = -10.0
	add_child(twin)
	var patch := FUR.new()
	patch.number_of_shells = 16
	patch.length = 0.05
	patch.thickness_scale = 0.8
	patch.albedo_color = Color(1.0, 0.55, 0.1)
	patch.target_surfaces = [0]
	square.add_child(patch)
	var through := _background(await _frame("surfaces.png"))
	if through.x > through.y * 0.1:
		return _fail("%d of %d samples of the square with fur on target_surfaces show the background" % [through.x, through.y])
	if red.next_pass != null or twin.get_active_material(0) != red:
		return _fail("fur on one mesh's target_surfaces went onto the material that the Mesh shares")
	# The game changes the surface through its override, then the fur rebuilds with fewer shells: the change stays,
	# under the fur. A surface that leaves target_surfaces, and every surface once the fur is freed, draws the Mesh's
	# material again.
	var changed := square.get_surface_override_material(0) as StandardMaterial3D
	changed.albedo_color = Color(0.1, 0.8, 0.1)
	patch.number_of_shells = 8
	await get_tree().process_frame
	if square.get_surface_override_material(0) != changed or not _has_fur(changed):
		return _fail("lowering number_of_shells took the surface's changed material, or the fur on it, away")
	patch.target_surfaces = []
	await get_tree().process_frame
	if square.get_surface_override_material(0) != null or not _has_fur(square.material_overlay):
		return _fail("a surface that left target_surfaces kept its copy of the Mesh's material")
	patch.target_surfaces = [0]
	patch.queue_free()
	await get_tree().process_frame
	if square.get_surface_override_material(0) != null:
		return _fail("freeing the fur of target_surfaces left a material on the surface")
	square.queue_free()
	twin.queue_free()

	# A body that carries the mesh moves and turns, as a creature does: the fur lags behind it.
	var body := Node3D.new()
	add_child(body)
	var carried := MeshInstance3D.new()
	carried.mesh = sphere
	body.add_child(carried)
	var swinging := FUR.new()
	swinging.number_of_shells = 8
	carried.add_child(swinging)
	await get_tree().physics_frame
	var lag := 0.0
	var twist := 0.0
	for _i: int in 10:
		body.position.y -= 0.05
		body.rotate_y(0.05)
		await get_tree().physics_frame
		lag = maxf(lag, swinging.spring_offset.length())
		twist = maxf(twist, swinging.spring_rotation.length())
	if lag < 0.001 or twist < 0.001:
		return _fail("fur lagged %f m and %f rad behind the moving, turning body that carries its mesh" % [lag, twist])
	body.queue_free()

	# A camera that is the child of a rig far from the world's origin, as an orbit camera is: fur 3 m from it keeps
	# all its shells.
	var rig := Node3D.new()
	rig.position = Vector3(50, 0, 0)
	add_child(rig)
	var rig_camera := Camera3D.new()
	rig_camera.position = Vector3(0, 0, 3)
	rig.add_child(rig_camera)
	rig_camera.current = true
	var pet := MeshInstance3D.new()
	pet.mesh = sphere
	pet.position = Vector3(50, 0, 0)
	add_child(pet)
	var near := FUR.new()
	near.number_of_shells = 16
	near.lod_enabled = true
	pet.add_child(near)
	await get_tree().process_frame
	await get_tree().process_frame
	if near.lod_shell_count < near.number_of_shells:
		return _fail("fur 3 m from the camera of a rig draws %d of its %d shells" % [near.lod_shell_count, near.number_of_shells])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)


## Whether a fur shell hangs in a material's next_pass chain.
func _has_fur(material: Material) -> bool:
	while material != null:
		if material.has_meta("is_fur"):
			return true
		material = material.next_pass
	return false


## How many samples of the picture's middle, which the square covers, show the blue background, of how many.
func _background(image: Image) -> Vector2i:
	var seen := 0
	var total := 0
	for y: int in range(int(image.get_height() * 0.42), int(image.get_height() * 0.58), 2):
		for x: int in range(int(image.get_width() * 0.46), int(image.get_width() * 0.54), 2):
			var pixel := image.get_pixel(x, y)
			total += 1
			if absf(pixel.r - 0.1) + absf(pixel.g - 0.3) + absf(pixel.b - 0.8) < 0.15:
				seen += 1
	return Vector2i(seen, total)
