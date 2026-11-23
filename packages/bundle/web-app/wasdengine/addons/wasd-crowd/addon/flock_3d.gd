# SPDX-License-Identifier: CC0-1.0
# Life in the background: a flock of birds, a school of fish, or butterflies over a meadow. The creatures are small
# shapes built in code, with no model and no texture, and a shader moves them, turns them to face where they go, and
# beats their wings and tails, so a flock of hundreds is one draw call and costs no script time. They roam round this
# node, travel with it when it moves, and fly apart when `scare()` startles them. They do not collide and are not
# nodes: they are scenery.
class_name WasdFlock3D
extends MultiMeshInstance3D

## What each kind starts from; setting `kind` sets these, so change them after it.
const KINDS := {
	"birds": {"shape": 0, "speed": 7.0, "spread": 0.25, "size": 0.8, "beat": 14.0, "color": Color(0.1, 0.1, 0.12), "variety": 0.15, "metallic": 0.0, "sight": 0.0},
	"fish": {"shape": 1, "speed": 1.4, "spread": 0.3, "size": 0.3, "beat": 10.0, "color": Color(0.55, 0.65, 0.72), "variety": 0.2, "metallic": 0.35, "sight": 80.0},
	"butterflies": {"shape": 2, "speed": 0.9, "spread": 0.0, "size": 0.09, "beat": 22.0, "color": Color(1.0, 0.5, 0.06), "variety": 0.6, "metallic": 0.0, "sight": 22.0},
}

## "birds", "fish", or "butterflies". Birds and fish travel together round the node; butterflies each keep near a spot
## of their own within `radius`.
@export_enum("birds", "fish", "butterflies") var kind := "birds": set = _set_kind
## How many creatures.
@export_range(1, 5000, 1) var count := 40: set = _set_count
## How far from this node the flock roams, in meters.
@export_range(0.5, 500.0, 0.5) var radius := 25.0: set = _set_radius
## The height of the band the creatures keep to, half above this node and half below, in meters.
@export_range(0.0, 100.0, 0.1) var height := 6.0: set = _set_height
## Meters a second.
@export_range(0.0, 60.0, 0.1) var speed := 7.0: set = _set_speed
## A creature's wingspan, or a fish's length, in meters.
@export_range(0.01, 20.0, 0.01) var size := 0.8: set = _set_size
## The creatures' color.
@export var color := Color(0.1, 0.1, 0.12): set = _set_color
## How much the creatures differ from one another in color, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var variety := 0.15: set = _set_variety
## Meters from the camera beyond which a creature is not drawn, where it would be a speck that flickers; 0 draws
## them at any distance, as birds are.
@export_range(0.0, 2000.0, 1.0) var sight := 0.0: set = _set_sight
## The flock looks the same on every run with the same number here.
@export var random_seed := 1: set = _set_random_seed

var _material := ShaderMaterial.new()
var _clock := 0.0


func _init() -> void:
	_material.shader = preload("flock.gdshader")
	material_override = _material
	multimesh = MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.use_colors = true
	multimesh.use_custom_data = true
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_set_kind(kind)


func _process(delta: float) -> void:
	_clock += delta
	_material.set_shader_parameter(&"clock", _clock)


## Startles the flock: the creatures near a place in the world fly apart from it, birds upward, and come back over
## some ten seconds. `strength` 1 is a person walking up; 3 is a gunshot.
func scare(from: Vector3, strength := 1.0) -> void:
	_material.set_shader_parameter(&"scare_place", to_local(from) if is_inside_tree() else from)
	_material.set_shader_parameter(&"scare_clock", _clock)
	_material.set_shader_parameter(&"scare_strength", strength)


## The names of the kinds.
static func kinds() -> PackedStringArray:
	return PackedStringArray(KINDS.keys())


func _set_kind(value: String) -> void:
	if not KINDS.has(value):
		push_warning("WasdFlock3D: no kind named \"%s\". The kinds are: %s." % [value, ", ".join(KINDS.keys())])
		return
	kind = value
	var start: Dictionary = KINDS[value]
	speed = start["speed"]
	size = start["size"]
	color = start["color"]
	variety = start["variety"]
	sight = start["sight"]
	multimesh.mesh = _shape(start["shape"])
	_material.set_shader_parameter(&"kind", start["shape"])
	# Butterflies differ more in size than birds of one flock do.
	_material.set_shader_parameter(&"size_variety", 0.5 if value == "butterflies" else 0.3)
	_material.set_shader_parameter(&"beat_rate", start["beat"])
	_material.set_shader_parameter(&"metallic", start["metallic"])
	_fill()
	_bounds()


func _set_count(value: int) -> void:
	count = maxi(value, 1)
	_fill()


func _set_radius(value: float) -> void:
	radius = value
	_bounds()


