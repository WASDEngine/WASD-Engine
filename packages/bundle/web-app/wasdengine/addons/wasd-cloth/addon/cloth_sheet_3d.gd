# SPDX-License-Identifier: CC0-1.0
# A rectangle of cloth that the physics engine simulates while the game runs: a flag, banner, curtain, sail, awning,
# hammock, or laundry that the player or the wind moves. It builds its own grid mesh, applies a fabric preset, pins
# the named edges, and moves pinned points with `pin_target`. WasdClothWind3D zones blow on it. It needs Jolt Physics
# (Project Settings > Physics > 3D > Physics Engine): with Godot Physics, soft bodies fall through static bodies.
@tool
class_name WasdClothSheet3D
extends SoftBody3D

## Which way the sheet faces before it moves.
enum Facing {
	## Hangs in the node's XY plane, facing +Z: flags, banners, curtains, sails, capes.
	VERTICAL,
	## Lies in the node's XZ plane, facing +Y: awnings, hammocks, nets, a cloth dropped onto something.
	HORIZONTAL,
}

## Width (local X) and height in meters; the height runs along local Y when VERTICAL and along local Z when HORIZONTAL.
@export var size := Vector2(1.0, 1.0):
	set(value):
		size = value.max(Vector2(0.05, 0.05))
		_rebuild()

@export var facing := Facing.VERTICAL:
	set(value):
		facing = value
		_rebuild()

## Grid spacing in meters. 0.04 to 0.08 looks like cloth; each halving makes the sheet about four times as costly.
@export_range(0.02, 0.5, 0.005, "suffix:m") var cell := 0.06:
	set(value):
		cell = clampf(value, 0.02, 0.5)
		_rebuild()

## Fabric preset from WasdClothFabrics: silk, cotton, canvas, denim, leather, or rubber. It sets the mass from the
## area, the stiffness, the damping, and the precision when the sheet is added to its parent, before it enters the
## tree, and again whenever a setting changes after that. Jolt keeps the stiffness and the precision that a sheet has
## when it enters the tree, so set them before. custom leaves those SoftBody3D properties as the scene or your code
## set them.
@export_enum("silk", "cotton", "canvas", "denim", "leather", "rubber", "custom") var fabric := "cotton":
	set(value):
		fabric = value
		if _fabric_applied:
			_apply_fabric()
		notify_property_list_changed()

## Solver iterations per physics tick; 0 uses the fabric's. Higher stretches less and costs more, about linearly.
@export_range(0, 40) var precision := 0:
	set(value):
		precision = clampi(value, 0, 40)
		if _fabric_applied:
			_apply_fabric()

## Edges whose points do not move: top, bottom, left, right, or a corner (top_left, top_right, bottom_left,
## bottom_right). Top is +Y when VERTICAL and -Z when HORIZONTAL; left is -X.
@export var pinned_edges := PackedStringArray(["top"])

## How many rows of points next to each pinned edge are pinned; 2 keeps the cloth from stretching at a pole or rail.
@export_range(1, 4) var pin_rows := 1

## A node that the pinned points move with, such as the pole, a character's BoneAttachment3D, or the ship the sail is
## on. Empty keeps them where they start.
@export var pin_target: NodePath

## Render both faces with the default material. A material of your own needs cull_mode = CULL_DISABLED for the same.
@export var double_sided := true:
	set(value):
		double_sided = value
		_rebuild()

var _columns := 0
var _rows := 0
## Final vertex index of each grid point, row by row.
var _grid: PackedInt32Array = []
var _local: PackedVector3Array = []
var _pinned: PackedInt32Array = []
var _pin_offsets: PackedVector3Array = []
var _target: Node3D
## Whether the fabric was applied once; setters apply it again only after that.
var _fabric_applied := false


## Builds the mesh only. A scene sets its SoftBody3D properties before it attaches this script, which runs _init(), and
## sets fabric after that, so a preset applied here would overwrite the settings of a custom sheet.
func _init() -> void:
	_rebuild()


## Applies the fabric when the sheet gets its parent: a scene has set all of this node's properties by then, fabric
## among them, and the soft body does not exist yet, which the physics engine creates when the sheet enters the tree.
func _notification(what: int) -> void:
	if what == NOTIFICATION_PARENTED:
		_apply_fabric()


func _ready() -> void:
	# A script attached after the sheet got its parent has not applied the fabric yet.
	if not _fabric_applied:
		_apply_fabric()
	if Engine.is_editor_hint():
		return
	var engine := str(ProjectSettings.get_setting("physics/3d/physics_engine", "DEFAULT"))
	if engine != "Jolt Physics":
		push_warning("WASD Cloth: %s runs on the %s physics engine. Set [physics] 3d/physics_engine=\"Jolt Physics\" in project.godot; Godot Physics lets soft bodies fall through static bodies." % [name, engine])
	if not global_basis.get_scale().is_equal_approx(Vector3.ONE):
		push_warning("WASD Cloth: %s is scaled, and soft bodies ignore scale. Set size instead and keep the scale at 1." % name)
	_pin()


func _physics_process(_delta: float) -> void:
	if Engine.is_editor_hint() or _target == null or not is_instance_valid(_target):
		return
	var to_world := _target.global_transform
	var body := get_physics_rid()
	for k in _pinned.size():
		PhysicsServer3D.soft_body_move_point(body, _pinned[k], to_world * _pin_offsets[k])


## Vertex indices of the pinned points, once the sheet is ready.
func pinned_indices() -> PackedInt32Array:
	return _pinned


