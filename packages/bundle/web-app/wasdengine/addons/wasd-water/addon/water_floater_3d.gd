# SPDX-License-Identifier: CC0-1.0
# Makes a RigidBody3D float on WasdWater3D. Put one at each corner of a boat's hull, or one in the middle of a crate:
# each pushes its body up while it is under the surface, harder the deeper it is, and slows the body in the water.
# The body rides the waves, tilts with them, and drifts with the current.
class_name WasdWaterFloater3D
extends Node3D

## The floater went under the surface, at `speed` m/s downward. Splash sounds and particles start here.
signal entered_water(speed: float)
## The floater came out of the water.
signal left_water

## The water to float on. Empty finds the water at the floater's position.
@export_node_path("MeshInstance3D") var water: NodePath
## Lift when fully under water, as a multiple of this floater's share of the body's weight: 1 hangs in the water,
## 2 floats half under, more rides higher.
@export_range(0.0, 10.0, 0.05) var buoyancy := 2.0
## Depth at which the floater is fully under water and its lift stops growing: about the height of the hull.
@export_range(0.05, 10.0, 0.05, "suffix:m") var submerge_depth := 0.5
## How strongly the water slows the body where this floater is.
@export_range(0.0, 20.0, 0.05) var drag := 2.5
## How strongly the current carries the body, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var current_pull := 1.0
## Start rings on the water when the floater falls in.
@export var splash_rings := true

var _body: RigidBody3D
var _share := 1.0
var _in_water := false


func _ready() -> void:
	_body = get_parent() as RigidBody3D
	if _body == null:
		push_warning("WasdWaterFloater3D: the parent of %s is not a RigidBody3D, so it does nothing." % name)
		set_physics_process(false)
		return
	var floaters := 0
	for sibling in _body.get_children():
		if sibling is WasdWaterFloater3D:
			floaters += 1
	_share = 1.0 / maxi(floaters, 1)


func _physics_process(_delta: float) -> void:
	var at := global_position
	var body_of_water := get_node_or_null(water) as WasdWater3D if not water.is_empty() else WasdWater3D.find(get_tree(), at)
	var under := 0.0
	if body_of_water != null and body_of_water.contains(at):
		under = body_of_water.depth_at(at)
	if under <= 0.0 or under > body_of_water.depth:
		if _in_water:
			_in_water = false
			left_water.emit()
		return
	var arm := at - _body.global_position
	var velocity := _body.linear_velocity + _body.angular_velocity.cross(arm)
	if not _in_water:
		_in_water = true
		entered_water.emit(maxf(-velocity.y, 0.0))
		if splash_rings and body_of_water.shape != WasdWater3D.Shape.PATH:
			body_of_water.add_ripple(at, clampf(-velocity.y * 0.5, 0.5, 3.0))
	var deep := clampf(under / submerge_depth, 0.0, 1.0)
	var weight := _body.mass * _share * float(ProjectSettings.get_setting("physics/3d/default_gravity", 9.8)) * _body.gravity_scale
	var push := Vector3.UP * weight * buoyancy * deep
	var through := velocity - body_of_water.flow_at(at) * current_pull
	push -= through * drag * _body.mass * _share * deep
	_body.apply_force(push, arm)


## Whether the floater is under the surface now.
func is_in_water() -> bool:
	return _in_water
