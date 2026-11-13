extends SceneTree
## Smoke test of the wasd-cloth catalog entry on Godot 4.7.2 with Jolt Physics: a flag pinned to a pole in wind, a
## tablecloth dropped onto a table, a spring-bone cape on a skeleton that runs, and a banner with the flag shader. After
## three seconds of physics it checks that every point is a number, pins held, edges kept their length, the tablecloth
## rests on the table, the cape has its chains and colliders and swung, and the wind blows.

const SECONDS := 3.0

var scene: Node
var ticks := 0
var failures: Array[String] = []
var flag_start := PackedVector3Array()
var tip_rest := Vector3.ZERO
var tip_travel := 0.0


func _initialize() -> void:
	scene = (load("res://wasd_smoke/smoke.tscn") as PackedScene).instantiate()
	root.add_child(scene)
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
	if ticks * delta < SECONDS:
		return false
	finish(flag)
	return true


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
	if failures.is_empty():
		print("SMOKE_PASS wasd-cloth")
	else:
		for failure in failures:
			print("SMOKE_FAIL wasd-cloth: " + failure)
