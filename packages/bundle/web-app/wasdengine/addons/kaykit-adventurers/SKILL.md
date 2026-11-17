---
name: kaykit-adventurers
description: KayKit Adventurers (Kay Lousberg, CC0) is installed in this project. Five rigged, textured, low-poly fantasy characters (Knight, Barbarian, Mage, Rogue, hooded Rogue) with their weapons, sharing one skeleton and 76 clips, and 27 weapons and props on their own. Load before using these characters or props.
---

# KayKit Adventurers (Kay Lousberg, 1.0)

The add-on folder `res://addons/kaykit_character_pack_adventures/` holds:
- `Characters/gltf/<Name>.glb` for `Barbarian`, `Knight`, `Mage`, `Rogue`, and `Rogue_Hooded`: a scene with an `AnimationPlayer` of the 76 clips and `Rig/Skeleton3D`, which holds the body and its gear.
- `Assets/gltf/<prop>.gltf`: 27 weapons and props on their own, for pickups, loot, racks, and set dressing: arrow, arrow_bundle, axe_1handed, axe_2handed, crossbow_1handed, crossbow_2handed, dagger, mug_empty, mug_full, quiver, shield_badge, shield_round, shield_spikes, and shield_square (each also as `_color`), shield_round_barbarian, smokebomb, spellbook_closed, spellbook_open, staff, sword_1handed, sword_2handed, sword_2handed_color, and wand.

## 1. Place a character

Instance the `.glb` under the body that moves it:

```
[gd_scene format=3]

[ext_resource type="PackedScene" path="res://addons/kaykit_character_pack_adventures/Characters/gltf/Knight.glb" id="1_knight"]

[node name="Player" type="CharacterBody3D"]

[node name="Knight" parent="." instance=ExtResource("1_knight")]
```

The characters stand on the origin and face +Z. Their proportions are chibi: about 2.2 m to the top of the head, with the hips at 0.4 m; the Knight's helmet reaches 2.5 m and the Mage's hat 3 m. Fit the collision shape to that, or scale the instance, such as `scale = Vector3(0.8, 0.8, 0.8)` for a 1.8 m head, when the game's doors and props are sized for people.

## 2. Gear in the hands

Each character shows all of its gear at once, under `BoneAttachment3D` nodes of `Rig/Skeleton3D`: `handslot_r` and `handslot_l` hold the weapons, `head` the hat or helmet, and `chest` the cape.

| Character | `handslot_r` | `handslot_l` | `head`, `chest` |
|---|---|---|---|
| Knight | 1H_Sword, 2H_Sword | 1H_Sword_Offhand, Badge_Shield, Rectangle_Shield, Round_Shield, Spike_Shield | Knight_Helmet, Knight_Cape |
| Barbarian | 1H_Axe, 2H_Axe, Mug | 1H_Axe_Offhand, Barbarian_Round_Shield | Barbarian_Hat, Barbarian_Cape |
| Mage | 1H_Wand, 2H_Staff | Spellbook, Spellbook_open | Mage_Hat, Mage_Cape |
| Rogue, Rogue_Hooded | 1H_Crossbow, 2H_Crossbow, Knife, Throwable | Knife_Offhand | Rogue_Cape |

Show only what the character carries, and switch weapons the same way:

```
func equip(model: Node3D, gear: Array) -> void:
	for slot in ["handslot_r", "handslot_l"]:
		for item in model.get_node("Rig/Skeleton3D/" + slot).get_children():
			item.visible = String(item.name) in gear
```

such as `equip($Knight, ["1H_Sword", "Round_Shield"])` in `_ready`. A prop from `Assets/gltf/` goes in a hand as a child of `handslot_r` or `handslot_l`.

## 3. Play the clips

