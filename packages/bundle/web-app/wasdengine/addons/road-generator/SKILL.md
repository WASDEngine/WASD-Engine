---
name: road-generator
description: Road Generator 0.9.5 is installed in this project. Its nodes build roads from points in code, with lanes and their markings, shoulders, bends and slopes, crossings where roads meet, collision, and lanes that traffic follows with RoadLaneAgent, and they draw in Web builds. Load before building a road, a street grid, a highway, or traffic.
---

# Road Generator 0.9.5

`res://addons/road-generator/` (MIT, by Moo-Ack! Productions; global classes, no plugin to enable; the editor panels and prefab pieces are left out). A road is a `RoadContainer` under a `RoadManager`; its `RoadPoint` children are cross-sections, and the add-on builds a mesh with markings and a collider between each two that are connected. It draws on every renderer.

## A road through places

```gdscript
var manager := RoadManager.new()
add_child(manager)
var highway := add_road(manager, [Vector3(0, 0, 0), Vector3(20, 2, -60), Vector3(60, 4, -110)], 2)


## A road through places, in order, with as many lanes each way.
func add_road(manager: RoadManager, places: Array[Vector3], lanes_each_way := 1) -> RoadContainer:
	var road := RoadContainer.new()
	road.generate_ai_lanes = true        # lanes for traffic; leave it out where nothing drives by itself
	manager.add_child(road)
	road._auto_refresh = false           # build once at the end, without warnings on the way
	var points := add_points(road, places, lanes_each_way)
	for index: int in points.size() - 1:
		points[index].connect_roadpoint(RoadPoint.PointInit.NEXT, points[index + 1], RoadPoint.PointInit.PRIOR)
	finish(road)
	return road


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
		point.auto_lanes = true          # markings to match: a double yellow line between the two ways
		var last := places.size() - 1
		var ahead := (places[mini(index + 1, last)] - places[maxi(index - 1, 0)]).normalized()
		point.transform = Transform3D(Basis.looking_at(-ahead, Vector3.UP), places[index])
		var reach := places[index].distance_to(places[index + 1] if index < last else places[index - 1]) * 0.35
		point.prior_mag = reach          # how far the bend reaches toward the point before, and the one after
		point.next_mag = reach
		points.append(point)
	return points


func finish(road: RoadContainer) -> void:
	road._auto_refresh = true
	road.rebuild_segments(true)
	road.update_edges()
	road.update_lane_seg_connections()
```

- A point's +Z is the way the road goes on (its "next" side), -Z its "prior" side. A point that faces the wrong way gives a twisted, pinched road.
- A lane is `lane_width` wide (4 m), with shoulders of `shoulder_width_l` and `shoulder_width_r` (2 m); points along one road may differ in lanes and widths, and the road widens between them. A point's height and tilt make slopes and banked bends.
- Keep points 20 to 80 m apart. A bend sharper than the road is wide folds the mesh: add a point.
- `road.material_resource` replaces the asphalt; its markings come from the add-on's texture, so a material of your own needs that layout. `road.collision_layer` with `override_collision_layers = true` sets the layers.
- After moving or adding points later, call `finish(road)` again.

## A crossing

A `RoadIntersection` joins the open ends of roads in the same container, at any angles, three ways or more:

```gdscript
var town := RoadContainer.new()
town.generate_ai_lanes = true
manager.add_child(town)
town._auto_refresh = false
var crossing := RoadIntersection.new()
town.add_child(crossing)
crossing.position = Vector3(0, 0, 0)
for arm: int in 4:
	var way := Vector3.FORWARD.rotated(Vector3.UP, arm * TAU / 4.0)
	var points := add_points(town, [crossing.position + way * 18.0, crossing.position + way * 70.0], 1)
	points[0].connect_roadpoint(RoadPoint.PointInit.NEXT, points[1], RoadPoint.PointInit.PRIOR)
	crossing.add_branch(points[0])       # the point nearest the crossing, 15 to 25 m from its middle
finish(town)
```

A street grid is one container with a crossing at every corner and two points on every street between corners.

## Traffic

With `generate_ai_lanes`, every segment and crossing holds `RoadLane` paths, joined end to end. A `RoadLaneAgent` child moves its parent along them; the parent must be a child of the `RoadManager`, or the agent's `road_manager_path` must point to it. Roads build once more at the end of the frame they entered the tree in, and a car on a lane that is rebuilt is freed with it (`road.auto_free_vehicles`), so wait a frame after `finish()`:

```gdscript
await get_tree().process_frame
var car := preload("res://cars/sedan.tscn").instantiate() as Node3D
car.position = Vector3(2, 0, 60)
manager.add_child(car)
var agent := RoadLaneAgent.new()
car.add_child(agent)
agent.assign_nearest_lane()              # FAILED when no lane lies within 50 m

func _physics_process(delta: float) -> void:
	if not is_instance_valid(agent.current_lane):
		return                           # the road ended; calling on without a lane is an error
	var to := agent.move_along_lane(speed * delta)
	if to.distance_to(car.global_position) > 0.01:
		car.look_at(to)
	car.global_position = to
```

At a crossing the agent goes straight on. `agent.change_lane(1)` moves a lane to the right (-1 left), and `agent.cars_in_lane(RoadLaneAgent.LaneChangeDir.CURRENT)` counts every car registered in its lane, its own included (`RIGHT` and `LEFT` the next lanes', -1 where there is none), to choose a lane; to brake behind a car, measure the distance to the others in `agent.current_lane.get_vehicles()` or cast a ray ahead. Lanes are also plain `Path3D` nodes, in the group `road_lanes`, for a path follower of your own.

## Pitfalls

- A player's car drives on the road's collider like on any ground; the lanes are only for traffic.
- The road does not shape terrain. Over `lite-terrain`, take each point's height from the terrain and add 0.15 m, with points close enough that no hill pokes through.
- It builds in the frame `finish()` is called: a street grid of nine crossings and a highway took 32 ms on desktop and 73 ms in a browser, where it then ran at 60 fps with twenty cars in its lanes. Build roads while the level loads.

## Check it

`godot_run`, then `godot_screenshot` from above and from a driver's height: lanes of even width, no pinched or folded segment, markings continuous across points. Drive or walk onto it to confirm the collider.
