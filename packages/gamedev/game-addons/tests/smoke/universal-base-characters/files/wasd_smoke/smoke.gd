extends SceneTree

# Universal Base Characters smoke. Each body imports retargeted to Godot's humanoid profile, as the Universal Animation
# Library's clips expect: one skeleton, the unique %GeneralSkeleton, with the profile's bone names and the motion scale
# of its hips' height, facing +Z. Each hair, beard, and eyebrow model imports retargeted the same way: its skin binds
# name bones of the skeleton of the body it was made for, with that body's own bind pose of the head, and its mesh
# moves onto that skeleton as the guide moves it. The run prints what the guide names: each body's height and meshes.

const ROOT := "res://addons/universal_base_characters/"
const BODIES := {
	"Superhero_Male_FullBody": {"meshes": ["Eyebrows", "Eyes", "SuperHero_Male"], "parts": ["Eyebrows_Regular", "Hair_Beard", "Hair_Buzzed", "Hair_SimpleParted"]},
	"Superhero_Female_FullBody": {"meshes": ["Eyebrows", "Eyes", "Superhero_Female"], "parts": ["Eyebrows_Female", "Hair_Buns", "Hair_BuzzedFemale", "Hair_Long"]},
}
const PROFILE := ["Root", "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head", "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes", "RightFoot"]

var _failures := PackedStringArray()


func _check(ok: bool, what: String) -> void:
	if not ok:
		_failures.append(what)


func _initialize() -> void:
	await process_frame
	for body_name in BODIES:
		_body(body_name, BODIES[body_name]["meshes"], BODIES[body_name]["parts"])
	if _failures.is_empty():
		print("SMOKE_PASS ", OS.get_cmdline_user_args()[0])
	else:
		print("SMOKE_FAIL ", "; ".join(_failures))
	quit()


func _bind_pose(skin: Skin, bone: String) -> Variant:
	for i in skin.get_bind_count():
		if String(skin.get_bind_name(i)) == bone:
			return skin.get_bind_pose(i)
	return null


func _body(body_name: String, meshes: Array, parts: Array) -> void:
	var scene := load(ROOT + body_name + ".gltf") as PackedScene
	_check(scene != null, "%s does not load" % body_name)
	if scene == null:
		return
	var body := scene.instantiate() as Node3D
	root.add_child(body)
	var skeleton := body.get_node_or_null("%GeneralSkeleton") as Skeleton3D
	_check(skeleton != null, "%s has no %%GeneralSkeleton" % body_name)
	if skeleton == null:
		body.free()
		return
	_check(body.find_children("*", "Skeleton3D", true, false).size() == 1, "%s has more than one skeleton" % body_name)
	for bone in PROFILE:
		_check(skeleton.find_bone(bone) >= 0, "%s has no bone %s" % [body_name, bone])
	_check(skeleton.motion_scale > 0.8 and skeleton.motion_scale < 1.1, "%s has motion scale %f" % [body_name, skeleton.motion_scale])
	var top := 0.0
	for mesh_name in meshes:
		var mesh := skeleton.get_node_or_null(NodePath(mesh_name)) as MeshInstance3D
		_check(mesh != null, "%s has no mesh %s under its skeleton" % [body_name, mesh_name])
		if mesh != null:
			top = maxf(top, (mesh.global_transform * mesh.get_aabb()).end.y)
	var foot := skeleton.get_bone_global_pose(skeleton.find_bone("LeftFoot")).origin
	var toes := skeleton.get_bone_global_pose(skeleton.find_bone("LeftToes")).origin
	_check(toes.z > foot.z, "%s does not face +Z" % body_name)
	var own := skeleton.get_node_or_null(NodePath(meshes[2])) as MeshInstance3D
	var head: Variant = null if own == null or own.skin == null else _bind_pose(own.skin, "Head")
	_check(head != null, "%s binds no Head bone" % body_name)
	for part_name in parts:
		_part(body_name, skeleton, head, part_name)
	var names := PackedStringArray()
	for mesh in skeleton.find_children("*", "MeshInstance3D", false, false):
		names.append(mesh.name)
	print("BODY %s height %.2f m, motion scale %.3f; meshes after the parts: %s" % [body_name, top, skeleton.motion_scale, ", ".join(names)])
	body.free()


func _part(body_name: String, skeleton: Skeleton3D, head: Variant, part_name: String) -> void:
	var scene := load(ROOT + part_name + ".gltf") as PackedScene
	_check(scene != null, "%s does not load" % part_name)
	if scene == null:
		return
	var part := scene.instantiate()
	var meshes := part.find_children("*", "MeshInstance3D", true, false)
	_check(meshes.size() == 1, "%s has %d meshes" % [part_name, meshes.size()])
	for mesh: MeshInstance3D in meshes:
		_check(mesh.skin != null, "%s has no skin" % part_name)
		if mesh.skin == null:
			continue
		var missing := PackedStringArray()
		for i in mesh.skin.get_bind_count():
			if skeleton.find_bone(String(mesh.skin.get_bind_name(i))) < 0:
				missing.append(String(mesh.skin.get_bind_name(i)))
		_check(missing.is_empty(), "%s binds bones that %s lacks: %s" % [part_name, body_name, ", ".join(missing)])
		var pose: Variant = _bind_pose(mesh.skin, "Head")
		_check(pose != null and head != null and (pose as Transform3D).is_equal_approx(head), "%s binds Head unlike %s" % [part_name, body_name])
		# The guide's move onto the body's skeleton.
		mesh.owner = null
		mesh.reparent(skeleton, false)
		mesh.skeleton = NodePath("..")
		_check(mesh.get_node_or_null(mesh.skeleton) == skeleton, "%s does not follow %s's skeleton" % [part_name, body_name])
	part.free()
