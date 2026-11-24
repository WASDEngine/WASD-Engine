---
name: mirror3d
description: Mirror3D 1.9 is installed in this project. The Mirror3D scene is a flat mirror that shows a true reflection of the scene from a second camera, on walls and as a polished floor, and it draws in Web builds. Load before adding a mirror, a reflective floor, or a reflecting window.
---

# Mirror3D 1.9

`res://addons/Mirror3D/` (MIT; no plugin to enable). `Mirror3D.tscn` is a flat mirror: a quad that shows what a second camera sees from behind the mirror plane, so it reflects the whole scene with moving characters, lights, and the sky. It draws on every renderer, and a Web build showed it at 60 fps.

## Add one

Instance the scene; the script alone has no viewport and does nothing.

```gdscript
const MIRROR := preload("res://addons/Mirror3D/Mirror3D.tscn")

func add_wall_mirror(at: Vector3, facing_degrees: float) -> Mirror3D:
	var mirror := MIRROR.instantiate() as Mirror3D
	mirror.size = Vector2(1.2, 2.0)          # metres; the mirror faces its local +Z
	mirror.pixels_per_unit = 256             # texture pixels per metre
	add_child(mirror)
	mirror.position = at
	mirror.rotation_degrees.y = facing_degrees
	return mirror
```

In a `.tscn`, instance `Mirror3D.tscn` and set the same properties on the instance. A polished or wet floor is the same mirror lying flat: `mirror.rotation_degrees.x = -90`, one centimetre above the floor mesh so the two do not flicker. Water, still or moving, is wasd-water's, which mirrors the scene itself.

It reflects for the camera that `get_viewport().get_camera_3d()` returns, so it follows the active camera of the main viewport.

## Properties

- `size`: width and height in metres. The frame, glass edge, or floor around it is the game's own mesh.
- `pixels_per_unit` (200): the reflection's texture is `size * pixels_per_unit` pixels. A 1.2 x 2 m mirror at 256 is 307 x 512 pixels; a 10 x 10 m floor needs 64 to 100, not 200.
- `color`: tints the reflection, and its alpha blends the mirror over what lies behind it. `Color(0.9, 0.97, 0.94)` is clean glass; alpha 0.3 to 0.5 over a floor mesh reads as polished stone or a wet street.
- `mask_texture`: a texture whose color and alpha multiply the reflection: a round mirror, puddles on a street, dirt at the edges.
- `distortion` (0 to 100) with `distortion_texture`: bends the reflection by a noise texture, for old or warped glass.
- `cull_mask`: the render layers the mirror draws. Leave out layers that hold what need not reflect, such as distant scenery, particles, or first-person arms.
- `cull_near` (0.05), `cull_far` (50): how close to and how far behind the mirror plane things still reflect. Lower `cull_far` to the size of the room.
- `freeze_distance` (50): farther away than this, the mirror keeps its last picture.
- `max_fps` (-1, every frame): reflections per second; 30 halves the cost of a mirror in a 60 fps game.
- `use_linear_filter` (true): false gives hard pixels for a pixel-art look.

## Cost

Each mirror on screen draws the scene a second time. Keep at most one or two visible at once, hide mirrors in other rooms (`visible = false` stops their camera), and in a Web game keep the texture at or under about 1024 pixels on its long side, set `max_fps = 30`, and trim `cull_far` and `cull_mask`. A mirror seen inside another mirror shows the other's previous picture, not an endless tunnel.

## Pitfalls

- Only what is in front of the mirror plane reflects: the mirror's camera starts drawing at the plane. A thick frame that crosses the plane cuts into the picture, so keep frames flush with the plane or in front of it.
- A first-person body shows in the mirror only if it has a mesh on a layer in `cull_mask`.
- An irregular shiny area, such as puddles, is one mirror with a `mask_texture`, not many small mirrors.

## Check it

`godot_run`, face the mirror, then `godot_screenshot`: the reflection lines up with the room at the mirror's edges, moving the camera shifts it the way a real mirror would, and the character shows in it. `godot_performance` with and without the mirror visible shows its cost.
