---
name: lite-terrain
description: LiteTerrain 2.0 is installed in this project. One ChunkTerrain node builds an endless landscape from a seed, with meadow, desert, salt flats, canyons, and mountains, grass, rock, snow, haze, level of detail, and collision under moving bodies, and it runs at full frame rate in Web builds. Load before adding outdoor ground to a 3D game, and before placing anything on it.
---

# LiteTerrain 2.0

`res://addons/lite_terrain/` (MIT). `ChunkTerrain` (a `StaticBody3D`, global class) computes the ground from a seed in chunks around the camera: no height map, no edge, the same seed always the same world. The installation declares the shader globals its ground shader reads (`world_haze`, `haze_range`, and three more under `[shader_globals]` in `project.godot`) and does not enable the add-on's editor plugin, which only adds editor buttons.

Measured in a Web build: ready in about half a second, 57 fps while flying at 20 m/s, about 160 draw calls.

## Add the ground

```gdscript
var terrain: ChunkTerrain

func _ready() -> void:
	terrain = ChunkTerrain.new()
	terrain.forced_seed = 7                   # any integer; it is the world
	add_child(terrain)
	await terrain.terrain_ready               # real time, not frames: the near ground and its collision are up
	var spawn: Variant = terrain.plain_near(Vector3.ZERO, 600.0)      # nearest flat ground that is no canyon or mountain, or null
	var at: Vector3 = spawn if spawn != null else Vector3.ZERO
	player.global_position = Vector3(at.x, terrain.terrain_height_at(at) + 1.0, at.z)
```

In a `.tscn`: a node of type `StaticBody3D` with the script `res://addons/lite_terrain/chunk_terrain.gd` and `forced_seed` set.

The scene needs a current `Camera3D`, because the ground is built round the camera that draws the scene, and a `DirectionalLight3D`; the ground is lit like any surface. Give the camera `far` of at least `view_distance`.

## Shape and look

- On the node: `view_distance` (1400 m; 200 to 10,000), `haze_enabled`, and the biome switches `desert_enabled`, `canyons_enabled`, `mountains_enabled`, `salt_flats_enabled`; with all four off the world is rolling meadow. `grass_lift_enabled` and `snow_lift_enabled` raise grass blades and a snow crust from the ground's own vertices.
- `terrain.biomes` is a `TerrainBiomes` resource; without one the node makes its own. Its fields set where biomes lie and their colors: `color_grass`, `color_sand`, `color_rock`, `color_snow`, `color_canyon`, `color_salt`; patch sizes `biome_scale`, `canyon_scale`, `mountain_scale`; how much of the map each takes `biome_bias`, `canyon_threshold`, `mountain_threshold`, `salt_threshold`; `snow_frac` for the snow line; `grass_density`, `grass_height`. Set them before the node enters the tree.
- Haze: the ground fades into the color of the global `world_haze` between the distances in `haze_range` (x start, y end, in metres). Make the sky's horizon and the Environment's fog that color, or the horizon shows a seam: `RenderingServer.global_shader_parameter_set("world_haze", color)`, also from a day and night cycle. With the `wasd-look` add-on, set `look.view_distance` to the terrain's `view_distance` less 100 and hand both on whenever the look changes, which keeps ground and sky alike through every look, hour, and weather, thick fog included:

```gdscript
look.applied.connect(func() -> void:
	RenderingServer.global_shader_parameter_set("world_haze", look.get_horizon_color().srgb_to_linear())
	RenderingServer.global_shader_parameter_set("haze_range", look.get_haze_range()))
```
- An autoload named `G` with a `world_seed` property overrides `forced_seed`; set `terrain.follow_world_settings = false` if the game has such an autoload for another purpose.

## Ask the ground

Only after `terrain_ready`:

- `terrain_height_at(world_pos) -> float`, and `ground_sample(world_pos) -> Vector3` with the height in x and the slope along X and Z in y and z.
- `biome_at(world_pos) -> Vector3`: canyon, meadow, and mountain masks from 0 to 1; `salt_at(world_pos) -> float`. Use them to choose what to scatter where: trees on meadow, cacti off it.
- `plain_near(from, reach)`: the nearest level ground within `reach` metres, or null.
- `is_point_hidden(world_pos, height := 1.0) -> bool`: whether a hill hides the point from the camera, to skip drawing what stands there.

Place trees, rocks, and buildings by these heights in the area around the player, and again as the player moves on; the world has no end, so nothing can be placed everywhere in advance.

## Bodies on the ground

Collision exists only near moving bodies: the node watches every `RigidBody3D` and `CharacterBody3D` in the tree and builds collision tiles under and ahead of them. A body released where its tile is not up yet falls through and never returns:

```gdscript
body.freeze = true                 # a CharacterBody3D: skip move_and_slide() instead
while not terrain.has_collision_at(body.global_position):
	await get_tree().physics_frame
body.freeze = false
```

The ground is on collision layer 1. Ray casts hit it only where tiles exist; far from bodies, use `terrain_height_at`.

## Level a building site

```gdscript
terrain.flatten_area(center, Vector2(8, 6), height, 4.0)   # half extents in metres, the pad's height, a 4 m blend at its edge
```

Mesh, collision, and height queries all follow. The world is its seed plus its edits: save `terrain.ground_edits()` (an Array of plain dictionaries) and replay it with `apply_ground_edits(list)` after `terrain_ready` on load, before restoring what stands on the pads. `reset_heights()` forgets every edit.

## Pitfalls

- Call `terrain.stop_generation()` before freeing the node or changing scene; it waits for the running chunk jobs.
- The node finds the seed and builds as it enters the tree: set `forced_seed`, `biomes`, and the switches first.
- Water, roads, and paths are not part of it: add wasd-water at a fixed height for lakes and sea, and flatten a strip for a road.

## Check it

`godot_run`, then `godot_screenshot` from the player's eye: ground to the horizon, haze that meets the sky without a line, and the player standing on it. Move for ten seconds and take `godot_performance`: steady frames while new ground comes up. `godot_run` with `web: true` shows the browser's version.
