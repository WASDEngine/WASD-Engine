# SPDX-License-Identifier: CC0-1.0
# Footprints behind whatever this node is a child of: a player, an enemy, an animal. Each physics frame it measures
# how far its parent has walked, and every `stride` meters it lays a print on the ground under itself, the left foot
# and the right in turn, pointing the way the parent walks. Its signal `stepped` tells where each foot lands, for a
# footstep sound or a puff of dust.
class_name WasdFootprints3D
extends Node3D

## A foot has landed at a world position; `left` tells which foot.
signal stepped(at: Vector3, left: bool)

## Meters walked between one print and the next.
@export_range(0.1, 5.0, 0.01) var stride := 0.7
## Meters between the line of left prints and the line of right prints.
@export_range(0.0, 2.0, 0.01) var spacing := 0.26
## Length of a print in meters.
@export_range(0.05, 3.0, 0.01) var size := 0.3: set = _set_size
## Color of the prints; its alpha makes them fainter. Dark for mud and wet shoes, pale blue-gray for dents in snow.
@export var tint := Color(0.08, 0.065, 0.05, 0.8): set = _set_tint
## Seconds a print stays; 0 keeps prints until the oldest is replaced.
@export_range(0.0, 600.0, 0.1) var lifetime := 20.0: set = _set_lifetime
## Most prints at once.
@export_range(2, 1024, 1) var capacity := 64: set = _set_capacity
## false stops the prints and keeps the signal: for footstep sounds on ground that takes no print.
@export var prints := true
## Physics layers the ground is on.
@export_flags_3d_physics var ground_mask := 1
## How far below this node the ground may lie for a foot to land on it, in meters.
@export_range(0.05, 5.0, 0.01) var reach := 0.5

var _pool := WasdDecals3D.new()
var _last := Vector3.ZERO
var _walked := 0.0
var _left := true
var _started := false


func _init() -> void:
	_pool.mark = "footprint"
	_pool.size = size
	_pool.tint = tint
	_pool.lifetime = lifetime
	_pool.capacity = capacity
	add_child(_pool)


## The pool that holds the prints, to give it a texture of the game's own (`mark = ""`), such as a paw.
func get_pool() -> WasdDecals3D:
	return _pool


## Removes every print.
func clear() -> void:
	_pool.clear()


func _physics_process(_delta: float) -> void:
	var here := global_position
	if not _started:
		_started = true
		_last = here
		return
	var moved := here - _last
	_last = here
	moved.y = 0.0
	var step := moved.length()
	# A jump across the level is not a walk.
	if step > 5.0 or step < 0.00001:
		return
	_walked += step
	if _walked < stride:
		return
	var query := PhysicsRayQueryParameters3D.create(here + Vector3.UP * 0.3, here + Vector3.DOWN * reach, ground_mask)
	var body := get_parent() as CollisionObject3D
	if body != null:
		query.exclude = [body.get_rid()]
	var hit := get_world_3d().direct_space_state.intersect_ray(query)
	if hit.is_empty():
		# In the air: the next print comes where the parent lands.
		_walked = stride
		return
	_walked = 0.0
	var normal := hit["normal"] as Vector3
	var ahead := moved / step
	var beside := ahead.cross(normal).normalized() * spacing * (-0.5 if _left else 0.5)
	var at := (hit["position"] as Vector3) + beside
	if prints:
		_pool.add_toward(at, normal, ahead, size, 0 if _left else 1)
	stepped.emit(at, _left)
	_left = not _left


func _set_size(value: float) -> void:
	size = value
	_pool.size = value


func _set_tint(value: Color) -> void:
	tint = value
	_pool.tint = value


func _set_lifetime(value: float) -> void:
	lifetime = value
	_pool.lifetime = value


func _set_capacity(value: int) -> void:
	capacity = value
	_pool.capacity = value
