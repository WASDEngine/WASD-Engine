---
name: wasd-water
description: WASD Water is installed in this project. A Godot node for water in 3D games, WasdWater3D (rectangle, disc, a sea to the horizon, or a river along a Path3D, with ocean waves, light through crests, foam that trails behind them, depth colors, refraction, caustics, mirrored scenery, rings, an underwater view, and 16 presets from ocean and lake to toon, low_poly, and lava), and WasdWaterFloater3D, which makes rigid bodies float. Load before adding water, lava, or another liquid to this game.
---

# WASD Water

`res://addons/wasd_water/` (CC0, no plugin to enable; the classes are global): `WasdWater3D` is a body of water, `WasdWaterFloater3D` makes a RigidBody3D float, `WasdWaterPresets` has the looks. It draws on Forward+, Mobile, and Web builds' Compatibility renderer alike.

## Add water

```
[ext_resource type="Script" path="res://addons/wasd_water/water_3d.gd" id="1_water"]

[node name="Sea" type="MeshInstance3D" parent="."]
script = ExtResource("1_water")
preset = "ocean"
shape = 2
size = Vector2(2000, 2000)
wave_height = 1.2
```

In code: `var water := WasdWater3D.new()`, set `preset` first, then other properties, then `add_child(water)`, since `preset` resets every look and wave property. The node's Y is the water level.

| `shape` | Mesh |
|---|---|
| 0 `RECTANGLE` | `size` meters along X and Z |
| 1 `DISC` | an ellipse `size` across: ponds, pools |
| 2 `INFINITE` | a sea `size.x` across (1000 to 3000) that stays under the camera |
| 3 `PATH` | a ribbon `size.x` wide along the Path3D that `path` names: rivers, waterfalls. It flows from the curve's start to its end; `rebuild()` after changing the curve |
| 4 `CUSTOM` | the node's own `mesh`, flat and facing +Y |

`cell` (0.5 m) is the distance between vertices: waves shorter than 5 cells only shade the surface. The ground under the water must exist and be opaque: depth colors, shore foam, and caustics come from it. Put the level 0.3 to 1 m above a river's bed and let lakes and seas cut into sloping terrain.

## Presets

| Preset | Look |
|---|---|
| `lake` | calm, clear, mirrors its shores; the default |
| `spring` | a still forest pool, very clear, green |
| `pond` | small, still, green, murky |
| `river` | a current of 1.5 m/s, white water on slopes and falls |
| `calm_sea` | deep blue, 0.5 m swell, little foam |
| `ocean` | 2.2 m rolling swell, light through the crests, foam trailing behind them |
| `storm` | 5 m dark waves streaked with foam |
| `tropical` | turquoise lagoon, bright caustics, foam lines on the beach |
| `swamp` | brown-green, opaque, no waves |
| `arctic` | pale, glassy |
| `pool` | light blue, lively caustics |
| `toon` | 3 flat color bands, hard white shore lines |
| `low_poly` | faceted; also sets `cell` to 1.5 |
| `retro` | blocky, 4 colors |
| `lava` | glows orange, dark crust |
| `toxic` | glowing green slime |

## Properties

