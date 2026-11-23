extends Node3D
## Starter Kit Racing smoke test: the kit's track runs from its folder under addons/, the installed input actions
## drive the truck forward and steer it, and the camera rig follows it.

const ID := "starter-kit-racing"
const KIT := "res://addons/starter_kit_racing/"


func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _run() -> void:
	for action: String in ["forward", "back", "left", "right", "bounce"]:
		if not InputMap.has_action(action) or InputMap.action_get_events(action).is_empty():
			return _fail("the input action %s is missing or has no events" % [action])
	var track := (load(KIT + "scenes/main.tscn") as PackedScene).instantiate()
	add_child(track)
	await get_tree().create_timer(1.0).timeout
	var vehicle := track.get_node("Vehicle") as Vehicle
	var body := vehicle.get_node("Container") as Node3D
	var view := track.get_node("View") as Node3D
	var start := vehicle.get_vehicle_position()
	if absf(start.y) > 2.0:
		return _fail("the truck rests at height %f" % [start.y])

	Input.action_press("forward")
	await get_tree().create_timer(1.5).timeout
	var straight := vehicle.get_vehicle_position()
	var heading := body.global_rotation.y
	if straight.distance_to(start) < 2.0:
		return _fail("the truck drove %f m in 1.5 s of forward" % [straight.distance_to(start)])
	Input.action_press("left")
	await get_tree().create_timer(1.0).timeout
	Input.action_release("left")
	Input.action_release("forward")
	var turned := absf(angle_difference(heading, body.global_rotation.y))
	if turned < 0.2:
		return _fail("the truck turned %f rad in 1 s of left" % [turned])
	if view.global_position.distance_to(vehicle.get_vehicle_position()) > 6.0:
		return _fail("the camera rig is %f m from the truck" % [view.global_position.distance_to(vehicle.get_vehicle_position())])
	print("drove ", straight.distance_to(start), " turned ", turned)
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
