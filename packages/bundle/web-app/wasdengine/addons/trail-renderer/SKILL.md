---
name: trail-renderer
description: TrailRenderer is installed in this project. A TrailRenderer node leaves a fading ribbon behind whatever it follows, and a LineRenderer draws a ribbon through points set from code; both are meshes, so they draw in Web builds, where particle trails do not. Load before making a sword swing trail, a tracer, a speed streak, a laser, or lightning.
---

# TrailRenderer

`res://addons/TrailRenderer/` (MIT; global classes, and no plugin to enable; the installation leaves out the add-on's samples and its C# version). Two nodes, both `Node3D`:

- `TrailRenderer` leaves a ribbon behind itself as it moves and lets it fade.
- `LineRenderer` draws a ribbon through `points` that code sets.

Both build a mesh each frame, so they draw on every renderer. The add-on also takes the global class names `Point` and `TrailPiece`: do not name a class of the game `Point`.

## A trail behind something that moves

Add the trail as a child of what moves: a blade's tip, a bullet, a car's rear corner.

```gdscript
func add_trail(parent: Node3D, half_width: float, color: Color, seconds := 0.3) -> TrailRenderer:
	var trail := TrailRenderer.new()
	trail.lifetime = seconds                 # how long each part of the ribbon lasts
	trail.min_vertex_distance = 0.05         # metres moved between ribbon points; smaller is smoother
	trail.alignment = LineRenderer.Alignment.View
	var width := Curve.new()                 # half the ribbon's width in metres, from tail (0) to head (1)
	width.max_value = maxf(half_width, 1.0)  # a Curve clamps its points to max_value, which starts at 1
	width.add_point(Vector2(0.0, 0.0))
	width.add_point(Vector2(1.0, half_width))
	trail.curve = width
	var fade := Gradient.new()               # color from tail (0) to head (1)
	fade.set_color(0, Color(color, 0.0))
	fade.set_color(1, color)
	trail.color_gradient = fade
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.vertex_color_use_as_albedo = true
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.blend_mode = BaseMaterial3D.BLEND_MODE_ADD   # glowing; leave out for smoke or dust
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	trail.material = material
	parent.add_child(trail)
	return trail
```

- `is_emitting = false` stops new ribbon and lets the rest fade; set it true only during the swing, the dash, or the shot.
- The ribbon's points live for `lifetime` seconds of real time.
- Without a `material` the ribbon is white and lit; without a `curve` it is 1 m wide; without a `color_gradient` it is white.
- `texture_mode`: `Stretch` lays the material's texture once along the whole ribbon, `Tile` repeats it per metre, `PerSegment` per point. A soft streak texture with `Stretch` gives a ribbon soft edges.

## Which way the ribbon faces

`alignment` picks the axis the flat ribbon faces while `world_space` is true, as it is by default:

- `Alignment.View`: toward the camera. Use it for tracers, streaks, lasers, lightning.
- `Alignment.TransformZ` (default): toward the node's own Z axis. Use it for a sword swing: put the trail at the middle of the blade, turn it so its Z axis points out of the blade's flat side, and make the curve's width half the blade's length, so the ribbon spans the blade.
- `Alignment.Static`: each point faces its own `alignment_vector`: for a trail, the node's X axis when the point was made; for a line, the `facing` of `Point.new(position, facing)`, `Vector3.FORWARD` when left out.

## A line through points

```gdscript
var beam := LineRenderer.new()
beam.alignment = LineRenderer.Alignment.View
beam.curve = width
beam.material = material
add_child(beam)
beam.points = [Point.new(from), Point.new(to)]        # world positions; set again whenever they move
```

`world_space = false` reads the points in the node's own space, so the line moves with it (keep it true on a trail). `alignment` then does nothing: each point faces its own `alignment_vector`, as with `Static`, so give every point a facing across the line, such as `Point.new(position, Vector3.UP)` for a level beam that is seen from above; with the default facing, a line along the node's -Z has no width. Lightning is a line whose points are re-made with random offsets every few frames; a rope or cable is a line through the positions of its segments.

## Cost

A trail rebuilds its mesh every frame: a few dozen points cost little, but hundreds of trails at once do not. Give bullets a trail only while they are near the camera, keep `lifetime` under a second, and free the node with what it follows.

## Check it

`godot_run`, trigger the motion, and `godot_screenshot` during it: the ribbon follows the path, is as wide as intended at its head, and fades toward its tail. A ribbon that is invisible from some angles faces the wrong way: change `alignment` or turn the node.
