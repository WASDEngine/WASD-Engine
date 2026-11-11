extends Node2D
## Gaea smoke test: island_graph.tres is a Gaea graph written as text (Noise2D -> ThresholdMapper with a
## MaterialParameter -> Output layer 0). The generator (fixed seed, single-threaded task pool) renders it into
## the Ground TileMapLayer. Checks that the cell count repeats for the same seed, changes with the seed, and
## matches the same graph built in code.

var failures: PackedStringArray = []
@onready var generator: GaeaGenerator = $Generator
@onready var ground: TileMapLayer = $Ground


func _ready() -> void:
	_run.call_deferred()


func _expect(label: String, ok: bool) -> void:
	if not ok:
		failures.append(label)


func _generate(seed_value: int) -> int:
	generator.settings.seed = seed_value
	generator.generate()  # resets the renderer, then generates world_size
	await generator.generation_finished
	await get_tree().process_frame
	return ground.get_used_cells_by_id(0, Vector2i(1, 0)).size()


func _code_graph() -> GaeaGraph:
	# The same graph as island_graph.tres, built with the GaeaGraph API.
	var graph := GaeaGraph.new()  # holds the Output node (id 0) and one GaeaLayer
	var noise := graph.add_node(GaeaNodeNoise2D.new(), Vector2(-600, 0))
	graph.set_node_argument(noise, &"frequency", 0.08)
	var mapper := graph.add_node(GaeaNodeThresholdMapper.new(), Vector2(-300, 0))
	graph.set_node_argument(mapper, &"range", {"min": 0.5, "max": 1.0})
	var land := graph.add_node(GaeaNodeMaterialParameter.new(), Vector2(-600, 200))
	for id in [noise, mapper, land]:
		graph.set_node_salt(id, 0)  # add_node() picks a random salt
	await get_tree().process_frame  # add_node() registers the parameter in a deferred call
	var material := TileMapGaeaMaterial.new()
	material.atlas_coord = Vector2i(1, 0)
	graph.set_parameter(&"MaterialParameter", material)
	_expect("connect noise", graph.connect_nodes(noise, 0, mapper, 0) == OK)  # noise -> reference
	_expect("connect land", graph.connect_nodes(land, 0, mapper, 1) == OK)  # value -> material
	_expect("connect output", graph.connect_nodes(mapper, 0, 0, 0) == OK)  # map -> layer 0
	return graph


func _run() -> void:
	var first: int = await _generate(1234)
	var again: int = await _generate(1234)
	var other: int = await _generate(99)
	print("text graph cells: seed 1234 -> %d, again -> %d, seed 99 -> %d" % [first, again, other])
	_expect("seed 1234 produced %d of 1024 cells" % first, first > 100 and first < 924)
	_expect("same seed repeats (%d vs %d)" % [first, again], first == again)
	_expect("other seed differs (%d vs %d)" % [first, other], first != other)
	generator.graph = await _code_graph()
	var from_code: int = await _generate(1234)
	print("code graph cells: seed 1234 -> %d" % from_code)
	_expect("code graph matches text graph (%d vs %d)" % [from_code, first], from_code == first)
	if failures.is_empty():
		print("SMOKE_PASS gaea")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(failures))
		get_tree().quit(1)
