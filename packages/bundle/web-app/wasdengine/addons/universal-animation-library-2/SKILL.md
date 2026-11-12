---
name: universal-animation-library-2
description: Universal Animation Library 2 (Quaternius, CC0) is installed in this project. 42 humanoid clips (sword and shield combos, climbing, sliding, ninja jumps, throws, farming, chopping, carrying, zombie moves) in one AnimationLibrary retargeted to Godot's humanoid skeleton, and retarget.gd, which prepares MPFB, Rigify, Mixamo, and Quaternius models to play them. Load before animating a humanoid character in this project.
---

# Universal Animation Library 2 (Quaternius, Standard edition)

The add-on folder `res://addons/universal_animation_library_2/` holds:
- `UAL2_Standard.glb`, which imports as an `AnimationLibrary`, not a scene: 43 clips whose tracks drive the bones of Godot's `SkeletonProfileHumanoid` (`Hips`, `Spine`, `Chest`, `UpperChest`, `Neck`, `Head`, `LeftShoulder`, `LeftUpperArm`, `LeftLowerArm`, `LeftHand`, `LeftUpperLeg`, `LeftLowerLeg`, `LeftFoot`, `LeftToes`, fingers, and the `Right` ones) on a skeleton named `%GeneralSkeleton`. Its `.glb.import` file and `bone_maps/quaternius_ual2.tres` do the retargeting.
- `retarget.gd` and `bone_maps/`, which prepare a model to play the clips.

It complements `universal-animation-library`, which has idle, walk, run, crouch, and jump clips; both libraries play on one model and one AnimationPlayer.

## 1. Retarget each model once

The model is a `.glb`, `.gltf`, or `.fbx` file in the project with a humanoid skeleton: an MPFB human, a Rigify game skeleton (see the rigify guide), a Mixamo download, or a Quaternius character. Once the project has imported it, call `godot_script` with `script: "res://addons/universal_animation_library_2/retarget.gd"` and `args: ["res://characters/hero.glb"]`; several models may follow. A model retargeted with the other library's script is ready already. It prints one line per model:

```
RETARGETED res://characters/hero.glb: skeleton Human_rig/Skeleton3D, bone map mpfb_game_engine (53 of its 53 bones found), saved as res://characters/hero.bone_map.tres. ...
```

It picks the map in `bone_maps/` that names the most bones of the model's skeleton, saves a copy beside the model, and sets the model's import options: that bone map, Fix Silhouette, and the unique skeleton name `GeneralSkeleton`. The next import, which `godot_check`, `godot_script`, and `godot_run` start with, renames the skeleton's bones to the profile's names. The options stay when the model is exported again; run the script again after renaming the armature.

| Map | Rig: some of its bone names |
|---|---|
| `mpfb_game_engine` | MPFB `game_engine`: `Root`, `pelvis`, `spine_01`, `head`, `upperarm_l`; also most Unreal-style rigs |
| `mixamo` | Mixamo downloads and MPFB's `mixamo` rig: `mixamorig_Hips` (Godot turns `mixamorig:` into `mixamorig_`; numbered prefixes such as `mixamorig1_` work) |
| `rigify` | Rigify game skeleton: `DEF-spine`, `DEF-upper_arm.L` |
| `quaternius_ual1` | Universal Animation Library's mannequin: `DEF-hips`, `DEF-spine.001` |
| `quaternius_ual2` | this pack's mannequins: `pelvis`, `Head`, `upperarm_l` |

`RETARGET_FAILED` with "no map ... names this skeleton's bones" lists the skeleton's bones. Copy the closest map beside the model, set its `bone_map/<ProfileBone> = &"<bone>"` lines to those names (every required profile bone: Hips, Spine, Head, shoulders, arms, hands, legs, feet), and run the script again with `args: ["--map=res://characters/hero_rig.tres", "res://characters/hero.glb"]`.

## 2. Play the clips

Give the AnimationPlayer the library, and point its `root_node` at the model's instance, which owns `%GeneralSkeleton`; with the default `..` no track finds its bone:

```
[gd_scene format=3]

[ext_resource type="PackedScene" path="res://characters/hero.glb" id="1_hero"]
[ext_resource type="AnimationLibrary" path="res://addons/universal_animation_library_2/UAL2_Standard.glb" id="2_ual2"]

[node name="Player" type="CharacterBody3D"]

[node name="Hero" parent="." instance=ExtResource("1_hero")]

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
root_node = NodePath("../Hero")
libraries/ual2 = ExtResource("2_ual2")
```

Then `$AnimationPlayer.play("ual2/Sword_Regular_A")`, or `play("ual2/Slide", 0.2)` to blend over 0.2 s; `animation_finished` reports the end of a clip that does not loop. With the first library too, add `libraries/ual = ExtResource(...)` of `res://addons/universal_animation_library/AnimationLibrary_Godot_Standard.glb`. From code: `player.add_animation_library(&"ual2", preload("res://addons/universal_animation_library_2/UAL2_Standard.glb"))`. An AnimationTree takes the same library and `root_node`.

Clips (* loops): A_TPose, Chest_Open, ClimbUp_1m_RM, Consume, Farm_Harvest, Farm_PlantSeed, Farm_Watering, Hit_Knockback, Hit_Knockback_RM, Idle_FoldArms*, Idle_Lantern*, Idle_No*, Idle_Rail*, Idle_Rail_Call, Idle_Shield*, Idle_Shield_Break, Idle_TalkingPhone*, LayToIdle, Melee_Hook, Melee_Hook_Rec, NinjaJump_Idle*, NinjaJump_Land, NinjaJump_Start, OverhandThrow, Shield_Dash_RM, Shield_OneShot, Slide*, Slide_Exit, Slide_Start, Sword_Block, Sword_Dash_RM, Sword_Regular_A, Sword_Regular_A_Rec, Sword_Regular_B, Sword_Regular_B_Rec, Sword_Regular_C, Sword_Regular_Combo, TreeChopping*, Walk_Carry*, Yes, Zombie_Idle*, Zombie_Scratch, Zombie_Walk_Fwd*.

- The import drops the `_Loop` ending of the file's clip names and makes those clips loop. Sword_Regular_A_Rec and Sword_Regular_B_Rec go on from the end of Sword_Regular_A and Sword_Regular_B.
- Walk_Carry and Zombie_Walk_Fwd play in place, and the body moves in code. A planted foot stays put only while the body moves at the clip's ground speed, here in m/s per meter of the model's hip height, which is its skeleton's `motion_scale` (`$Hero.get_node("%GeneralSkeleton").motion_scale`, 0.92 on the pack's mannequins): Walk_Carry 0.74, Zombie_Walk_Fwd 1.08; rigs differ by up to a tenth. Move the body at that speed, or play the clip at the body's speed: `play("ual2/Walk_Carry", 0.2, speed / (0.74 * motion_scale))`.
- The `_RM` clips and the `Sword_Regular_` clips move the `Root` bone: on the pack's mannequin ClimbUp_1m_RM goes 1 m up and 1.7 m forward onto a ledge in 0.67 s, Hit_Knockback_RM 3 m back in 0.83 s, Sword_Dash_RM 3.7 m and Shield_Dash_RM 1 m forward, Sword_Regular_A 0.8 m, B none, C 1.6 m, Combo 2.3 m, and A_Rec and B_Rec 0.3 m; other models move in proportion to their hips' height. Without root motion the model slides away from its body and snaps back when the next clip starts: set `root_motion_track = NodePath("%GeneralSkeleton:Root")` and move the body by `get_root_motion_position()` each frame. Only rigs with a `Root` bone (MPFB game_engine, Quaternius) carry this motion; on the others these clips play in place, and the body moves those distances in code.
- The hips' height scales to the model, so a small character keeps its feet on the ground.
- Sword, shield, and lantern clips hold the hands where those props go: put each prop under a `BoneAttachment3D` child of `%GeneralSkeleton` with `bone_name = "RightHand"` or `"LeftHand"`.

## Check it

Run the game and take a `godot_screenshot` while a clip plays; `godot_eval` of the AnimationPlayer's `current_animation` names the clip that plays, and `godot_scene_tree` shows `GeneralSkeleton` under the model. On MPFB, Rigify, and Mixamo rigs the limbs follow the clips within about 10 degrees; MPFB's `game_engine` rig bends the torso up to 23 degrees differently in deep bends, and its `mixamo` rig follows more closely.

## Pitfalls

- After retargeting, the model's bones have the profile's names: code that names bones uses `Hips` or `LeftHand`, not `pelvis`.
- A model without finger bones ignores the finger tracks. Animals, creatures with tails or wings, and other non-humanoid rigs cannot play these clips.
- Removing the add-on deletes its folder; the bone maps beside the models stay, and scenes that use the library must drop it.
- CC0: no credit is required. Tell the user the clips are by Quaternius (quaternius.com).