- Color: `shallow_color` (the tint light takes on in `color_depth` m of water: how a pale bottom looks at that depth), `deep_color` (the water's own color where the bottom is lost), `clarity` (m one sees through), `color_steps` (2+ toon bands), `glow`, `scatter_color` and `scatter_strength` (sunlight through wave crests).
- Surface: `roughness` (blurs the mirrored sky), `reflectivity`, `refraction`, ripples `surface_normal_map`, `surface_scale` (m per tile), `surface_strength`, `surface_speed`, sun glitter `glint_strength`, `glint_size`, `glint_sparkle` (breaks it into sparks), `glint_hardness` (1 is toon), `flat_shading`, `pixel_size`.
- Reflection: `reflection` is 0 `SKY` (the sky and ReflectionProbes), 1 `SCREEN` (also what is on screen above the water; the inland presets use it), or 2 `PLANAR` (a mirror camera draws the scene again: exact, for one calm lake or pool the player stands at; level water only). `reflection_steps` and `reflection_distance` (m) tune SCREEN; `reflection_resolution` (px), `reflection_distance`, and `reflection_layers` tune PLANAR; `reflection_distortion` is how far waves bend the image.
- Waves: `wave_height` (m, trough to crest of the larger waves; 0 is flat), `wave_length` (m, the longest), `wave_count` (0 to 32: each wave is a fifth shorter than the one before, so more add finer chop), `wave_chop` (0 smooth swell, 1 rough), `wave_steepness` (0 round, 1 crests about to break), `wave_direction` (degrees, 0 toward -Z, 90 toward +X; along a PATH 0 is downstream), `wave_spread`, `wave_speed`.
- Flow: `flow` (m/s along world X and Z; for PATH across and along the path).
- Foam: `crest_foam` (white caps where `wave_steepness` folds the crests), `foam_trail` (seconds foam stays behind a crest), `foam_trail_waves` (how many of the longest waves leave it), `foam_stretch` (streaks along the wind), `shore_foam`, `shore_foam_width` (m of depth), `shore_foam_lines`, `slope_foam` (rapids, falls), `foam_color`, `foam_noise`, `foam_scale`, `foam_speed`, `foam_hardness`.
- Caustics: `caustics`, `caustics_scale`, `caustics_depth`, `caustics_pattern`. Edge: `edge_fade` (m). Time: `time_scale`.
- Underwater: `underwater_effect`, `underwater_color`, `underwater_fog_density`; the node tints the view and sets the Environment's fog while the camera is under; signals `camera_submerged` and `camera_surfaced` time muffled audio.
- `quality = 1` (`FAST`) reads neither screen nor depth: waves, white caps, rings, glitter, and the sky's reflection stay; refraction, depth colors, shore foam, caustics, and mirrored scenery go.

## Make it look good

- The sky colors the water: under a gray sky it is gray. Give the scene a sky with color, a sun (`wasd-look`'s or a DirectionalLight3D) for glitter and light through crests, and the Environment's glow for the sparks.
- A sea reads as a sea when its waves are large on screen: `wave_length` 15 to 30 times `wave_height`, the camera a few meters over the surface.
- Still water reads as water when it mirrors something: put trees, rocks, or a bank behind it and look across it at a flat angle.
- `wave_count`, `foam_trail_waves`, and `reflection_steps` cost every pixel of the water. When the Web check or `godot_performance` shows the water costs too much, lower them, set `reflection = 0`, or use FAST.

## Float, swim, splash

```gdscript
var water := WasdWater3D.find(get_tree(), global_position)  # null away from water
if water != null and water.is_underwater(global_position):
	velocity += water.flow_at(global_position) * delta  # the current carries the swimmer
```

`water.add_ripple(position, strength)` starts rings for a moment, not each frame: 3 a splash as a swimmer goes in, 1 a wading step. Also `height_at(position)` (world Y of the waves now), `depth_at(position)` (m of water over a point), `contains(position)`, and `depth` (how far down the water reaches, 50 m).

A RigidBody3D floats with `WasdWaterFloater3D` children, added before the body enters the tree: one in the middle of a crate, or one per corner of a hull, level with the center of mass or higher. Each has `buoyancy` (2 floats half under), `submerge_depth` (about the hull's height), `drag`, `current_pull`, and signals `entered_water(speed)` and `left_water`.

## Pitfalls

- Waves do not know the shore: where a sea meets a beach, lower `wave_height`, or the swell runs through the sand.
- SCREEN mirrors only what is on screen; PLANAR mirrors everything and doubles the drawing. A PLANAR water draws on render layer 20, which mirror cameras skip.
- Transparent things under the surface (glass, particles) do not show through the water.
- Keep the node level and unscaled. Only PATH and CUSTOM meshes may slope.
- `height_at()` on a PATH is the path's height without waves; rings do not draw on a PATH.
- An `INFINITE` sea flattens its waves beyond a fifth of `size.x` from the camera.
- Two waters at the same height flicker where they overlap: end a river a few centimeters above the lake.
- A shadow-casting sun makes everything brighter on the Compatibility renderer than on Forward+: judge colors with `godot_run` and `web: true`.

## Check the water

`godot_run` with `web: true` and a screenshot from the player's camera, then one from above: the shore shows a color change from shallow to deep, a sea shows crests and foam, still water mirrors what stands behind it, and the surface moves between two screenshots.
