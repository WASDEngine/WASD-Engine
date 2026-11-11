---
name: ant-landscape
description: A.N.T. Landscape 0.2.0 is installed for this project's Blender and makes noise-based terrain grids and planets with seeds, height clamps, edge falloff and erosion, exported as a terrain .glb plus an EXR heightmap for Godot collision. Load before generating terrain in Blender.
---

# A.N.T. Landscape 0.2.0 on Blender 5.2.3, headless

In each Blender Session, first run `import wasd_addons; wasd_addons.enable("ant-landscape")` with `mcp__wasd_blender__execute_python`. It is idempotent, survives `new_scene`, and must be repeated after a tool result says the worker's state was lost. All code below runs in `execute_python` (set `result` to return values).

## What it adds

- `bpy.ops.mesh.landscape_add(...)` (object mode) adds a mesh object `Landscape`. Pass `refresh=True`: without it the operator returns `{'PASS_THROUGH'}` and adds nothing.
  - Grid: `subdivision_x`, `subdivision_y` (vertices per side, 4..6400), `mesh_size_x`, `mesh_size_y` (m), centered on the 3D cursor (`at_cursor=True`). Planet: `sphere_mesh=True`, `mesh_size`.
  - Noise: `random_seed` (0 = no random offset), `noise_type` (`'multi_fractal'`, `'ridged_multi_fractal'`, `'hybrid_multi_fractal'`, `'hetero_terrain'`, `'fractal'`, `'turbulence_vector'`, `'variable_lacunarity'`, `'marble_noise'`, `'shattered_hterrain'`, `'strata_hterrain'`, `'ant_turbulence'`, `'vl_noise_turbulence'`, `'vl_hTerrain'`, `'distorted_heteroTerrain'`, `'double_multiFractal'`, `'rocks_noise'`, `'slick_rock'`, `'planet_noise'`), `basis_type` (`'BLENDER'`, `'PERLIN_NEW'`, `'VORONOI_F1'`...), `noise_size`, `noise_depth`, `dimension`, `lacunarity`, `offset`, `gain`, `distortion`, `noise_offset_x`/`_y`.
  - Height: `height` (scale, default 0.5), `height_offset`, `height_invert`, then clamped to `minimum`..`maximum` (default -1..1: raise both for tall terrain).
  - Edges: `edge_falloff` (`'0'` none, `'1'` Y, `'2'` X, `'3'` X and Y), `falloff_x`, `falloff_y`, `edge_level`. Terraces: `strata_type` (`'0'`..`'5'`), `strata`. Water: `water_plane=True`, `water_level` adds a flat `Landscape_plane`. `smooth_mesh`, `tri_face`.
- `bpy.ops.mesh.eroder(Iterations=1, IterRiver=10, IterAva=2, IterDiffuse=2)` erodes the active landscape grid (it replaces the mesh data and adds vertex groups `rainmap`, `scree`, `water`, `deposit`...). It is slow: 6 s for 64 x 64 with those numbers.
- Vertex order of a grid: vertex `k` is column `i = k // subdivision_y` along X and `j = k % subdivision_y` along Y.

## Terrain mesh and heightmap

One sample per metre (65 vertices over 64 m) so that the heightmap matches Godot's HeightMapShape3D, whose samples are 1 unit apart:

```python
import bpy, numpy as np
N, SIZE = 65, 64.0
bpy.ops.mesh.landscape_add(refresh=True, subdivision_x=N, subdivision_y=N, mesh_size_x=SIZE, mesh_size_y=SIZE,
                           random_seed=42, noise_type='hetero_terrain', height=8.0, maximum=8.0, minimum=-2.0)
land = bpy.context.active_object
co = np.empty(len(land.data.vertices) * 3, np.float32)
land.data.vertices.foreach_get("co", co)
rows = co[2::3].reshape(N, N).T[::-1]        # image row 0 = +Y in Blender = -Z in Godot
img = bpy.data.images.new("height", N, N, float_buffer=True, is_data=True)
px = np.zeros((N, N, 4), np.float32)
px[..., 0] = rows[::-1]                      # Blender stores pixel rows bottom-up
px[..., 3] = 1.0
img.pixels.foreach_set(px.ravel())
img.filepath_raw = "/abs/game/assets/terrain_height.exr"
img.file_format = 'OPEN_EXR'
img.save()                                   # 32-bit float, heights in metres
bpy.ops.object.select_all(action='DESELECT'); land.select_set(True)
bpy.ops.export_scene.gltf(filepath="/abs/game/assets/terrain.glb", export_format='GLB', use_selection=True)
result = {"vertices": len(land.data.vertices), "min": float(rows.min()), "max": float(rows.max())}
```

The same seed and settings give the same terrain. In Godot 4.7.2 the EXR imports as a float texture; build the collision with:

```gdscript
var img: Image = (load("res://assets/terrain_height.exr") as Texture2D).get_image()
img.convert(Image.FORMAT_RF)
var shape := HeightMapShape3D.new()
shape.update_map_data_from_image(img, 0.0, 1.0)   # values are metres already
$Terrain/StaticBody3D/CollisionShape3D.shape = shape
```

Checked: the map is 65 x 65, its heights equal the mesh's, and row 10 / column 20 is the vertex at x = -12, z = -22 of `terrain.glb`, so collision and mesh line up when both nodes sit at the same origin. Keep `mesh_size_x = subdivision_x - 1` (and the same for Y) so that the samples stay 1 m apart.

Do not use a 16-bit PNG heightmap: Godot 4.7.2 loads 16-bit PNGs as 8-bit (`FORMAT_L8`), about 3 cm steps on a 7 m range.

## Verify

- `len(land.data.vertices) == N * N`, `land.dimensions`, and the height range above.
- `render_preview(objects=["Landscape"])` (iso) or `view="top"`.
- In Godot: `godot_eval` on `shape.get_min_height()`, `shape.get_max_height()`, `shape.map_width`.

## Pitfalls

- Heights above 1 or below -1 are cut off until you raise `maximum` / lower `minimum`.
- `random_seed=0` ignores the seed; use any other number.
- Keep terrain meshes small for the Web: 65 x 65 is 8,192 triangles; 257 x 257 is 131,072.
- `eroder` and very large grids can exceed a tool call's time limit; save the .blend first.
- To change a terrain, delete it and call `landscape_add` again with new settings.
