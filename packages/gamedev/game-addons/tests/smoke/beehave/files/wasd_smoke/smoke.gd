extends Node
## Beehave smoke test: a BeehaveTree (selector -> [sequence(IsTired, Rest), Work]) with custom
## ConditionLeaf/ActionLeaf scripts. Ticks it by hand and checks status, actor state, the
## blackboard, the running action and the before_run/after_run hooks; then lets it tick itself
## in the physics process.

const ID := "beehave"

@onready var actor: Node = $Actor
@onready var tree: BeehaveTree = $Actor/BeehaveTree


func _ready() -> void:
	_run.call_deferred()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _run() -> void:
	for autoload: String in ["BeehaveGlobalMetrics", "BeehaveGlobalDebugger"]:
		if get_tree().root.get_node_or_null(autoload) == null:
			return _fail("autoload %s missing" % autoload)
	if tree.actor != actor:
		return _fail("tree actor is %s, expected its parent" % [tree.actor])

	# Manual ticks: work, work, (tired) rest RUNNING, rest done, work.
	var expected_status := [BeehaveTree.SUCCESS, BeehaveTree.SUCCESS, BeehaveTree.RUNNING, BeehaveTree.SUCCESS, BeehaveTree.SUCCESS]
	var expected_energy := [1, 0, 1, 2, 1]
	var expected_work := [1, 2, 2, 2, 3]
	for i: int in expected_status.size():
		var status := tree.tick()
		var work: int = tree.blackboard.get_value("work_done", 0)
		if status != expected_status[i] or actor.energy != expected_energy[i] or work != expected_work[i]:
			return _fail("tick %d: status=%d energy=%d work_done=%d, expected %d/%d/%d" % [
				i + 1, status, actor.energy, work, expected_status[i], expected_energy[i], expected_work[i]])
		if i == 2 and tree.get_running_action() != $Actor/BeehaveTree/Root/RestWhenTired/Rest:
			return _fail("running action after tick 3 is %s, expected Rest" % [tree.get_running_action()])
	if actor.rest_starts != 1 or actor.rest_ends != 1:
		return _fail("Rest before_run/after_run ran %d/%d times, expected 1/1" % [actor.rest_starts, actor.rest_ends])
	if tree.get_running_action() != null:
		return _fail("running action not cleared after Rest finished")

	# Automatic ticking in the physics process.
	tree.process_thread = BeehaveTree.ProcessThread.PHYSICS
	tree.enable()
	for _i: int in 12:
		await get_tree().physics_frame
	tree.disable()
	var auto_work: int = tree.blackboard.get_value("work_done", 0)
	if auto_work <= 3 or actor.rest_starts <= 1:
		return _fail("physics ticking did not run the tree (work_done=%d, rest_starts=%d)" % [auto_work, actor.rest_starts])

	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
