---
name: wasd-materials
description: WASD Materials 1.1.0 is installed in this project. WasdSurface gives materials by name that need no texture files and no UV maps, such as concrete, bricks, planks, metal, rock, and sand, correct materials from a folder of downloaded textures or from one picture, a toon look with outlines, glass, glow, and skin, eyes, teeth, lashes, and hair for humans that hold up close in Web builds. Load before giving any mesh a material.
---

# WASD Materials 1.1.0

`res://addons/wasd_materials/` (CC0, written by WASD Engine; a global class, no plugin to enable). `WasdSurface` is a set of static functions that each return a material. Everything draws the same on Forward+, Mobile, and in Web builds.

## Surfaces by name

```gdscript
var bricks := WasdSurface.make("bricks")
$Wall.material_override = bricks            # a MeshInstance3D
$Tower.material = bricks                    # a CSG shape
WasdSurface.paint($Level/Houses, bricks)    # every mesh and CSG shape under a node
```

| Kind | Names |
|---|---|
| Built | `concrete`, `plaster`, `asphalt`, `bricks`, `stone_blocks`, `tiles`, `planks`, `wood` |
| Metal | `metal` (steel; with a color any bare metal), `painted_metal` (paint with chips), `rust` |
| Ground | `rock`, `sand`, `dirt`, `grass`, `snow` |
| Made | `plastic`, `rubber`, `fabric` |
| Blocking out | `grid`: a line every meter, a stronger one every five |

One shader lays every pattern out in meters of the world, from three sides, so a brick is 24 by 7.5 cm on any wall, floor, or boulder of any size or scale, and generated or CSG geometry looks finished. Nothing is downloaded: a Web build makes the one small picture all surfaces share in 67 ms, and a street of 24 houses in 11 surfaces runs at 60 fps there. Make each material once and give it to every mesh of that surface.

Options, in a dictionary after the name:

- `color`: recolors the surface and keeps its character. `WasdSurface.make("metal", {"color": Color(1.0, 0.77, 0.34)})` is gold; `painted_metal` and `plastic` take any color.
- `size`: the pattern that many times larger. `roughness`: its own. `bump`: multiplies the relief.
- `with_object: true`: lays the pattern out in the object's own meters. Use it on everything that moves or turns, such as crates, doors, and vehicles: laid out in the world, a pattern stands still while the object slides through it.
- Any shader value by name: `piece` (a brick's or plank's length and height in meters), `gap`, `gap_color`, `wear` (0 to 1) and `wear_color`, `spots`, `specks`.

## From downloaded textures

```gdscript
var cobbles := WasdSurface.from_folder("res://assets/polyhaven/cobblestone_floor_02", {"size": 2.0})
```

Give it the folder that `polyhaven_download` or `ambientcg_download` filled. It tells the pictures apart by their names (color, OpenGL normal map, roughness, metal, ambient occlusion, or the packed `arm` picture) and lays them out from three sides like the surfaces above, so the mesh still needs no UV map. `size` is the meters across one repeat, which the download's result gives ("2 × 2 m"). `uv: true` uses the mesh's own UV map instead; `with_object` as above. For the Web, download 1k jpg.

`WasdSurface.cutout("res://assets/ambientcg/LeafSet030", {"region": Rect2(0, 0, 0.5, 0.5)})` makes a cut-out of a folder that also has an opacity picture, such as an ambientCG atlas or decal: it draws where that picture is light, on the mesh's own UV map and from both sides, so a quad becomes a leaf or a fence. `region` shows one piece of an atlas, in shares of the picture; `shine_through` (0 to 1) lets light through leaves; `soft: true` blends instead of cutting, for stains and road lines on a quad 2 mm above a surface, under snow and decal marks.

`WasdSurface.from_picture(load("res://art/wall.png"), {"size": 1.5, "bump": 1.0})` makes a surface of one picture, such as a photograph or one from `image_generate`: its relief is worked out from the picture's light and dark.

## Looks

