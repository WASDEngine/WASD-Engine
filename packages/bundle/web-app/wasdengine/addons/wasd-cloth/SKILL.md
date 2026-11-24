---
name: wasd-cloth
description: WASD Cloth is installed in this project. Godot nodes for cloth and ropes in 3D games (WasdClothSheet3D soft-body sheets with fabric presets, WasdClothChains3D spring-bone capes and skirts, WasdRope3D ropes, cables, and vines that hang and swing, WasdClothWind3D wind zones), flag_wind.gdshader for flags without physics, and check_cloth.gd, which measures the cloth of a scene. Load before adding cloth, a rope, or a hanging cable to this game.
---

# WASD Cloth

`res://addons/wasd_cloth/` (CC0, no plugin to enable; the classes are global):

| File | For |
|---|---|
| `cloth_sheet_3d.gd`, `WasdClothSheet3D` | cloth the physics engine moves |
| `cloth_chains_3d.gd`, `WasdClothChains3D` | capes, skirts, coat tails, scarves, hair, tails on bone chains |
| `rope_3d.gd`, `WasdRope3D` | ropes, cables, wire ropes, vines that hang and swing |
| `cloth_wind_3d.gd`, `WasdClothWind3D` | wind with gusts for all three |
| `flag_wind.gdshader` | flags and banners that wave without physics |
| `check_cloth.gd` | measures the cloth of a scene |

## Pick the kind

| The cloth | Use | Cost per frame |
|---|---|---|
| Flags, banners, sails far away or in numbers | `flag_wind.gdshader` | none |
| One flag, sail, or curtain close up that only waves | a loop baked in Blender (`bake_loop`) | small |
| Tablecloths, bedsheets, tarps, rugs | a drape baked in Blender (`drape`), a plain mesh | none |
| Capes, skirts, coat tails, scarves, hair | Blender `add_chains` + `WasdClothChains3D` | about 0.1 ms |
| Cloth that players or objects push: curtains walked through, banners hit, hammocks | `WasdClothSheet3D` | 0.5 to 1.5 ms per sheet |

The Blender rows need the wasd-cloth-blender add-on.

## WasdClothSheet3D

It needs Jolt Physics, which runs SoftBody3D in Godot 4.7: `project.godot` must have `3d/physics_engine="Jolt Physics"` under `[physics]`; with Godot Physics, soft bodies fall through static bodies. In a game that already exists, ask the user first: the switch changes how its rigid bodies behave.

```
[ext_resource type="Script" path="res://addons/wasd_cloth/cloth_sheet_3d.gd" id="1_sheet"]

[node name="Flag" type="SoftBody3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.8, 2.45, 0)
script = ExtResource("1_sheet")
size = Vector2(1.5, 1)
fabric = "canvas"
pinned_edges = PackedStringArray("left")
pin_rows = 2
```

- `size` in meters; `facing` 0 hangs in the XY plane facing +Z, 1 lies in XZ facing +Y; `cell` is the grid spacing (0.06 m).
- `fabric`: silk, cotton, canvas, denim, leather, rubber. It sets mass, stiffness, damping, and solver precision; `precision` overrides the iterations, and `custom` keeps SoftBody3D settings of your own.
- `pinned_edges`: top, bottom, left, right, or a corner such as top_left; top is +Y when hanging and -Z when lying. `pin_rows = 2` stops stretching beside a pole.
- `pin_target`: the path of a node the pins move with, such as `NodePath("../Pole")`, a BoneAttachment3D, or a ship; without it the pins stay put.
- The default material is double-sided; a `material_override` of your own needs `cull_mode = CULL_DISABLED`.
- While the game runs, a new `size`, `cell`, or `facing` builds the sheet again, at rest where it rests (by its `pin_target` if it has one), with its fabric's current settings; its motion starts over. New `pinned_edges` (assign a new array), `pin_rows`, or `pin_target` pin it again: points that leave a pinned edge let go, new ones hold where they are or, with a target, where they rest relative to it.

Measured on Jolt at 60 ticks per second: 95% of edges within 2 to 5% of their length in a 6 m/s gust, nothing sinking into colliders, no explosions, 0.45 ms (leather) to 1.5 ms (silk) per sheet of 300 to 1,000 points.

