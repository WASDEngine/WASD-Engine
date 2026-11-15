extends SceneTree
## Smoke test of the wasd-cloth catalog entry on Godot 4.7.2 with Jolt Physics: a flag pinned to a pole in wind, a
## tablecloth dropped onto a table, a spring-bone cape on a skeleton that runs, a banner with the flag shader, a custom
## sheet whose scene sets its own soft-body settings before its script, a sail in a wind zone turned half around, a
## turned curtain that gets a new size, cell, pinned edge, pin rows, and pin target while it hangs, and an awning that
## turns from hanging to lying. After three seconds of physics it checks that every point is a number, pins held,
## edges kept their length, the tablecloth rests on the table, the cape has its chains and colliders and swung, the
## wind blows, the flag has its fabric's settings and the custom sheet its own, the sail went the way of the zone's
## world direction, and the curtain and the awning were built again where they rest, pinned anew, the curtain's pins
## following the pole.

const SECONDS := 3.0

var scene: Node
var ticks := 0
var failures: Array[String] = []
var flag_start := PackedVector3Array()
var tip_rest := Vector3.ZERO
var tip_travel := 0.0
## Sum and count of the sail's bottom-row Z over the last second.
var sail_drift := 0.0
var sail_samples := 0
## The tick the curtain and the awning change on, and the tick after which the pole stops moving.
const CHANGE_TICK := 20
const POLE_STOP_TICK := 150
## The curtain as the scene places it, and the pole when the curtain is pinned to it.
var curtain_rest := Transform3D()
var pole_at_change := Transform3D()


func _initialize() -> void:
	scene = (load("res://wasd_smoke/smoke.tscn") as PackedScene).instantiate()
	root.add_child(scene)
	# The scene's root sits at the origin, so the curtain's transform is where it rests in the world.
	curtain_rest = (scene.get_node("Curtain") as Node3D).transform
	var skeleton := scene.get_node("Hero/Skeleton3D") as Skeleton3D
	skeleton.skeleton_updated.connect(_on_skeleton_updated.bind(skeleton))


## The spring bones' pose exists while the skeleton reports its update; the cape's middle tip is measured there.
func _on_skeleton_updated(skeleton: Skeleton3D) -> void:
	var tip := skeleton.get_bone_global_pose(skeleton.find_bone("cloth_cape_02_05")).origin
	if tip_rest == Vector3.ZERO:
		tip_rest = tip
	tip_travel = maxf(tip_travel, tip.distance_to(tip_rest))


func check(ok: bool, message: String) -> void:
	if not ok:
		failures.append(message)


func _physics_process(delta: float) -> bool:
	ticks += 1
	var flag := scene.get_node("Flag") as WasdClothSheet3D
	var hero := scene.get_node("Hero") as Node3D
	if ticks == 1:
		for index in flag.pinned_indices():
			flag_start.append(flag.get_point_transform(index))
		return false
	hero.position.x = -5.0 + 2.0 * sin(ticks * delta * 3.0)
	if ticks == CHANGE_TICK:
		reshape()
	elif ticks > CHANGE_TICK and ticks <= POLE_STOP_TICK:
		(scene.get_node("Pole") as Node3D).position.y += 0.002
	if ticks == CHANGE_TICK + 1:
		# A sheet hanging in still air keeps its plane; a nudge across it lets the cloth fold where it is free.
		var curtain := scene.get_node("Curtain") as WasdClothSheet3D
		curtain.apply_impulse(curtain.point_at(curtain.grid_size().x, 0), Vector3(0.002, 0, 0))
	if ticks * delta >= SECONDS - 1.0:
		sail_drift += bottom_z(scene.get_node("Sail") as WasdClothSheet3D)
		sail_samples += 1
	if ticks * delta < SECONDS:
		return false
	finish(flag)
	return true


## Changes the curtain and the awning while they hang: the curtain gets a new size, cell, pinned edge, pin rows, and
## pin target, and the awning lies down.
func reshape() -> void:
	var curtain := scene.get_node("Curtain") as WasdClothSheet3D
	curtain.size = Vector2(1.6, 0.8)
	curtain.cell = 0.08
	curtain.pinned_edges = PackedStringArray(["left"])
	curtain.pin_rows = 2
	var pole := scene.get_node("Pole") as Node3D
	pole_at_change = pole.global_transform
	curtain.pin_target = curtain.get_path_to(pole)
	(scene.get_node("Awning") as WasdClothSheet3D).facing = WasdClothSheet3D.Facing.HORIZONTAL


