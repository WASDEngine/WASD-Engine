---
name: better-terrain
description: Better Terrain 1.1 is installed in this project. It autotiles TileMapLayer cells, using terrain rules that you define in code or in .tres text, and its BetterTerrain API paints cells and picks matching tiles at runtime. Load before you set up tile terrains or change tiles from code.
---

# Better Terrain 1.1

## What it adds

- The autoload `BetterTerrain` (`res://addons/better-terrain/BetterTerrain.gd`) holds the whole API. It adds no node type: use an ordinary `TileMapLayer` with a `TileSet`.
- Rules are metadata named `_better_terrain` on the `TileSet` and on each tile's `TileData`. They do not use Godot's terrain sets, custom data layers, or `set_cells_terrain_connect()`. Its editor dock is unusable here: define terrains in code or in text.
- Painting a cell does not choose its tile. Call an update function after painting.

## API

- `add_terrain(ts, name: String, color: Color, type: int, categories := [], icon := {}) -> bool`. Terrain indexes follow the call order (0, 1, …). Types: `BetterTerrain.TerrainType.MATCH_TILES` (0, matches neighbour cells), `MATCH_VERTICES` (1, corner/Wang style), `CATEGORY` (2).
- `set_tile_terrain_type(ts, td: TileData, type) -> bool` assigns a tile to a terrain.
- `add_tile_peering_type(ts, td, peering: int, type) -> bool` says that the tile connects on side or corner `peering` (`TileSet.CELL_NEIGHBOR_*`) to terrain `type`; type -1 means the neighbour must be empty.
- `terrain_count(ts)`, `get_terrain(ts, i) -> {name, color, type, categories, icon, valid}`, `tile_peering_keys(td)`, `tile_peering_types(td, peering)`.
- Paint: `set_cell(layer, coord: Vector2i, type) -> bool` and `set_cells(layer, coords: Array, type) -> bool`. Type -1 erases.
- Solve: `update_terrain_cells(layer, cells: Array, and_surrounding_cells := true)`, `update_terrain_cell(layer, cell)`, `update_terrain_area(layer, area: Rect2i)`. The area includes its end row and column.
- `get_cell(layer, coord) -> int` returns the terrain index: -1 for an empty cell, -2 for a tile that belongs to no terrain.
- Threaded: `create_terrain_changeset(layer, paint: Dictionary)` (Vector2i → type), `is_terrain_changeset_ready(change)`, `wait_for_terrain_changeset(change)`, `apply_terrain_changeset(change)`.

Square-tile peering bits are `RIGHT_SIDE` 0, `BOTTOM_RIGHT_CORNER` 3, `BOTTOM_SIDE` 4, `BOTTOM_LEFT_CORNER` 7, `LEFT_SIDE` 8, `TOP_LEFT_CORNER` 11, `TOP_SIDE` 12 and `TOP_RIGHT_CORNER` 15. MATCH_TILES uses all eight; MATCH_VERTICES uses the corners only.

How a tile is chosen: each set bit scores +3 when the neighbour's terrain is in its list and -10 when it is not, and the tile with the highest score wins. Unset bits score nothing. Give each tile exactly the sides it connects to. A tile with no bits is the lone-cell tile.

## Build a terrain in code

The following code builds a 4×4 atlas of 16 px tiles. Tile `(m % 4, m >> 2)` connects on the sides set in mask m: 1 top, 2 right, 4 bottom, 8 left.

