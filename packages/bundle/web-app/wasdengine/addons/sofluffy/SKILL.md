---
name: sofluffy
description: SO FLUFFY is installed in this project. Its Fur node grows shell fur on any mesh it is a child of, with length, density, curls, a color along each strand, and springy physics that swings the fur when its owner moves, and it draws in Web builds. Load before making a creature, a mascot, a rug, or moss furry.
---

# SO FLUFFY (2024-02-13)

`res://addons/so_fluffy/` (MIT, by Max Muermann; no plugin to enable). Fur as shells: the mesh is drawn again and again, each time a little larger, and a shader cuts strands out of every shell. Three furry things with 104 shells between them ran at 60 fps in a Web build, at 515 draw calls.

## Fur on a mesh

The script has no class name; preload it:

```gdscript
const FUR := preload("res://addons/so_fluffy/so_fluffy.gd")

func make_furry(body: MeshInstance3D, color: Color) -> void:
	var fur := FUR.new()
	fur.number_of_shells = 32            # every shell draws the mesh once more: 16 for a rug, 32 to 48 for a hero
	fur.length = 0.12                    # meters
	fur.density = 0.7                    # 0 to 1
	fur.albedo_color = color
	body.add_child(fur)                  # a MeshInstance3D or a CSG shape; the fur covers all its surfaces
```

Set the properties before `add_child`, or at any time after: the fur rebuilds. Freeing the Fur node gives the bare mesh back.

| Property | Default | |
|---|---|---|
| `number_of_shells` | 64 | lower it first when frames drop |
| `length` | 0.1 | strand length in meters |
| `density` | 0.5 | share of the surface that grows strands |
| `scruffiness` | 0.5 | how unequal the strands' lengths are |
| `thickness_scale` | 1.5 | thicker strands read as wool or moss, thinner as hair |
| `curls_enabled`, `curls_twist` | false, 48 | curls, for sheep and poodles |
| `turbulence_strength` | 0.3 | strands lean this way and that |
| `normal_strength`, `static_direction_local` | 1, zero | fur grows out of the surface; `static_direction_local = Vector3.DOWN * 0.6` makes it hang |
| `albedo_color`, `albedo_texture` | light blue | the fur's color, or a texture on the mesh's UV map for spots and stripes |
| `height_gradient` | dark root to full tip | a `GradientTexture2D` of colors from root to tip |
| `target_surfaces` | all | surface indices of the mesh that grow fur: the body and not the eyes |
| `physics_enabled`, `spring_constant`, `mass`, `damping` | true, 80, 0.15, 3 | the fur lags behind its owner's movement and springs back |
| `lod_enabled`, `lod_min_distance`, `lod_max_distance` | false, 3, 25 | fewer shells with distance from the camera |

Under the fur the mesh keeps its own material: give it the fur's color, darker, so that thin places show skin and not gray.

## Pitfalls

- The cost is the number of shells times the mesh's triangles, and each shell is also drawn into every shadow: keep fur to one or two things near the camera, switch `lod_enabled` on for anything that can be far away, and set `cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF` on rugs and moss.
- The fur is the mesh's `material_overlay`. Whatever else sets an overlay on the same mesh takes the fur off, such as `wasd-weather` covering it with snow: add a furry mesh to the group `wasd_weather_bare`.
- Strands follow the mesh's UV map: a mesh without one grows no pattern, and a ball's poles show a swirl. Turn the swirl away from the camera or cover it.
- Fur thicker than the gaps between a character's limbs pokes through them: keep `length` under a third of the thinnest limb.

## Check it

`godot_run`, then `godot_screenshot` from near and from the game's camera, and `godot_performance` with the furry things on screen. Fur that looks like noise from the game's camera is too short or too sparse for that distance: lengthen it or leave it out.
