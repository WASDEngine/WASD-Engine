extends Node3D
## Road Generator smoke test (render run on the Compatibility renderer): a road through five places and a crossing of
## four roads are built from code as the guide shows; they have meshes, collision under a ray, and lanes; a lane agent
## drives through the crossing onto the road beyond; and the picture shows asphalt with a yellow middle line.

const ID := "road-generator"


func _ready() -> void:
	get_tree().create_timer(90.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


## A road through places, in order, with as many lanes each way; the guide's helper.
func add_road(manager: RoadManager, places: Array[Vector3], lanes_each_way := 1) -> RoadContainer:
	var road := RoadContainer.new()
	road.generate_ai_lanes = true
	manager.add_child(road)
	road._auto_refresh = false
	var points := add_points(road, places, lanes_each_way)
	for index: int in points.size() - 1:
		points[index].connect_roadpoint(RoadPoint.PointInit.NEXT, points[index + 1], RoadPoint.PointInit.PRIOR)
	finish(road)
	return road


## Road points at places, each facing along the way through them: a point's +Z is the way the road goes on.
func add_points(road: RoadContainer, places: Array[Vector3], lanes_each_way: int) -> Array[RoadPoint]:
	var points: Array[RoadPoint] = []
	for index: int in places.size():
		var point := RoadPoint.new()
		road.add_child(point)
		var ways: Array[RoadPoint.LaneDir] = []
		for lane: int in lanes_each_way:
			ways.append(RoadPoint.LaneDir.REVERSE)
		for lane: int in lanes_each_way:
			ways.append(RoadPoint.LaneDir.FORWARD)
		point.traffic_dir = ways
		point.auto_lanes = true
		var last := places.size() - 1
		var ahead := (places[mini(index + 1, last)] - places[maxi(index - 1, 0)]).normalized()
		point.transform = Transform3D(Basis.looking_at(-ahead, Vector3.UP), places[index])
		var reach := places[index].distance_to(places[index + 1] if index < last else places[index - 1]) * 0.35
		point.prior_mag = reach
		point.next_mag = reach
		points.append(point)
	return points


func finish(road: RoadContainer) -> void:
	road._auto_refresh = true
	road.rebuild_segments(true)
	road.update_edges()
	road.update_lane_seg_connections()


func _count(root: Node, kind: Callable) -> int:
	var found := 0
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if kind.call(node):
			found += 1
		stack.append_array(node.get_children())
	return found


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.2, 0.5, 0.9)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	add_child(world)
	var camera := Camera3D.new()
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = 60.0
	camera.position = Vector3(0, 80, 40)
	camera.rotation_degrees = Vector3(-90, 0, 0)
	add_child(camera)
	var manager := RoadManager.new()
	add_child(manager)

	# A road of two lanes each way that bends and climbs, far from the crossing.
	var places: Array[Vector3] = []
	for index: int in 5:
		places.append(Vector3(200.0 + sin(index * 0.4) * 40.0, index * 2.0, -index * 30.0))
	var bend := add_road(manager, places, 2)
	if bend.get_segments().size() != 4:
		return _fail("a road through five places has %d segments" % [bend.get_segments().size()])
	if _count(bend, func(node: Node) -> bool: return node is MeshInstance3D and (node as MeshInstance3D).mesh != null) < 4:
		return _fail("the road has no mesh on every segment")
	if _count(bend, func(node: Node) -> bool: return node is RoadLane) != 16:
		return _fail("four segments of four lanes hold %d lanes" % [_count(bend, func(node: Node) -> bool: return node is RoadLane)])

	# Four roads of one lane each way that meet in a crossing at the origin.
	var town := RoadContainer.new()
	town.generate_ai_lanes = true
	manager.add_child(town)
	town._auto_refresh = false
	var crossing := RoadIntersection.new()
	town.add_child(crossing)
	for arm: int in 4:
		var way := Vector3.FORWARD.rotated(Vector3.UP, arm * TAU / 4.0)
		var ends: Array[Vector3] = [way * 18.0, way * 70.0]
		var points := add_points(town, ends, 1)
		points[0].connect_roadpoint(RoadPoint.PointInit.NEXT, points[1], RoadPoint.PointInit.PRIOR)
		crossing.add_branch(points[0])
	finish(town)
	for _i: int in 4:
		await get_tree().physics_frame
	if crossing.edge_points.size() != 4:
		return _fail("the crossing has %d branches" % [crossing.edge_points.size()])
	# Collision: a ray down onto an arm of the crossing and onto its middle.
	var space := get_world_3d().direct_space_state
	for at: Vector3 in [Vector3(0, 0, 45), Vector3(0, 0, 0)]:
		var hit := space.intersect_ray(PhysicsRayQueryParameters3D.create(at + Vector3.UP * 5.0, at + Vector3.DOWN * 5.0))
		if hit.is_empty() or absf((hit["position"] as Vector3).y) > 0.3:
			return _fail("a ray down at %s hit %s" % [at, hit.get("position", "nothing")])

	# A car under the manager, on the lane that leads into the crossing from +Z, drives through it.
	var car := Node3D.new()
	car.position = Vector3(2, 0, 60)
	manager.add_child(car)
	var agent := RoadLaneAgent.new()
	car.add_child(agent)
	if agent.assign_nearest_lane() != OK:
		return _fail("the agent found no lane near %s" % [car.position])
	var lanes_driven := {}
	for frame: int in 400:
		if not is_instance_valid(agent.current_lane):
			return _fail("the agent lost its lane at %s" % [car.global_position])
		lanes_driven[agent.current_lane] = true
		car.global_position = agent.move_along_lane(0.3)
	if car.global_position.z > -40.0 or lanes_driven.size() < 3:
		return _fail("the car drove %d lanes and stopped at %s, not beyond the crossing" % [lanes_driven.size(), car.global_position])

	# The picture: asphalt, and the yellow line down the middle of the arm that runs toward the camera's bottom edge.
	for _i: int in 4:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/road.png"))
	var asphalt := 0
	var yellow := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			if pixel.r > 0.55 and pixel.g > 0.45 and pixel.b < 0.3:
				yellow += 1
			elif absf(pixel.r - pixel.g) < 0.06 and absf(pixel.g - pixel.b) < 0.06 and pixel.r < 0.5:
				asphalt += 1
	if asphalt < 800 or yellow < 20:
		return _fail("the picture has %d asphalt and %d yellow samples" % [asphalt, yellow])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
