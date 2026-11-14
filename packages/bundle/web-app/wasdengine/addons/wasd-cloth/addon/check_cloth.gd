# SPDX-License-Identifier: CC0-1.0
# Checks the cloth of a scene without showing it. Run it with godot_script, the scene's res:// path, and options:
#   --seconds=N        how long to simulate, 6 by default.
#   --move=PATH        a node, relative to the scene's root, that runs a 3 m circle while the cloth is checked,
#                      such as the character that wears a cape.
#   --speed=M          its speed in m/s, 3 by default.
# Physics runs in real time, so the check takes about N seconds. It reports every SoftBody3D (WasdClothSheet3D or
# another), every SpringBoneSimulator3D (WasdClothChains3D or another), every animation that plays baked cloth
# (blend-shape tracks), and every mesh that uses flag_wind.gdshader, one line each, and ends with CLOTH_CHECK OK or
# CLOTH_CHECK PROBLEMS. Measured: points that are not numbers (an explosion), how far edges stretch past their rest
# length, points that sink into other bodies, the motion at the end, and the physics time per tick.
extends SceneTree

const SAMPLE_EVERY := 6
const DEEP := 0.015

var _seconds := 6.0
var _speed := 3.0
var _move_path := ""
var _scene: Node
var _mover: Node3D
var _mover_start := Transform3D.IDENTITY
var _ticks := 0
var _sheets: Array[Dictionary] = []
var _chains: Array[Dictionary] = []
var _physics_time := 0.0
var _tick_started := 0
var _measured := 0
var _started := false
var _failed := false


func _initialize() -> void:
	var path := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--seconds="):
			_seconds = maxf(1.0, arg.trim_prefix("--seconds=").to_float())
		elif arg.begins_with("--move="):
			_move_path = arg.trim_prefix("--move=")
		elif arg.begins_with("--speed="):
			_speed = arg.trim_prefix("--speed=").to_float()
		elif not arg.begins_with("--"):
			path = arg
	if path == "":
		print("CLOTH_CHECK FAILED: give the scene's res:// path, such as res://levels/castle.tscn.")
		_failed = true
		return
	var packed := load(path) as PackedScene
	if packed == null:
		print("CLOTH_CHECK FAILED: %s is not a scene that loads." % path)
		_failed = true
		return
	_scene = packed.instantiate()
	root.add_child(_scene)


func _physics_process(delta: float) -> bool:
	if _failed:
		return true
	if not _started:
		_start()
		return false
	_ticks += 1
	var t := _ticks * delta
	if _mover != null:
		var turn := _speed / 3.0 * t
		_mover.global_transform = Transform3D(
			Basis(Vector3.UP, -turn) * _mover_start.basis,
			_mover_start.origin + _mover_start.basis * Vector3(3.0 * (1.0 - cos(turn)), 0.0, -3.0 * sin(turn)))
	if _ticks % SAMPLE_EVERY == 0:
		for sheet in _sheets:
			_sample_sheet(sheet, delta * SAMPLE_EVERY)
	if t >= _seconds:
		_report()
		return true
	_tick_started = Time.get_ticks_usec()
	return false


## The physics step runs between the last _physics_process of a frame and its _process, so that span is its cost
## (with the scene's own _physics_process code).
func _process(_delta: float) -> bool:
	if _tick_started > 0:
		_physics_time += (Time.get_ticks_usec() - _tick_started) / 1000000.0
		_measured += 1
		_tick_started = 0
	return false


func _start() -> void:
	_started = true
	if _move_path != "":
		_mover = _scene.get_node_or_null(_move_path) as Node3D
		if _mover == null:
			print("CLOTH_CHECK FAILED: --move=%s names no Node3D under the scene's root %s." % [_move_path, _scene.name])
			_failed = true
			return
		_mover_start = _mover.global_transform
	for node in _scene.find_children("*", "SoftBody3D", true, false):
		_sheets.append(_sheet_entry(node as SoftBody3D))
	for node in _scene.find_children("*", "SpringBoneSimulator3D", true, false):
		var entry := _chain_entry(node as SpringBoneSimulator3D)
		if not entry.is_empty():
			_chains.append(entry)


