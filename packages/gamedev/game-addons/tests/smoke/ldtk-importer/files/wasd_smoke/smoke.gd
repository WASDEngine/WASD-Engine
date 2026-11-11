extends Node
## Smoke test for the Godot LDtk Importer 2.0.1, run after the project's import step.
##
## world.ldtk is a minimal LDtk 1.5.3 project: one level "Level_0" (64x48 px, 16 px grid) with a Tiles layer "Ground"
## using tiles.png (tile 0 red, tile 1 blue): (0,2) tile 0, (1,2) tile 1, (3,2) tile 0 flipped X; and an Entities
## layer "Entities" with one "Player" entity at (16,16) whose Int field hp is 3.
## With the default import options the world must import as an LDTKWorld scene whose level is saved to
## levels/Level_0.scn, its TileSet to tilesets/tileset_16px.res, and the entity kept as data on the entity layer.

const ID := "ldtk-importer"
const COMPONENTS := "res://addons/ldtk-importer/src/components/"
const RED := Color(1, 0, 0, 1)
const BLUE := Color(0, 0, 1, 1)
const TILESET_UID := 4

var _failures := PackedStringArray()


func _ready() -> void:
	# A script error aborts the checks without quitting; the watchdog then reports the failure.
	get_tree().create_timer(30.0).timeout.connect(_on_watchdog)
	_run.call_deferred()


func _on_watchdog() -> void:
	print("SMOKE_FAIL checks did not finish (script error?) ", " | ".join(_failures))
	get_tree().quit(1)


func _run() -> void:
	_check_world()
	if _failures.is_empty():
		print("SMOKE_PASS ", ID)
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", " | ".join(_failures))
		get_tree().quit(1)


func _fail(message: String) -> void:
	_failures.append(message)


func _same(a: Color, b: Color) -> bool:
	return absf(a.r - b.r) < 0.02 and absf(a.g - b.g) < 0.02 and absf(a.b - b.b) < 0.02 and absf(a.a - b.a) < 0.02


func _script_is(node: Node, file: String) -> bool:
	return node != null and node.get_script() != null and node.get_script().resource_path == COMPONENTS + file


func _check_world() -> void:
	var packed := load("res://wasd_smoke/world.ldtk") as PackedScene
	if packed == null:
		_fail("world.ldtk did not import as a PackedScene (editor plugin not loaded during the import step?)")
		return
	var world := packed.instantiate()
	add_child(world)
	if not _script_is(world, "ldtk-world.gd") or world.get("rect") != Rect2i(0, 0, 64, 48):
		_fail("root is not an LDTKWorld with rect (0, 0, 64, 48)")
	var level := world.get_node_or_null("Level_0")
	if not _script_is(level, "ldtk-level.gd"):
		_fail("Level_0 is missing or not an LDTKLevel")
		return
	if level.get("size") != Vector2i(64, 48) or level.scene_file_path != "res://wasd_smoke/levels/Level_0.scn":
		_fail("Level_0 size %s scene %s" % [level.get("size"), level.scene_file_path])
	_check_ground(level.get_node_or_null("Ground") as TileMapLayer)
	_check_entities(level.get_node_or_null("Entities"))
	world.free()


func _check_ground(ground: TileMapLayer) -> void:
	if ground == null:
		_fail("Level_0 has no TileMapLayer Ground")
		return
	var tile_set := ground.tile_set
	if tile_set == null or tile_set.resource_path != "res://wasd_smoke/tilesets/tileset_16px.res" or not tile_set.has_source(TILESET_UID):
		_fail("Ground tile set %s is not tilesets/tileset_16px.res with source %d" % [tile_set, TILESET_UID])
		return
	var source := tile_set.get_source(TILESET_UID) as TileSetAtlasSource
	if source == null or source.get_tiles_count() != 2 or source.texture == null or source.texture.resource_path != "res://wasd_smoke/tiles.png":
		_fail("atlas source %d does not have 2 tiles from res://wasd_smoke/tiles.png" % TILESET_UID)
		return
	var image := source.texture.get_image()
	if not _same(image.get_pixel(8, 8), RED) or not _same(image.get_pixel(24, 8), BLUE):
		_fail("atlas texture pixels %s, %s" % [image.get_pixel(8, 8), image.get_pixel(24, 8)])
	if ground.get_used_cells().size() != 3:
		_fail("Ground has %d cells, expected 3" % ground.get_used_cells().size())
	var expected := [
		[Vector2i(0, 2), Vector2i(0, 0), 0],
		[Vector2i(1, 2), Vector2i(1, 0), 0],
		[Vector2i(3, 2), Vector2i(0, 0), TileSetAtlasSource.TRANSFORM_FLIP_H],
	]
	for item: Array in expected:
		var cell: Vector2i = item[0]
		if ground.get_cell_source_id(cell) != TILESET_UID or ground.get_cell_atlas_coords(cell) != item[1] or ground.get_cell_alternative_tile(cell) != item[2]:
			_fail("Ground cell %s is %d %s %d, expected %d %s %d" % [cell, ground.get_cell_source_id(cell), ground.get_cell_atlas_coords(cell), ground.get_cell_alternative_tile(cell), TILESET_UID, item[1], item[2]])


func _check_entities(layer: Node) -> void:
	if not _script_is(layer, "ldtk-entity-layer.gd"):
		_fail("Level_0 has no LDTKEntityLayer Entities")
		return
	var entities: Array = layer.get("entities")
	if entities.size() != 1:
		_fail("Entities holds %d entities, expected 1" % entities.size())
		return
	var player: Dictionary = entities[0]
	if player.get("identifier") != "Player" or player.get("position") != Vector2i(16, 16) or player.get("size") != Vector2i(16, 16):
		_fail("entity is %s at %s size %s, expected Player at (16, 16) size (16, 16)" % [player.get("identifier"), player.get("position"), player.get("size")])
	if player.get("iid") != "a0f0c3a0-9f00-11ef-8000-000000000001" or player.get("fields", {}).get("hp") != 3:
		_fail("entity iid %s fields %s" % [player.get("iid"), player.get("fields")])
