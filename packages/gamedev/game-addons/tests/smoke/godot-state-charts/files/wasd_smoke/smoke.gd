extends Node
## Godot State Charts smoke test: a ParallelState with two CompoundStates (Movement: Idle/Walking,
## Weapon: Holstered/Drawn). Sends events and checks the active states, the order of the
## state_entered/state_exited signals, Transition.taken, an ExpressionGuard on an expression
## property, and a delayed automatic transition.

const ID := "godot-state-charts"

@onready var chart: StateChart = $StateChart
@onready var root_state: ParallelState = $StateChart/Root
@onready var movement: CompoundState = $StateChart/Root/Movement
@onready var idle: AtomicState = $StateChart/Root/Movement/Idle
@onready var walking: AtomicState = $StateChart/Root/Movement/Walking
@onready var holstered: AtomicState = $StateChart/Root/Weapon/Holstered
@onready var drawn: AtomicState = $StateChart/Root/Weapon/Drawn

var trace: Array[String] = []
var events: Array[StringName] = []


func _ready() -> void:
	get_tree().create_timer(20.0).timeout.connect(func() -> void: _fail("timed out"))
	for state: StateChartState in [idle, walking, holstered, drawn]:
		state.state_entered.connect(func() -> void: trace.append("enter " + state.name))
		state.state_exited.connect(func() -> void: trace.append("exit " + state.name))
	$StateChart/Root/Movement/Idle/OnMove.taken.connect(func() -> void: trace.append("taken OnMove"))
	chart.event_received.connect(func(event: StringName) -> void: events.append(event))
	_run.call_deferred()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _active() -> String:
	var names: Array[String] = []
	for state: StateChartState in [root_state, movement, idle, walking, holstered, drawn]:
		if state.active:
			names.append(state.name)
	return ",".join(names)


func _expect_active(expected: String, step: String) -> bool:
	if _active() != expected:
		_fail("%s: active states %s, expected %s (trace %s)" % [step, _active(), expected, trace])
		return false
	return true


func _run() -> void:
	await get_tree().process_frame  # the chart enters its initial states one frame after _ready
	if not _expect_active("Root,Movement,Idle,Holstered", "initial"): return
	if trace != ["enter Idle", "enter Holstered"]:
		return _fail("initial signals %s" % [trace])

	trace.clear()
	chart.send_event("move")
	if not _expect_active("Root,Movement,Walking,Holstered", "after move"): return
	if trace != ["taken OnMove", "exit Idle", "enter Walking"]:
		return _fail("move signals %s, expected taken OnMove, exit Idle, enter Walking" % [trace])

	chart.send_event("draw")  # guard "ammo > 0" fails with the initial ammo = 0
	if not _expect_active("Root,Movement,Walking,Holstered", "draw without ammo"): return
	chart.set_expression_property("ammo", 3)
	chart.send_event("draw")
	if not _expect_active("Root,Movement,Walking,Drawn", "draw with ammo"): return

	await get_tree().create_timer(0.5).timeout  # AutoHolster fires after 0.2 s
	if not _expect_active("Root,Movement,Walking,Holstered", "after the delayed transition"): return

	chart.send_event("stop")
	if not _expect_active("Root,Movement,Idle,Holstered", "after stop"): return
	if events != [&"move", &"draw", &"draw", &"stop"]:
		return _fail("StateChart.event_received got %s" % [events])
	if chart.get_expression_property("ammo") != 3:
		return _fail("expression property ammo = %s" % [chart.get_expression_property("ammo")])

	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
