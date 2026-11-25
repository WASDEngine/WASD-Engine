extends Node3D
## TrailRenderer smoke test (render run on the Compatibility renderer): a trail follows a node that circles in front
## of the camera, draws its gradient's color, and fades out once it stops emitting; a LineRenderer draws the points
## that code gives it, and in its own space, where `alignment` does nothing, a line along -Z has width only when its
## points face across it. A trail point lives on the wall clock, so the trail keeps its points for twelve frames at
## least and the emitter moves for eight frames at least: a software renderer, such as the one that GitHub's macOS
## runners give OpenGL, takes a large part of a second for a frame.

const ID := "trail-renderer"


func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _material() -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.vertex_color_use_as_albedo = true
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	return material


## The seconds that a frame takes here, measured over three frames.
func _frame_seconds() -> float:
	await get_tree().process_frame
	var began := Time.get_ticks_usec()
	for _i: int in 3:
		await get_tree().process_frame
	return float(Time.get_ticks_usec() - began) / 3_000_000.0


## The share of the frame's pixels whose color is close to `color`.
func _share(color: Color, file: String) -> float:
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	var hits := 0
	var total := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			total += 1
			if absf(pixel.r - color.r) < 0.2 and absf(pixel.g - color.g) < 0.2 and absf(pixel.b - color.b) < 0.2:
				hits += 1
	return float(hits) / float(total)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color.BLACK
	add_child(world)
	var camera := Camera3D.new()
	camera.position = Vector3(0, 0, 6)
	add_child(camera)

	var tip := Node3D.new()
	add_child(tip)
	var trail := TrailRenderer.new()
	trail.lifetime = maxf(0.6, 12.0 * await _frame_seconds())
	trail.min_vertex_distance = 0.1
	trail.alignment = LineRenderer.Alignment.View
	trail.material = _material()
	var width := Curve.new()
	width.add_point(Vector2(0.0, 0.3))
	width.add_point(Vector2(1.0, 0.3))
	trail.curve = width
	var gradient := Gradient.new()
	gradient.set_color(0, Color(0, 1, 0))
	gradient.set_color(1, Color(0, 1, 0))
	trail.color_gradient = gradient
	tip.add_child(trail)

	var angle := 0.0
	var started := Time.get_ticks_msec()
	var moves := 0
	while Time.get_ticks_msec() - started < 700 or moves < 8:
		angle = float(Time.get_ticks_msec() - started) / 1000.0 * 6.0
		tip.position = Vector3(cos(angle), sin(angle), 0) * 2.0
		moves += 1
		await get_tree().process_frame
	var lines := trail.find_children("*", "LineRenderer", true, false)
	if lines.is_empty():
		return _fail("the trail made no line")
	var line := lines[0] as LineRenderer
	if line.points.size() < 4:
		return _fail("the trail holds %d points after a move of several metres" % [line.points.size()])
	var count := line.points.size()
	# The trail's last point follows the emitter, so the width curve and the gradient run from the tail to the head.
	if (line.get_point(count - 1).position as Vector3).distance_to(tip.global_position) > 0.05:
		return _fail("the trail's last point is not at the emitter")
	var mesh := (line.get_node("MeshInstance3D") as MeshInstance3D).mesh
	if mesh.get_surface_count() != 1:
		return _fail("the trail's mesh has %d surfaces" % [mesh.get_surface_count()])
	var drawn := await _share(Color(0, 1, 0), "trail.png")
	if drawn < 0.01:
		return _fail("the trail does not show in the frame (share %f)" % [drawn])

	# A point lives for the trail's lifetime on the wall clock, however fast the frames run.
	trail.is_emitting = false
	await get_tree().create_timer(trail.lifetime + 0.9).timeout
	var faded := await _share(Color(0, 1, 0), "faded.png")
	if faded > 0.0005:
		return _fail("the trail still shows after its lifetime (share %f)" % [faded])

	var bolt := LineRenderer.new()
	bolt.material = _material()
	bolt.alignment = LineRenderer.Alignment.View
	bolt.curve = width
	var red := Gradient.new()
	red.set_color(0, Color(1, 0, 0))
	red.set_color(1, Color(1, 0, 0))
	bolt.color_gradient = red
	add_child(bolt)
	bolt.points = [Point.new(Vector3(-2, -1, 0)), Point.new(Vector3(0, 1, 0)), Point.new(Vector3(2, -1, 0))]
	for _i: int in 4:
		await get_tree().process_frame
	var line_share := await _share(Color(1, 0, 0), "line.png")
	if line_share < 0.01:
		return _fail("the line does not show in the frame (share %f)" % [line_share])

	# In the node's own space each point faces its own alignment_vector, Vector3.FORWARD unless Point.new() is given one.
	var beam := LineRenderer.new()
	beam.world_space = false
	beam.alignment = LineRenderer.Alignment.View
	beam.curve = width
	add_child(beam)
	var beam_mesh := (beam.get_node("MeshInstance3D") as MeshInstance3D).mesh
	beam.points = [Point.new(Vector3.ZERO), Point.new(Vector3(0, 0, -4))]
	for _i: int in 2:
		await get_tree().process_frame
	var unfaced := beam_mesh.get_aabb().size.x
	beam.points = [Point.new(Vector3.ZERO, Vector3.UP), Point.new(Vector3(0, 0, -4), Vector3.UP)]
	for _i: int in 2:
		await get_tree().process_frame
	var faced := beam_mesh.get_aabb().size.x
	if unfaced > 0.01 or absf(faced - 0.6) > 0.01:
		return _fail("a line along -Z in its node's space is %.2f m wide with the default facing and %.2f m facing up" % [unfaced, faced])
	print("points ", count, " trail ", drawn, " faded ", faded, " line ", line_share, " beam ", unfaced, " ", faced)
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
