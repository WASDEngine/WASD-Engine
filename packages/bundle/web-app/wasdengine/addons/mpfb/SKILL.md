---
name: mpfb
description: MPFB 2.0.18 (MakeHuman Plugin for Blender) is installed for this project's Blender with MakeHuman's CC0 system assets and makes rigged human characters with body sliders, skins, eyes, hair, clothes, low-poly proxies, and a 53-bone game skeleton, ready for .glb export. Load before making human characters in Blender.
---

# MPFB 2.0.18 (MakeHuman) on Blender 5.2.3, headless

In each Blender Session, first run `import wasd_addons; wasd_addons.enable("mpfb")` with `mcp__wasd_blender__execute_python`. It points MPFB at MakeHuman's CC0 system assets, which WASD Engine installed with it, is idempotent, survives `new_scene`, and must be repeated after a tool result says the worker's state was lost. All code below runs in `execute_python` (set `result` to return values).

Use MPFB's Python services, not its `bpy.ops.mpfb.*` operators: the operators read settings from UI panels. The base mesh, body targets, skeletons and weights ship with the add-on; skins, eyes, eyebrows, eyelashes, hair, teeth, clothes, shoes and low-poly proxies come from the system assets, whose folder `wasd_addons.assets("mpfb")` returns.

## Services

```python
from bl_ext.wasd.mpfb.services import HumanService, TargetService, RigService
from bl_ext.wasd.mpfb.services.exportservice import ExportService
```

- `TargetService.get_default_macro_info_dict()`: `{'gender': 0.5, 'age': 0.5, 'muscle': 0.5, 'weight': 0.5, 'proportions': 0.5, 'height': 0.5, 'cupsize': 0.5, 'firmness': 0.5, 'race': {'asian': 0.33, 'caucasian': 0.33, 'african': 0.33}}`. All values 0..1: gender 0 female, 1 male; age 0 baby, 0.1875 child, 0.5 young adult, 1 old.
- `HumanService.create_human(macro_detail_dict=macro)` returns the base mesh object `Human`, feet on the ground at the origin, about 1.66 m with defaults. It has 19,158 vertices, of which 13,380 (26,756 triangles) are visible; the rest is helper geometry hidden by a Mask modifier ("Hide helpers"). The body shape is shape keys.
- `HumanService.add_builtin_rig(basemesh, "game_engine")` adds `Human.rig`, parents the body to it with weights and an Armature modifier. game_engine has 53 deform bones with Unreal-style names: `Root`, `pelvis`, `spine_01`..`spine_03`, `neck_01`, `head`, `clavicle_l`, `upperarm_l`, `lowerarm_l`, `hand_l`, finger bones (`index_01_l`...), `thigh_l`, `calf_l`, `foot_l`, `ball_l` (and `_r`). Other names: `default`, `default_no_toes`, `game_engine_with_breast`, `mixamo`, `mixamo_unity`, `cmu_mb`, `openpose`.
- `TargetService.bake_targets(basemesh)` applies the shape keys; `ExportService.bake_modifiers_remove_helpers(basemesh, bake_masks=True)` deletes the helper geometry (13,380 vertices left). Add the rig first: it is placed from the helpers.

## Game-ready character

```python
import bpy
from bl_ext.wasd.mpfb.services import HumanService, TargetService
from bl_ext.wasd.mpfb.services.exportservice import ExportService
macro = TargetService.get_default_macro_info_dict()
macro.update(gender=1.0, muscle=0.7, weight=0.4, height=0.6)
body = HumanService.create_human(macro_detail_dict=macro)
rig = HumanService.add_builtin_rig(body, "game_engine")
TargetService.bake_targets(body)
ExportService.bake_modifiers_remove_helpers(body, bake_masks=True)
decimate = body.modifiers.new("Decimate", 'DECIMATE')
decimate.ratio = 0.25            # about 6,700 triangles; weights survive
skin = bpy.data.materials.new("Skin"); skin.diffuse_color = (0.8, 0.6, 0.5, 1.0)
body.data.materials.append(skin)
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True); rig.select_set(True); bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath="/abs/path/human.glb", export_format='GLB', use_selection=True, export_apply=True)
result = {"bones": len(rig.data.bones), "vertices": len(body.data.vertices)}
```

The `export_gltf` tool with `selection: ["Human.rig"]` exports the same (children are included, modifiers applied). Without the Decimate modifier the body is 26,756 triangles, too heavy for most Web games.

## Animate

Pose bones of `Human.rig` directly, for example `rig.pose.bones["upperarm_l"].rotation_euler` (rotation mode XYZ) with `keyframe_insert`. For Rigify controls instead, enable Rigify too (`wasd_addons.enable("rigify")`), then `meta = HumanService.add_builtin_rig(body, "rigify.human")` and `rig = RigService.generate_rigify_rig(meta)`: the body is moved onto the generated rig (`Human.rigify`, 930 bones, 181 deform including the face); load the rigify skill for animating and exporting it.

## Verify

- `len(body.data.vertices)` and triangles of the evaluated mesh, `len(rig.data.bones)`, `body.parent == rig`.
- `render_preview(objects=["Human.rig"], view="front")`. Rotate `rig.pose.bones["upperarm_l"]` and preview again to see the skinning.
- In Godot, the .glb imports as a Skeleton3D with 53 bones and a skinned MeshInstance3D.

## Dress a character

Add parts to a base mesh `body` that already has its rig, in this order. Each comes back parented to the rig with an Armature modifier:

```python
import os, wasd_addons
from bl_ext.wasd.mpfb.services import HumanService
ASSETS = wasd_addons.assets("mpfb")
def part(path, kind):
    return HumanService.add_mhclo_asset(os.path.join(ASSETS, path), body, asset_type=kind, subdiv_levels=0)
proxy = part("proxymeshes/proxy741/proxy741.proxy", "Proxymeshes")
HumanService.set_character_skin(os.path.join(ASSETS, "skins/young_caucasian_male/young_caucasian_male.mhmat"), body,
                                skin_type="GAMEENGINE", material_instances=False)
eyes = part("eyes/low-poly/low-poly.mhclo", "Eyes")
hair = part("hair/short02/short02.mhclo", "Hair")
suit = part("clothes/male_casualsuit01/male_casualsuit01.mhclo", "Clothes")
```

Export the rig with the proxy, eyes, hair and clothes, not the base mesh. Measured triangles: proxy741 1,460, low-poly eyes 172, short02 hair 3,344, male_casualsuit01 16,672. Clothes add Mask modifiers that hide the skin under them, so exporting with modifiers applied removes it. Textures are 2048 px (that character's .glb was 15.9 MB): `image.scale(1024, 1024)` each one for the Web. The pack's asset names are in [references/asset-packs.md](references/asset-packs.md).

## Pitfalls

- The base mesh, targets, and system assets are CC0, so characters made from them carry no license duty; the add-on's GPL code is not part of the game.
- `new_scene` resets add-on preferences; the worker points MPFB at the system assets again, but set your own MPFB preferences again.
- `create_human` deselects everything and makes no material.
- MPFB prints `[INFO ]` / `[WARN ]` log lines; "User home directory does not exist" is harmless.
- Do not call `bpy.ops.mpfb.*` operators; do not export the body with shape keys to the Web (each becomes a morph target).