func _sheet_entry(body: SoftBody3D) -> Dictionary:
	var entry := {"node": body, "edges": PackedInt32Array(), "rest": PackedFloat32Array(), "count": 0,
		"nan": 0, "p95": 0.0, "max": 0.0, "inside": 0, "speed": 0.0, "previous": PackedVector3Array()}
	if body.mesh == null or body.mesh.get_surface_count() == 0:
		return entry
	var arrays := body.mesh.surface_get_arrays(0)
	var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX] if arrays[Mesh.ARRAY_INDEX] != null else PackedInt32Array()
	entry["count"] = vertices.size()
	var seen := {}
	var edges := PackedInt32Array()
	var rest := PackedFloat32Array()
	for t in range(0, indices.size() - 2, 3):
		for k in 3:
			var a := indices[t + k]
			var b := indices[t + (k + 1) % 3]
			var key := mini(a, b) * 4194304 + maxi(a, b)
			var length := vertices[a].distance_to(vertices[b])
			if not seen.has(key) and length > 0.0001:
				seen[key] = true
				edges.append(a)
				edges.append(b)
				rest.append(length)
	entry["edges"] = edges
	entry["rest"] = rest
	return entry


func _sample_sheet(entry: Dictionary, interval: float) -> void:
	var body: SoftBody3D = entry["node"]
	if not is_instance_valid(body) or entry["count"] == 0:
		return
	var points := PackedVector3Array()
	points.resize(entry["count"])
	var nan := 0
	for i in points.size():
		var p := body.get_point_transform(i)
		if not (is_finite(p.x) and is_finite(p.y) and is_finite(p.z)):
			nan += 1
			p = Vector3.ZERO
		points[i] = p
	entry["nan"] = maxi(entry["nan"], nan)
	var edges: PackedInt32Array = entry["edges"]
	var rest: PackedFloat32Array = entry["rest"]
	var ratios := PackedFloat32Array()
	ratios.resize(rest.size())
	for e in rest.size():
		ratios[e] = points[edges[e * 2]].distance_to(points[edges[e * 2 + 1]]) / rest[e]
	ratios.sort()
	if ratios.size() > 0 and nan == 0:
		entry["p95"] = maxf(entry["p95"], ratios[int(ratios.size() * 0.95)])
		entry["max"] = maxf(entry["max"], ratios[ratios.size() - 1])
	var previous: PackedVector3Array = entry["previous"]
	if previous.size() == points.size():
		var moved := 0.0
		for i in points.size():
			moved += points[i].distance_to(previous[i])
		entry["speed"] = moved / points.size() / interval
	entry["previous"] = points
	if nan == 0:
		entry["inside"] = maxi(entry["inside"], _points_inside(body, points))


## Points deeper than DEEP inside another body: the point and the six points DEEP away from it all lie inside.
func _points_inside(body: SoftBody3D, points: PackedVector3Array) -> int:
	var space := body.get_world_3d().direct_space_state
	var query := PhysicsPointQueryParameters3D.new()
	query.exclude = [body.get_physics_rid()]
	query.collide_with_areas = false
	var inside := 0
	var steps := [Vector3.ZERO, Vector3.RIGHT, Vector3.LEFT, Vector3.UP, Vector3.DOWN, Vector3.FORWARD, Vector3.BACK]
	for p in points:
		var deep := true
		for step in steps:
			query.position = p + step * DEEP
			if space.intersect_point(query, 1).is_empty():
				deep = false
				break
		if deep:
			inside += 1
	return inside


