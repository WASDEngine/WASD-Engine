extends Node3D
## WASD Decals smoke test (render run on the Compatibility renderer): marks show on a floor and a wall, keep to their
## capacity, and fade after their lifetime, also when the pool's clock has run for most of a day; the marks drawn in
## code show without a texture, in the tint the screen shows, and turn toward a direction; a walking body leaves
## footprints, left and right in turn, and none in the air; a blob shadow darkens the ground under a body, follows it,
## and fades as the body rises; see-through things before a mark or a blob shadow, such as a puff of dust, are drawn
## over them; and marks and blob shadows lie over a soft mark of WASD Materials, such as a road line.

const ID := "wasd-decals"

var camera: Camera3D


func _ready() -> void:
	# In real seconds: the test makes game time run fast for a while.
	get_tree().create_timer(60.0, true, false, true).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frame(file: String) -> Image:
	for _i: int in 4:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


## The share of the picture's pixels that are clearly red.
func _red(image: Image) -> float:
	var hits := 0
	var total := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			total += 1
			if pixel.r > 0.6 and pixel.g < 0.3 and pixel.b < 0.3:
				hits += 1
	return float(hits) / float(total)


func _luminance(image: Image, part: Rect2) -> float:
	var size := Vector2(image.get_size())
	var total := 0.0
	var count := 0
	for y: int in range(int(part.position.y * size.y), int(part.end.y * size.y), 2):
		for x: int in range(int(part.position.x * size.x), int(part.end.x * size.x), 2):
			total += image.get_pixel(x, y).get_luminance()
			count += 1
	return total / float(count)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.3, 0.5, 0.8)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	add_child(world)
	camera = Camera3D.new()
	camera.position = Vector3(0, 6, 6)
	camera.rotation_degrees = Vector3(-45, 0, 0)
	add_child(camera)
	# A pale floor with a collider, and a pale wall behind it.
	var pale := StandardMaterial3D.new()
	pale.albedo_color = Color(0.85, 0.85, 0.85)
	for spec: Array in [[Vector3(20, 1, 20), Vector3(0, -0.5, 0)], [Vector3(20, 8, 1), Vector3(0, 4, -6.5)]]:
		var body := StaticBody3D.new()
		var shape := CollisionShape3D.new()
		var box := BoxShape3D.new()
		box.size = spec[0]
		shape.shape = box
		body.add_child(shape)
		var mesh := MeshInstance3D.new()
		var box_mesh := BoxMesh.new()
		box_mesh.size = spec[0]
		box_mesh.material = pale
		mesh.mesh = box_mesh
		body.add_child(mesh)
		body.position = spec[1]
		add_child(body)
	var bare := await _frame("bare.png")
	if _red(bare) > 0.0005:
		return _fail("the bare scene is red")

	var gradient := Gradient.new()
	gradient.set_color(0, Color(1, 0, 0, 1))
	gradient.set_color(1, Color(1, 0, 0, 1))
	var splat := GradientTexture2D.new()
	splat.gradient = gradient
	splat.width = 32
	splat.height = 32
	var marks := WasdDecals3D.new()
	marks.texture = splat
	marks.unlit = true
	marks.size = 0.8
	marks.lifetime = 1.2
	marks.fade = 0.4
	marks.capacity = 12
	add_child(marks)
	for index: int in 5:
		marks.add(Vector3(index * 1.2 - 2.4, 0.0, 0.5), Vector3.UP)
	for index: int in 3:
		marks.add(Vector3(index * 1.5 - 1.5, 2.0, -6.0), Vector3.BACK)
	var marked := await _frame("marked.png")
	var share := _red(marked)
	if share < 0.01:
		return _fail("eight marks cover %f of the picture" % [share])
	for index: int in 30:
		marks.add(Vector3(randf_range(-3, 3), 0.0, randf_range(-2, 2)), Vector3.UP)
	if marks.count() != 12:
		return _fail("%d marks in a pool of 12" % [marks.count()])
	await get_tree().create_timer(1.6).timeout
	var faded := await _frame("faded.png")
	if _red(faded) > 0.0005:
		return _fail("marks still show after their lifetime (share %f)" % [_red(faded)])
	marks.lifetime = 0.0
	marks.add(Vector3(0, 0, 1), Vector3.UP, 1.5)
	await get_tree().create_timer(0.8).timeout
	if _red(await _frame("kept.png")) < 0.002:
		return _fail("a mark without a lifetime did not stay")
	marks.clear()
	if _red(await _frame("cleared.png")) > 0.0005:
		return _fail("clear() left marks")
	# A pool whose clock has run for 70,000 seconds, as one in an autoload does in a long session: a mark still shows
	# for its lifetime and then goes. The Compatibility renderer keeps a mark's end as a half float, which holds no time
	# past 65,504 seconds.
	var lasting := WasdDecals3D.new()
	lasting.texture = splat
	lasting.unlit = true
	lasting.size = 1.5
	lasting.lifetime = 1.2
	lasting.fade = 0.4
	add_child(lasting)
	Engine.time_scale = 100000.0
	await get_tree().create_timer(70000.0).timeout
	Engine.time_scale = 1.0
	lasting.add(Vector3(0, 0, 1), Vector3.UP)
	await get_tree().create_timer(0.3).timeout
	var shown_late := _red(await _frame("late_shown.png"))
	await get_tree().create_timer(1.3).timeout
	var gone_late := _red(await _frame("late_gone.png"))
	if shown_late < 0.002 or gone_late > 0.0005:
		return _fail("after 70,000 seconds a mark of 1.2 s covers %f of the picture at 0.3 s and %f at 1.7 s" % [shown_late, gone_late])
	lasting.queue_free()

	# Marks drawn in code: soot darkens the pale floor without any texture.
	var middle := Rect2(0.485, 0.535, 0.03, 0.05)
	var soot := WasdDecals3D.new()
	soot.mark = "scorch"
	soot.lifetime = 0.0
	add_child(soot)
	if soot.texture != null or not is_equal_approx(soot.size, 1.8):
		return _fail("the scorch mark came with a texture or a size of %f" % [soot.size])
	soot.add(Vector3(0, 0, 1), Vector3.UP, 3.0)
	var sooted := await _frame("sooted.png")
	if _luminance(sooted, middle) > _luminance(bare, middle) * 0.6:
		return _fail("a scorch mark left the floor at %f of %f" % [_luminance(sooted, middle), _luminance(bare, middle)])
	soot.queue_free()
	# A tint is the color the screen shows: an unlit splat tinted middle gray is middle gray.
	var paint := WasdDecals3D.new()
	paint.mark = "splat"
	paint.unlit = true
	paint.tint = Color(0.5, 0.5, 0.5)
	paint.lifetime = 0.0
	add_child(paint)
	paint.add(Vector3(0, 0, 1), Vector3.UP, 3.0)
	var painted := await _frame("painted.png")
	var shown := painted.get_pixel(painted.get_width() / 2, int(painted.get_height() * 0.58))
	if absf(shown.r - 0.5) > 0.04 or absf(shown.g - 0.5) > 0.04 or absf(shown.b - 0.5) > 0.04:
		return _fail("a splat tinted middle gray shows as %s" % [shown])
	# A mark placed toward a direction has the top of its picture, its -Z, along it.
	var slot := paint.add_toward(Vector3(3, 0, 1), Vector3.UP, Vector3(1, 0, 0), 1.0)
	var top := -paint.multimesh.get_instance_transform(slot).basis.z.normalized()
	if top.distance_to(Vector3(1, 0, 0)) > 0.01:
		return _fail("a mark placed toward +X has its top along %s" % [top])
	if not WasdDecals3D.names().has("footprint") or WasdDecals3D.names().size() != 5:
		return _fail("the drawn marks are %s" % [WasdDecals3D.names()])
	paint.queue_free()

	# Someone who walks five meters along the floor leaves prints, left and right in turn, on either side of the way.
	var walker := AnimatableBody3D.new()
	var walker_shape := CollisionShape3D.new()
	walker_shape.shape = SphereShape3D.new()
	walker_shape.position = Vector3(0, 1.0, 0)
	walker.add_child(walker_shape)
	var steps := WasdFootprints3D.new()
	steps.lifetime = 0.0
	steps.stride = 0.5
	walker.add_child(steps)
	walker.position = Vector3(-2.5, 0.0, 2.0)
	add_child(walker)
	var landed: Array = []
	steps.stepped.connect(func(at: Vector3, left: bool) -> void: landed.append([at, left]))
	for frame: int in 100:
		walker.position.x += 0.05
		await get_tree().physics_frame
	if landed.size() < 8 or landed.size() > 11 or steps.get_pool().count() != landed.size():
		return _fail("five meters at a stride of 0.5 m left %d steps and %d prints" % [landed.size(), steps.get_pool().count()])
	for index: int in landed.size():
		var at: Vector3 = landed[index][0]
		var left: bool = landed[index][1]
		if left != (index % 2 == 0) or absf(absf(at.z - 2.0) - steps.spacing * 0.5) > 0.01 or (at.z < 2.0) != left or absf(at.y) > 0.01:
			return _fail("step %d landed at %s, left %s" % [index, at, left])
	# In the air no foot lands.
	var before_jump := landed.size()
	for frame: int in 40:
		walker.position = Vector3(2.5 - frame * 0.05, 3.0, 2.0)
		await get_tree().physics_frame
	if steps.global_position.y < 2.9:
		return _fail("the walker did not rise: %s" % [steps.global_position])
	if landed.size() != before_jump:
		return _fail("%d steps landed in the air" % [landed.size() - before_jump])
	walker.queue_free()

	# A body that hovers over the floor, with a blob shadow as its child.
	var hover := AnimatableBody3D.new()
	var ball := CollisionShape3D.new()
	ball.shape = SphereShape3D.new()
	hover.add_child(ball)
	hover.position = Vector3(0, 1.0, 1.0)
	add_child(hover)
	var shadow := WasdBlobShadow3D.new()
	shadow.size = 2.0
	shadow.darkness = 0.8
	shadow.reach = 6.0
	hover.add_child(shadow)
	await get_tree().create_timer(0.3).timeout
	var under := Rect2(0.47, 0.51, 0.06, 0.1)
	var low := await _frame("shadow_low.png")
	if not shadow.visible or absf(shadow.global_position.y - 0.015) > 0.01 or absf(shadow.global_position.x) > 0.01:
		return _fail("the shadow lies at %s under a body at %s" % [shadow.global_position, hover.global_position])
	if _luminance(low, under) > _luminance(bare, under) * 0.8:
		return _fail("the shadow does not darken the floor: %f against %f" % [_luminance(low, under), _luminance(bare, under)])
	hover.position = Vector3(2.0, 4.0, 1.0)
	await get_tree().create_timer(0.3).timeout
	var high := shadow.global_position
	if absf(high.x - 2.0) > 0.01 or (shadow.get_active_material(0) as StandardMaterial3D).albedo_color.a > 0.8 * 0.5:
		return _fail("the shadow did not follow and fade as the body rose: at %s" % [high])
	hover.position = Vector3(2.0, 9.0, 1.0)
	await get_tree().create_timer(0.3).timeout
	if shadow.visible:
		return _fail("the shadow still shows beyond its reach")

	# A pale see-through card, as a puff of dust, stands before a scorch mark and before the blob shadow: marks and
	# shadows lie on the floor, so the card is drawn over them. Each card stands a third of the way from what lies on
	# the floor to the camera.
	var puff_paint := StandardMaterial3D.new()
	puff_paint.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	puff_paint.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	puff_paint.albedo_color = Color(0.95, 0.95, 0.95, 0.97)
	var lying: Array[Vector3] = [Vector3(-2, 0, 0.5), Vector3(2, 0, 1)]
	var puffs: Array[MeshInstance3D] = []
	for floor_place: Vector3 in lying:
		var puff := MeshInstance3D.new()
		puff.mesh = QuadMesh.new()
		(puff.mesh as QuadMesh).size = Vector2(1.4, 1.4)
		puff.material_override = puff_paint
		puff.rotation_degrees = Vector3(-45, 0, 0)
		puff.position = floor_place.lerp(camera.position, 0.3)
		add_child(puff)
		puffs.append(puff)
	var puffs_bare := await _frame("puffs_bare.png")
	var burnt := WasdDecals3D.new()
	burnt.mark = "scorch"
	burnt.lifetime = 0.0
	add_child(burnt)
	burnt.add(lying[0], Vector3.UP, 2.0, 0.0, 5)
	hover.position = lying[1] + Vector3.UP
	await get_tree().create_timer(0.3).timeout
	var puffs_marked := await _frame("puffs_marked.png")
	var to_pixels := Vector2(puffs_marked.get_size()) / get_viewport().get_visible_rect().size
	if not shadow.visible or shadow.global_position.distance_to(lying[1]) > 0.05:
		return _fail("the shadow shows %s at %s" % [shadow.visible, shadow.global_position])
	for index: int in puffs.size():
		var at := Vector2i(camera.unproject_position(puffs[index].position) * to_pixels)
		var bare_shade := puffs_bare.get_pixelv(at).get_luminance()
		var marked_shade := puffs_marked.get_pixelv(at).get_luminance()
		if marked_shade < bare_shade - 0.05:
			return _fail("a pale card before %s shows %f, before the bare floor %f" % [["a scorch mark", "a blob shadow"][index], marked_shade, bare_shade])
	burnt.queue_free()
	for puff: MeshInstance3D in puffs:
		puff.queue_free()

	# A soft mark of WASD Materials, a pale road line on a quad just above the floor, lies under marks and blob
	# shadows: a scorch mark and the shadow over the line darken it.
	hover.position = Vector3(2.0, 9.0, 1.0)
	var line := MeshInstance3D.new()
	line.mesh = PlaneMesh.new()
	(line.mesh as PlaneMesh).size = Vector2(0.8, 8)
	line.material_override = WasdSurface.cutout("res://wasd_smoke/line", {"soft": true})
	line.position = Vector3(0, 0.002, 0)
	add_child(line)
	var line_alone := await _frame("line_alone.png")
	var line_marks := WasdDecals3D.new()
	line_marks.mark = "scorch"
	line_marks.lifetime = 0.0
	add_child(line_marks)
	line_marks.add(Vector3(0, 0, -1), Vector3.UP, 1.6, 0.0, 5)
	hover.position = Vector3(0, 1.0, 1.5)
	await get_tree().create_timer(0.3).timeout
	var line_marked := await _frame("line_marked.png")
	var line_shades: Array[float] = []
	for place: Vector3 in [Vector3(0, 0, -1), Vector3(0, 0, 1.5)]:
		var at := Vector2i(camera.unproject_position(place) * to_pixels)
		line_shades.append_array([line_alone.get_pixelv(at).get_luminance(), line_marked.get_pixelv(at).get_luminance()])
	if line_shades[0] < 0.6 or line_shades[1] > line_shades[0] - 0.2 or line_shades[3] > line_shades[2] - 0.15:
		return _fail("a road line shows %f, under a scorch mark %f; %f, under a blob shadow %f" % line_shades)
	line.queue_free()
	line_marks.queue_free()
	print("marks ", share)
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
