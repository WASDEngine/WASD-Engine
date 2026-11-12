---
name: universal-animation-library
description: Universal Animation Library (Quaternius, CC0) is installed in this project. 45 humanoid clips (idle, walk, jog, sprint, crouch, jump, roll, swim, sit, punch, sword, pistol, spells, hits, deaths) in one AnimationLibrary retargeted to Godot's humanoid skeleton, and retarget.gd, which prepares MPFB, Rigify, Mixamo, and Quaternius models to play them. Load before animating a humanoid character in this project.
---

# Universal Animation Library (Quaternius, Standard edition)

The add-on folder `res://addons/universal_animation_library/` holds:
- `AnimationLibrary_Godot_Standard.glb`, which imports as an `AnimationLibrary`, not a scene: 46 clips whose tracks drive the bones of Godot's `SkeletonProfileHumanoid` (`Hips`, `Spine`, `Chest`, `UpperChest`, `Neck`, `Head`, `LeftShoulder`, `LeftUpperArm`, `LeftLowerArm`, `LeftHand`, `LeftUpperLeg`, `LeftLowerLeg`, `LeftFoot`, `LeftToes`, fingers, and the `Right` ones) on a skeleton named `%GeneralSkeleton`. Its `.glb.import` file and `bone_maps/quaternius_ual1.tres` do the retargeting.
- `retarget.gd` and `bone_maps/`, which prepare a model to play the clips.

## 1. Retarget each model once

The model is a `.glb`, `.gltf`, or `.fbx` file in the project with a humanoid skeleton: an MPFB human, a Rigify game skeleton (see the rigify guide), a Mixamo download, or a Quaternius character. Once the project has imported it, call `godot_script` with `script: "res://addons/universal_animation_library/retarget.gd"` and `args: ["res://characters/hero.glb"]`; several models may follow. It prints one line per model:

```
RETARGETED res://characters/hero.glb: skeleton Human_rig/Skeleton3D, bone map mpfb_game_engine (53 of its 53 bones found), saved as res://characters/hero.bone_map.tres. ...
```

It picks the map in `bone_maps/` that names the most bones of the model's skeleton, saves a copy beside the model, and sets the model's import options: that bone map, Fix Silhouette, and the unique skeleton name `GeneralSkeleton`. The next import, which `godot_check`, `godot_script`, and `godot_run` start with, renames the skeleton's bones to the profile's names. The options stay when the model is exported again; run the script again after renaming the armature.

| Map | Rig: some of its bone names |
|---|---|
| `mpfb_game_engine` | MPFB `game_engine`: `Root`, `pelvis`, `spine_01`, `head`, `upperarm_l`; also most Unreal-style rigs |
| `mixamo` | Mixamo downloads and MPFB's `mixamo` rig: `mixamorig_Hips` (Godot turns `mixamorig:` into `mixamorig_`; numbered prefixes such as `mixamorig1_` work) |
| `rigify` | Rigify game skeleton: `DEF-spine`, `DEF-upper_arm.L` |
| `quaternius_ual1` | this pack's mannequin: `DEF-hips`, `DEF-spine.001` |
| `quaternius_ual2` | Universal Animation Library 2's mannequins: `pelvis`, `Head`, `upperarm_l` |

`RETARGET_FAILED` with "no map ... names this skeleton's bones" lists the skeleton's bones. Copy the closest map beside the model, set its `bone_map/<ProfileBone> = &"<bone>"` lines to those names (every required profile bone: Hips, Spine, Head, shoulders, arms, hands, legs, feet), and run the script again with `args: ["--map=res://characters/hero_rig.tres", "res://characters/hero.glb"]`.

## 2. Play the clips

Give the AnimationPlayer the library, and point its `root_node` at the model's instance, which owns `%GeneralSkeleton`; with the default `..` no track finds its bone:

```
[gd_scene format=3]

[ext_resource type="PackedScene" path="res://characters/hero.glb" id="1_hero"]
[ext_resource type="AnimationLibrary" path="res://addons/universal_animation_library/AnimationLibrary_Godot_Standard.glb" id="2_ual"]

[node name="Player" type="CharacterBody3D"]

[node name="Hero" parent="." instance=ExtResource("1_hero")]

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
root_node = NodePath("../Hero")
libraries/ual = ExtResource("2_ual")
```

