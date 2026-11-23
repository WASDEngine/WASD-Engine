extends Node
## Runs the Maaack's Menus Template smoke test from under the root, across the scene change that New Game makes.

const ID := "maaacks-menus-template"
const KIT := "res://addons/maaacks_menus_template/"
const GAME := "res://wasd_smoke/game.tscn"


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _run() -> void:
	if get_node_or_null("/root/MenusStartUp") == null:
		return _fail("the MenusStartUp autoload, which applies saved settings, is missing")
	var credits := (load(KIT + "examples/scenes/credits/credits_label.tscn") as PackedScene).instantiate() as RichTextLabel
	if not credits.text.contains("Credits") or credits.text.contains("Person 1"):
		return _fail("the credits label holds the template's placeholder text")
	credits.free()
	var menu := (load(KIT + "examples/scenes/menus/main_menu/main_menu.tscn") as PackedScene).instantiate() as MainMenu
	menu.game_scene_path = GAME
	get_tree().current_scene.add_child(menu)
	await get_tree().create_timer(0.3).timeout
	for button_name: String in ["NewGameButton", "OptionsButton", "CreditsButton"]:
		var button := menu.find_child(button_name) as Button
		if button == null or not button.is_visible_in_tree():
			return _fail("the main menu shows no %s" % [button_name])
	var opened: Array[bool] = [false]
	menu.sub_menu_opened.connect(func() -> void: opened[0] = true)
	(menu.find_child("OptionsButton") as Button).pressed.emit()
	await get_tree().create_timer(0.3).timeout
	if not opened[0] or menu.sub_menu == null:
		return _fail("the options button opened no menu")

	# A saved setting, as the options menu's slider writes it, applies at start-up through AppSettings.
	var before := AudioServer.get_bus_volume_db(AppSettings.MASTER_BUS_INDEX)
	PlayerConfig.set_config(AppSettings.AUDIO_SECTION, "Master", 0.5)
	AppSettings.set_audio_from_config()
	var after := AudioServer.get_bus_volume_db(AppSettings.MASTER_BUS_INDEX)
	PlayerConfig.erase_section(AppSettings.AUDIO_SECTION)
	AudioServer.set_bus_volume_db(AppSettings.MASTER_BUS_INDEX, before)
	if absf(after - (before + linear_to_db(0.5))) > 0.1:
		return _fail("a saved master volume of 0.5 took the bus from %f to %f dB" % [before, after])

	menu.new_game()
	await get_tree().create_timer(0.5).timeout
	var game := get_tree().current_scene
	if game == null or game.scene_file_path != GAME:
		return _fail("New Game left the scene at %s" % ["none" if game == null else game.scene_file_path])

	var controller := Node.new()
	controller.set_script(load(KIT + "base/nodes/utilities/pause_menu_controller.gd"))
	controller.pause_menu_packed = load(KIT + "examples/scenes/windows/pause_menu.tscn")
	game.add_child(controller)
	await get_tree().create_timer(0.3).timeout
	var cancel := InputEventAction.new()
	cancel.action = &"ui_cancel"
	cancel.pressed = true
	Input.parse_input_event(cancel)
	await get_tree().create_timer(0.4).timeout
	var pause_menu: Control = controller.pause_menu
	if not pause_menu.visible or not get_tree().paused:
		return _fail("ui_cancel left the pause menu %s and the tree %s" % ["shown" if pause_menu.visible else "hidden", "paused" if get_tree().paused else "running"])
	pause_menu.close()
	await get_tree().create_timer(0.4).timeout
	if pause_menu.visible or get_tree().paused:
		return _fail("closing the pause menu left the game paused")
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
