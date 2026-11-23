# SPDX-License-Identifier: CC0-1.0
# A rope, cable, cord, or vine that hangs and swings: from this node to another node, such as two posts, a ship and its
# anchor, or a hook and the player, or from this node with a free end, on which a lamp or a bucket can hang. It is a
# chain of points that keep their distance, moved by gravity and by the wind of the scene's WasdClothWind3D zones, and
# costs one draw call. It can lie on the ground, and code can push it and read where each part of it is.
class_name WasdRope3D
extends MeshInstance3D

const SHADER := preload("res://addons/wasd_cloth/rope.gdshader")
## Most points a rope has, one more than its segments.
const MOST_POINTS := 32
## Looks by name: color, strands (1 a laid rope, 0 smooth), roughness, metallic, knobs, how many strands.
const LOOKS := {
	"rope": [Color(0.58, 0.46, 0.3), 1.0, 0.9, 0.0, 0.0, 3.0],
	"cable": [Color(0.07, 0.07, 0.075), 0.0, 0.55, 0.0, 0.0, 3.0],
	"steel": [Color(0.66, 0.68, 0.7), 0.85, 0.28, 1.0, 0.0, 6.0],
	"vine": [Color(0.22, 0.36, 0.14), 0.25, 0.7, 0.0, 1.0, 2.0],
}

## The rope's length in meters. A rope longer than the way between its ends sags; code may change it while the game
## runs, to reel a rope in or pay it out.
@export_range(0.1, 200.0, 0.01, "suffix:m") var length := 4.0: set = _set_length
## Parts the rope bends in, at most 31: more for a long rope that coils or lies over things.
@export_range(2, 31, 1) var segments := 16: set = _set_segments
## The rope's thickness in meters.
@export_range(0.002, 1.0, 0.001, "suffix:m") var thickness := 0.04: set = _set_thickness
## The node the far end is tied to; without one the far end is free.
@export var end_target: Node3D
## A node that hangs on the free end and swings with it, such as a lamp, a hook, or a bucket.
@export var hanging: Node3D
## Swells the rope into a knot where it is tied: at this node, and at `end_target`. Turn it off for a cable that runs
## into a wall or a lamp.
@export var knots := true: set = _set_knots
## "rope" (tan, wound strands), "cable" (dark, smooth), "steel" (a wire rope), or "vine". It sets `color`.
@export_enum("rope", "cable", "steel", "vine") var look := "rope": set = _set_look
## The rope's color; set it after `look`.
@export var color := Color(0.62, 0.5, 0.34): set = _set_color
## Passes that pull the rope back to its length each physics frame: more for a long rope or a hard pull.
@export_range(1, 40, 1) var precision := 12
## Share of its speed the rope loses each physics frame: more makes it settle sooner.
@export_range(0.0, 0.5, 0.001) var drag := 0.015
## Scales gravity on the rope: 0 floats, as in space or under water.
@export_range(0.0, 4.0, 0.01) var gravity_scale := 1.0
## How strongly the wind of WasdClothWind3D zones moves the rope: 0 ignores it.
@export_range(0.0, 4.0, 0.01) var wind_response := 1.0
## Physics layers of the ground and of what the rope may lie on; 0 lets it hang through everything.
@export_flags_3d_physics var ground_mask := 0

var _material := ShaderMaterial.new()
var _points := PackedVector3Array()
var _last := PackedVector3Array()
var _sides := PackedVector3Array()
var _gravity := Vector3.DOWN * 9.8
var _hanging_basis := Basis.IDENTITY
var _laid := false


func _init() -> void:
	_material.shader = SHADER
	material_override = _material
	_set_look(look)
	_pass_size()
	_build_tube()


func _ready() -> void:
	_gravity = (ProjectSettings.get_setting("physics/3d/default_gravity_vector", Vector3.DOWN) as Vector3) * float(ProjectSettings.get_setting("physics/3d/default_gravity", 9.8))
	reset()


