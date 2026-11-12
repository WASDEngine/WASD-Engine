extends SceneTree

# Animation pack smoke, run with the arguments <add-on id> <library path> <clip count>. The installed pack imports as
# an AnimationLibrary retargeted to Godot's SkeletonProfileHumanoid, and each of its looping clips loops. The pack's
# retarget.gd prepared the rigs in wasd_smoke/ before the import: MPFB 2.0.18's game_engine and mixamo rigs and a Rigify
# basic_human game skeleton, each with one small skinned cube, which tests/smoke/universal-animation-library/rigs.py
# made with Blender 5.2.3. Every clip must pose them as it poses the pack's own rig, read from the .glb file at run
# time: a limb's direction may differ by MEAN_LIMIT degrees on average over the clips' worst moments, and by MAX_LIMIT
# degrees at any moment.

const SEGMENTS := [["Hips", "Head"], ["LeftUpperArm", "LeftLowerArm"], ["LeftLowerArm", "LeftHand"], ["RightUpperArm", "RightLowerArm"], ["RightLowerArm", "RightHand"], ["LeftUpperLeg", "LeftLowerLeg"], ["LeftLowerLeg", "LeftFoot"], ["RightUpperLeg", "RightLowerLeg"], ["RightLowerLeg", "RightFoot"]]
const RIGS := ["mpfb_game_engine", "mpfb_mixamo", "rigify_basic_human"]
const SAMPLES := 5
const MEAN_LIMIT := 15.0
const MAX_LIMIT := 30.0

var _failures := PackedStringArray()


func _check(ok: bool, what: String) -> void:
	if not ok:
		_failures.append(what)


func _initialize() -> void:
	await process_frame
	var args := OS.get_cmdline_user_args()
	_run(args[1], int(args[2]))
	if _failures.is_empty():
		print("SMOKE_PASS ", args[0])
	else:
		print("SMOKE_FAIL ", "; ".join(_failures))
	quit()


func _direction(skeleton: Skeleton3D, from: String, to: String) -> Vector3:
	var start := (skeleton.global_transform * skeleton.get_bone_global_pose(skeleton.find_bone(from))).origin
	return ((skeleton.global_transform * skeleton.get_bone_global_pose(skeleton.find_bone(to))).origin - start).normalized()


func _run(library_path: String, clip_count: int) -> void:
	var library := load(library_path) as AnimationLibrary
	_check(library != null, "%s is not an AnimationLibrary" % library_path)
	if library == null:
		return
	var clips := library.get_animation_list()
	_check(clips.size() == clip_count, "%d clips, expected %d" % [clips.size(), clip_count])
	for clip in clips:
		var animation := library.get_animation(clip)
		for track in animation.get_track_count():
			_check(String(animation.track_get_path(track)).begins_with("%GeneralSkeleton:"), "%s track %s" % [clip, animation.track_get_path(track)])
	# The pack's own rig and clips, as the .glb file holds them.
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	_check(document.append_from_file(ProjectSettings.globalize_path(library_path), state) == OK, "the .glb file does not load")
	var source: Node = document.generate_scene(state)
	root.add_child(source)
	var source_player := source.find_child("AnimationPlayer", true, false) as AnimationPlayer
	var source_skeleton := source.find_child("Skeleton3D", true, false) as Skeleton3D
	var config := ConfigFile.new()
	config.load(library_path + ".import")
	var map: BoneMap
	for options in config.get_value("params", "_subresources", {}).get("nodes", {}).values():
		map = options.get("retarget/bone_map")
	_check(map != null, "the pack's import has no bone map")
	if map == null:
		return
	var source_names := {}
	for name in source_player.get_animation_list():
		var clip := name.trim_suffix("_Loop")
		source_names[clip] = name
		if name.ends_with("_Loop") and library.has_animation(clip):
			_check(library.get_animation(clip).loop_mode == Animation.LOOP_LINEAR, "%s does not loop" % clip)
	for rig in RIGS:
		var model: Node = (load("res://wasd_smoke/%s.glb" % rig) as PackedScene).instantiate()
		root.add_child(model)
		var skeleton := model.get_node_or_null("%GeneralSkeleton") as Skeleton3D
		_check(skeleton != null and skeleton.find_bone("Hips") >= 0, "%s was not retargeted" % rig)
		if skeleton == null:
			continue
		var player := AnimationPlayer.new()
		model.add_child(player)
		player.add_animation_library("pack", library)
		var total := 0.0
		var worst := 0.0
		var worst_at := ""
		for clip in clips:
			var clip_worst := 0.0
			var length := library.get_animation(clip).length
			for k in SAMPLES:
				var time := length * k / float(SAMPLES - 1)
				# Bones that a clip of the file leaves out keep their rest pose, as they do in the imported clip.
				source_skeleton.reset_bone_poses()
				source_player.play(source_names[clip])
				source_player.seek(time, true)
				skeleton.reset_bone_poses()
				player.play("pack/" + clip)
				player.seek(time, true)
				for segment in SEGMENTS:
					var expected := _direction(source_skeleton, map.get_skeleton_bone_name(segment[0]), map.get_skeleton_bone_name(segment[1]))
					var angle := rad_to_deg(expected.angle_to(_direction(skeleton, segment[0], segment[1])))
					if angle > clip_worst:
						clip_worst = angle
					if angle > worst:
						worst = angle
						worst_at = "%s %s->%s at %.2f s" % [clip, segment[0], segment[1], time]
			total += clip_worst
		var mean := total / clips.size()
		print("%s: %d clips, limb directions within %.1f degrees on average and %.1f at most (%s)" % [rig, clips.size(), mean, worst, worst_at])
		_check(mean <= MEAN_LIMIT, "%s differs by %.1f degrees on average" % [rig, mean])
		_check(worst <= MAX_LIMIT, "%s differs by %.1f degrees at %s" % [rig, worst, worst_at])