`$Knight/AnimationPlayer.play("Idle")`, or `play("Running_A", 0.2)` to blend over 0.2 s; `animation_finished` reports the end of a clip that does not loop. Pick the clips that fit the weapon: `1H_Melee_*` with one one-handed weapon, `Dualwield_*` with two, `2H_Melee_*` with a two-handed one, `1H_Ranged_*` and `2H_Ranged_*` with the crossbows, `Spellcast_*` with the wand or staff, and `Unarmed_*` with none.

Clips (* loops): 1H_Melee_Attack_Chop, 1H_Melee_Attack_Slice_Diagonal, 1H_Melee_Attack_Slice_Horizontal, 1H_Melee_Attack_Stab, 1H_Ranged_Aiming*, 1H_Ranged_Reload, 1H_Ranged_Shoot, 1H_Ranged_Shooting*, 2H_Melee_Attack_Chop, 2H_Melee_Attack_Slice, 2H_Melee_Attack_Spin, 2H_Melee_Attack_Spinning*, 2H_Melee_Attack_Stab, 2H_Melee_Idle*, 2H_Ranged_Aiming*, 2H_Ranged_Reload, 2H_Ranged_Shoot, 2H_Ranged_Shooting*, Block, Block_Attack, Block_Hit, Blocking*, Cheer, Death_A, Death_A_Pose, Death_B, Death_B_Pose, Dodge_Backward, Dodge_Forward, Dodge_Left, Dodge_Right, Dualwield_Melee_Attack_Chop, Dualwield_Melee_Attack_Slice, Dualwield_Melee_Attack_Stab, Hit_A, Hit_B, Idle*, Interact, Jump_Full_Long, Jump_Full_Short, Jump_Idle*, Jump_Land, Jump_Start, Lie_Down, Lie_Idle*, Lie_Pose, Lie_StandUp, PickUp, Running_A*, Running_B*, Running_Strafe_Left*, Running_Strafe_Right*, Sit_Chair_Down, Sit_Chair_Idle*, Sit_Chair_Pose, Sit_Chair_StandUp, Sit_Floor_Down, Sit_Floor_Idle*, Sit_Floor_Pose, Sit_Floor_StandUp, Spellcast_Long, Spellcast_Raise, Spellcast_Shoot, Spellcasting*, T-Pose, Throw, Unarmed_Idle*, Unarmed_Melee_Attack_Kick, Unarmed_Melee_Attack_Punch_A, Unarmed_Melee_Attack_Punch_B, Unarmed_Pose, Use_Item, Walking_A*, Walking_B*, Walking_Backwards*, Walking_C*.

- The add-on's import settings make the clips marked * loop. Jump_Idle is the mid-air loop between Jump_Start and Jump_Land. The `_Pose` clips are single poses, for a character placed already dead, seated, or lying.
- Clips play in place, and the body moves in code. A planted foot stays put only while the body moves at the clip's ground speed, at the pack's size: Walking_A, Walking_B, and Walking_Backwards about 0.8 m/s, Walking_C 0.6, Running_B 2.3, and Running_A 4; multiply by the instance's scale. Or play the clip at the body's speed: `play("Walking_A", 0.2, speed / 0.8)`.

## Check it

Run the game and take a `godot_screenshot` while a clip plays; `godot_eval` of the AnimationPlayer's `current_animation` names the clip that plays.

## Pitfalls

- The look is chunky and big-headed, with flat palette colors. Keep the game's other models in that style, such as low-poly props with flat colors, or pick another character source.
- The skeleton is KayKit's own (`hips`, `upperarm.l`, `handslot.r`, and IK control bones): the Universal Animation Library's clips and other packs' clips do not play on it.
- Each character's colors come from one palette texture (`Textures/knight_texture.png` and the others, which the props share). For a variant, such as an enemy team, recolor a copy in GIMP and give the character's meshes a `material_override` that uses it.
- Removing the add-on moves its folder into a new backup folder under `.wasdengine/backups/kaykit-adventurers/`; scenes that instance its characters must drop them.
- CC0: no credit is required. Tell the user the characters are by Kay Lousberg (www.kaylousberg.com), who asks for credit where it fits.