## Lays the rope out again between its ends, at rest: call it after moving the rope or its ends a long way at once.
func reset() -> void:
	if not is_inside_tree():
		return
	var from := global_position
	var count := segments + 1
	_points.resize(count)
	_last.resize(count)
	_sides.resize(count)
	var down := _gravity.normalized()
	var to := from + down * length
	var tied := end_target != null and end_target.is_inside_tree()
	if tied:
		to = end_target.global_position
	# A free rope that reaches the ground starts with the rest of its length in a coil there.
	var hangs := length
	var lands := Vector3.ZERO
	if not tied and ground_mask != 0:
		var hit := get_world_3d().direct_space_state.intersect_ray(PhysicsRayQueryParameters3D.create(from, to, ground_mask))
		if not hit.is_empty():
			lands = (hit["position"] as Vector3) - down * thickness * 0.5
			hangs = from.distance_to(lands)
	for index: int in count:
		var part := float(index) / float(segments)
		var along := part * length
		if along > hangs:
			# Each turn of the coil lies outside the one before, a thickness and a little apart.
			var wound := along - hangs
			var turn := wound / 0.3
			_points[index] = lands + Vector3(cos(turn) - 1.0, 0.0, sin(turn)) * (0.3 + turn * thickness * 0.2)
		else:
			# A rope longer than the way between its ends starts in the sag it will settle in.
			var slack := maxf(length - from.distance_to(to), 0.0) if tied else 0.0
			_points[index] = from.lerp(to, part) + down * slack * 0.6 * sin(part * PI)
		_last[index] = _points[index]
		_sides[index] = Vector3.RIGHT
	if hanging != null:
		_hanging_basis = hanging.global_basis
	_laid = true
	_show()


## How many points the rope has: its segments and one.
func point_count() -> int:
	return _points.size()


## A point of the rope in the world, from 0 at this node to `point_count() - 1` at the far end.
func get_point(index: int) -> Vector3:
	return _points[clampi(index, 0, _points.size() - 1)]


## The place in the world a share of the way along the rope, from 0 at this node to 1 at the far end: where to hang a
## lantern on a line, or to put a hand that holds it.
func get_position_at(part: float) -> Vector3:
	var at := clampf(part, 0.0, 1.0) * float(_points.size() - 1)
	var index := mini(int(at), _points.size() - 2)
	return _points[index].lerp(_points[index + 1], at - float(index))


## Pushes the rope: adds `speed` in meters a second to the points round a share of the way along it, most at `part`
## and none beyond `reach`, a share of the rope's length. A bullet, a gust, a body that brushes it.
func push(speed: Vector3, part := 1.0, reach := 0.25) -> void:
	var step := 1.0 / float(Engine.physics_ticks_per_second)
	for index: int in range(1, _points.size()):
		var away := absf(float(index) / float(segments) - part)
		if away < reach:
			_last[index] -= speed * step * (1.0 - away / reach)


func _physics_process(delta: float) -> void:
	if not _laid:
		return
	var count := _points.size()
	var tied := end_target != null and end_target.is_inside_tree()
	var wind := Vector3.ZERO
	if wind_response > 0.0:
		wind = WasdClothWind3D.velocity_at(get_tree(), _points[count / 2])
	var pull := _gravity * gravity_scale * delta * delta
	# The wind drags a rope toward its own speed, slowly, thin as a rope is.
	var caught := minf(wind_response * 0.25 * delta, 1.0)
	var space := get_world_3d().direct_space_state if ground_mask != 0 else null
	var half := thickness * 0.5
	for index: int in range(1, count - (1 if tied else 0)):
		var speed := (_points[index] - _last[index]) * (1.0 - drag)
		speed += (wind * delta - speed) * caught
		_last[index] = _points[index]
		_points[index] += speed + pull
		if space != null:
			# The rope lies on what is under it.
			var above := _points[index] + Vector3.UP * (half + 0.4)
			var hit := space.intersect_ray(PhysicsRayQueryParameters3D.create(above, _points[index] + Vector3.DOWN * half, ground_mask))
			if not hit.is_empty():
				_points[index].y = (hit["position"] as Vector3).y + half
				# What lies on the ground rubs on it.
				_last[index] = _last[index].lerp(_points[index], 0.3)
	var rest := length / float(segments)
	var from := global_position
	var to := end_target.global_position if tied else Vector3.ZERO
	for _pass: int in precision:
		_points[0] = from
		if tied:
			_points[count - 1] = to
		for index: int in count - 1:
			var gap := _points[index + 1] - _points[index]
			var far := gap.length()
			if far < 0.0001:
				# Two points in one place, as where a rope drops onto the ground, part sideways, each pair another way:
				# the rope coils.
				gap = Vector3(cos(index * 2.4), 0.0, sin(index * 2.4)) * 0.0001
				far = 0.0001
			var off := gap * ((far - rest) / far)
			if index == 0:
				_points[index + 1] -= off
			elif tied and index == count - 2:
				_points[index] += off
			else:
				_points[index] += off * 0.5
				_points[index + 1] -= off * 0.5
		# A rope does not fold flat on itself: a point and the next but one keep some distance, so that a rope on the
		# ground lies in loops.
		for index: int in range(1, count - 2):
			var gap := _points[index + 2] - _points[index]
			var far := gap.length()
			if far < rest * 1.6 and far > 0.0001:
				var off := gap * ((far - rest * 1.6) / far) * 0.25
				_points[index] += off
				_points[index + 2] -= off
	_points[0] = from
	if tied:
		_points[count - 1] = to
	_show()


