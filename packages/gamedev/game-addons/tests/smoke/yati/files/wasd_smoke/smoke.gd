extends Node
## Smoke test for YATI 2.2.9 (GDScript edition), run after the project's import step.
##
## level.tmj (JSON, external tileset tiles.tsj) and level.tmx (XML, embedded tileset) hold the same 4x3 map of
## 16 px tiles from tiles.png (tile 0 red, tile 1 blue): tile layer "Ground" with 8 tiles and object layer "Objects"
## with a point "Spawn" (int property hp = 3) and a 16x16 rectangle "Goal" of type "area".
## Each map must import as a scene: a Node2D "level" with a TileMapLayer and the objects as Godot nodes.

const ID := "yati"
const BLUE := Color(0, 0, 1, 1)
const RED := Color(1, 0, 0, 1)

var _failures := PackedStringArray()


func _ready() -> void:
	# A script error aborts the checks without quitting; the watchdog then reports the failure.
	get_tree().create_timer(30.0).timeout.connect(_on_watchdog)
	_run.call_deferred()


func _on_watchdog() -> void:
	print("SMOKE_FAIL checks did not finish (script error?) ", " | ".join(_failures))
	get_tree().quit(1)


func _run() -> void:
	_check_map("res://wasd_smoke/level.tmj")
	_check_map("res://wasd_smoke/level.tmx")
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


func _check_map(path: String) -> void:
	var packed := load(path) as PackedScene
	if packed == null:
		_fail("%s did not import as a PackedScene (editor plugin not loaded during the import step?)" % path)
		return
	var map := packed.instantiate()
	if not map is Node2D or map.name != &"level":
		_fail("%s root is %s %s, expected Node2D level" % [path, map.get_class(), map.name])
	add_child(map)
	_check_tiles(path, map)
	_check_objects(path, map)
	map.free()


func _check_tiles(path: String, map: Node) -> void:
	var ground := map.get_node_or_null("Ground") as TileMapLayer
	if ground == null:
		_fail("%s has no TileMapLayer Ground" % path)
		return
	if ground.get_used_cells().size() != 8:
		_fail("%s Ground has %d cells, expected 8" % [path, ground.get_used_cells().size()])
	var tile_set := ground.tile_set
	if tile_set == null or tile_set.get_source_count() != 1 or tile_set.tile_size != Vector2i(16, 16):
		_fail("%s Ground tile set is missing, or has the wrong source count or tile size" % path)
		return
	var source_id := tile_set.get_source_id(0)
	var source := tile_set.get_source(source_id) as TileSetAtlasSource
	if source == null or source.get_tiles_count() != 2 or source.texture_region_size != Vector2i(16, 16):
		_fail("%s atlas source is missing or does not have 2 tiles of 16x16" % path)
		return
	if source.texture == null or source.texture.resource_path != "res://wasd_smoke/tiles.png":
		_fail("%s atlas texture is %s, expected the imported res://wasd_smoke/tiles.png" % [path, source.texture])
		return
	var image := source.texture.get_image()
	if not _same(image.get_pixel(8, 8), RED) or not _same(image.get_pixel(24, 8), BLUE):
		_fail("%s atlas texture pixels %s, %s" % [path, image.get_pixel(8, 8), image.get_pixel(24, 8)])
	var expected := {Vector2i(0, 0): Vector2i(0, 0), Vector2i(1, 1): Vector2i(1, 0), Vector2i(2, 1): Vector2i(1, 0), Vector2i(3, 2): Vector2i(0, 0)}
	for cell: Vector2i in expected:
		if ground.get_cell_source_id(cell) != source_id or ground.get_cell_atlas_coords(cell) != expected[cell]:
			_fail("%s cell %s is %d %s, expected %d %s" % [path, cell, ground.get_cell_source_id(cell), ground.get_cell_atlas_coords(cell), source_id, expected[cell]])
	if ground.get_cell_source_id(Vector2i(0, 1)) != -1:
		_fail("%s cell (0, 1) should be empty" % path)


func _check_objects(path: String, map: Node) -> void:
	var spawn := map.get_node_or_null("Objects/Spawn") as Marker2D
	if spawn == null or spawn.position != Vector2(24, 40) or spawn.get_meta("hp", 0) != 3:
		_fail("%s point object Spawn is not a Marker2D at (24, 40) with meta hp = 3" % path)
	var goal := map.get_node_or_null("Objects/Goal (Area)") as Area2D
	if goal == null or goal.position != Vector2(48, 16):
		_fail("%s rectangle object Goal is not an Area2D at (48, 16)" % path)
		return
	var shape := goal.get_node_or_null("Goal") as CollisionShape2D
	if shape == null or not shape.shape is RectangleShape2D or (shape.shape as RectangleShape2D).size != Vector2(16, 16) or shape.position != Vector2(8, 8):
		_fail("%s Goal has no 16x16 RectangleShape2D centred at (8, 8)" % path)
