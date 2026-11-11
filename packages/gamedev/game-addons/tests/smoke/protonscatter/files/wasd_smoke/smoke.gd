extends Node3D
## ProtonScatter smoke test: a Scatter node written as .tscn text (box ScatterShape, a mesh ScatterItem,
## Create Inside (Random) amount 40 + Randomize Transforms, global_seed 7, main-thread build) scatters at
## runtime without the editor. Checks the instance count, the placement, seed determinism, and a rebuild
## after changing the modifier amount from code.

var failures: PackedStringArray = []
var scatter: ProtonScatter


func _ready() -> void:
	scatter = $Scatter
	_run.call_deferred()


func _expect(label: String, ok: bool) -> void:
	if not ok:
		failures.append(label)


func _instance_count() -> int:
	var output := scatter.get_node_or_null("ScatterOutput")
	if output == null:
		return -1
	var total := 0
	for mmi: MultiMeshInstance3D in output.find_children("*", "MultiMeshInstance3D", true, false):
		total += mmi.multimesh.instance_count
	return total


func _positions() -> Array:
	var list := []
	for t: Transform3D in scatter.transforms.list:
		list.append(t.origin.snapped(Vector3.ONE * 0.0001))
	return list


func _wait_build(label: String) -> bool:
	# The build runs on load (force_rebuild_on_load) or after rebuild(); build_completed follows it.
	var done := [false]
	var on_done := func(): done[0] = true
	scatter.build_completed.connect(on_done, CONNECT_ONE_SHOT)
	for i in 300:
		if done[0]:
			return true
		await get_tree().process_frame
	failures.append("%s: build_completed never fired" % label)
	return false


func _run() -> void:
	if not await _wait_build("load"):
		_finish()
		return
	_expect("instances after load %d" % _instance_count(), _instance_count() == 40)
	_expect("transforms after load %d" % scatter.transforms.size(), scatter.transforms.size() == 40)
	var inside := true
	for p: Vector3 in _positions():
		inside = inside and absf(p.x) <= 10.0 and absf(p.z) <= 10.0 and absf(p.y) <= 0.5
	_expect("all instances inside the box", inside)
	var first := _positions()
	# A different seed moves the instances; the original seed brings the same layout back.
	scatter.global_seed = 8  # the setter calls rebuild()
	await _wait_build("seed 8")
	_expect("seed 8 changes the layout", _positions() != first and _instance_count() == 40)
	scatter.global_seed = 7
	await _wait_build("seed 7")
	_expect("seed 7 repeats the layout", _positions() == first)
	# Change the stack from code and rebuild explicitly.
	scatter.modifier_stack.stack[0].amount = 12
	scatter.rebuild()
	await _wait_build("amount 12")
	_expect("instances after amount 12: %d" % _instance_count(), _instance_count() == 12)
	_finish()


func _finish() -> void:
	if failures.is_empty():
		print("SMOKE_PASS protonscatter")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(failures))
		get_tree().quit(1)
