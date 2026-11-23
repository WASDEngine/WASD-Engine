# SPDX-License-Identifier: CC0-1.0
# A dungeon room of boxes that DungeonBoxRooms builds: a floor, a ceiling, and on every outer side of every cell a wall
# and a wall with a doorway. When the dungeon is generated, each side keeps one of the two: the doorway where the
# generator joined the room to another, the wall where it did not. A corridor piece opens its joined sides fully.
# Written by WASD Engine for SimpleDungeons; dedicated to the public domain.
class_name DungeonBoxRoom
extends DungeonRoom3D

## true opens a joined side from wall to wall, as a corridor piece does; false leaves a doorway.
@export var open_sides := false

## The rooms this room is joined to, by the name of the side that leads to each. Filled when the dungeon is done.
var joined := {}


func _ready() -> void:
	super._ready()
	if not dungeon_done_generating.is_connected(_keep_walls_or_doorways):
		dungeon_done_generating.connect(_keep_walls_or_doorways)


func _keep_walls_or_doorways() -> void:
	for door: Variant in get_doors():
		var marker: Node3D = door.door_node
		if not is_instance_valid(marker):
			continue
		var side := String(marker.name).get_slice("_", 1)
		var wall := get_node_or_null("Wall_" + side)
		var doorway := get_node_or_null("Doorway_" + side)
		var next_room: DungeonRoom3D = door.get_room_leads_to()
		if next_room != null:
			joined[side] = next_room
			if wall != null:
				wall.queue_free()
			if doorway != null:
				if open_sides:
					doorway.queue_free()
				else:
					doorway.visible = true
		elif doorway != null:
			doorway.queue_free()


## The middle of the opening on a joined side, on the floor, in the world: where a door, a gate, or a trigger goes.
func get_doorway_position(side: String) -> Vector3:
	var marker := get_node_or_null("DOOR?_" + side) as Node3D
	if marker == null:
		marker = get_node_or_null("DOOR_" + side) as Node3D
	if marker == null:
		return global_position
	return marker.global_position - global_basis.y * voxel_scale.y * 0.5 + global_basis.y * 0.3
