---
name: simple-grass-textured
description: SimpleGrassTextured 2.1.1 is installed in this project. Its grass node draws thousands of textured tufts as one MultiMesh, placed from game code, swaying in a wind that the SimpleGrass autoload sets, and optionally pushed aside by characters; a Web build drew 12,000 tufts at 60 fps. Load before adding grass, reeds, wheat, or flower fields to 3D ground.
---

# SimpleGrassTextured 2.1.1

`res://addons/simplegrasstextured/` (MIT). Grass is a `MultiMeshInstance3D` with the script `grass.gd`: every tuft is a few crossed cards with a grass texture, lit by the scene, swaying in the wind. The installation adds the `SimpleGrass` autoload and the shader globals the grass shader reads to `project.godot`, names render layer 17, and leaves out the add-on's editor plugin, whose paint brush needs the Godot editor: place grass from code as below.

Measured in a Web build: 12,000 tufts with sun shadows at 60 fps in 28 draw calls, with the interactive mode on too.

## Plant a field

```gdscript
const GRASS := preload("res://addons/simplegrasstextured/grass.gd")

func plant(area: Rect2, count: int, ground_y: float) -> MultiMeshInstance3D:
	var grass := MultiMeshInstance3D.new()
	grass.set_script(GRASS)
	add_child(grass)
	var tufts: Array = []
	for _i: int in count:
		var at := Vector3(randf_range(area.position.x, area.end.x), ground_y, randf_range(area.position.y, area.end.y))
		tufts.append(grass.eval_grass_transform(at, Vector3.UP, Vector3.ONE * randf_range(0.7, 1.2), randf() * TAU))
	grass.add_grass_batch(tufts)
	grass.set_process(true)       # required: the node applies added grass in _process, which it switches off in games
	return grass
```

- `eval_grass_transform(position, ground_normal, scale, turn)` makes one tuft's transform in the grass node's space; a tuft is 1 m wide and 1 m tall at scale 1, so short lawn grass is `Vector3(0.6, 0.3, 0.6)`.
- On uneven ground, give every tuft a height above the ground, then `await get_tree().process_frame`, since the node adds planted tufts in its next `_process`, and `await grass.snap_to_terrain()`: each tuft drops onto the collider under it (`collision_mask`, all layers by default). The ground needs a collision shape.
- `grass.erase(grass.to_local(world_position), radius)` clears a circle, for paths, buildings, and scorch marks: its point is in the grass node's own space. `erase_box(size, area_transform)` and `erase_cylinder(rx, height, rz, area_transform)`, which take the area's world transform, clear other areas.
- Three to six tufts per square metre read as a meadow. Planting 12,000 at once took about a second in a browser: plant per area while a loading screen shows, or in batches across frames.
- Keep one grass node per field or chunk of at most a few thousand tufts, so that fields outside the view are not drawn.

## Look

Set these on the node before or after planting:

- `texture_albedo` (a grass tuft by default) and `albedo`, its tint; `texture_frames` when the texture is a sheet of several tufts, such as `Vector2i(2, 2)`. Any texture of plants on a transparent background works: reeds, wheat, flowers.
- `scale_h`, `scale_w`: height and width of every tuft; `scale_var`: random variation.
- `light_mode`: 0 Lambert, 1 normal grass (default), 2 unshaded; `alpha_scissor_threshold` (0.5).
- `grass_strength` (0.55): how far the wind bends this field.
- `optimization_by_distance = true` hides a growing share of the tufts with distance from the camera and all of them beyond `optimization_dist_max` (50 m), fading in from `optimization_dist_min` (10 m).
- `mesh`: another mesh per tuft in place of the crossed cards.

The colors come out brighter and more yellow in a browser than on the desktop renderers: tune `albedo` from `godot_run` with `web: true`.

## Wind and things that walk through

```gdscript
SimpleGrass.set_wind_direction(Vector3(1, 0, 0.3))
SimpleGrass.set_wind_strength(0.15)        # 0 is still air; raise it for a gale
SimpleGrass.set_wind_turbulence(1.0)
```

For grass that parts around the player and other moving things:

```gdscript
func _ready() -> void:
	SimpleGrass.set_interactive(true)
	$Body.layers |= 1 << 16                 # render layer 17: what is on it pushes the grass

func _process(_delta: float) -> void:
	SimpleGrass.set_player_position(global_position)   # the 50 m square around this point reacts
```

Put only simple meshes on layer 17: a capsule or sphere the size of the body's lower half, which may be invisible to the main camera's cull mask. `grass.interactive = false` keeps one field from reacting.

## Pitfalls

- Grass that never appears lacks `grass.set_process(true)` after `add_grass_batch`.
- The grass shader needs the `sgt_*` entries under `[shader_globals]` and the `SimpleGrass` autoload that the installation wrote into `project.godot`: keep them.
- Tufts keep the positions they were planted with: when the ground changes, erase and plant again.
- Under a low sun the tufts shade one another until the whole field is dark and nothing else's shadow shows on it: for sunsets and mornings set `grass.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF`.

## Check it

`godot_run`, then `godot_screenshot` at the player's eye level and from above: no bare gaps or floating tufts, a color that matches the ground texture under it, and movement between two screenshots taken a second apart.