func _chain_entry(simulator: SpringBoneSimulator3D) -> Dictionary:
	var skeleton := simulator.get_skeleton()
	if skeleton == null:
		return {}
	var entry := {"node": simulator, "skeleton": skeleton, "settings": simulator.get_setting_count(), "joints": 0,
		"rest": {}, "nan": 0, "travel": 0.0, "drift": 0.0, "colliders": 0}
	for child in simulator.get_children(true):
		if child is SpringBoneCollision3D:
			entry["colliders"] += 1
	for i in simulator.get_setting_count():
		entry["joints"] += simulator.get_joint_count(i)
	skeleton.skeleton_updated.connect(_sample_chain.bind(entry))
	return entry


func _sample_chain(entry: Dictionary) -> void:
	var simulator: SpringBoneSimulator3D = entry["node"]
	var skeleton: Skeleton3D = entry["skeleton"]
	if not is_instance_valid(simulator) or not is_instance_valid(skeleton):
		return
	var rest: Dictionary = entry["rest"]
	for i in simulator.get_setting_count():
		var count := simulator.get_joint_count(i)
		if count < 2:
			continue
		var root_bone := simulator.get_joint_bone(i, 0)
		var root_pose := skeleton.get_bone_global_pose(root_bone)
		for j in range(1, count):
			var bone := simulator.get_joint_bone(i, j)
			var parent := simulator.get_joint_bone(i, j - 1)
			var pose := skeleton.get_bone_global_pose(bone).origin
			if not (is_finite(pose.x) and is_finite(pose.y) and is_finite(pose.z)):
				entry["nan"] += 1
				continue
			var length := pose.distance_to(skeleton.get_bone_global_pose(parent).origin)
			var key := "%d/%d" % [i, j]
			if not rest.has(key):
				rest[key] = [length, root_pose.affine_inverse() * pose]
				continue
			var rest_length: float = rest[key][0]
			if rest_length > 0.0001:
				entry["drift"] = maxf(entry["drift"], absf(length - rest_length) / rest_length)
			entry["travel"] = maxf(entry["travel"], (root_pose.affine_inverse() * pose).distance_to(rest[key][1]))