## Where a sheet's grid point rests in the sheet's own space.
func rest_point(sheet: WasdClothSheet3D, column: int, row: int) -> Vector3:
	var grid := sheet.grid_size()
	var x := (float(column) / grid.x - 0.5) * sheet.size.x
	var along := (float(row) / grid.y - 0.5) * sheet.size.y
	return Vector3(x, -along, 0.0) if sheet.facing == WasdClothSheet3D.Facing.VERTICAL else Vector3(x, 0.0, along)


## The 95th percentile of the stretch of a sheet's edges between neighboring grid points.
func grid_stretch(sheet: WasdClothSheet3D) -> float:
	var grid := sheet.grid_size()
	var ratios := PackedFloat32Array()
	for row in grid.y + 1:
		for column in grid.x + 1:
			for step: Vector2i in [Vector2i(1, 0), Vector2i(0, 1)]:
				var next := Vector2i(column, row) + step
				if next.x > grid.x or next.y > grid.y:
					continue
				var rest := rest_point(sheet, column, row).distance_to(rest_point(sheet, next.x, next.y))
				ratios.append(sheet.get_point_transform(sheet.point_at(column, row)).distance_to(sheet.get_point_transform(sheet.point_at(next.x, next.y))) / rest)
	ratios.sort()
	return ratios[int(ratios.size() * 0.95)]


## Checks a sheet that was built again: every point a number, its edges at their length, and its pinned points the
## ones it names, pinned in the physics engine, where they rest in `placement`.
func check_rebuilt(sheet: WasdClothSheet3D, grid: Vector2i, placement: Transform3D, pinned: Callable) -> void:
	check(sheet.grid_size() == grid, "%s has a grid of %s instead of %s after its change" % [sheet.name, sheet.grid_size(), grid])
	var bad := 0
	for row in grid.y + 1:
		for column in grid.x + 1:
			var p := sheet.get_point_transform(sheet.point_at(column, row))
			if not (is_finite(p.x) and is_finite(p.y) and is_finite(p.z)):
				bad += 1
	check(bad == 0, "%s has %d points that are not numbers after its change" % [sheet.name, bad])
	check(grid_stretch(sheet) < 1.08, "%s stretches %.3f at the 95th percentile after its change" % [sheet.name, grid_stretch(sheet)])
	var expected := 0
	var misplaced := 0
	var engine_pins := 0
	for row in grid.y + 1:
		for column in grid.x + 1:
			var index := sheet.point_at(column, row)
			if PhysicsServer3D.soft_body_is_point_pinned(sheet.get_physics_rid(), index) != pinned.call(column, row):
				engine_pins += 1
			if not pinned.call(column, row):
				continue
			expected += 1
			if sheet.get_point_transform(sheet.point_at(column, row)).distance_to(placement * rest_point(sheet, column, row)) > 0.01:
				misplaced += 1
	check(sheet.pinned_indices().size() == expected, "%s pinned %d points instead of %d after its change" % [sheet.name, sheet.pinned_indices().size(), expected])
	check(misplaced == 0, "%s has %d pinned points away from where they rest after its change" % [sheet.name, misplaced])
	check(engine_pins == 0, "the physics engine pins %d points of %s otherwise than its pinned edges" % [engine_pins, sheet.name])


## Mean world Z of a sheet's bottom row of points, its free edge when it hangs from the top.
func bottom_z(sheet: WasdClothSheet3D) -> float:
	var grid := sheet.grid_size()
	var total := 0.0
	for column in grid.x + 1:
		total += sheet.get_point_transform(sheet.point_at(column, grid.y)).z
	return total / (grid.x + 1)


func stretch(sheet: WasdClothSheet3D) -> float:
	var arrays := sheet.mesh.surface_get_arrays(0)
	var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
	var ratios := PackedFloat32Array()
	for t in range(0, indices.size(), 3):
		var a := indices[t]
		var b := indices[t + 1]
		ratios.append(sheet.get_point_transform(a).distance_to(sheet.get_point_transform(b)) / vertices[a].distance_to(vertices[b]))
	ratios.sort()
	return ratios[int(ratios.size() * 0.95)]