These break cloth without an error:
- Scale on the sheet or a parent: soft bodies ignore it. Set `size` instead.
- Moving it after it enters the tree misplaces it: free it and add a new one where it belongs.
- Changing `fabric`, `precision`, or `linear_stiffness` after it enters the tree: Jolt keeps the stiffness and solver iterations it started with until a new `size`, `cell`, or `facing` builds the sheet again. Set them before `add_child`, or add a new sheet.
- Toggling its `process_mode` makes it grow.
- `linear_stiffness` 1.0 explodes; the presets stay at 0.9.
- A sheet that starts inside a collider, or a collider thinner than a cell, lets points through.

## WasdClothWind3D

An Area3D that blows on every soft body in its `box_size` box (100 by 40 by 100 m around it); WasdClothChains3D follows it too. Set `direction`, `speed` in m/s (2 is a breeze, 6 stiff, 12 a gale), `gustiness` (0 to 1), `turbulence` (degrees the direction swings), and `cloth_pressure` (scales the push on sheets). `direction` is a world direction: turning the zone, or a ship that carries it, turns only its box. Wind along a sheet's surface does not push it: aim it across. `WasdClothWind3D.velocity_at(get_tree(), position)` returns the wind for your own code. With the `wasd-weather` add-on, `zone.add_to_group("wasd_wind")` hands the zone the weather's wind, so cloth flies harder in a storm, and its own when the weather leaves.

## WasdClothChains3D

A child of the character's Skeleton3D. It finds the bones named `cloth_<group>_<column>_<row>` that `add_chains` made, makes one spring-bone chain each with the fabric's stiffness, drag, and gravity, and puts capsules around the hips, torso, and legs (Godot humanoid, MPFB, Mixamo, or Rigify bone names). Set `group` (empty takes all), `fabric`, `body_colliders`, `wind_response`, and `joint_radius`. An imported model's skeleton sits inside its instance, so add the node from the character's script:

```gdscript
func _ready() -> void:
	var cloth := WasdClothChains3D.new()
	cloth.fabric = "canvas"
	$Model/Armature/Skeleton3D.add_child(cloth)
```

Call `reset()` on it after teleporting the character, and `configure()` after changing the skeleton. Chains do not hold each other, so a skirt's chains can part in fast moves.

## WasdRope3D

One draw call, no physics body, no texture:

```gdscript
var rope := WasdRope3D.new()
rope.length = 4.3               # longer than the gap, so it sags
rope.end_target = $PostB/Top    # none: a free end
$PostA/Top.add_child(rope)      # starts at the node
```

`look` is rope, cable, steel, or vine and sets `color`; `thickness` (0.04 m); `segments` (16, at most 31). `hanging` is a node that swings on the free end, such as a lamp. `ground_mask` lets the rope lie on those physics layers; a free rope starts coiled there. `knots = false` suits a cable into a wall. Wind zones move it (`wind_response`). Code may change `length`, `push(speed, part)` it, and read `get_position_at(part)` (0 to 1) to hang things on it; call `reset()` after teleporting an end. It passes through walls and bodies.

## flag_wind.gdshader

For a subdivided plane, such as a PlaneMesh with `orientation = 2` (facing Z) and `subdivide_width` and `subdivide_depth` of 16 or more. Parameters: `albedo_texture`, `albedo_color`, `pinned_edge` (0 keeps the UV.x = 0 edge still, a flag on a pole; 1 the UV.y = 0 edge, a hanging banner), `wind_speed`, `amplitude`, `wave_length`, `cloth_size` (meters along and across the waves), `flutter`, and `phase` (set it differently on neighbors). It is double-sided.

## Baked cloth from Blender

A `bake_loop` object exports as morph targets with an action named `..._loop`; Godot imports it as an animation that loops, named without `_loop`. Play it with `$Flag/AnimationPlayer.play("Flag")` or `autoplay`. A `drape` result is a plain mesh.

## Check the cloth

Call `godot_script` with `script: "res://addons/wasd_cloth/check_cloth.gd"` and `args: ["res://levels/castle.tscn", "--seconds=6"]`. Add `"--move=Player"`, a node path under the scene's root, to run that node around a 3 m circle so that capes swing. Physics runs in real time. One line per cloth:

```
OK WasdClothSheet3D Flag: fabric canvas, 468 points, 36 pinned, precision 15, stiffness 0.90, mass 0.45 kg; stretch 95% +3.2%, max +25.3%; 0 sunk; end speed 1.20 m/s.
```

`PROBLEM` lines say what to change, and the last line is `CLOTH_CHECK OK` or `CLOTH_CHECK PROBLEMS <n>`. Then look at it: `godot_run` and a screenshot.
