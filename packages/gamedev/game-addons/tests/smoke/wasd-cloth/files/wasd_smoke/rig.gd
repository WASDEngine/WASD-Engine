extends Skeleton3D
## A humanoid skeleton made in code, with a cape of 5 chains of 6 bones behind its chest, as add_chains names them.

func _init() -> void:
	var joints := [
		["Hips", "", Vector3(0, 1.0, 0)], ["Spine", "Hips", Vector3(0, 1.15, 0)], ["Chest", "Spine", Vector3(0, 1.35, 0)],
		["Neck", "Chest", Vector3(0, 1.55, 0)],
		["LeftUpperLeg", "Hips", Vector3(0.1, 0.95, 0)], ["LeftLowerLeg", "LeftUpperLeg", Vector3(0.1, 0.52, 0)], ["LeftFoot", "LeftLowerLeg", Vector3(0.1, 0.08, 0)],
		["RightUpperLeg", "Hips", Vector3(-0.1, 0.95, 0)], ["RightLowerLeg", "RightUpperLeg", Vector3(-0.1, 0.52, 0)], ["RightFoot", "RightLowerLeg", Vector3(-0.1, 0.08, 0)],
	]
	for column in 5:
		var parent := "Chest"
		for row in 6:
			var bone := "cloth_cape_%02d_%02d" % [column, row]
			joints.append([bone, parent, Vector3(-0.2 + 0.1 * column, 1.5 - 0.2 * row, 0.16 + 0.02 * row)])
			parent = bone
	var at := {}
	for joint in joints:
		var index := add_bone(joint[0])
		at[joint[0]] = joint[2]
		var local: Vector3 = joint[2]
		if joint[1] != "":
			set_bone_parent(index, find_bone(joint[1]))
			local = joint[2] - at[joint[1]]
		set_bone_rest(index, Transform3D(Basis(), local))
	reset_bone_poses()