- `WasdSurface.toon(Color(0.9, 0.45, 0.2), {"steps": 2, "outline": 2.0})`: light in flat steps with a rim and an outline in pixels. More options: `soft`, `rim`, `shine` (a hard highlight), `outline_color`, `picture` (a texture on the mesh's UV map). The outline wants smooth normals: on a mesh with hard edges, such as a plain box, it opens at the corners, so set `outline` to 0 there or bevel the mesh.
- `WasdSurface.glass(Color(0.8, 0.9, 1.0), {"clear": 0.85, "roughness": 0.04})`: clear seen straight on, a mirror of the sky seen along it; a higher roughness frosts it.
- `WasdSurface.glow(Color(1.0, 0.7, 0.3), 4.0)`: a lamp's bulb, a screen, neon, lava. With an energy above 2 it gets a halo under WASD Look.

## Humans

A character from MPFB (MakeHuman), like many other .glb characters, comes into Godot with every material see-through and none made for a face: eyes, teeth, and the back of the hair show through the skin, lashes smear into a band over each eye, and teeth take the sky's blue.

```gdscript
var human := preload("res://characters/human.glb").instantiate()
add_child(human)
WasdSurface.human(human)
```

puts that right, and returns what it took each mesh for. A `WasdFace3D` of `wasd-face`, and with it a `WasdCharacter3D`, calls it by itself for a human that the `mpfb` guide's `wasd_mpfb` made; call it yourself for any other. It tells each surface by its material's name, or its mesh's, and the rest by whether its picture has holes:

- **Skin** (`body`, `skin`): light wraps round into the shade and turns warm there, standing in for subsurface scattering; its shadows are not black, and the side of a face turned from the light is not flat and dark; it shines in patches and through pores, not as one sheet; and the picture's own lines, such as wrinkles, are pressed into it. It reads a glTF material's roughness and occlusion pictures, which `wasd_mpfb` makes for the head, and takes a normal map of no strength for the face's folds, as those humans bring them: a `WasdFace3D` has the skin press them in as the face smiles and frowns.
- **Eyes** (`eye`): shaded under the lids and in their corners, wet, with one small catchlight wherever the lights stand, as bright as the scene, and with the pink of their inner corners where one mesh holds both eyes.
- **Teeth and tongue** (`teeth`, `tongue`): they take little of the sun and none of the sky's color, and fall dark toward the back of the mouth.
- **Brows and lashes** (`brow`, `lash`): each lash thin and dark from any side, brows a soft band of hairs, and no shadow of their cards on the lids.
- **Hair** (`hair`): solid where it is whole and thinning out lock by lock along the hairline, with a ragged band of light across its strands.
- Cloth with holes is cut out; everything else is made solid.

For a character of another make: `WasdSurface.skin(picture, {"relief": normal_map, "gloss": roughness_picture, "shade": occlusion_picture})`, `WasdSurface.eye(picture, 1.0, WasdSurface.eye_middles(mesh))`, `WasdSurface.mouth(picture)`, `WasdSurface.lashes(picture)` (brows: `lashes(picture, Color.WHITE, 0.5, 0.0)`), and `WasdSurface.hair(picture, tint)`. Hair thins out where the alpha of its vertices' color says so; `{"straight": 0.0}` drops its band of light, for curls, as `human()` does for hair named "curl".

## Pitfalls

- Metal mirrors what the scene gives it, and under an open sky that is the sky. Indoors add a ReflectionProbe, or metal walls turn sky blue.
- On a ball, bricks, tiles, and planks run as on the flat side that faces most. They are for walls, floors, and boxes; give round things `rock`, `metal`, or a plain surface.
- A see-through surface sorts by its object's middle: two large glass panes that cross can draw in the wrong order. Keep panes apart or small.
- A GridMap takes its materials from its MeshLibrary: set the surface on the library's meshes.
- `paint()` skips every node of another WASD add-on with all under it, such as effects, water, and a `WasdCharacter3D`: paint `hero.model` itself.

## Check it

`godot_run`, then `godot_screenshot` near a wall with a character or a door in view: bricks the size of bricks, planks the width of planks, relief that shows where light rakes across. Run once with `web: true`.