func _set_height(value: float) -> void:
	height = value
	_bounds()


func _set_speed(value: float) -> void:
	speed = value
	_material.set_shader_parameter(&"speed", value)


func _set_size(value: float) -> void:
	size = value
	_material.set_shader_parameter(&"size", value)


func _set_sight(value: float) -> void:
	sight = value
	_material.set_shader_parameter(&"sight", value)


func _set_color(value: Color) -> void:
	color = value
	_fill()


func _set_variety(value: float) -> void:
	variety = value
	_fill()


func _set_random_seed(value: int) -> void:
	random_seed = value
	_fill()


## Gives every member its four numbers and its color.
func _fill() -> void:
	if multimesh == null:
		return
	var random := RandomNumberGenerator.new()
	random.seed = random_seed
	multimesh.instance_count = count
	for member: int in count:
		multimesh.set_instance_transform(member, Transform3D.IDENTITY)
		multimesh.set_instance_custom_data(member, Color(random.randf(), random.randf(), random.randf(), random.randf()))
		var own := color
		var pick := random.randf()
		var hue := random.randf()
		var light := random.randf()
		if kind == "butterflies" and pick < variety * 0.35:
			# Some butterflies are yellows and some are blues, whatever color the others have.
			own = Color(0.97, 0.94, 0.55) if pick < variety * 0.25 else Color(0.25, 0.5, 0.95)
		else:
			# The others keep near the flock's color: toward red and toward yellow, lighter and darker.
			own.h = fposmod(own.h + (hue - 0.35) * variety * 0.18, 1.0)
			own.v = clampf(own.v * (1.0 + (light - 0.5) * variety), 0.0, 1.0)
		multimesh.set_instance_color(member, own)


## The shader moves the creatures, so the node says how far they may be drawn from it, or the renderer would leave
## them out when only the node's middle is out of view.
func _bounds() -> void:
	if multimesh == null or not KINDS.has(kind):
		return
	var stray: float = radius * float(KINDS[kind]["spread"])
	_material.set_shader_parameter(&"radius", radius)
	_material.set_shader_parameter(&"height", height)
	_material.set_shader_parameter(&"spread", stray)
	# Startled creatures fly up to 40 m further.
	var across := radius + stray + 42.0
	var tall := height * 0.5 + stray + 42.0
	custom_aabb = AABB(Vector3(-across, -tall, -across), Vector3(across, tall, across) * 2.0)


## Adds a wing as a fan of triangles from its root, the outline's first corner, so that the fan's edges run where a
## wing's veins do. `rim` says for each corner how near the wing's outer edge it lies, from 0 at the body to 1: the
## shader draws the dark border where that number is high, so a lower number thins the border there. `cup` lifts the
## outline's middle corners, which gives the wing the shallow bowl that light rolls across, and `light` is how light
## each corner is: a dark tip, as many butterflies have.
func _wing(triangles: Array[Array], outline: Array, rim: Array, cup: float, light: Array) -> void:
	var root: Vector3 = outline[0]
	for index: int in range(1, outline.size() - 1):
		var a: Vector3 = outline[index]
		var b: Vector3 = outline[index + 1]
		a.y += cup * sin(PI * float(index) / float(outline.size() - 1))
		b.y += cup * sin(PI * float(index + 1) / float(outline.size() - 1))
		var normal := (b - root).cross(a - root).normalized()
		if normal.y < 0.0:
			normal = -normal
		# Lightness: shaded at the root, where the wing meets the body. After it: the rim numbers, then for each corner
		# its share of the triangle toward the two veins, which tells the shader where they run.
		triangles.append([root, a, b, normal, 0.55, light[index], light[index + 1], 0.0, rim[index], rim[index + 1], Vector2(0, 0), Vector2(1, 0), Vector2(0, 1)])


