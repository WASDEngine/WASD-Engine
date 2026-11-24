extends Node3D
## SimpleDungeons smoke test (render run on the Compatibility renderer): a one-floor and a two-floor dungeon generate
## from box rooms built in code; every kind of room is there in its own shape; the same seed gives the same dungeon;
## each joined side has an open doorway that a ball passes through and each other side a wall; a walker climbs the
## stairs from the lower floor to the upper; the rooms show in the picture; and a room of the game's own keeps its size
## when its voxel_scale is the dungeon's, while one left at the default is squashed to fit.

const ID := "simple-dungeons"
const CELL := Vector3(6, 4, 6)


func _ready() -> void:
	get_tree().create_timer(120.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _dungeon(floors: int, seed_number: int, at: Vector3) -> DungeonGenerator3D:
	var open := {"ceiling": false}
	var dungeon := DungeonGenerator3D.new()
	dungeon.voxel_scale = CELL
	dungeon.dungeon_size = Vector3i(9, floors, 9)
	dungeon.generate_on_ready = false
	var blue := StandardMaterial3D.new()
	blue.albedo_color = Color(0.2, 0.4, 0.9)
	var scenes: Array[PackedScene] = [DungeonBoxRooms.room(Vector2i(2, 2), open), DungeonBoxRooms.room(Vector2i(3, 2), {"ceiling": false, "floor": blue, "max_count": 3})]
	if floors > 1:
		scenes.append(DungeonBoxRooms.stairs(open))
	dungeon.room_scenes = scenes
	dungeon.corridor_room_scene = DungeonBoxRooms.corridor(open)
	dungeon.position = at
	add_child(dungeon)
	dungeon.generate(seed_number)
	return dungeon


## A room of one cell as the guide makes a room of the game's own: a DungeonRoom3D root with a door marker in the
## middle of each outer side, packed into a scene of its own path. A `cell` of zero leaves `voxel_scale` at its default.
func _own_room(room_name: String, cell: Vector3) -> PackedScene:
	var room := DungeonRoom3D.new()
	room.name = room_name
	if cell != Vector3.ZERO:
		room.voxel_scale = cell
	room.size_in_voxels = Vector3i.ONE
	room.min_count = 1
	room.max_count = 1
	for side: String in ["W", "E", "N", "S"]:
		var way: Vector3 = {"W": Vector3.LEFT, "E": Vector3.RIGHT, "N": Vector3.FORWARD, "S": Vector3.BACK}[side]
		var door := Node3D.new()
		door.name = "DOOR?_" + side
		door.position = way * room.voxel_scale * 0.5
		room.add_child(door)
		door.owner = room
	var packed := PackedScene.new()
	packed.pack(room)
	packed.take_over_path("res://wasd_smoke/%s.tscn" % [room_name])
	room.free()
	return packed


func _rooms(dungeon: DungeonGenerator3D) -> Array[DungeonRoom3D]:
	var rooms: Array[DungeonRoom3D] = []
	var stack: Array[Node] = [dungeon]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if node is DungeonRoom3D:
			rooms.append(node)
		stack.append_array(node.get_children())
	return rooms


func _layout(dungeon: DungeonGenerator3D) -> String:
	var lines: Array[String] = []
	for room: DungeonRoom3D in _rooms(dungeon):
		lines.append("%s %s" % [String(room.name).get_slice("_", 0), room.position.snapped(Vector3.ONE * 0.1)])
	lines.sort()
	return "; ".join(lines)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.02, 0.02, 0.03)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	add_child(world)
	var camera := Camera3D.new()
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = 62.0
	camera.position = Vector3(0, 60, 0)
	camera.rotation_degrees = Vector3(-90, 0, 0)
	add_child(camera)

	# One floor.
	var flat := _dungeon(1, 7, Vector3.ZERO)
	for _i: int in 6:
		await get_tree().physics_frame
	if flat.stage != DungeonGenerator3D.BuildStage.DONE:
		return _fail("the one-floor dungeon stopped at stage %s" % [flat.stage])
	var kinds := {}
	var space := get_world_3d().direct_space_state
	var ball := SphereShape3D.new()
	ball.radius = 0.5
	var doorways := 0
	for room: DungeonRoom3D in _rooms(flat):
		var kind := String(room.name).get_slice("_", 0)
		kinds[kind] = int(kinds.get(kind, 0)) + 1
		var cells := room.size_in_voxels
		var floor_mesh := (room.get_node("Floor").get_child(0) as MeshInstance3D).mesh as BoxMesh
		if not is_equal_approx(floor_mesh.size.x, cells.x * CELL.x) or not is_equal_approx(floor_mesh.size.z, cells.z * CELL.z):
			return _fail("%s of %s cells has a floor of %s" % [room.name, cells, floor_mesh.size])
		for marker: Node3D in room.get_door_nodes():
			var side := String(marker.name).get_slice("_", 1)
			var wall := room.get_node_or_null("Wall_" + side)
			var joined: bool = (room as DungeonBoxRoom).joined.has(side)
			if joined == (wall != null and not wall.is_queued_for_deletion()):
				return _fail("%s side %s is joined %s and has its wall %s" % [room.name, side, joined, wall != null])
			if not joined:
				continue
			doorways += 1
			if (room as DungeonBoxRoom).get_doorway_position(side).distance_to(marker.global_position) > CELL.y:
				return _fail("the doorway of %s side %s is reported at %s" % [room.name, side, (room as DungeonBoxRoom).get_doorway_position(side)])
			# A ball at walking height passes from a meter inside the room to a meter beyond the doorway.
			var middle := marker.global_position
			middle.y = room.global_position.y - CELL.y * 0.5 + 1.2
			var inward := (room.global_position - marker.global_position)
			inward.y = 0.0
			inward = inward.normalized() if inward.length() > 0.01 else Vector3.ZERO
			var out := Vector3(signf(marker.position.x) if absf(marker.position.x) > absf(marker.position.z) else 0.0, 0, signf(marker.position.z) if absf(marker.position.z) >= absf(marker.position.x) else 0.0)
			out = room.global_basis * out
			var query := PhysicsShapeQueryParameters3D.new()
			query.shape = ball
			query.transform = Transform3D(Basis.IDENTITY, middle - out * 1.2)
			query.motion = out * 2.4
			var travel := space.cast_motion(query)
			if travel[0] < 0.999:
				return _fail("a ball stops %.2f of the way through the doorway of %s side %s" % [travel[0], room.name, side])
	if int(kinds.get("Room2x2", 0)) < 2 or int(kinds.get("Room3x2", 0)) < 2 or int(kinds.get("Corridor", 0)) < 1 or doorways < 8:
		return _fail("the one-floor dungeon holds %s with %d joined sides" % [kinds, doorways])
	# The same seed gives the same dungeon; another seed another.
	var again := _dungeon(1, 7, Vector3(0, 100, 0))
	var other := _dungeon(1, 8, Vector3(0, 200, 0))
	for _i: int in 4:
		await get_tree().physics_frame
	if _layout(again) != _layout(flat) or _layout(other) == _layout(flat):
		return _fail("seeds: the same seed gave the same dungeon %s, another seed another %s" % [_layout(again) == _layout(flat), _layout(other) != _layout(flat)])
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/dungeon.png"))
	var blue_floor := 0
	var lit := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			if pixel.b > 0.6 and pixel.r < 0.4:
				blue_floor += 1
			if pixel.get_luminance() > 0.2:
				lit += 1
	if blue_floor < 400 or lit < 2000:
		return _fail("the picture shows %d samples of the blue rooms' floors and %d lit samples" % [blue_floor, lit])

	# Two floors: stairs join them, and a walker climbs them.
	var tall := _dungeon(2, 7, Vector3(0, 400, 0))
	for _i: int in 6:
		await get_tree().physics_frame
	if tall.stage != DungeonGenerator3D.BuildStage.DONE:
		return _fail("the two-floor dungeon stopped at stage %s" % [tall.stage])
	var stairs: DungeonRoom3D = null
	var upper := 0
	for room: DungeonRoom3D in _rooms(tall):
		if String(room.name).begins_with("Stairs"):
			stairs = room
		elif room.position.y > 0.1:
			upper += 1
	if stairs == null or upper < 1:
		return _fail("the two-floor dungeon has stairs %s and %d rooms on its upper floor" % [stairs != null, upper])
	var walker := CharacterBody3D.new()
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.35
	capsule.height = 1.7
	shape.shape = capsule
	shape.position.y = 0.85
	walker.add_child(shape)
	add_child(walker)
	# From just inside the foot of the stairs, at the +X end of the lower floor, toward the head at -X.
	var foot := stairs.global_transform * Vector3(CELL.x - 0.6, -CELL.y + 1.0, 0.0)
	var up_the_ramp := (stairs.global_basis * Vector3.LEFT).normalized()
	walker.global_position = foot
	for _i: int in 900:
		walker.velocity = up_the_ramp * 4.0 + Vector3.DOWN * 3.0
		walker.move_and_slide()
		await get_tree().physics_frame
		if walker.global_position.y - (foot.y - 0.7) > CELL.y - 0.1:
			break
	var climbed := walker.global_position.y - (foot.y - 0.7)
	if climbed < CELL.y - 0.3:
		return _fail("the walker climbed %.2f m of the stairs' %.1f m, to %s in the stairs' own space" % [climbed, CELL.y, stairs.to_local(walker.global_position)])

	# Rooms of the game's own: one with the dungeon's voxel_scale keeps its size; one left at the default is squashed.
	var own := DungeonGenerator3D.new()
	own.voxel_scale = CELL
	own.dungeon_size = Vector3i(6, 1, 6)
	own.generate_on_ready = false
	var own_scenes: Array[PackedScene] = [_own_room("Shrine", CELL), _own_room("DefaultShrine", Vector3.ZERO)]
	own.room_scenes = own_scenes
	own.corridor_room_scene = DungeonBoxRooms.corridor()
	own.position = Vector3(400, 0, 0)
	add_child(own)
	own.generate(3)
	for _i: int in 6:
		await get_tree().physics_frame
	if own.stage != DungeonGenerator3D.BuildStage.DONE:
		return _fail("the dungeon of the game's own rooms stopped at stage %s" % [own.stage])
	var scales := {}
	for room: DungeonRoom3D in _rooms(own):
		scales[String(room.name).get_slice("_", 0)] = room.basis.get_scale()
	if not (scales.get("Shrine", Vector3.ZERO) as Vector3).is_equal_approx(Vector3.ONE) or not (scales.get("DefaultShrine", Vector3.ZERO) as Vector3).is_equal_approx(CELL / 10.0):
		return _fail("rooms of the game's own are scaled %s" % [scales])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