```gdscript
const SIDES := [TileSet.CELL_NEIGHBOR_TOP_SIDE, TileSet.CELL_NEIGHBOR_RIGHT_SIDE,
		TileSet.CELL_NEIGHBOR_BOTTOM_SIDE, TileSet.CELL_NEIGHBOR_LEFT_SIDE]

func build_walls(texture: Texture2D) -> TileSet:
	var ts := TileSet.new()
	ts.tile_size = Vector2i(16, 16)
	var atlas := TileSetAtlasSource.new()
	atlas.texture = texture
	atlas.texture_region_size = Vector2i(16, 16)
	ts.add_source(atlas, 0)
	BetterTerrain.add_terrain(ts, "Wall", Color.SLATE_GRAY, BetterTerrain.TerrainType.MATCH_TILES)
	for mask in 16:
		var coord := Vector2i(mask % 4, mask >> 2)
		atlas.create_tile(coord)
		var td := atlas.get_tile_data(coord, 0)
		BetterTerrain.set_tile_terrain_type(ts, td, 0)
		for bit in 4:
			if mask & (1 << bit):
				BetterTerrain.add_tile_peering_type(ts, td, SIDES[bit], 0)
	return ts

func paint(layer: TileMapLayer, cells: Array) -> void:
	BetterTerrain.set_cells(layer, cells, 0)        # any tile of terrain 0
	BetterTerrain.update_terrain_cells(layer, cells)  # the right tile for each cell and its neighbours

func dig(layer: TileMapLayer, cell: Vector2i) -> void:
	BetterTerrain.set_cell(layer, cell, -1)
	BetterTerrain.update_terrain_cell(layer, cell)
```

To keep a tileset that you built in code, save it once from a `godot_script` with `ResourceSaver.save(ts, "res://tiles/walls.tres")`. The rules are saved with it.

## Write a terrain as .tres text

The four tiles of this tileset form a horizontal ground row: (0,0) a lone tile, (1,0) a middle tile, (2,0) a left end that connects right, and (3,0) a right end that connects left.

```
[gd_resource type="TileSet" load_steps=3 format=3]

[ext_resource type="Texture2D" path="res://tiles/ground_row.png" id="1_tex"]

[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_row"]
texture = ExtResource("1_tex")
0:0/0 = 0
0:0/0/metadata/_better_terrain = {&"type": 0}
1:0/0 = 0
1:0/0/metadata/_better_terrain = {0: [0], 8: [0], &"type": 0}
2:0/0 = 0
2:0/0/metadata/_better_terrain = {0: [0], &"type": 0}
3:0/0 = 0
3:0/0/metadata/_better_terrain = {8: [0], &"type": 0}

[resource]
sources/0 = SubResource("TileSetAtlasSource_row")
metadata/_better_terrain = {
&"terrains": [["Ground", Color(0.3, 0.7, 0.2, 1), 0, [], {}]],
&"decoration": ["Decoration", Color(0.41, 0.41, 0.41, 1), 3, [], {}],
&"version": "0.2"
}
```

- Tile key `x:y/0/metadata/_better_terrain`: `&"type"` is the terrain index. Each int key is a peering bit, and its value lists the terrain indexes that the side connects to.
- Each `terrains` entry is `[name, color, TerrainType, categories, icon]`. Keep the `decoration` entry and `"version": "0.2"` as shown.
- The default tile size is 16×16. For other sizes, add `tile_size = Vector2i(32, 32)` under `[resource]` and `texture_region_size = Vector2i(32, 32)` to the atlas source.
- Use the tileset in a scene: `[node name="Ground" type="TileMapLayer" parent="."]` with `tile_set = ExtResource("…")`.

## Verify in WASD Engine

- Run the game with `godot_run`, then read cells with `godot_eval`: `root.get_node("BetterTerrain").get_cell(scene.get_node("Ground"), Vector2i(2, 0))` and `scene.get_node("Ground").get_cell_atlas_coords(Vector2i(2, 0))`. Look for seams with `godot_screenshot`.
- Only game scripts know the global name `BetterTerrain`. In a `godot_eval` expression it fails with "Invalid named index", and in a `godot_script` (SceneTree script) it fails with "Identifier not found". In both, use `root.get_node("BetterTerrain")`; the autoload is present.

## Pitfalls (seen on Godot 4.7.2)

- After `set_cells()`, always call an update function, or the cells keep an arbitrary tile.
- A changeset solves only the cells in `paint`. Add the neighbours with their current terrain if they need re-solving too. Either poll `is_terrain_changeset_ready()` each frame and then apply, or call `wait_for_terrain_changeset()` and then apply. Calling `is_terrain_changeset_ready()` after a wait fails with "Invalid Group ID".
- The Web export is single-threaded, so prefer the synchronous `update_terrain_*` functions there.
- Terrain indexes shift when you call `remove_terrain()`, so rebuild the rule lists afterwards.
- Do not mix Godot's built-in terrain painting with these rules, and do not use the deprecated `TileMap` node: the API takes a `TileMapLayer`.
