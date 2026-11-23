---
name: wasd-bake-blender
description: WASD Bake for Blender is installed for this project's Blender. Python functions that bake textures with Cycles without a window, in one call each, a model's node materials into color, roughness, metal, and normal images with ambient occlusion in its creases and one material that glTF exports whole, a detailed model's surface onto a simple one, and occlusion into vertex colors. Load before texturing a model in Blender for the game.
---

# WASD Bake for Blender

In each Blender Session, with execute_python:

```python
import importlib, wasd_addons
bake = importlib.import_module(wasd_addons.enable("wasd-bake-blender"))
```

glTF carries images, not node materials: a model whose materials are built from Noise, Voronoi, Wave, Color Ramp, or Bump nodes arrives in Godot white. Baking turns what the materials show into images. Every function restores the render settings it changed and returns a dict: read it before going on.

## Bake a model's materials

```python
crate = bpy.data.objects["Crate"]
print(bake.textures(crate, size=1024, maps=("color", "roughness", "metallic", "normal", "ao")))
```

It gives the object a new UV map without overlaps (Smart UV Project), bakes each map, and replaces the object's materials with one, `<object>_baked`, made of the images, which `export_gltf` embeds. A crate with two node materials took 5 seconds at 1024 pixels and went from two draw calls to one.

| Map | Holds |
|---|---|
| `color` | each material's Base Color, metals included |
| `roughness`, `metallic` | those inputs |
| `normal` | the relief that Bump and Normal Map nodes give the materials |
| `emission` | what glows |
| `ao` | ambient occlusion: the darkness of creases and of places close to other parts of the object |

- `ao_into_color` (0.7): how much the occlusion darkens the color image. The shading then shows in every renderer and in Web builds; 0 keeps the color clean and only saves the occlusion image.
- `size`: 512 for small props, 1024 for most models, 2048 for large or close-up ones.
- `folder="/abs/path"` also saves the images as `<object>_<map>.png`.
- `unwrap=False` bakes into the object's own UV map, which must not overlap: leftover UVs of joined primitives do.
- `replace_materials=False` only makes the images.
- The dict's `range` gives each image's darkest and brightest value: `metallic` at `(0, 0)` means nothing is metal, and a `normal` that barely leaves 0.5 means the materials have no relief, so leave such maps out next time.

Bake one object at a time. Join parts that share a texture first, and apply modifiers that change the shape.

## Detail from a high-poly model

```python
print(bake.from_high("Rock_low", "Rock_high", size=1024, maps=("normal", "ao", "color")))
```

The simple model must lie where the detailed one does. Its relief becomes a normal map, its creases occlusion, and `color`, `roughness`, `metallic`, and `emission` come from its materials. A ball of 5,120 faces baked onto one of 80 in 2 seconds. Export only the low model.

- `extrusion` (0.05 m): how far outside the low model the rays start. Raise it when parts of the detail are missed and come out flat; lower it when neighboring parts bleed in.
- Give the low model smooth shading first (`bpy.ops.object.shade_smooth()`), or its facets show through the normal map.
- `high` may be a list of objects.

## Occlusion in vertex colors

```python
print(bake.vertex_ao("Tree"))
```

It bakes ambient occlusion into a color attribute and multiplies it into each material's base color, which makes glTF export it and Godot shade with it: no texture, no UV map. It shades only as finely as the mesh is divided, so it suits models of many small faces with plain colors, such as low-poly trees, rocks, and buildings, not a box of twelve triangles.

## Pitfalls

- Bake after the model's shape is final: moving a vertex afterwards leaves the texture where it was.
- Baked images are colors under no light. Lights in the Blender scene do not go into them; only `ao` shades.
- Other objects close by darken the `ao` of the one being baked. Move it apart, or hide the others from rendering.
- A model with image textures on good UVs needs no bake, only `ao`: `bake.textures(obj, maps=("color", "ao"), unwrap=False)` keeps its UV map and darkens its color.
- Look with render_preview in material mode after the bake, and at the model in Godot with `asset_view` after export.
