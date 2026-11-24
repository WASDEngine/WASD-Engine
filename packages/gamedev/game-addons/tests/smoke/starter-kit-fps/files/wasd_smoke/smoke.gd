extends Node3D
## Starter Kit FPS smoke test: the kit's level runs from its folder under addons/, the installed input actions move
## the player and fire the blaster, a hit destroys an enemy, damage shows on the HUD, and the weapon toggles.

const ID := "starter-kit-fps"
const KIT := "res://addons/starter_kit_fps/"


func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _run() -> void:
	for action: String in ["move_forward", "move_back", "move_left", "move_right", "jump", "shoot", "weapon_toggle", "mouse_capture", "mouse_capture_exit", "camera_left", "camera_right", "camera_up", "camera_down"]:
		if not InputMap.has_action(action) or (InputMap.action_get_events(action).is_empty()):
			return _fail("the input action %s is missing or has no events" % [action])
	if get_node_or_null("/root/Audio") == null:
		return _fail("the Audio autoload is missing")
	var level := (load(KIT + "scenes/main.tscn") as PackedScene).instantiate()
	add_child(level)
	await get_tree().create_timer(0.5).timeout
	var player := level.get_node("Player") as CharacterBody3D
	var enemies := level.get_node("Enemies").get_children()
	if enemies.size() != 4:
		return _fail("%d enemies in the kit's level" % [enemies.size()])
	if not player.is_on_floor():
		return _fail("the player is not standing on the level")

	var from := player.global_position
	Input.action_press("move_forward")
	await get_tree().create_timer(0.6).timeout
	Input.action_release("move_forward")
	var moved := player.global_position.distance_to(from)
	if moved < 0.5:
		return _fail("the player moved %f m in 0.6 s of move_forward" % [moved])

	var cooldown := player.get_node("Cooldown") as Timer
	Input.action_press("shoot")
	await get_tree().create_timer(0.15).timeout
	Input.action_release("shoot")
	if cooldown.is_stopped() and cooldown.time_left <= 0.0 and player.blaster_cooldown.wait_time <= 0.0:
		return _fail("shoot did not start the weapon's cooldown")

	var first: Weapon = player.weapon
	# The kit reads the toggle with is_action_just_pressed, which holds for the frame an input event arrives in.
	var press := InputEventAction.new()
	press.action = &"weapon_toggle"
	press.pressed = true
	Input.parse_input_event(press)
	await get_tree().create_timer(0.6).timeout
	if player.weapons.size() < 2 or player.weapon == first:
		return _fail("weapon_toggle did not change the weapon")

	var enemy: Node3D = enemies[0]
	enemy.damage(100)
	await get_tree().process_frame
	await get_tree().process_frame
	if is_instance_valid(enemy) and not enemy.is_queued_for_deletion():
		return _fail("an enemy survived 100 damage")
	# The level's other enemies shoot back, so the health is read just before and just after the damage.
	var before: int = player.health
	player.damage(10)
	if player.health != before - 10:
		return _fail("10 damage took the health from %d to %d" % [before, player.health])
	await get_tree().process_frame
	var label := level.get_node("HUD/Health") as Label
	if label.text != "%d%%" % [player.health]:
		return _fail("health %d, HUD %s after 10 damage" % [player.health, label.text])
	print("moved ", moved, " weapon ", player.weapon.resource_path.get_file())
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