func _report() -> void:
	var problems := 0
	var lines: Array[String] = []
	var engine := str(ProjectSettings.get_setting("physics/3d/physics_engine", "DEFAULT"))
	var ticks_per_second := Engine.physics_ticks_per_second
	var per_tick := _physics_time / maxi(_measured, 1) * 1000.0
	if _sheets.size() > 0 and engine != "Jolt Physics":
		problems += 1
		lines.append("PROBLEM physics engine is %s: soft bodies fall through static bodies there. Set [physics] 3d/physics_engine=\"Jolt Physics\" in project.godot." % engine)
	for entry in _sheets:
		var body: SoftBody3D = entry["node"]
		var notes: Array[String] = []
		if entry["count"] == 0:
			notes.append("it has no mesh to simulate")
		elif entry["nan"] > 0:
			notes.append("%d points are not numbers: the solver exploded. Lower linear_stiffness below 0.85, raise simulation_precision, or use a WasdClothSheet3D fabric preset" % entry["nan"])
		else:
			if entry["p95"] > 1.06:
				notes.append("rubbery: 5%% of edges stretch %d%% or more. Raise simulation_precision to 15-20, pin 2 rows, or use a heavier fabric" % roundi((entry["p95"] - 1.0) * 100.0))
			if entry["max"] > 1.6:
				notes.append("some edges stretch to %.1f times their length, usually beside pins that move fast" % entry["max"])
			if entry["inside"] > maxi(2, entry["count"] / 50):
				notes.append("%d points sank more than %d cm into other bodies: make colliders thicker, start the cloth clear of them, raise simulation_precision, or slow what hits it" % [entry["inside"], roundi(DEEP * 100.0)])
		var kind := "WasdClothSheet3D" if body.has_method("pinned_indices") else "SoftBody3D"
		var pins := str(body.pinned_indices().size()) if body.has_method("pinned_indices") else "some"
		var detail := "%d points, %s pinned, precision %d, stiffness %.2f, mass %.2f kg; stretch 95%% %s, max %s; %d sunk; end speed %.2f m/s" % [
			entry["count"], pins, body.simulation_precision, body.linear_stiffness, body.total_mass,
			_percent(entry["p95"]), _percent(entry["max"]), entry["inside"], entry["speed"]]
		if body.has_method("pinned_indices") and body.get("fabric") != null:
			detail = "fabric %s, " % body.get("fabric") + detail
		lines.append(_line(kind, body, detail, notes))
		problems += 1 if notes.size() > 0 else 0
	for entry in _chains:
		var simulator: SpringBoneSimulator3D = entry["node"]
		var notes: Array[String] = []
		if entry["settings"] == 0:
			notes.append("it has no chains: name the bones <prefix><group>_<column>_<row> or set root and end bones")
		if entry["nan"] > 0:
			notes.append("%d joint positions are not numbers" % entry["nan"])
		if entry["drift"] > 0.05:
			notes.append("bones change length by up to %d%%; keep the skeleton and its parents at scale 1" % roundi(entry["drift"] * 100.0))
		var kind := "WasdClothChains3D" if simulator.has_method("chain_count") else "SpringBoneSimulator3D"
		var detail := "%d chains, %d joints, %d colliders; joints swung up to %.2f m from their rest" % [
			entry["settings"], entry["joints"], entry["colliders"], entry["travel"]]
		if _mover == null and entry["travel"] < 0.005 and entry["settings"] > 0:
			detail += " (nothing moved them: pass --move=<the character> to see them swing)"
		lines.append(_line(kind, simulator, detail, notes))
		problems += 1 if notes.size() > 0 else 0
	for player in _scene.find_children("*", "AnimationPlayer", true, false):
		var animation_player := player as AnimationPlayer
		for animation_name in animation_player.get_animation_list():
			var animation := animation_player.get_animation(animation_name)
			var shapes := 0
			for track in animation.get_track_count():
				if animation.track_get_type(track) == Animation.TYPE_BLEND_SHAPE:
					shapes += 1
			if shapes == 0:
				continue
			var notes: Array[String] = []
			var looped := animation.loop_mode != Animation.LOOP_NONE
			if not looped:
				notes.append("it plays once; name the Blender action ..._loop or set loop_mode to loop it")
			var detail := "animation %s: %d blend-shape tracks, %.2f s, %s" % [animation_name, shapes, animation.length, "loops" if looped else "plays once"]
			lines.append(_line("baked cloth", animation_player, detail, notes))
			problems += 1 if notes.size() > 0 else 0
	for node in _scene.find_children("*", "MeshInstance3D", true, false):
		var mesh_instance := node as MeshInstance3D
		var material := mesh_instance.get_active_material(0)
		if material is ShaderMaterial and (material as ShaderMaterial).shader != null and (material as ShaderMaterial).shader.resource_path.ends_with("flag_wind.gdshader"):
			lines.append(_line("flag shader", mesh_instance, "moves in the shader; no physics cost", []))
	if lines.is_empty():
		print("CLOTH_CHECK FAILED: the scene has no cloth (no SoftBody3D, SpringBoneSimulator3D, blend-shape animation, or flag_wind material).")
		return
	print("Cloth in %s, %.1f s at %d physics ticks per second, physics %.2f ms per tick, engine %s:" % [_scene.scene_file_path, _seconds, ticks_per_second, per_tick, engine])
	for line in lines:
		print(line)
	print("CLOTH_CHECK OK" if problems == 0 else "CLOTH_CHECK PROBLEMS %d" % problems)


func _line(kind: String, node: Node, detail: String, notes: Array[String]) -> String:
	var where := _scene.get_path_to(node)
	if notes.is_empty():
		return "OK %s %s: %s." % [kind, where, detail]
	var text := "; ".join(notes)
	return "PROBLEM %s %s: %s. %s." % [kind, where, detail, text[0].to_upper() + text.substr(1)]


func _percent(ratio: float) -> String:
	return "%+.1f%%" % ((ratio - 1.0) * 100.0)
