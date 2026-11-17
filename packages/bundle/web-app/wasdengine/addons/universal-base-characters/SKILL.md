---
name: universal-base-characters
description: Universal Base Characters (Quaternius, CC0) is installed in this project. Two rigged, textured human bodies, a man and a woman in underwear, imported retargeted to Godot's humanoid skeleton so the Universal Animation Library's clips play on them, with hair, beard, and eyebrow models to put on them. Load before using these characters.
---

# Universal Base Characters (Quaternius, Standard edition)

The add-on folder `res://addons/universal_base_characters/` holds:
- `Superhero_Male_FullBody.gltf` and `Superhero_Female_FullBody.gltf`: a man 1.81 m and a woman 1.77 m tall, each with its body, eyes, and eyebrows, in dark gray underwear. Their import retargets them to Godot's `SkeletonProfileHumanoid`: the skeleton is the unique node `%GeneralSkeleton` (`Armature/GeneralSkeleton`), with the profile's bone names (`Hips`, `Spine`, `Head`, `LeftHand`, `LeftFoot`, and the others). They stand on the origin and face +Z.
- Hair, beard, and eyebrow models (`.gltf`), each made for one body: for the man `Hair_SimpleParted`, `Hair_Buzzed`, `Hair_Beard`, and `Eyebrows_Regular`; for the woman `Hair_Long`, `Hair_Buns`, `Hair_BuzzedFemale`, and `Eyebrows_Female`. On the other body they sit visibly off.
- `T_Superhero_Male_Ligh.png` and `T_Superhero_Female_Light_BaseColor.png`: the bodies' color textures with light gray underwear.
- `retarget.gd` and `bone_maps/`, as in the animation add-ons, for other models.

## 1. Place a character and play clips

The clips come from the Universal Animation Library: install `universal-animation-library`, and `universal-animation-library-2` for more, with game_addons. Point the AnimationPlayer's `root_node` at the body's instance, which owns `%GeneralSkeleton`:

```
[gd_scene format=3]

[ext_resource type="PackedScene" path="res://addons/universal_base_characters/Superhero_Female_FullBody.gltf" id="1_body"]
[ext_resource type="AnimationLibrary" path="res://addons/universal_animation_library/AnimationLibrary_Godot_Standard.glb" id="2_ual"]

[node name="Player" type="CharacterBody3D"]

[node name="Body" parent="." instance=ExtResource("1_body")]

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
root_node = NodePath("../Body")
libraries/ual = ExtResource("2_ual")
```

Then `$AnimationPlayer.play("ual/Walk")`. These bodies need no `retarget.gd` run. The library's guide lists its clips and their ground speeds per meter of `motion_scale`, which is 0.949 for the man and 0.932 for the woman: Walk moves at about 1.1 m/s.

## 2. Hair, beard, and eyebrows

The bodies are bald. Move a part's mesh onto the body's skeleton, which it then follows. Its texture is near white, as are the body's own eyebrows, so give it a color:

```
const UBC := "res://addons/universal_base_characters/"

## Puts a hair, beard, or eyebrow model on a body, in a color.
func add_part(body: Node3D, file: String, color: Color) -> void:
	var skeleton: Skeleton3D = body.get_node("%GeneralSkeleton")
	var part := (load(UBC + file) as PackedScene).instantiate()
	for mesh: MeshInstance3D in part.find_children("*", "MeshInstance3D", true, false):
		mesh.owner = null
		mesh.reparent(skeleton, false)
		mesh.skeleton = NodePath("..")
		tint(mesh, color)
	part.free()


## Multiplies the color of a mesh's material: hair, eyebrows, or skin.
func tint(mesh: MeshInstance3D, color: Color) -> void:
	var material := mesh.get_active_material(0).duplicate() as StandardMaterial3D
	material.albedo_color = color
	mesh.set_surface_override_material(0, material)
```

such as, in `_ready`, `add_part($Body, "Hair_Long.gltf", Color(0.32, 0.2, 0.12))` and `tint($Body/Armature/GeneralSkeleton/Eyebrows, Color(0.32, 0.2, 0.12))`. Brown `Color(0.32, 0.2, 0.12)`, auburn `Color(0.62, 0.25, 0.12)`, and black `Color(0.08, 0.07, 0.07)` read well. To change the eyebrows' shape, hide the body's `Eyebrows` and add its body's eyebrow model.

## 3. Skin and underwear

- The textures have one skin tone. For darker skin, `tint` the body mesh, `SuperHero_Male` or `Superhero_Female` under `Armature/GeneralSkeleton`, such as with `Color(0.55, 0.4, 0.32)`; the tint also darkens the underwear, and it cannot lighten the skin.
- For light gray underwear, set that mesh's override material's `albedo_texture` to the `Ligh`/`Light` texture.

## Check it

Run the game and take a `godot_screenshot` while a clip plays: the hair stays on the head through the motion, and the eyebrows and hair have their colors. `godot_eval` of the AnimationPlayer's `current_animation` names the clip that plays.

## Pitfalls

- They wear only underwear. For clothes, model the outfit in Blender over the body's file, give it the body's skin weights with a Data Transfer modifier, export it with the armature as glTF, run `retarget.gd` on it, and add it like hair; or pick kaykit-adventurers or MPFB characters.
- Code that names bones uses the profile's names, such as `Hips` or `RightHand`, not the file's `pelvis` or `hand_r`. A weapon goes under a `BoneAttachment3D` child of `%GeneralSkeleton` with `bone_name = "RightHand"`.
- Removing the add-on moves its folder into a new backup folder under `.wasdengine/backups/universal-base-characters/`; scenes that instance its bodies must drop them.
- CC0: no credit is required. Tell the user the characters are by Quaternius (quaternius.com).