## Hands the points to the shader, turns each ring of the tube as little as its neighbor allows, and moves what hangs.
func _show() -> void:
	var count := _points.size()
	var to_local := global_transform.affine_inverse()
	var local := PackedVector3Array()
	local.resize(MOST_POINTS)
	var across := PackedVector3Array()
	across.resize(MOST_POINTS)
	var side := _sides[0]
	var low := Vector3.INF
	var high := -Vector3.INF
	for index: int in count:
		var along := (_points[mini(index + 1, count - 1)] - _points[maxi(index - 1, 0)]).normalized()
		side = side - along * side.dot(along)
		if side.length_squared() < 0.0001:
			side = along.cross(Vector3(0.31, 0.95, 0.07))
		side = side.normalized()
		_sides[index] = side
		local[index] = to_local * _points[index]
		across[index] = to_local.basis * side
		low = low.min(local[index])
		high = high.max(local[index])
	_material.set_shader_parameter(&"points", local)
	_material.set_shader_parameter(&"sides", across)
	_material.set_shader_parameter(&"count", count)
	_material.set_shader_parameter(&"knot_start", 1.0 if knots else 0.0)
	var tied := end_target != null and end_target.is_inside_tree()
	_material.set_shader_parameter(&"knot_end", 1.0 if knots and tied else 0.0)
	# An end that is neither tied nor carries something is a loose end.
	_material.set_shader_parameter(&"loose_end", 0.0 if tied or hanging != null else 1.0)
	custom_aabb = AABB(low, high - low).grow(thickness * 2.0)
	if hanging != null and hanging.is_inside_tree() and not tied:
		# What hangs keeps the way it faced and tilts with the rope's end.
		var up := (_points[count - 2] - _points[count - 1]).normalized()
		var tilt := Quaternion(-_gravity.normalized(), up) if up.length_squared() > 0.5 else Quaternion.IDENTITY
		hanging.global_transform = Transform3D(Basis(tilt) * _hanging_basis, _points[count - 1])


## The fixed tube the shader bends: three rings to a segment, ten sides.
func _build_tube() -> void:
	var rings := segments * 3 + 1
	var around := 10
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	for ring: int in rings:
		for step: int in around + 1:
			var angle := TAU * float(step) / float(around)
			vertices.append(Vector3(cos(angle), 0.0, sin(angle)))
			normals.append(Vector3(cos(angle), 0.0, sin(angle)))
			uvs.append(Vector2(float(step) / float(around), float(ring) / float(rings - 1)))
	for ring: int in rings - 1:
		for step: int in around:
			var first := ring * (around + 1) + step
			var next := first + around + 1
			indices.append_array([first, first + 1, next, first + 1, next + 1, next])
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	var tube := ArrayMesh.new()
	tube.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh = tube


func _pass_size() -> void:
	_material.set_shader_parameter(&"radius", thickness * 0.5)
	_material.set_shader_parameter(&"rope_length", length)


func _set_length(value: float) -> void:
	length = maxf(value, 0.1)
	_pass_size()


func _set_thickness(value: float) -> void:
	thickness = value
	_pass_size()


func _set_segments(value: int) -> void:
	segments = clampi(value, 2, MOST_POINTS - 1)
	_build_tube()
	reset()


func _set_look(value: String) -> void:
	look = value if LOOKS.has(value) else "rope"
	var parts: Array = LOOKS[look]
	color = parts[0]
	_material.set_shader_parameter(&"strands", parts[1])
	_material.set_shader_parameter(&"roughness", parts[2])
	_material.set_shader_parameter(&"metallic", parts[3])
	_material.set_shader_parameter(&"knobs", parts[4])
	_material.set_shader_parameter(&"strand_count", parts[5])


func _set_knots(value: bool) -> void:
	knots = value
	if _laid:
		_show()


func _set_color(value: Color) -> void:
	color = value
	_material.set_shader_parameter(&"color", value)
