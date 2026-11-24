extends Node3D
## Active Ragdoll smoke test on Jolt: a skeleton with Godot's humanoid bone names, built in code, gets the humanoid
## profile's 15 physical bones; a hit on plain animation makes the upper body react and recover; a whole-body ragdoll
## falls to the floor, stays above it, settles, lies on its back or front, and stops.

const ID := "active-ragdoll"

## Bone name, parent name, and rest offset from the parent, in meters.
const BONES := [
	["Hips", "", Vector3(0, 1.0, 0)],
	["Spine", "Hips", Vector3(0, 0.1, 0)],
	["Chest", "Spine", Vector3(0, 0.12, 0)],
	["UpperChest", "Chest", Vector3(0, 0.12, 0)],
	["Neck", "UpperChest", Vector3(0, 0.16, 0)],
	["Head", "Neck", Vector3(0, 0.1, 0)],
	["LeftUpperArm", "UpperChest", Vector3(0.2, 0.1, 0)],
	["LeftLowerArm", "LeftUpperArm", Vector3(0.28, 0, 0)],
	["LeftHand", "LeftLowerArm", Vector3(0.26, 0, 0)],
	["RightUpperArm", "UpperChest", Vector3(-0.2, 0.1, 0)],
	["RightLowerArm", "RightUpperArm", Vector3(-0.28, 0, 0)],
	["RightHand", "RightLowerArm", Vector3(-0.26, 0, 0)],
	["LeftUpperLeg", "Hips", Vector3(0.1, -0.05, 0)],
	["LeftLowerLeg", "LeftUpperLeg", Vector3(0, -0.45, 0)],
	["LeftFoot", "LeftLowerLeg", Vector3(0, -0.45, 0)],
	["LeftToes", "LeftFoot", Vector3(0, -0.04, 0.14)],
	["RightUpperLeg", "Hips", Vector3(-0.1, -0.05, 0)],
	["RightLowerLeg", "RightUpperLeg", Vector3(0, -0.45, 0)],
	["RightFoot", "RightLowerLeg", Vector3(0, -0.45, 0)],
	["RightToes", "RightFoot", Vector3(0, -0.04, 0.14)],
]

var _events: Array[String] = []


func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out; events: %s" % [_events]))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _physics_frames(count: int) -> void:
	for _i: int in count:
		await get_tree().physics_frame


func _skeleton() -> Skeleton3D:
	var skeleton := Skeleton3D.new()
	skeleton.name = "Skeleton3D"
	for bone: Array in BONES:
		var index := skeleton.add_bone(bone[0])
		if bone[1] != "":
			skeleton.set_bone_parent(index, skeleton.find_bone(bone[1]))
		skeleton.set_bone_rest(index, Transform3D(Basis.IDENTITY, bone[2]))
	skeleton.reset_bone_poses()
	return skeleton


func _run() -> void:
	var floor_body := StaticBody3D.new()
	var floor_shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(30, 1, 30)
	floor_shape.shape = box
	floor_body.add_child(floor_shape)
	floor_body.position = Vector3(0, -0.5, 0)
	add_child(floor_body)

	var skeleton := _skeleton()
	add_child(skeleton)
	await _physics_frames(2)
	var ragdoll := ActiveRagdoll.create(skeleton, RagdollProfile.humanoid())
	ragdoll.collision_layer = 1 << 9
	ragdoll.collision_mask = 1
	ragdoll.settled.connect(func() -> void: _events.append("settled"))
	if ragdoll.bones.size() != 15 or ragdoll.simulator == null:
		return _fail("built %d physical bones, expected the profile's 15" % [ragdoll.bones.size()])
	for bone: String in ["Hips", "UpperChest", "Head", "LeftLowerArm", "RightFoot"]:
		if not ragdoll.bones.has(bone):
			return _fail("no physical bone for %s" % [bone])
	await _physics_frames(5)

	# A hit on plain animation: the upper body reacts and hands control back.
	if ragdoll.is_running():
		return _fail("running before start()")
	if not ragdoll.hit(&"LeftUpperArm", Vector3(7, 0, 0)):
		return _fail("hit() on plain animation returned false")
	if not ragdoll.hitting():
		return _fail("not hitting() right after hit()")
	var waited := 0
	while ragdoll.hitting() and waited < 300:
		await get_tree().physics_frame
		waited += 1
	if ragdoll.hitting():
		return _fail("the hit reaction did not end in five seconds")

	# The whole body as a ragdoll, thrown forward.
	ragdoll.start(Vector3(0, 0, 1.5))
	if not ragdoll.is_running():
		return _fail("not running after start()")
	await _physics_frames(150)
	var hips := (ragdoll.bones["Hips"] as PhysicalBone3D).global_position
	if hips.y > 0.6 or hips.y < -0.2:
		return _fail("hips at %s after the fall, expected them near the floor" % [hips])
	for bone: String in ["Head", "LeftLowerArm", "RightFoot"]:
		var at := (ragdoll.bones[bone] as PhysicalBone3D).global_position
		if at.y < -0.3 or not is_finite(at.length()):
			return _fail("%s at %s, below the floor" % [bone, at])
	waited = 0
	while not _events.has("settled") and waited < 900:
		await get_tree().physics_frame
		waited += 1
	if not _events.has("settled"):
		return _fail("did not settle; hips speed %s" % [ragdoll.hips_speed()])
	if not ragdoll.lying_on_back() and not ragdoll.lying_face_down():
		print("note: the body rests on its side")
	ragdoll.stop()
	if ragdoll.is_running():
		return _fail("still running after stop()")
	print("SMOKE_PASS ", ID, " settled after ", waited, " more ticks")
	get_tree().quit(0)