## Vertex index of the grid point in column `column` (0 at the left edge) and row `row` (0 at the top edge).
func point_at(column: int, row: int) -> int:
	return _grid[clampi(row, 0, _rows) * (_columns + 1) + clampi(column, 0, _columns)]


## Grid columns and rows of cells.
func grid_size() -> Vector2i:
	return Vector2i(_columns, _rows)


const EDGES: PackedStringArray = ["top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"]


func _pin() -> void:
	_pinned = PackedInt32Array()
	var seen := {}
	for name_given in pinned_edges:
		var edge := String(name_given).strip_edges().to_lower()
		if edge not in EDGES:
			push_warning("WASD Cloth: %s has the unknown pinned edge \"%s\"; use %s." % [name, edge, ", ".join(EDGES)])
			continue
		for row in _rows + 1:
			for column in _columns + 1:
				if _on_edge(edge, column, row) and not seen.has(point_at(column, row)):
					seen[point_at(column, row)] = true
					_pinned.append(point_at(column, row))
	for index in _pinned:
		set_point_pinned(index, true)
	_target = null
	if not pin_target.is_empty():
		_target = get_node_or_null(pin_target) as Node3D
		if _target == null:
			push_warning("WASD Cloth: %s has no Node3D at pin_target %s; its pins stay where they are." % [name, pin_target])
	if _target != null:
		var to_target := _target.global_transform.affine_inverse() * global_transform
		_pin_offsets = PackedVector3Array()
		for index in _pinned:
			_pin_offsets.append(to_target * _local[index])
	set_physics_process(_target != null)


func _on_edge(edge: String, column: int, row: int) -> bool:
	var top := row < pin_rows
	var bottom := row > _rows - pin_rows
	var left := column < pin_rows
	var right := column > _columns - pin_rows
	match edge:
		"top": return top
		"bottom": return bottom
		"left": return left
		"right": return right
		"top_left": return top and left
		"top_right": return top and right
		"bottom_left": return bottom and left
		"bottom_right": return bottom and right
	return false


func _apply_fabric() -> void:
	_fabric_applied = true
	if fabric == "custom":
		if precision > 0:
			simulation_precision = precision
		return
	var preset := WasdClothFabrics.sheet(fabric)
	total_mass = maxf(float(preset["density"]) * size.x * size.y, 0.01)
	linear_stiffness = float(preset["stiffness"])
	damping_coefficient = float(preset["damping"])
	simulation_precision = precision if precision > 0 else int(preset["precision"])
	pressure_coefficient = 0.0


## The generated mesh is never saved, and neither are the soft-body settings that a fabric preset decides.
func _validate_property(property: Dictionary) -> void:
	var managed := ["total_mass", "linear_stiffness", "damping_coefficient", "simulation_precision", "pressure_coefficient"]
	if property["name"] == "mesh" or (fabric != "custom" and property["name"] in managed):
		property["usage"] = property["usage"] & ~PROPERTY_USAGE_STORAGE


## Build the grid mesh. Jolt numbers its points in the order the triangles first use them and pins by mesh vertex
## index, so the vertices are stored in that order: then both numberings agree, and forces on points near pinned
## ones reach the right points.
func _rebuild() -> void:
	_columns = maxi(1, roundi(size.x / cell))
	_rows = maxi(1, roundi(size.y / cell))
	var triangles: Array[int] = []
	for row in _rows:
		for column in _columns:
			var a := row * (_columns + 1) + column
			var b := a + 1
			var c := a + _columns + 1
			var d := c + 1
			# Alternating diagonals keep folds from following one direction.
			if (row + column) % 2 == 0:
				triangles.append_array([a, b, c, b, d, c])
			else:
				triangles.append_array([a, b, d, a, d, c])
	var order := {}
	_grid = PackedInt32Array()
	_grid.resize((_columns + 1) * (_rows + 1))
	var indices := PackedInt32Array()
	for grid_index in triangles:
		if not order.has(grid_index):
			order[grid_index] = order.size()
			_grid[grid_index] = order[grid_index]
		indices.append(order[grid_index])
	var count := order.size()
	_local = PackedVector3Array()
	_local.resize(count)
	var normals := PackedVector3Array()
	normals.resize(count)
	var tangents := PackedFloat32Array()
	tangents.resize(count * 4)
	var uvs := PackedVector2Array()
	uvs.resize(count)
	var normal := Vector3.BACK if facing == Facing.VERTICAL else Vector3.UP
	for row in _rows + 1:
		for column in _columns + 1:
			var index := _grid[row * (_columns + 1) + column]
			var u := float(column) / _columns
			var v := float(row) / _rows
			var x := (u - 0.5) * size.x
			var along := (v - 0.5) * size.y
			_local[index] = Vector3(x, -along, 0.0) if facing == Facing.VERTICAL else Vector3(x, 0.0, along)
			normals[index] = normal
			uvs[index] = Vector2(u, v)
			tangents[index * 4] = 1.0
			tangents[index * 4 + 3] = -1.0
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = _local
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TANGENT] = tangents
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	var grid_mesh := ArrayMesh.new()
	grid_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	if double_sided:
		var material := StandardMaterial3D.new()
		material.cull_mode = BaseMaterial3D.CULL_DISABLED
		material.albedo_color = Color(0.82, 0.8, 0.76)
		grid_mesh.surface_set_material(0, material)
	mesh = grid_mesh
	# The mass follows the area; until the sheet gets its parent, the fabric waits for the scene's values.
	if _fabric_applied:
		_apply_fabric()
