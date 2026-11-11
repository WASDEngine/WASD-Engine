---
name: ldtk-importer
description: Godot LDtk Importer 2.0.1 is installed in this project and imports LDtk projects (.ldtk) the user saves into the project as scenes with an LDTKWorld, LDTKLevel scenes, TileMapLayers, and entity data. Load before using LDtk levels.
---

# LDtk Importer 2.0.1

An editor import plugin in `res://addons/ldtk-importer/`. Imported scenes use its scripts in `src/components/` at runtime, so keep the add-on installed; do not edit or move it. Its `plugin.cfg` says version 2.0; the installed code is release 2.0.1.

## Place the files

- `.ldtk` projects from LDtk 1.0 to 1.5. Newer files import with the warning `LDtk file version is newer than what is supported. Errors may occur.`
- Have the user save each `.ldtk` in its own folder in the project, with its tileset images and level backgrounds at the relative paths LDtk stored, for example `res://levels/world/world.ldtk` and `res://levels/world/tiles.png`. Leave those PNGs on Godot's default texture import.
- The import writes beside the `.ldtk`: `tilesets/tileset_<grid>px.res` (one TileSet per layer grid size) and, while `pack_levels` is on (default), `levels/<Level>.scn`. Two `.ldtk` files in one folder overwrite each other's files. Never edit `levels/*.scn`: every import rewrites them.
- Ask the user to turn off LDtk's "Save levels to separate files": with it, 2.0.1 logs `SCRIPT ERROR: Unable to iterate on object of type 'Nil'`, and layers that use an override tileset of another tile size lose their tiles.
- Use the `.ldtk` path as a scene: `load("res://levels/world/world.ldtk").instantiate()` or a `.tscn` `[ext_resource type="PackedScene" path="res://levels/world/world.ldtk" id="1"]`. One level alone: `levels/Level_0.scn`.

## What the scene contains

- Root `LDTKWorld` (Node2D) named after the file: `iid`, `rect: Rect2i` (bounds of all levels), `levels: Array[LDTKLevel]`.
- Each level: `LDTKLevel` (Node2D) at its world position, with `iid`, `world_position`, `size: Vector2i` (pixels), `fields: Dictionary` (level fields), `neighbours`, `bg_color`, and a `BG Image` Sprite2D when it has a background.
- Tiles and AutoLayer layers: `TileMapLayer` named like the layer, bottom layer first. Cell source id = the LDtk tileset's uid; atlas coords = the tile's column and row in its image; flipped tiles use alternative id `TileSetAtlasSource.TRANSFORM_FLIP_H` (4096) and/or `TRANSFORM_FLIP_V` (8192). Stacked tiles go to child TileMapLayers. A layer hidden in LDtk is disabled unless `layers_always_visible` is on.
- IntGrid layer without auto-tiles: `TileMapLayer` `<Layer>-values`, one cell per filled cell, source id = the layer's uid, atlas x = the value's index in the layer's value list. It draws nothing unless `integer_grid_tilesets` is on, but code can read it.
- Entities layer: `LDTKEntityLayer` (Node2D). No nodes are made for entities: its `entities` Array holds one Dictionary per entity with `iid`, `identifier`, `position: Vector2i` (pixels inside the level), `size`, `pivot`, `smart_color`, `definition`, and `fields` (Int, Float, Bool, String as such; Color as Color; Point as a Vector2i grid cell; Enum as `"Enum.Value"`; Tile as AtlasTexture; EntityRef as the target's iid String).

## Spawn entities

At runtime:

```gdscript
extends Node2D

const COIN := preload("res://coin.tscn")

func _ready() -> void:
	var world: Node2D = load("res://levels/world/world.ldtk").instantiate()
	add_child(world)
	for level in world.levels:
		var layer: Node2D = level.get_node("Entities")
		for entity in layer.entities:
			if entity.identifier == "Coin":
				var coin: Node2D = COIN.instantiate()
				coin.position = entity.position
				coin.set_meta("value", entity.fields.get("value", 1))
				layer.add_child(coin)
```

Or at import time, so the nodes are saved in the level scenes: set `entities_post_import="res://ldtk/spawn_entities.gd"`:

```gdscript
@tool
extends RefCounted

func post_import(entity_layer: LDTKEntityLayer) -> LDTKEntityLayer:
	for entity in entity_layer.entities:
		if entity.identifier == "Coin":
			var coin: Node2D = load("res://coin.tscn").instantiate()
			coin.position = entity.position
			entity_layer.add_child(coin)
	return entity_layer
```

`tileset_post_import`, `level_post_import`, and `world_post_import` scripts work the same way and receive the Dictionary of TileSets by grid size, an `LDTKLevel`, or the `LDTKWorld`. Give tiles collision in a `tileset_post_import`: `tile_set.add_physics_layer()`, then per tile `source.get_tile_data(coords, 0)` with `add_collision_polygon(0)` and `set_collision_polygon_points(0, 0, points)`. `use_entity_placeholders=true` adds an `LDTKEntity` node per entity instead (debug drawing; same `fields`).

## Options

`[params]` of `<file>.ldtk.import`: `pack_levels` (true), `group_world_layers` (false; levels grouped by world depth), `layers_always_visible`, `tileset_custom_data` (custom data layers `LDTK Custom` and `LDTK Custom Enum`), `integer_grid_tilesets`, `atlas_texture_type` (0 CompressedTexture2D, 1 CanvasTexture for normal maps), `resolve_entityrefs` (true), `use_entity_placeholders`, the four `*_post_import` script paths, `force_tileset_reimport`, `verbose_output`.

Change them only after a first import: let `godot_run` import the `.ldtk`, edit the values in the `.import` file Godot wrote, and run again. A `.import` you write from scratch makes the `.ldtk` import before its PNGs: the log shows `Cannot access source texture` and `TileSetAtlasSource missing`, the tile layers stay empty, and they stay so until the `.ldtk` or its `.import` changes again.

The importer keeps an existing `tilesets/*.res` and only adds missing atlas sources, so after the user rearranges a tileset image, set `force_tileset_reimport=true` for one run.

## Verify in WASD Engine

1. `godot_run` imports the file. Its result lists the importer's `ERROR:`/`WARNING:` lines, such as `Cannot access source texture: ...`, `TileSetAtlasSource missing`, or `Detected null tilemap ...`; progress lines such as `[LDTK] Start Import` are not kept. The first import of a new `.ldtk`, and the game run right after it, warn `invalid UID ... using text path instead` for the generated files; this is harmless and stops on the next run.
2. List the folder of the `.ldtk`: `tilesets/` and `levels/` must be there.
3. With the world in the running scene, look at `godot_scene_tree`, and check with `godot_eval`, for example `scene.get_node("World/Level_0/Ground").get_used_cells().size()` or `scene.get_node("World/Level_0/Entities").entities.size()`. `load()` is not available in `godot_eval` expressions.
4. Without a scene: after a `godot_run` has imported the file, run a SceneTree script with `godot_script` that instantiates the world and prints what you need, then read its output.

## Pitfalls

- A run that imports an `.ldtk` also logs leak messages at exit (`RIDs of type "CanvasItem" were leaked`, `resources still in use at exit`). They are harmless.
- Node names come from LDtk identifiers (`Level_0`, `Ground`); renaming a level or layer in LDtk changes the node paths your code uses.
- Do not move the generated `levels/` or `tilesets/` files: the world scene refers to them by path.
