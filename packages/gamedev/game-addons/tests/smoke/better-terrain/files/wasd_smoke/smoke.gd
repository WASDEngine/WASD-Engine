extends Node2D
## Better Terrain smoke test: a terrain written as .tres text (terrain_tiles.tres, a row of four tiles)
## and a 16-tile terrain built in code, painted and solved with the BetterTerrain API.

# Bits of the code-built tileset: atlas tile (mask % 4, mask >> 2) connects on these sides.
const SIDES := [TileSet.CELL_NEIGHBOR_TOP_SIDE, TileSet.CELL_NEIGHBOR_RIGHT_SIDE,
		TileSet.CELL_NEIGHBOR_BOTTOM_SIDE, TileSet.CELL_NEIGHBOR_LEFT_SIDE]
const OFFSETS := [Vector2i.UP, Vector2i.RIGHT, Vector2i.DOWN, Vector2i.LEFT]

var failures: PackedStringArray = []


func _ready() -> void:
	_check_text_tileset()
	_check_code_tileset()
	if failures.is_empty():
		print("SMOKE_PASS better-terrain")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(failures))
		get_tree().quit(1)


func _expect(label: String, got: Variant, want: Variant) -> void:
	if got != want:
		failures.append("%s: got %s, want %s" % [label, got, want])


func _check_text_tileset() -> void:
	var layer: TileMapLayer = $Ground
	var ts := layer.tile_set
	_expect("text terrain_count", BetterTerrain.terrain_count(ts), 1)
	_expect("text terrain name", BetterTerrain.get_terrain(ts, 0).get("name"), "Ground")
	var row: Array = [Vector2i(0, 0), Vector2i(1, 0), Vector2i(2, 0), Vector2i(3, 0), Vector2i(4, 0)]
	var lone := Vector2i(0, 3)
	_expect("text set_cells", BetterTerrain.set_cells(layer, row + [lone], 0), true)
	BetterTerrain.update_terrain_cells(layer, row + [lone])
	# Left end (2,0), three middles (1,0), right end (3,0); a lone cell gets the plain tile (0,0).
	var want_row := [Vector2i(2, 0), Vector2i(1, 0), Vector2i(1, 0), Vector2i(1, 0), Vector2i(3, 0)]
	for i in row.size():
		_expect("text row %s" % row[i], layer.get_cell_atlas_coords(row[i]), want_row[i])
	_expect("text lone", layer.get_cell_atlas_coords(lone), Vector2i(0, 0))
	# Runtime change: erase the middle cell, re-solve, and the neighbours become ends.
	BetterTerrain.set_cell(layer, Vector2i(2, 0), -1)
	BetterTerrain.update_terrain_cell(layer, Vector2i(2, 0))
	_expect("text erased", layer.get_cell_source_id(Vector2i(2, 0)), -1)
	_expect("text (1,0) after erase", layer.get_cell_atlas_coords(Vector2i(1, 0)), Vector2i(3, 0))
	_expect("text (3,0) after erase", layer.get_cell_atlas_coords(Vector2i(3, 0)), Vector2i(2, 0))
	_expect("text get_cell", BetterTerrain.get_cell(layer, Vector2i(0, 0)), 0)
	_expect("text get_cell empty", BetterTerrain.get_cell(layer, Vector2i(2, 0)), -1)


func _build_sides_tileset() -> TileSet:
	var image := Image.create(64, 64, false, Image.FORMAT_RGBA8)
	image.fill(Color.WHITE)
	var ts := TileSet.new()
	ts.tile_size = Vector2i(16, 16)
	var atlas := TileSetAtlasSource.new()
	atlas.texture = ImageTexture.create_from_image(image)
	atlas.texture_region_size = Vector2i(16, 16)
	ts.add_source(atlas, 0)
	if not BetterTerrain.add_terrain(ts, "Wall", Color.SLATE_GRAY, BetterTerrain.TerrainType.MATCH_TILES):
		failures.append("add_terrain returned false")
	for mask in 16:
		var coord := Vector2i(mask % 4, mask >> 2)
		atlas.create_tile(coord)
		var td := atlas.get_tile_data(coord, 0)
		BetterTerrain.set_tile_terrain_type(ts, td, 0)
		for bit in 4:
			if mask & (1 << bit):
				BetterTerrain.add_tile_peering_type(ts, td, SIDES[bit], 0)
	return ts


func _expected_mask(cells: Dictionary, cell: Vector2i) -> int:
	var mask := 0
	for bit in 4:
		if cells.has(cell + OFFSETS[bit]):
			mask |= 1 << bit
	return mask


func _check_code_tileset() -> void:
	var ts := _build_sides_tileset()
	_expect("code terrain_count", BetterTerrain.terrain_count(ts), 1)
	var probe := (ts.get_source(0) as TileSetAtlasSource).get_tile_data(Vector2i(3, 1), 0)  # mask 7
	_expect("code peering keys", BetterTerrain.tile_peering_keys(probe), [SIDES[0], SIDES[1], SIDES[2]])
	var layer := TileMapLayer.new()
	layer.tile_set = ts
	add_child(layer)
	# A plus sign, a 2x2 block, and a lone cell.
	var cells := {}
	for c in [Vector2i(5, 5), Vector2i(4, 5), Vector2i(6, 5), Vector2i(5, 4), Vector2i(5, 6),
			Vector2i(9, 9), Vector2i(10, 9), Vector2i(9, 10), Vector2i(10, 10), Vector2i(1, 1)]:
		cells[c] = true
	BetterTerrain.set_cells(layer, cells.keys(), 0)
	BetterTerrain.update_terrain_area(layer, Rect2i(0, 0, 12, 12))
	for c: Vector2i in cells:
		var mask := _expected_mask(cells, c)
		_expect("code cell %s" % c, layer.get_cell_atlas_coords(c), Vector2i(mask % 4, mask >> 2))
	# Runtime change: removing the centre of the plus leaves four lone arms (mask 0).
	BetterTerrain.set_cell(layer, Vector2i(5, 5), -1)
	BetterTerrain.update_terrain_cell(layer, Vector2i(5, 5))
	for c in [Vector2i(4, 5), Vector2i(6, 5), Vector2i(5, 4), Vector2i(5, 6)]:
		_expect("code arm %s after erase" % c, layer.get_cell_atlas_coords(c), Vector2i(0, 0))
	# A code-built terrain survives a save and load as .tres.
	var path := "user://wasd_smoke_sides.tres"
	_expect("code save", ResourceSaver.save(ts, path), OK)
	var loaded: TileSet = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	_expect("loaded terrain_count", BetterTerrain.terrain_count(loaded), 1)
	var loaded_probe := (loaded.get_source(0) as TileSetAtlasSource).get_tile_data(Vector2i(3, 1), 0)
	_expect("loaded peering types", BetterTerrain.tile_peering_types(loaded_probe, SIDES[1]), [0])
