---
name: yati
description: YATI 2.2.9 (Yet Another Tiled Importer, GDScript edition) is installed in this project and imports Tiled maps (.tmx, .tmj) the user saves into the project as scenes of TileMapLayer and object nodes. Load before using Tiled maps or tilesets.
---

# YATI 2.2.9 (Tiled importer)

An editor import plugin in `res://addons/YATI/`. It runs only in the import step that `godot_run` performs; imported scenes need nothing from it in the game. Do not edit or move that folder, and do not name your own scripts `CommonUtils`, `DataLoader`, or `CustomTypes` (YATI's global classes).

## Place the files

- Maps: `.tmx` (XML) or `.tmj` (JSON) from Tiled 1.x, finite or infinite; orthogonal, isometric, staggered, or hexagonal. Tilesets embedded or external (`.tsx`/`.tsj`), templates `.tx`/`.tj`.
- Have the user save the map, its tilesets, and their images inside the project at the relative paths Tiled stored, for example `res://levels/level1.tmx`, `res://levels/terrain.tsx`, `res://levels/terrain.png`. A path that leaves the project folder does not load.
- Godot imports each map with the importer `YATI` and reimports it when the map file changes. A change to an external tileset or template alone is not noticed: have the user save the map as well.
- Use the map path as a scene: `load("res://levels/level1.tmx").instantiate()`, or `[ext_resource type="PackedScene" path="res://levels/level1.tmx" id="1"]` and a node with `instance=ExtResource("1")`.

## What the scene contains

- Root: a `Node2D` named after the file (`level1`). A map with only one layer gets that layer's node as the root instead.
- Tile layer: `TileMapLayer` named like the layer, `texture_filter` nearest. All layers share one `TileSet`, embedded in the scene unless `save_tileset_to` is set. Each tileset image is one `TileSetAtlasSource`, ids 0, 1, ... in map order (an image-collection tileset gives one source per tile image); a tile's atlas coords are (id % columns, id / columns).
- Object layer and group layer: `Node2D`. Image layer: `TextureRect`.
- Objects, by Tiled class (or a string property `godot_node_type`, which wins):
  - point: `Marker2D` with the object name.
  - rectangle, ellipse, polygon: no class, `collision`, or `staticbody` gives `StaticBody2D` named `<name> (SB)`; `area` gives `Area2D` `<name> (Area)`; `animatablebody` gives `AnimatableBody2D`. The shape is a child `CollisionShape2D` (rectangle, ellipse as capsule) or `CollisionPolygon2D` named like the object. `navigation` gives `NavigationRegion2D`, `occluder` `LightOccluder2D`, `polygon` `Polygon2D`.
  - polyline: `line` gives `Line2D`, `path` gives `Path2D`.
  - tile object: `Sprite2D`. Text: `Label`.
  - class `instance` with a file property `res_path`: an instance of that scene.
  - any other class: `StaticBody2D` (with an `Unknown class` message); set `add_class_as_metadata` to also store the class as meta `class` and silence that message.
- Custom properties become node metadata (`get_meta("hp")`): int, float, and bool keep their type, most other types (color, file, string) arrive as String. A few names set node properties instead, for example `godot_group` (comma-separated groups), `godot_script` (file), `z_index`, `modulate`, `collision_layer`/`collision_mask` (like `"1,3"`).
- Tile properties named `data_<x>` become TileSet custom data `<x>` (`tile_data.get_custom_data("kind")`); other tile properties become TileData metadata. Shapes drawn in Tiled's tile collision editor become polygons in TileSet physics layer 0 (an int property `physics_layer` on a shape picks another layer; `navigation_layer`/`occlusion_layer` make navigation or occluder polygons).

## Options

`[params]` of `<map>.import`: `use_default_filter`, `add_class_as_metadata`, `add_id_as_metadata` (meta `id`), `no_alternative_tiles`, `map_wangset_to_terrain`, `custom_data_prefix` (`"data_"`), `tiled_project_file` (a `.tiled-project` for custom types), `post_processor` (a `@tool` script with `func _post_process(scene: Node2D) -> Node2D` that edits and returns the scene before it is saved), `save_tileset_to` (for example `"res://levels/terrain_tileset.tres"`).

To change one, let `godot_run` import the map first, then edit the value in the `.import` file Godot wrote and run again. Do not write a new `.import` for a map by hand: the map then imports before its images and YATI embeds them as `ImageTexture`s instead of using the imported PNGs.

## Example

```gdscript
extends Node2D

func _ready() -> void:
	var level: Node2D = load("res://levels/level1.tmx").instantiate()
	add_child(level)
	var ground := level.get_node("Ground") as TileMapLayer
	$Player.position = level.get_node("Objects/Spawn").position
	for cell in ground.get_used_cells():
		var data := ground.get_cell_tile_data(cell)
		if data.get_custom_data("kind") == "lava":
			print("lava at ", ground.map_to_local(cell))
	for goal in get_tree().get_nodes_in_group("goals"):
		goal.body_entered.connect(_on_goal)

func _on_goal(body: Node2D) -> void:
	print(body.name, " reached the goal")
```

This needs a tile property `data_kind` and an `area` object with the property `godot_group` = `goals`.

## Verify in WASD Engine

1. `godot_run` imports the map. Its result lists only `ERROR:`/`WARNING:` lines from the import, such as `ERROR: Image file '...' not found.` or `ERROR: Tileset file '...' not found. -> Continuing but result may be unusable`; YATI's other messages (`Import succeeded.`, `Unknown class` warnings) are not kept.
2. Read the result: the `path=` line of the map's `.import` names the imported scene, `res://.godot/imported/level1.tmx-<hash>.tscn`, a text scene you can read (never edit it).
3. With the map in the running scene, `godot_scene_tree` shows the layers and objects, and `godot_eval` checks details, for example `scene.get_node("Level1/Ground").get_used_cells().size()` or `scene.get_node("Level1/Objects/Spawn").get_meta("hp")`. `load()` is not available in `godot_eval` expressions.
4. Without a scene: after a `godot_run` has imported the map, run a SceneTree script with `godot_script` that loads and instantiates the map and prints what you need, then read its output.

## Pitfalls

- Object names get suffixes (`Goal (Area)`, `Wall (SB)`); markers, sprites, and the shape children keep the plain name. Use these names in node paths.
- A run that imports a map also logs leak messages at exit (`RIDs of type "CanvasItem" were leaked`, `ObjectDB instances were leaked at exit`, `RID allocations ... were leaked at exit`). They are harmless.
- The imported scene is regenerated on each reimport: change behavior through properties in Tiled, `post_processor`, or code that runs on the instanced scene, not by editing the imported scene.