## A creature of one wingspan or length, facing +Z. A corner's UV holds how far toward the rim it lies and how light
## that part is.
func _shape(shape: int) -> ArrayMesh:
	# Each triangle: three corners, its normal, how light each corner is, and for a wing how far toward the rim.
	var triangles: Array[Array] = []
	if shape == 0:
		# A bird from above: a body like a dart, and on each side a wing of two panels that ends in a point.
		triangles.append([Vector3(0, 0, 0.26), Vector3(-0.05, 0, 0.0), Vector3(0.05, 0, 0.0), Vector3.UP, 1.0, 1.0, 1.0])
		triangles.append([Vector3(-0.05, 0, 0.0), Vector3(0, 0, -0.26), Vector3(0.05, 0, 0.0), Vector3.UP, 1.0, 0.8, 1.0])
		for side: float in [-1.0, 1.0]:
			triangles.append([Vector3(side * 0.05, 0, 0.1), Vector3(side * 0.05, 0, -0.08), Vector3(side * 0.28, 0, 0.06), Vector3.UP, 1.0, 1.0, 0.9])
			triangles.append([Vector3(side * 0.05, 0, -0.08), Vector3(side * 0.28, 0, -0.1), Vector3(side * 0.28, 0, 0.06), Vector3.UP, 1.0, 0.85, 0.9])
			triangles.append([Vector3(side * 0.28, 0, 0.06), Vector3(side * 0.28, 0, -0.1), Vector3(side * 0.5, 0, -0.06), Vector3.UP, 0.9, 0.85, 0.7])
	elif shape == 1:
		# A fish from the side: a body with a dark back and a pale belly, a forked tail, and a narrow back seen from above.
		triangles.append([Vector3(0, 0, 0.5), Vector3(0, 0.15, 0.12), Vector3(0, -0.13, 0.12), Vector3.RIGHT, 0.9, 0.6, 1.0])
		triangles.append([Vector3(0, 0.15, 0.12), Vector3(0, 0, -0.3), Vector3(0, -0.13, 0.12), Vector3.RIGHT, 0.6, 0.8, 1.0])
		triangles.append([Vector3(0, 0, -0.26), Vector3(0, 0.15, -0.5), Vector3(0, 0.0, -0.4), Vector3.RIGHT, 0.8, 0.6, 0.7])
		triangles.append([Vector3(0, 0, -0.26), Vector3(0, 0.0, -0.4), Vector3(0, -0.15, -0.5), Vector3.RIGHT, 0.8, 0.7, 0.6])
		triangles.append([Vector3(0, 0.02, 0.45), Vector3(-0.05, 0.02, 0.1), Vector3(0.05, 0.02, 0.1), Vector3.UP, 0.6, 0.6, 0.6])
		triangles.append([Vector3(-0.05, 0.02, 0.1), Vector3(0, 0.02, -0.3), Vector3(0.05, 0.02, 0.1), Vector3.UP, 0.6, 0.6, 0.6])
	else:
		# A butterfly from above: a dark body with two feelers, and on each side a long forewing and a round hindwing
		# with a short tail, a notch between the two.
		triangles.append([Vector3(0, 0.004, 0.17), Vector3(-0.045, 0.004, 0.06), Vector3(0.045, 0.004, 0.06), Vector3.UP, 0.12, 0.18, 0.18])
		triangles.append([Vector3(-0.045, 0.004, 0.06), Vector3(0, 0.004, -0.24), Vector3(0.045, 0.004, 0.06), Vector3.UP, 0.18, 0.08, 0.18])
		for side: float in [-1.0, 1.0]:
			triangles.append([Vector3(side * 0.01, 0.004, 0.15), Vector3(side * 0.04, 0.004, 0.15), Vector3(side * 0.17, 0.004, 0.36), Vector3.UP, 0.1, 0.1, 0.1])
			# Forewing: from the root along the leading edge to the tip, down the outer edge, and back to the body.
			_wing(triangles, [Vector3(side * 0.02, 0, 0.07), Vector3(side * 0.2, 0, 0.27), Vector3(side * 0.4, 0, 0.33), Vector3(side * 0.5, 0, 0.26), Vector3(side * 0.46, 0, 0.12), Vector3(side * 0.3, 0, 0.05), Vector3(side * 0.02, 0, 0.01)], [0.0, 0.8, 1.0, 1.0, 1.0, 0.86, 0.0], 0.035, [0.55, 1.0, 0.5, 0.3, 0.5, 1.0, 0.55])
			# Hindwing: from the root out under the notch, round the lobe to the tail, and back to the body.
			_wing(triangles, [Vector3(side * 0.02, 0, 0.0), Vector3(side * 0.26, 0, -0.04), Vector3(side * 0.38, 0, -0.13), Vector3(side * 0.37, 0, -0.25), Vector3(side * 0.27, 0, -0.33), Vector3(side * 0.2, 0, -0.43), Vector3(side * 0.13, 0, -0.31), Vector3(side * 0.02, 0, -0.16)], [0.0, 0.86, 1.0, 1.0, 1.0, 1.0, 0.86, 0.0], 0.03, [0.55, 1.0, 1.0, 0.8, 0.6, 0.4, 0.8, 0.55])
	var points := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var veins := PackedVector2Array()
	for triangle: Array in triangles:
		for corner: int in 3:
			points.append(triangle[corner])
			normals.append(triangle[3])
			uvs.append(Vector2(triangle[7 + corner] if triangle.size() > 7 else 0.0, triangle[4 + corner]))
			# Away from a wing, a corner lies far from every vein.
			veins.append(triangle[10 + corner] if triangle.size() > 10 else Vector2(0.5, 0.5))
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = points
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_TEX_UV2] = veins
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh
