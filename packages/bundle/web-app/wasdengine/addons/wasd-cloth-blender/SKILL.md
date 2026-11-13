---
name: wasd-cloth-blender
description: WASD Cloth for Blender is installed for this project's Blender. Python functions that make cloth with Blender's Cloth modifier without a window (drapes settled onto props, wind loops baked into shape keys, bone chains for capes and skirts) and measure it. Load before making cloth in Blender.
---

# WASD Cloth for Blender

In each Blender Session, with execute_python:

```python
import importlib, wasd_addons
cloth = importlib.import_module(wasd_addons.enable("wasd-cloth-blender"))
```

Units are meters, +Z is up, and a standing sheet faces -Y. Fabrics: silk, cotton, canvas, denim, leather, rubber (Blender's presets, and canvas for flags and sails). Every function returns a dict of measurements: read it before going on, and look with render_preview (shading "material") after each step. Godot plays the results with the wasd-cloth add-on.

## Make a sheet and pin it

`cloth.sheet(name, size=(w, h), cell=0.04, facing="VERTICAL", location=...)` makes a subdivided rectangle with UVs: VERTICAL stands in the XZ plane (flags, banners, curtains), HORIZONTAL lies in XY (tablecloths, tarps). Any mesh works with the functions below; a sheet saves modelling. `cloth.pin(obj, "left", rows=2)` makes the vertex group `pin` along named edges (top, bottom, left, right, or a corner such as top_left).

## Drape cloth onto props

```python
table = bpy.data.objects["Table"]
sheet = cloth.sheet("Tablecloth", size=(1.8, 1.8), cell=0.03, facing="HORIZONTAL", location=(0, 0, 0.84))
print(cloth.drape(sheet, [table], "cotton"))
```

It simulates until the cloth settles, keeps the shape as a plain mesh, and removes the Cloth modifier. Measured: 3,721 points over a 1 m table, 150 frames in 7.5 s, no point inside the table, 95% of edges within 0.4% of their length. Options: `frames` (150), `self_collision` (True keeps folds from crossing and takes about three times as long), `thickness` (adds a Solidify of that many meters, for close-ups), `pin_group` (to hang it, such as a banner over a wall), `apply=False` to keep the simulation.

- Start the cloth 2 to 5 cm above the colliders, never touching them.
- Colliders are closed meshes at real size with their scale applied.
- `settled: False` means the frames ran out: drape again with more `frames`.
- `inside_colliders` above zero: start higher, or raise `collision_distance` (0.005 m).

Then texture it like any mesh and export_gltf it.

## Flags and sails that loop

```python
flag = cloth.sheet("Flag", size=(1.5, 1.0), cell=0.05, location=(0.78, 0, 2.45))
cloth.pin(flag, "left", rows=2)
print(cloth.bake_loop(flag, wind_speed=5, seconds=2))
```

It simulates the pinned sheet in wind on a copy and makes `Flag_loop`: one shape key per frame at 24 fps, keyed into an action named `Flag_loop`, which loops when Godot imports it. Its last frames fade into its first, so it repeats without a jump. The source object stays as it was.

- `wind_direction` (default (1, -0.5, 0)) must cross the sheet: wind along its surface only pulls it straight. Measured on that flag: the free corner hangs about 40 degrees below level at 3 m/s, 24 at 5 m/s, and 10 at 8 m/s.
- `turbulence` (0 to 1) adds flutter; `warmup` (3 s) lets the motion start before the loop; `blend` (0.5 s) sets the fade.
- Export only the loop object: `export_gltf` with `selection: ["Flag_loop"]`. It has no modifiers, so its shape keys become morph targets.
- Each frame stores about 24 bytes per vertex: the 651-vertex flag over 48 frames is 0.8 MB. Keep `cell` at 0.05 or more and loops at 3 s or less, and reuse one file for every copy of a flag.

## Capes, skirts, and coats on bone chains

With the character's armature at its rest pose and the cloth mesh around the body:

```python
print(cloth.add_chains("Cape", "Human_rig", anchor="spine_03", group="cape", columns=5, rows=6))
print(cloth.add_chains("Skirt", "Human_rig", anchor="pelvis", group="skirt", columns=8, rows=4, layout="tube"))
```

It adds chains of bones named `cloth_<group>_<column>_<row>` from the top of the cloth down, `columns` across a sheet or, with `layout="tube"`, around it, parented to `anchor`. Then it weights the cloth to them and gives it an Armature modifier. The cloth loses its weights to the armature's other bones, and the top `top_band` (8% of its height) stays on the anchor.

| Rig | Cape anchor | Skirt anchor |
|---|---|---|
| MPFB game_engine | `spine_03` | `pelvis` |
| Rigify | `DEF-spine.003` | `DEF-spine` |
| Mixamo | `mixamorig:Spine2` | `mixamorig:Hips` |

- `farthest_from_cloth` (meters) should be a few centimeters at most; more means the cloth is not one piece around the body.
- 5 to 8 columns of 4 to 8 bones is enough: more chains cost more and look no better.
- Export the armature with its meshes using export_gltf, then add WasdClothChains3D under the model's Skeleton3D in Godot (see the wasd-cloth guide). It swings the chains, adds body colliders, and follows the wind.

## Check cloth

`cloth.check(obj, colliders=(), rest=None)` measures cloth as it is: `not_numbers` (the simulation exploded), `stretch_p95` and `stretch_max` (fractions past the `rest` coordinates), `inside_colliders` (points more than 2 mm in), and `crossing_faces` (faces that pass through each other; drape with `self_collision=True` to remove them).
