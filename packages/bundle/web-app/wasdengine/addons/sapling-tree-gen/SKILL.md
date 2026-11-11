---
name: sapling-tree-gen
description: Sapling Tree Gen 1.0.0 is installed for this project's Blender and makes parametric trees and bushes from 29 species presets with seeds and leaves, baked to meshes for .glb export. Load before generating trees, bushes or palms in Blender.
---

# Sapling Tree Gen 1.0.0 on Blender 5.2.3, headless

In each Blender Session, first run `import wasd_addons; wasd_addons.enable("sapling-tree-gen")` with `mcp__wasd_blender__execute_python`. It is idempotent, survives `new_scene`, and must be repeated after a tool result says the worker's state was lost. All code below runs in `execute_python` (set `result` to return values).

Version 1.0.0 is a rewrite of the old Sapling add-on: same operator name, different output. Do not rely on older Sapling knowledge.

## What it adds

- `bpy.ops.curve.tree_add(**settings)` (object mode) adds a tree at the 3D cursor and leaves it selected and active:
  - `tree`: a mesh object whose Geometry Nodes modifier "Sapling Tree" builds the bark from the curves (material `Sapling Bark`);
  - `tree_curves`: a Curves object, child of `tree`, holding the branch curves;
  - `leaves`: a mesh, child of `tree`, one quad (`rect`) or hexagon (`hex`) per leaf (material `Sapling Leaf`, double-sided in glTF).
  Names get `.001` suffixes when taken.
- Built-in presets (`PresetStore.for_addon().entries()`): acer, apple, balsam_fir, bamboo, black_oak, black_tupelo, california_sagebrush, callistemon, cambridge_oak, coast_live_oak, coyote_brush, douglas_fir, european_larch, fan_palm, hill_cherry, japanese_maple, lombardy_poplar, monterey_cypress_grove, monterey_cypress_lone, monterey_cypress_sheared, monterey_pine, palm, quaking_aspen, sassafras, silver_birch, small_maple, small_pine, weeping_willow, white_birch.
- Main settings: `seed`, `scale` (tree height, m), `levels` (branch levels, 1..6, usually up to 4), `branches` (4 branch counts, one per level; presets keep the first at 0), `trunks`, `leaves` (per branch; negative makes palm fans), `showLeaves`, `leafShape` (`'rect'`, `'hex'`), `leafScale`, `bevel` (round branches), `bevelRes` (0..32), `resU`, `curveRes` (4 values), `prune`, `blossomRate`.

## Low-poly tree from a preset

Load the preset's settings, override them, then pass everything. Do not combine `preset=` with other settings: the preset overwrites them.

```python
import bpy
from bl_ext.wasd.sapling_tree_gen.presets import PresetStore
settings = PresetStore.for_addon().load("black_oak").values     # a dict of operator settings
settings.update(seed=7, scale=6.0, levels=3, branches=[0, 12, 6, 0], leaves=8, bevel=True, bevelRes=1,
                resU=2, curveRes=[4, 3, 2, 1], showLeaves=True, leafShape='rect')
bpy.ops.curve.tree_add(**settings)
tree = bpy.context.active_object                  # 'tree'
leaves = [c for c in tree.children if c.type == 'MESH'][0]
deps = bpy.context.evaluated_depsgraph_get()
def triangles(obj):
    mesh = obj.evaluated_get(deps).to_mesh()
    n = sum(len(p.vertices) - 2 for p in mesh.polygons)
    obj.evaluated_get(deps).to_mesh_clear()
    return n
result = {"bark": triangles(tree), "leaves": triangles(leaves), "height": tree.dimensions.z}
```

That tree measured 3,936 bark and 536 leaf triangles at 6.1 m. The same settings and seed give the same tree; change `seed` for variations. Budgets measured: small_pine preset 60,736 bark + 98,470 leaf triangles, callistemon 28,656 + 18,056, palm 11,376 + 14,700. Presets as they are are too heavy for Web games: lower `levels`, `branches`, `leaves`, `bevelRes`, `resU` and `curveRes` until the totals fit (aim for 1,000 to 5,000 per tree).

## Bake to one mesh and export

```python
bpy.ops.object.select_all(action='DESELECT')
tree.select_set(True); bpy.context.view_layer.objects.active = tree
bpy.ops.object.convert(target='MESH')             # applies the Geometry Nodes bark
for child in list(tree.children):
    if child.type == 'CURVES':
        bpy.data.objects.remove(child)
leaves.select_set(True); tree.select_set(True); bpy.context.view_layer.objects.active = tree
bpy.ops.object.join()                             # one mesh, materials Sapling Bark and Sapling Leaf
bpy.ops.export_scene.gltf(filepath="/abs/path/oak.glb", export_format='GLB', use_selection=True)
```

Without converting, the `export_gltf` tool with `selection: ["tree"]` exports the evaluated bark and the leaves as two meshes (modifiers applied), plus an empty node for `tree_curves`; delete `tree_curves` first. Materials are plain colors; give the leaves an alpha-textured material in Godot or in Blender for real foliage.

## Verify

- Triangle counts as above; `tree.dimensions` for size.
- `render_preview(objects=["tree"], view="front")`, with `shading="material"` to see the colors.
- In Godot: the .glb imports as MeshInstance3D nodes; place many with a MultiMeshInstance3D.

## Pitfalls

- Wind: `useRig=True, makeMesh=True, windAnim=True` makes an armature `treeArm` and an action `windAction` driven by F-curve modifiers whose frame range is 0..0, so the wind does not reach glTF. Animate sway with a Godot shader instead.
- The tree is placed at the 3D cursor (`bpy.context.scene.cursor.location`); move it after generation.
- `dFace` and `dVert` leaf shapes instance another object (`leafDupliObj`); use `rect` or `hex` for export.
- Remove `tree_curves` before joining or exporting a converted tree: it is not a mesh.
- The add-on's panel and redo settings are UI-only; everything is reachable through `tree_add` settings.