Then `$AnimationPlayer.play("ual/Walk")`, or `play("ual/Sprint", 0.2)` to blend over 0.2 s; `animation_finished` reports the end of a clip that does not loop. From code: `player.add_animation_library(&"ual", preload("res://addons/universal_animation_library/AnimationLibrary_Godot_Standard.glb"))`. An AnimationTree takes the same library and `root_node`.

Clips (* loops): A_TPose, Crouch_Fwd*, Crouch_Idle*, Dance*, Death01, Driving*, Fixing_Kneeling, Hit_Chest, Hit_Head, Idle*, Idle_Talking*, Idle_Torch*, Interact, Jog_Fwd*, Jump*, Jump_Land, Jump_Start, PickUp_Table, Pistol_Aim_Down, Pistol_Aim_Neutral, Pistol_Aim_Up, Pistol_Idle*, Pistol_Reload, Pistol_Shoot, Punch_Cross, Punch_Enter, Punch_Jab, Push*, Roll, Roll_RM, Sitting_Enter, Sitting_Exit, Sitting_Idle*, Sitting_Talking*, Spell_Simple_Enter, Spell_Simple_Exit, Spell_Simple_Idle*, Spell_Simple_Shoot, Sprint*, Swim_Fwd*, Swim_Idle*, Sword_Attack, Sword_Attack_RM, Sword_Idle, Walk*, Walk_Formal*.

- The import drops the `_Loop` ending of the file's clip names and makes those clips loop. Jump is the mid-air loop between Jump_Start and Jump_Land.
- Clips play in place, and the body moves in code. A planted foot stays put only while the body moves at the clip's ground speed, here in m/s per meter of the model's hip height, which is its skeleton's `motion_scale` (`$Hero.get_node("%GeneralSkeleton").motion_scale`, 0.92 on the pack's mannequin): Walk and Walk_Formal 1.17, Crouch_Fwd 0.77, Push 0.38, Jog_Fwd 6.6, Sprint 10.2; rigs differ by up to a fifth. Move the body at that speed, or play the clip at the body's speed: `play("ual/Walk", 0.2, speed / (1.17 * motion_scale))`. Jog_Fwd and Sprint touch the ground for a tenth of a second per step and suit fast runs; played much slower, they look like slow motion.
- Roll_RM and Sword_Attack_RM move the `Root` bone forward instead, 5 m in 1.47 s and 1.5 m in 1.53 s on the pack's mannequin and in proportion to the hips' height on other models; without root motion the model slides away from its body and snaps back when the next clip starts. Set `root_motion_track = NodePath("%GeneralSkeleton:Root")` and move the body by `get_root_motion_position()` each frame. Only rigs with a `Root` bone (MPFB game_engine, Quaternius) carry this motion; on the others play Roll or Sword_Attack and move the body that far in code.
- The hips' height scales to the model, so a small character keeps its feet on the ground.
- Weapon clips hold the right hand where a weapon goes: put the weapon under a `BoneAttachment3D` child of `%GeneralSkeleton` with `bone_name = "RightHand"`.

## Check it

Run the game and take a `godot_screenshot` while a clip plays; `godot_eval` of the AnimationPlayer's `current_animation` names the clip that plays, and `godot_scene_tree` shows `GeneralSkeleton` under the model. On MPFB, Rigify, and Mixamo rigs the limbs follow the clips within about 10 degrees; MPFB's `game_engine` rig bends the torso up to 20 degrees differently in deep bends, and its `mixamo` rig follows more closely.

## Pitfalls

- After retargeting, the model's bones have the profile's names: code that names bones uses `Hips` or `LeftHand`, not `pelvis`.
- A model without finger bones ignores the finger tracks. Animals, creatures with tails or wings, and other non-humanoid rigs cannot play these clips.
- Removing the add-on deletes its folder; the bone maps beside the models stay, and scenes that use the library must drop it.
- CC0: no credit is required. Tell the user the clips are by Quaternius (quaternius.com).