func finish(flag: WasdClothSheet3D) -> void:
	var table_cloth := scene.get_node("Tablecloth") as WasdClothSheet3D
	for sheet in [flag, table_cloth]:
		var count: int = (sheet as WasdClothSheet3D).mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX].size()
		var bad := 0
		for i in count:
			var p := (sheet as WasdClothSheet3D).get_point_transform(i)
			if not (is_finite(p.x) and is_finite(p.y) and is_finite(p.z)):
				bad += 1
		check(bad == 0, "%s has %d points that are not numbers" % [sheet.name, bad])
		check(stretch(sheet) < 1.08, "%s stretches %.3f at the 95th percentile" % [sheet.name, stretch(sheet)])
	var pins := flag.pinned_indices()
	var columns := 2 * (flag.grid_size().y + 1)
	check(pins.size() == columns, "the flag pinned %d points instead of 2 columns of %d" % [pins.size(), flag.grid_size().y + 1])
	for k in pins.size():
		check(flag.get_point_transform(pins[k]).distance_to(flag_start[k]) < 0.001, "flag pin %d moved" % pins[k])
	var lowest := INF
	var center := Vector3.ZERO
	var count: int = table_cloth.mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX].size()
	for i in count:
		var p := table_cloth.get_point_transform(i)
		center += p
		if absf(p.x - 5.0) < 0.45 and absf(p.z) < 0.45:
			lowest = minf(lowest, p.y)
	check(lowest > 0.78, "the tablecloth sank into the table top (lowest point over it at %.3f)" % lowest)
	check((center / count).y > 0.3, "the tablecloth fell off the table")
	var cape := scene.get_node("Hero/Skeleton3D/Cape") as WasdClothChains3D
	check(cape.chain_count() == 5, "the cape found %d chains instead of 5" % cape.chain_count())
	var colliders := 0
	for child in cape.get_children(true):
		if child is SpringBoneCollisionCapsule3D:
			colliders += 1
	check(colliders == 6, "the cape made %d body colliders instead of 6" % colliders)
	check(tip_travel > 0.05, "the cape's tip swung only %.3f m" % tip_travel)
	var wind := scene.get_node("Wind") as WasdClothWind3D
	check(wind.velocity().length() > 1.0, "the wind does not blow")
	check(WasdClothWind3D.velocity_at(self, Vector3(0.8, 2.4, 0)).length() > 1.0, "velocity_at finds no wind at the flag")
	var banner := scene.get_node("Banner") as MeshInstance3D
	check((banner.get_active_material(0) as ShaderMaterial).shader.code.contains("shader_type spatial"), "the flag shader did not load")
	check(is_equal_approx(flag.total_mass, 0.45) and is_equal_approx(flag.linear_stiffness, 0.9) and flag.simulation_precision == 15,
		"the canvas flag does not have its fabric's settings: mass %.2f kg, stiffness %.2f, precision %d" % [flag.total_mass, flag.linear_stiffness, flag.simulation_precision])
	var custom := scene.get_node("Custom") as WasdClothSheet3D
	check(is_equal_approx(custom.total_mass, 2.5) and is_equal_approx(custom.linear_stiffness, 0.6) and is_equal_approx(custom.damping_coefficient, 0.07) and custom.simulation_precision == 12,
		"the custom sheet lost the settings of its scene: mass %.2f kg, stiffness %.2f, damping %.2f, precision %d" % [custom.total_mass, custom.linear_stiffness, custom.damping_coefficient, custom.simulation_precision])
	# The zone is turned half around and blows toward world +Z, across the sail, which hangs at Z 0 facing +Z.
	var drift := sail_drift / maxi(sail_samples, 1)
	check(drift > 0.15, "the sail in the turned wind zone moved %.2f m toward the wind's world direction instead of at least 0.15 m" % drift)
	# The curtain rests where the scene placed it, turned a quarter around Y, relative to the pole, which has moved since.
	var curtain := scene.get_node("Curtain") as WasdClothSheet3D
	var pole := scene.get_node("Pole") as Node3D
	var curtain_placement := pole.global_transform * pole_at_change.affine_inverse() * curtain_rest
	check_rebuilt(curtain, Vector2i(20, 10), curtain_placement, func(column: int, _row: int) -> bool: return column < 2)
	# The far top corner, which the old top edge held, fell once that edge let go.
	var corner := curtain.get_point_transform(curtain.point_at(20, 0))
	check(corner.y < (curtain_placement * rest_point(curtain, 20, 0)).y - 0.05, "the curtain's far top corner did not fall once its top edge let go")
	# The awning lies at the height it hung from, pinned along its -Z edge, and its free edge hangs below.
	var awning := scene.get_node("Awning") as WasdClothSheet3D
	var awning_placement := Transform3D(Basis(), Vector3(14, 60, 0))
	check_rebuilt(awning, Vector2i(17, 17), awning_placement, func(_column: int, row: int) -> bool: return row < 1)
	check(awning.get_point_transform(awning.point_at(8, 17)).y < 59.9, "the awning's free edge does not hang below its pinned edge")
	if failures.is_empty():
		print("SMOKE_PASS wasd-cloth")
	else:
		for failure in failures:
			print("SMOKE_FAIL wasd-cloth: " + failure)
