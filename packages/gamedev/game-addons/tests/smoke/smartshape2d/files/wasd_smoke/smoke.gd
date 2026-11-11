extends Node2D
## SmartShape2D smoke test (render run): one closed shape written as .tscn text (TextShape, material in
## ground_material.tres) and one built in code; checks the generated meshes, the runtime collision polygon,
## and pixels of the rendered frame, then saves smoke.png.

const CLEAR := Color(0.1, 0.12, 0.18)
const SUN := Color(1.0, 0.85, 0.2)
const ROCK := Color(0.35, 0.35, 0.6)

var failures: PackedStringArray = []
var code_shape: SS2D_Shape
var frames := 0


func _ready() -> void:
	RenderingServer.set_default_clear_color(CLEAR)
	code_shape = _build_code_shape()
	add_child(code_shape)


func _build_code_shape() -> SS2D_Shape:
	var edge_image := Image.create(16, 12, false, Image.FORMAT_RGBA8)
	edge_image.fill(SUN)
	var fill_image := Image.create(32, 32, false, Image.FORMAT_RGBA8)
	fill_image.fill(ROCK)
	var edge := SS2D_Material_Edge.new()
	edge.textures = [ImageTexture.create_from_image(edge_image)]
	var meta := SS2D_Material_Edge_Metadata.new()
	meta.edge_material = edge  # normal_range defaults to 0..360: every edge
	var material := SS2D_Material_Shape.new()
	material.add_edge_material(meta)
	material.fill_textures = [ImageTexture.create_from_image(fill_image)]
	var shape := SS2D_Shape.new()
	shape.name = "CodeShape"
	shape.shape_material = material
	var points := shape.get_point_array()
	points.begin_update()
	for p in [Vector2(360, 280), Vector2(420, 120), Vector2(520, 90), Vector2(600, 280)]:
		points.add_point(p)
	points.close_shape()
	points.end_update()
	if not points.are_points_clockwise():
		points.invert_point_order()
	return shape


func _expect(label: String, ok: bool) -> void:
	if not ok:
		failures.append(label)


func _mesh_bounds(shape: SS2D_Shape) -> Array:
	# Returns [fill rect, union rect of all meshes, mesh count, total vertex count].
	var fill := Rect2()
	var union := Rect2()
	var vertex_count := 0
	var meshes: Array = shape._mesh_cache.meshes
	for i in meshes.size():
		var mesh: ArrayMesh = meshes[i].mesh
		if mesh.get_surface_count() == 0:
			continue
		vertex_count += mesh.surface_get_array_len(0)
		var box := mesh.get_aabb()
		var rect := Rect2(box.position.x, box.position.y, box.size.x, box.size.y)
		if i == 0:
			fill = rect
			union = rect
		else:
			union = union.merge(rect)
	return [fill, union, meshes.size(), vertex_count]


func _check_geometry() -> void:
	var text_shape: SS2D_Shape = $TextShape
	_expect("text shape closed", text_shape.get_point_array().is_shape_closed())
	_expect("code shape closed", code_shape.get_point_array().is_shape_closed())
	var t := _mesh_bounds(text_shape)
	_expect("text fill rect %s" % t[0], t[0].is_equal_approx(Rect2(60, 80, 220, 200)))
	_expect("text mesh count %d" % t[2], t[2] == 5)  # fill + 4 edges
	_expect("text vertex count %d" % t[3], t[3] >= 20)
	# Edges are 16 px tall (the grass texture's height) and centred on the outline.
	_expect("text union rect %s" % t[1], t[1].is_equal_approx(Rect2(52, 72, 236, 216)))
	var c := _mesh_bounds(code_shape)
	_expect("code fill rect %s" % c[0], c[0].is_equal_approx(Rect2(360, 90, 240, 190)))
	_expect("code mesh count %d" % c[2], c[2] >= 3)  # fill + welded edge strips
	_expect("code vertex count %d" % c[3], c[3] >= 12)
	_expect("code union grows by edge %s" % c[1], c[1].encloses(c[0]) and c[1].size.y > c[0].size.y + 6)
	var polygon: PackedVector2Array = $Body/Collision.polygon
	_expect("runtime collision polygon %d points" % polygon.size(), polygon.size() >= 4)
	var box := Rect2(polygon[0], Vector2.ZERO)
	for p in polygon:
		box = box.expand(p)
	_expect("collision covers the shape %s" % box, box.encloses(Rect2(70, 90, 200, 180)))


func _near(a: Color, b: Color) -> bool:
	return absf(a.r - b.r) < 0.12 and absf(a.g - b.g) < 0.12 and absf(a.b - b.b) < 0.12


func _check_pixels(image: Image) -> void:
	_expect("background pixel %s" % image.get_pixel(20, 20), _near(image.get_pixel(20, 20), CLEAR))
	var dirt := image.get_pixel(170, 180)
	_expect("text fill pixel %s" % dirt, dirt.r > dirt.g and dirt.g > dirt.b and dirt.r > 0.4)
	var grass := image.get_pixel(170, 80)
	_expect("text edge pixel %s" % grass, grass.g > 0.3 and grass.g > grass.r * 1.5)
	_expect("code fill pixel %s" % image.get_pixel(480, 230), _near(image.get_pixel(480, 230), ROCK))
	_expect("code edge pixel %s" % image.get_pixel(480, 280), _near(image.get_pixel(480, 280), SUN))


func _process(_delta: float) -> void:
	frames += 1
	if frames < 10:
		return
	set_process(false)
	_check_geometry()
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/smoke.png"))
	_check_pixels(image)
	if failures.is_empty():
		print("SMOKE_PASS smartshape2d")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(failures))
		get_tree().quit(1)
