---
name: wasd-decals
description: WASD Decals 1.0.0 is installed in this project. WasdDecals3D draws pooled marks on surfaces in one draw call, with bullet holes, scorch marks, splats, cracks, and footprints drawn in code without any texture, WasdFootprints3D leaves a trail of prints behind a walking character, and WasdBlobShadow3D lays a soft round shadow under one; all draw in Web builds, where Decal nodes do not. Load before leaving marks on floors or walls, or before giving a character footprints or a blob shadow.
---

# WASD Decals 1.0.0

`res://addons/wasd_decals/` (CC0, written by WASD Engine; global classes, and no plugin to enable). Godot's `Decal` node draws nothing on the Compatibility renderer, which every Web build uses. These three nodes draw flat quads just above the surface instead, the same on every renderer.

## Marks: WasdDecals3D

One node per kind of mark holds all marks of that kind. Add it once, for example to the level or an autoload:

```gdscript
var holes := WasdDecals3D.new()
holes.mark = "bullet_hole"           # drawn in code: no texture to make or download
holes.lifetime = 30.0                # seconds, 0 keeps marks
holes.capacity = 200                 # a new mark replaces the oldest
add_child(holes)
```

| `mark` | What it draws | Its size |
|---|---|---|
| `bullet_hole` | a black puncture in a chipped bowl, soot, short cracks | 0.16 m |
| `scorch` | soot with a ragged middle and streaks thrown outward: explosions, fire | 1.8 m |
| `splat` | a wet spill with drops round it, white for `tint` to color: blood, oil, paint, slime | 0.9 m |
| `crack` | cracks out of a crushed middle: a heavy landing, a hammer blow | 1.4 m |
| `footprint` | a shoe's sole with its tread; see Footprints below | 0.3 m |

Every mark gets a shape of its own, so a wall of bullet holes never repeats, and the marks have relief: light catches one side of a pit or a crack and the edge of a spill. Setting `mark` sets `size`, `tint`, and `shine` to what suits it; change them after. A game's own picture works as before: leave `mark` empty and set `texture` (marks on a transparent background) and `frames` (`Vector2i(2, 2)` when it holds 2 x 2 different marks).

Place a mark where a ray or a collision hit, with the surface's normal:

```gdscript
var hit := get_world_3d().direct_space_state.intersect_ray(query)
if not hit.is_empty():
	holes.add(hit["position"], hit["normal"])
```

- `add(position, normal, side := -1.0, turn := -1.0, frame := -1) -> int`: world position and normal; `side` in meters (the node's `size` when negative), `turn` in radians about the normal (random when negative), `frame` of the texture or the number of a drawn mark's shape (random when negative).
- `add_toward(position, normal, toward, side := -1.0, frame := -1)`: the same, turned so that the top of the mark points along `toward`: a footprint's toe, a splat thrown the way the bullet flew.
- `tint` colors the marks added after it is set, and its alpha makes them fainter: `Color(0.35, 0.01, 0.02)` on `splat` is blood, `Color(0.05, 0.04, 0.03)` oil, any bright color paint.
- `shine` (0 to 1): 0 is dry, 1 a fresh spill that mirrors the light.
- `fade` (2 s): the end of a mark's `lifetime` over which it fades out.
- `unlit` (false): false lights the marks like the surface, so they darken in shadow; true keeps their own colors, for glowing embers and neon paint.
- `lift` (0.012 m): how far marks float above the surface; raise it if marks flicker at a distance.
- `count()`, `clear()`.
- Marks lie on what they mark: they show on `wasd-weather`'s snow and wet ground and on `wasd-materials`' soft marks, such as road lines, and a puff of smoke or a fire before a mark is drawn over it. Blob shadows likewise.

For a mark the list lacks, such as a paw, a tire track, or a rune, make a texture with `image_generate` (a sheet of four to nine marks on a transparent background reads less repetitive than one); keep it small, 256 to 512 pixels.

## Footprints: WasdFootprints3D

```gdscript
var steps := WasdFootprints3D.new()
$Player.add_child(steps)             # at the soles: lower it, or raise reach, under a body centred higher
steps.stepped.connect(func(at: Vector3, left: bool) -> void: $StepSound.play())
```

Each physics frame it measures how far its parent has walked, and every `stride` meters (0.7) it lays a print on the ground under itself, the left foot and the right in turn, toes pointing the way the parent walks. Nothing lands while the parent is in the air. The signal `stepped(at, left)` tells where each foot lands: play the footstep sound there, or a puff of dust (`WasdFx.play("impact", at, {"scale": 0.3})` with `wasd-fx`).

Properties: `stride`, `spacing` (0.26 m between the left and the right line), `size` (0.3 m), `tint` (dark and faint for dust and mud; `Color(0.5, 0.56, 0.66, 0.7)` reads as dents in snow), `lifetime` (20 s), `capacity` (64), `ground_mask`, `reach` (0.5 m: how far below the node the ground may lie). `prints = false` stops the prints and keeps the signal, for footstep sounds on ground that takes no print: switch it by what the player walks on. `get_pool()` is the `WasdDecals3D` that holds the prints. For a print of the game's own, such as a paw, set its `mark = ""`, then its `texture` with the left print and the right side by side and `frames = Vector2i(2, 1)`. The ground needs a collider.

## A shadow under a character: WasdBlobShadow3D

```gdscript
var shadow := WasdBlobShadow3D.new()
shadow.size = 1.2                    # meters wide while the character stands
$Player.add_child(shadow)
```

Each physics frame it casts a ray down from its parent, lies on what the ray hits with the ground's slope, and shrinks and fades as the parent rises, which shows a jumping player where the landing is. Properties: `size`, `darkness` (0.6), `reach` (8 m: the height at which it has faded out), `ground_mask` (physics layers of the ground; 1), `lift` (0.015 m). The ground needs a collision shape; the parent's own body is ignored.

Starter Kit FPS and Starter Kit 3D Platformer give their players a `Decal` shadow, which is missing in Web builds: add a `WasdBlobShadow3D` to the player there.

## Limits

- A mark is a flat quad: on a corner or a curved surface its edge floats or cuts in. Keep marks small next to the curvature, or skip marks whose `normal` differs much from the surface around them.
- Marks stay where they were placed and do not move with what they are on: use them on the level's static geometry, not on doors, platforms, or characters.
- All marks of one node share one kind, lighting mode, and capacity; use one node per kind of mark.
- The drawn marks are dark or take their color from `tint`: on a nearly black surface, soot and cracks do not show. Tint a `splat` pale there, or skip the mark.

## Check it

`godot_run`, make marks, then `godot_screenshot` from close and from a grazing angle: marks lie flat on the surface without flicker, rotated differently, and none floats beyond an edge. A screenshot of a jumping character shows the shadow on the ground below it. `godot_run` with `web: true` shows the same.
