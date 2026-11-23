# SPDX-License-Identifier: CC0-1.0
# Bakes an animated model into a WasdCrowdData file, from godot_script:
#
#   script: "res://addons/wasd_crowd/bake_crowd.gd"
#   args: ["res://characters/walker.glb", "res://crowd/walker.res", "--clips=Idle,Walk,Jog_Fwd", "--fps=15"]
#
# The model is a scene with a Skeleton3D, skinned meshes, and an AnimationPlayer with the clips. A humanoid that was
# retargeted for the Universal Animation Library and has no clips of its own gets that library's, named without the
# "ual/" in front. Without --clips every clip is baked. It prints one line: CROWD_BAKED or CROWD_FAILED.
extends SceneTree

const UAL := "res://addons/universal_animation_library/AnimationLibrary_Godot_Standard.glb"


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var paths: Array[String] = []
	var clips := PackedStringArray()
	var fps := 15.0
	for arg: String in args:
		if arg.begins_with("--clips="):
			clips = PackedStringArray(arg.trim_prefix("--clips=").split(",", false))
		elif arg.begins_with("--fps="):
			fps = maxf(arg.trim_prefix("--fps=").to_float(), 1.0)
		elif not arg.begins_with("--"):
			paths.append(arg)
	if paths.size() != 2:
		_done("CROWD_FAILED: give the model's scene and the file to save, such as res://characters/walker.glb res://crowd/walker.res.", 1)
		return
	var scene := load(paths[0]) as PackedScene
	if scene == null:
		_done("CROWD_FAILED %s: it is not a scene. Check the path; godot_check or godot_run imports a new model." % [paths[0]], 1)
		return
	var model := scene.instantiate() as Node3D
	root.add_child(model)
	var player := WasdCrowdBaker._first(model, "AnimationPlayer") as AnimationPlayer
	var skeleton := model.get_node_or_null("%GeneralSkeleton") as Skeleton3D
	if (player == null or player.get_animation_list().is_empty()) and skeleton != null and ResourceLoader.exists(UAL):
		player = AnimationPlayer.new()
		model.add_child(player)
		player.root_node = player.get_path_to(model)
		player.add_animation_library(&"ual", load(UAL) as AnimationLibrary)
	if player == null:
		_done("CROWD_FAILED %s: it has no AnimationPlayer with clips, and it is not a humanoid retargeted for the Universal Animation Library." % [paths[0]], 1)
		return
	var wanted := PackedStringArray()
	var all := player.get_animation_list()
	if clips.is_empty():
		wanted = all
	for clip: String in clips:
		for known: String in all:
			if known == clip or known.get_slice("/", known.get_slice_count("/") - 1) == clip:
				wanted.append(known)
				break
	var began := Time.get_ticks_msec()
	var data := WasdCrowdBaker.bake(model, wanted, fps, player)
	if data == null:
		_done("CROWD_FAILED %s: see the error above. Its clips: %s." % [paths[0], ", ".join(all)], 1)
		return
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(paths[1].get_base_dir()))
	var saved := ResourceSaver.save(data, paths[1], ResourceSaver.FLAG_COMPRESS)
	if saved != OK:
		_done("CROWD_FAILED %s: could not save %s (error %d)." % [paths[0], paths[1], saved], 1)
		return
	var frames := 0
	for clip: String in data.clips:
		frames += int(data.clips[clip]["frames"])
	var size := FileAccess.get_file_as_bytes(paths[1]).size()
	_done("CROWD_BAKED %s: %d vertices in %d surfaces, clips %s, %d frames, textures of %d by %d pixels, saved as %s (%.1f MB) in %.1f s." % [
		paths[0], data.vertices, data.mesh.get_surface_count(), ", ".join(data.names()), frames,
		data.positions.get_width(), data.positions.get_height(), paths[1], size / 1000000.0, (Time.get_ticks_msec() - began) / 1000.0], 0)


func _done(line: String, code: int) -> void:
	print(line)
	quit(code)
