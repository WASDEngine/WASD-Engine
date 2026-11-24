---
name: drop-in-ragdoll
description: Drop-In Ragdoll 1.0.2 is installed in this project. One node, DropInRagdoll, under a humanoid Skeleton3D makes the character fall limp (go_limp), take hits (hit), come to rest, and blend back into its animation (get_up), at any scale, with bodies sized to the mesh. It needs Jolt Physics. Load before making a character die, get knocked out, or be thrown.
---

# Drop-In Ragdoll 1.0.2

`res://addons/dropin_ragdoll/` (MIT, no plugin to enable; the class is global): `DropInRagdoll` extends `SkeletonModifier3D` and goes under the character's `Skeleton3D`. It builds 16 rigid bodies with joints when the character first goes limp and frees them when it gets up.

It needs Jolt Physics: `3d/physics_engine="Jolt Physics"` under `[physics]` in `project.godot`. On Godot Physics the joints stretch and the body may never settle.

## Add it

An imported model's skeleton sits inside its instance, so add the node from the character's script:

```gdscript
var ragdoll: DropInRagdoll

func _ready() -> void:
	ragdoll = DropInRagdoll.new()
	($Model.find_children("*", "Skeleton3D", true, false)[0] as Skeleton3D).add_child(ragdoll)
	ragdoll.came_to_rest.connect(_on_ragdoll_rest)
```

It finds the bones by name: Godot's humanoid names, Mixamo, Unreal-style names such as MPFB's game-engine rig has, Blender's `.L`/`.R` names, and VRoid, and works out the spine and chest from the skeleton's shape. Hips, Head, and the upper and lower arms and legs are required; Spine, Chest, hands, and feet are used when present.

## Fall, take a hit, get up

```gdscript
func die(push: Vector3) -> void:
	$CollisionShape3D.disabled = true     # the character's own capsule, out of the way
	if not ragdoll.go_limp(push):         # push: world velocity in m/s
		push_warning("ragdoll: %s" % [ragdoll.get_bone_report()])

func shot(impulse: Vector3, at: Vector3) -> void:
	ragdoll.hit(impulse, at)              # goes limp if needed; the part nearest `at` takes impulse (kg m/s)

func _on_ragdoll_rest() -> void:
	global_transform = ragdoll.get_up_transform(self)   # under the hips, facing the way a body sits up
	$AnimationPlayer.play("get_up_back" if ragdoll.is_face_up() else "get_up_front", 0.0)
	ragdoll.get_up(0.25)                  # blends from the limp pose into the playing animation
	await ragdoll.got_up
	$CollisionShape3D.disabled = false
```

The ragdoll starts with the velocity of the `CharacterBody3D` or `RigidBody3D` that owns the skeleton, and never collides with that body. Without a get-up clip, `get_up(0.8)` into the idle pose also works.

## API

- `go_limp(velocity := Vector3.ZERO) -> bool`: false when a required bone is missing; it then prints which.
- `hit(impulse: Vector3, at: Vector3)`, `get_up(blend_seconds := 0.5)`, `get_up_transform(root: Node3D) -> Transform3D`.
- `is_limp()`, `is_resting()`, `is_face_up()`; signals `went_limp`, `came_to_rest`, `got_up`.
- `get_body(part) -> RigidBody3D`, `get_part_position(part) -> Vector3` while limp. Parts: Hips, Spine, Chest, Head, and Left/Right UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot.
- `fit() -> bool` reads the skeleton now instead of at the first fall; call it again after swapping meshes. `get_bone_report() -> Dictionary` maps each part to its bone.

## Properties

- Bones: `bone_map` (the `BoneMap` used for retargeting) or `bone_names`, a Dictionary from Godot's humanoid names to the rig's, such as `{"Head": "DEF-spine.006"}`, when guessing misses a bone.
- Body: `total_mass` (70 kg), `fit_to_mesh` (true: shapes from the skinned mesh; set false for a skeleton without one), `shape_scale`, `simulate_hands_and_feet`, `freeze_other_bones`.
- Physics: `collision_layer`, `collision_mask` (both 1: the floor must be on a masked layer), `friction`, `bounce`, `linear_damp`, `angular_damp`, `joint_damping`, `self_collision`, `inherit_body_velocity`, `settle`.
- Joint limits in degrees from the rest pose: `spine_swing`, `neck_swing`, `shoulder_swing`, `hip_swing`, `wrist_swing`, `ankle_swing`, `elbow_bend`, `knee_bend`.
- `show_shapes` draws the shapes while limp.

## Pitfalls

- The character's root stays where it was while the body is limp: move it with `get_up_transform()` before `get_up()`, or the body snaps back.
- A body takes about 2 to 4.5 seconds to come to rest; `came_to_rest` can fire again after a later `hit()`.

## Check it

`godot_run`, make the character go limp, then `godot_screenshot`: the body lies on the ground with arms and legs bent the way joints bend, nothing stretched, and nothing sunk into the floor. `godot_eval` of `ragdoll.is_resting()` turns true within a few seconds.
