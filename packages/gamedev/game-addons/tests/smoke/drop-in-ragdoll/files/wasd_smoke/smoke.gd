extends Node3D
## Drop-In Ragdoll smoke test on Jolt: a humanoid skeleton built in code, with Godot's humanoid bone names, stands on a
## floor; the ragdoll must find its bones, go limp with a push, fall to the floor and stay above it, take a hit, come
## to rest, and get up again into the pose the skeleton has.

const ID := "drop-in-ragdoll"

## Bone name, parent name, and rest offset from the parent, in meters.
const BONES := [
	["Hips", "", Vector3(0, 1.0, 0)],
	["Spine", "Hips", Vector3(0, 0.12, 0)],
	["Chest", "Spine", Vector3(0, 0.18, 0)],
	["Neck", "Chest", Vector3(0, 0.25, 0)],
	["Head", "Neck", Vector3(0, 0.1, 0)],
	["LeftUpperArm", "Chest", Vector3(0.2, 0.2, 0)],
	["LeftLowerArm", "LeftUpperArm", Vector3(0.28, 0, 0)],
	["LeftHand", "LeftLowerArm", Vector3(0.26, 0, 0)],
	["RightUpperArm", "Chest", Vector3(-0.2, 0.2, 0)],
	["RightLowerArm", "RightUpperArm", Vector3(-0.28, 0, 0)],
	["RightHand", "RightLowerArm", Vector3(-0.26, 0, 0)],
	["LeftUpperLeg", "Hips", Vector3(0.1, -0.05, 0)],
	["LeftLowerLeg", "LeftUpperLeg", Vector3(0, -0.45, 0)],
	["LeftFoot", "LeftLowerLeg", Vector3(0, -0.45, 0)],
	["RightUpperLeg", "Hips", Vector3(-0.1, -0.05, 0)],
	["RightLowerLeg", "RightUpperLeg", Vector3(0, -0.45, 0)],
	["RightFoot", "RightLowerLeg", Vector3(0, -0.45, 0)],
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
	if ProjectSettings.get_setting("physics/3d/physics_engine") != "Jolt Physics":
		return _fail("the project does not run Jolt Physics")
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
	var ragdoll := DropInRagdoll.new()
	ragdoll.fit_to_mesh = false
	skeleton.add_child(ragdoll)
	ragdoll.went_limp.connect(func() -> void: _events.append("went_limp"))
	ragdoll.came_to_rest.connect(func() -> void: _events.append("came_to_rest"))
	ragdoll.got_up.connect(func() -> void: _events.append("got_up"))
	await _physics_frames(3)

	if not ragdoll.fit():
		return _fail("fit() found no humanoid bones: %s" % [ragdoll.get_bone_report()])
	var report := ragdoll.get_bone_report()
	for part: String in ["Hips", "Head", "LeftUpperArm", "RightLowerLeg"]:
		if report.get(part, "") != part:
			return _fail("part %s plays bone %s" % [part, report.get(part, "")])
	if ragdoll.is_limp():
		return _fail("limp before go_limp()")
	if not ragdoll.go_limp(Vector3(0, 0, 1.5)):
		return _fail("go_limp() returned false")
	if not ragdoll.is_limp() or not _events.has("went_limp"):
		return _fail("not limp after go_limp(); events: %s" % [_events])
	var hips := ragdoll.get_body("Hips")
	if hips == null:
		return _fail("no body for Hips while limp")
	await _physics_frames(120)
	var fallen := ragdoll.get_part_position("Hips")
	if fallen.y > 0.6 or fallen.y < -0.2:
		return _fail("hips at %s after two seconds, expected them near the floor" % [fallen])
	for part: String in ["Head", "LeftHand", "RightFoot"]:
		var at := ragdoll.get_part_position(part)
		if at.y < -0.3 or not is_finite(at.length()):
			return _fail("%s at %s, below the floor" % [part, at])

	ragdoll.hit(Vector3(0, 60, 0), ragdoll.get_part_position("Chest"))
	await _physics_frames(10)
	if ragdoll.get_part_position("Chest").y <= fallen.y - 0.05:
		return _fail("a hit from below did not lift the chest")

	var waited := 0
	while not ragdoll.is_resting() and waited < 900:
		await get_tree().physics_frame
		waited += 1
	if not ragdoll.is_resting() or not _events.has("came_to_rest"):
		return _fail("not at rest after %d ticks; events: %s" % [waited, _events])

	ragdoll.get_up(0.2)
	waited = 0
	while not _events.has("got_up") and waited < 300:
		await get_tree().physics_frame
		waited += 1
	if not _events.has("got_up") or ragdoll.is_limp():
		return _fail("did not get up; events: %s" % [_events])
	print("SMOKE_PASS ", ID, " rest after ", waited, " ticks, events ", _events)
	get_tree().quit(0)
