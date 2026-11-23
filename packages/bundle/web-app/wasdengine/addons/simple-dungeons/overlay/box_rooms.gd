# SPDX-License-Identifier: CC0-1.0
# Room scenes for DungeonGenerator3D, built in code from boxes, so that a dungeon needs no room scene made by hand:
# rooms of any number of cells, a corridor piece, and stairs between two floors, each with a place for a door on
# every outer side. Rooms come with colliders. Written by WASD Engine for SimpleDungeons; dedicated to the public
# domain.
class_name DungeonBoxRooms
extends RefCounted

const ROOM := preload("res://addons/SimpleDungeons/box_room.gd")
## What a room is made with unless its options say otherwise.
const DEFAULTS := {
	"cell": Vector3(6.0, 4.0, 6.0), "min_count": 2, "max_count": 5, "door_width": 2.0, "door_height": 2.8,
	"wall_thickness": 0.3, "open_sides": false, "ceiling": true,
}

static var _made := 0


## A room `cells` wide and deep, one floor high. Options: "name"; "min_count" and "max_count", how many of it the
## dungeon holds (2 and 5); "cell", a grid cell's size in meters (6 by 4 by 6), which must be the generator's
## `voxel_scale`; "floor", "wall", and "roof", materials; "ceiling" (true; false leaves the room open above, for a
## camera that looks down); "door_width" (2.0) and "door_height" (2.8); "wall_thickness" (0.3).
static func room(cells: Vector2i, options := {}) -> PackedScene:
	var o := _options(options)
	var cell: Vector3 = o["cell"]
	var size := Vector3(cells.x * cell.x, cell.y, cells.y * cell.z)
	var root := _root("Room%dx%d" % [cells.x, cells.y], Vector3i(cells.x, 1, cells.y), o)
	_slab(root, "Floor", Vector3(size.x, 0.3, size.z), Vector3(0, -size.y * 0.5 + 0.15, 0), o["floor"])
	if o["ceiling"]:
		_slab(root, "Ceiling", Vector3(size.x, 0.3, size.z), Vector3(0, size.y * 0.5 - 0.15, 0), o["roof"])
	var side := 0
	for x: int in cells.x:
		for z: int in cells.y:
			var middle := Vector3((x + 0.5) * cell.x - size.x * 0.5, 0.0, (z + 0.5) * cell.z - size.z * 0.5)
			for way: Vector3 in [Vector3.LEFT, Vector3.RIGHT, Vector3.FORWARD, Vector3.BACK]:
				var beyond := Vector2i(x + int(way.x), z + int(way.z))
				if beyond.x >= 0 and beyond.x < cells.x and beyond.y >= 0 and beyond.y < cells.y:
					continue
				_side(root, str(side), middle, way, -size.y * 0.5, true, o)
				side += 1
	return _pack(root)


## A corridor piece: one cell whose joined sides open from wall to wall. The dungeon uses as many as it needs.
static func corridor(options := {}) -> PackedScene:
	var merged := options.duplicate()
	merged["open_sides"] = true
	merged["name"] = merged.get("name", "Corridor")
	merged["min_count"] = 0
	merged["max_count"] = 9999
	return room(Vector2i(1, 1), merged)


## Stairs between two floors: a ramp two cells long and two floors high, entered at its foot from the +X end of the
## lower floor and left at its head from the -X end of the upper floor. A dungeon of more than one floor needs it.
## Options as for `room()`; "min_count" is 1 and "max_count" 8 unless given.
static func stairs(options := {}) -> PackedScene:
	var merged := options.duplicate()
	merged["min_count"] = merged.get("min_count", 1)
	merged["max_count"] = merged.get("max_count", 8)
	var o := _options(merged)
	var cell: Vector3 = o["cell"]
	var size := Vector3(cell.x * 2.0, cell.y * 2.0, cell.z)
	var root := _root("Stairs", Vector3i(2, 2, 1), o)
	root.is_stair_room = true
	var thick: float = o["wall_thickness"]
	_slab(root, "Floor", Vector3(size.x, 0.3, size.z), Vector3(0, -size.y * 0.5 + 0.15, 0), o["floor"])
	if o["ceiling"]:
		_slab(root, "Ceiling", Vector3(size.x, 0.3, size.z), Vector3(0, size.y * 0.5 - 0.15, 0), o["roof"])
	# The ramp climbs one floor from the +X end to the -X end, from the top of the lower floor to the top of a landing
	# that lies level with the upper floor's rooms.
	var run := size.x - 1.5
	var long := sqrt(run * run + cell.y * cell.y)
	var ramp := _slab(root, "Ramp", Vector3(long, 0.3, size.z - thick * 2.0), Vector3(0.75, -cell.y * 0.5 + 0.3 - 0.15 * long / run, 0), o["floor"])
	ramp.rotation.z = -atan2(cell.y, run)
	_slab(root, "Landing", Vector3(1.5, 0.3, size.z - thick * 2.0), Vector3(-size.x * 0.5 + 0.75, 0.15, 0), o["floor"])
	# Long walls on both sides, two floors high.
	for way: float in [-1.0, 1.0]:
		_slab(root, "LongWall", Vector3(size.x, size.y, thick), Vector3(0, 0, way * (size.z - thick) * 0.5), o["wall"])
	# The foot: a doorway below and a wall above, at the +X end. The head: a wall below and a doorway above, at -X.
	var low_cell := Vector3(cell.x * 0.5, -cell.y * 0.5, 0.0)
	var high_cell := Vector3(-cell.x * 0.5, cell.y * 0.5, 0.0)
	_side(root, "foot", low_cell, Vector3.RIGHT, -size.y * 0.5, false, o)
	_slab(root, "EndWall", Vector3(thick, cell.y, size.z), Vector3((size.x - thick) * 0.5, cell.y * 0.5, 0), o["wall"])
	_side(root, "head", high_cell, Vector3.LEFT, 0.0, false, o)
	_slab(root, "EndWall", Vector3(thick, cell.y, size.z), Vector3(-(size.x - thick) * 0.5, -cell.y * 0.5, 0), o["wall"])
	return _pack(root)


