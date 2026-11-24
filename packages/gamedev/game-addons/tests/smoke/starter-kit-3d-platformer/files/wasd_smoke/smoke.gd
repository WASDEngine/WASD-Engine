extends Node3D
## Starter Kit 3D Platformer smoke test: the kit's level runs from its folder under addons/, the installed input
## actions walk and jump the player, a coin that touches the player counts on the HUD, and the camera rig turns.

const ID := "starter-kit-3d-platformer"
const KIT := "res://addons/starter_kit_3d_platformer/"


## The kit reloads the current scene when the player falls off the level, which would start this test again.
static var runs := 0


func _ready() -> void:
	runs += 1
	if runs > 1:
		return _fail("the player fell off the level and the kit reloaded the scene")
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


## Press an action at the start of a physics frame, where the kit's _physics_process reads is_action_just_pressed.
func _tap(action: StringName) -> void:
	await get_tree().physics_frame
	Input.action_press(action)
	await get_tree().physics_frame
	Input.action_release(action)


func _run() -> void:
	for action: String in ["move_forward", "move_back", "move_left", "move_right", "jump", "camera_left", "camera_right", "camera_up", "camera_down", "zoom_in", "zoom_out"]:
		if not InputMap.has_action(action) or InputMap.action_get_events(action).is_empty():
			return _fail("the input action %s is missing or has no events" % [action])
	if get_node_or_null("/root/Audio") == null:
		return _fail("the Audio autoload is missing")
	var level := (load(KIT + "scenes/main.tscn") as PackedScene).instantiate()
	add_child(level)
	await get_tree().create_timer(0.8).timeout
	var player := level.get_node("Player") as CharacterBody3D
	if not player.is_on_floor():
		return _fail("the player is not standing on the level")

	var ground := player.global_position.y
	await _tap(&"jump")
	var highest := ground
	var started := Time.get_ticks_msec()
	while Time.get_ticks_msec() - started < 500:
		highest = maxf(highest, player.global_position.y)
		await get_tree().physics_frame
	if highest - ground < 0.5:
		return _fail("jump lifted the player %f m" % [highest - ground])
	started = Time.get_ticks_msec()
	while not player.is_on_floor() and Time.get_ticks_msec() - started < 3000:
		await get_tree().physics_frame
	if not player.is_on_floor():
		return _fail("the player did not land after the jump")

	# A short walk: the level's first platform is small, and the kit reloads the scene when the player falls.
	var from := player.global_position
	Input.action_press("move_forward")
	await get_tree().create_timer(0.2).timeout
	Input.action_release("move_forward")
	await get_tree().create_timer(0.2).timeout
	var walked := Vector2(player.global_position.x - from.x, player.global_position.z - from.z).length()
	if walked < 0.2:
		return _fail("the player walked %f m in 0.2 s of move_forward" % [walked])

	var coin := level.get_node("World/coin") as Area3D
	coin.global_position = player.global_position
	await get_tree().create_timer(0.3).timeout
	var label := level.get_node("HUD/Coins") as Label
	if player.coins != 1 or label.text != "1":
		return _fail("%d coins, HUD %s after touching a coin" % [player.coins, label.text])

	var view := level.get_node("View") as Node3D
	var turned := view.rotation.y
	Input.action_press("camera_right")
	await get_tree().create_timer(0.4).timeout
	Input.action_release("camera_right")
	if is_equal_approx(view.rotation.y, turned):
		return _fail("camera_right did not turn the camera rig")
	print("walked ", walked, " jumped ", highest - ground)
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
