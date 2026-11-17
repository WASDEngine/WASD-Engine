extends SceneTree

# KayKit Adventurers smoke. Each of the pack's five characters imports as a scene with one Skeleton3D, whose bones
# include the hand slots that hold weapons, and one AnimationPlayer with the pack's 76 clips; the overlay's import
# settings make the clips that repeat loop and leave the others playing once; a walk moves the legs; and a prop model
# imports with its mesh. The run prints what the guide names: each character's height and its meshes under the
# skeleton.

const ROOT := "res://addons/kaykit_character_pack_adventures/"
const CHARACTERS := ["Barbarian", "Knight", "Mage", "Rogue", "Rogue_Hooded"]
const CLIPS := 76
const LOOPS := ["1H_Ranged_Aiming", "1H_Ranged_Shooting", "2H_Melee_Attack_Spinning", "2H_Melee_Idle", "2H_Ranged_Aiming", "2H_Ranged_Shooting", "Blocking", "Idle", "Jump_Idle", "Lie_Idle", "Running_A", "Running_B", "Running_Strafe_Left", "Running_Strafe_Right", "Sit_Chair_Idle", "Sit_Floor_Idle", "Spellcasting", "Unarmed_Idle", "Walking_A", "Walking_B", "Walking_Backwards", "Walking_C"]
const ONCE := ["Jump_Start", "Death_A", "1H_Melee_Attack_Chop", "Cheer", "PickUp"]

var _failures := PackedStringArray()


func _check(ok: bool, what: String) -> void:
	if not ok:
		_failures.append(what)


func _initialize() -> void:
	await process_frame
	for character in CHARACTERS:
		await _character(character)
	var prop := load(ROOT + "Assets/gltf/sword_1handed.gltf") as PackedScene
	_check(prop != null, "sword_1handed.gltf does not load")
	if prop != null:
		var sword := prop.instantiate()
		_check(sword.find_children("*", "MeshInstance3D", true, false).size() > 0, "sword_1handed.gltf has no mesh")
		sword.free()
	if _failures.is_empty():
		print("SMOKE_PASS ", OS.get_cmdline_user_args()[0])
	else:
		print("SMOKE_FAIL ", "; ".join(_failures))
	quit()


func _character(character: String) -> void:
	var path: String = ROOT + "Characters/gltf/%s.glb" % character
	var scene := load(path) as PackedScene
	_check(scene != null, "%s does not load" % path)
	if scene == null:
		return
	var model := scene.instantiate() as Node3D
	root.add_child(model)
	var skeletons := model.find_children("*", "Skeleton3D", true, false)
	var players := model.find_children("*", "AnimationPlayer", true, false)
	_check(skeletons.size() == 1, "%s has %d skeletons" % [character, skeletons.size()])
	_check(players.size() == 1, "%s has %d animation players" % [character, players.size()])
	if skeletons.size() != 1 or players.size() != 1:
		model.free()
		return
	var skeleton := skeletons[0] as Skeleton3D
	var player := players[0] as AnimationPlayer
	for bone in ["handslot.r", "handslot.l", "head", "hips", "foot.l"]:
		_check(skeleton.find_bone(bone) >= 0, "%s has no bone %s" % [character, bone])
	var clips := player.get_animation_list()
	_check(clips.size() == CLIPS, "%s has %d clips, expected %d" % [character, clips.size(), CLIPS])
	for clip in LOOPS:
		_check(player.has_animation(clip) and player.get_animation(clip).loop_mode == Animation.LOOP_LINEAR, "%s: %s does not loop" % [character, clip])
	for clip in ONCE:
		_check(player.has_animation(clip) and player.get_animation(clip).loop_mode == Animation.LOOP_NONE, "%s: %s loops" % [character, clip])
	# A walk moves the left foot.
	player.play("Walking_A")
	player.seek(0.0, true)
	var start := skeleton.get_bone_global_pose(skeleton.find_bone("foot.l")).origin
	player.seek(0.4, true)
	var later := skeleton.get_bone_global_pose(skeleton.find_bone("foot.l")).origin
	_check(start.distance_to(later) > 0.05, "%s: Walking_A does not move the left foot" % character)
	player.play("Idle")
	player.seek(0.0, true)
	var bounds := AABB()
	var meshes := PackedStringArray()
	for node in model.find_children("*", "MeshInstance3D", true, false):
		var mesh := node as MeshInstance3D
		var box := mesh.global_transform * mesh.get_aabb()
		bounds = box if bounds.size == Vector3.ZERO else bounds.merge(box)
		meshes.append("%s%s" % [String(model.get_path_to(mesh)), "" if mesh.visible else " (hidden)"])
	print("CHARACTER %s height %.2f m; meshes: %s" % [character, bounds.size.y, ", ".join(meshes)])
	model.free()