static func _options(options: Dictionary) -> Dictionary:
	var o := DEFAULTS.duplicate()
	o.merge(options, true)
	for part: Array in [["floor", Color(0.36, 0.34, 0.32)], ["wall", Color(0.55, 0.52, 0.48)], ["roof", Color(0.3, 0.29, 0.28)]]:
		if not o.has(part[0]) or o[part[0]] == null:
			var paint := StandardMaterial3D.new()
			paint.albedo_color = part[1]
			paint.roughness = 0.9
			o[part[0]] = paint
	return o


static func _root(name: String, cells: Vector3i, o: Dictionary) -> DungeonBoxRoom:
	var root := Node3D.new()
	root.set_script(ROOM)
	var room: DungeonBoxRoom = root
	room.name = o.get("name", name)
	room.voxel_scale = o["cell"]
	room.size_in_voxels = cells
	room.min_count = o["min_count"]
	room.max_count = o["max_count"]
	room.open_sides = o["open_sides"]
	return room


## A box with its collider, as a child of `under` and owned by `root`, so that the packed scene keeps it.
static func _slab(root: Node3D, name: String, size: Vector3, at: Vector3, material: Material, under: Node3D = null) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.name = name
	body.position = at
	var mesh := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = size
	box.material = material
	mesh.mesh = box
	body.add_child(mesh)
	var shape := CollisionShape3D.new()
	var form := BoxShape3D.new()
	form.size = size
	shape.shape = form
	body.add_child(shape)
	var parent := under if under != null else root
	parent.add_child(body, true)
	for node: Node in [body, mesh, shape]:
		node.owner = root
	return body


## One outer side of a cell whose middle is `middle`: the place of a door, a wall, and a wall with a doorway.
## `optional` lets the generator leave the side closed.
static func _side(root: Node3D, name: String, middle: Vector3, way: Vector3, floor_y: float, optional: bool, o: Dictionary) -> void:
	var cell: Vector3 = o["cell"]
	var thick: float = o["wall_thickness"]
	var along := cell.z if way.x != 0.0 else cell.x
	var out := (cell.x if way.x != 0.0 else cell.z) * 0.5
	var marker := Node3D.new()
	marker.name = ("DOOR?_" if optional else "DOOR_") + name
	marker.position = Vector3(middle.x, floor_y + cell.y * 0.5, middle.z) + way * out
	root.add_child(marker)
	marker.owner = root
	var centre := Vector3(middle.x, floor_y + cell.y * 0.5, middle.z) + way * (out - thick * 0.5)
	var turned := way.x != 0.0
	var wall := Node3D.new()
	wall.name = "Wall_" + name
	root.add_child(wall)
	wall.owner = root
	_slab(root, "Box", Vector3(thick, cell.y, along) if turned else Vector3(along, cell.y, thick), centre, o["wall"], wall)
	var doorway := Node3D.new()
	doorway.name = "Doorway_" + name
	doorway.visible = false
	root.add_child(doorway)
	doorway.owner = root
	var door_width: float = minf(o["door_width"], along - 0.4)
	var door_height: float = minf(o["door_height"], cell.y - 0.5)
	var beside := (along - door_width) * 0.5
	for part: float in [-1.0, 1.0]:
		var shift := part * (door_width + beside) * 0.5
		var at := centre + (Vector3(0, 0, shift) if turned else Vector3(shift, 0, 0))
		_slab(root, "Jamb", Vector3(thick, cell.y, beside) if turned else Vector3(beside, cell.y, thick), at, o["wall"], doorway)
	var over := cell.y - door_height
	_slab(root, "Lintel", Vector3(thick, over, door_width) if turned else Vector3(door_width, over, thick), centre + Vector3(0, (cell.y - over) * 0.5, 0), o["wall"], doorway)


static func _pack(root: Node3D) -> PackedScene:
	var packed := PackedScene.new()
	packed.pack(root)
	# The generator tells kinds of rooms apart by their scene's path, so each built scene gets a path of its own.
	_made += 1
	packed.take_over_path("res://addons/SimpleDungeons/built/%s_%d.tscn" % [root.name, _made])
	root.free()
	return packed
