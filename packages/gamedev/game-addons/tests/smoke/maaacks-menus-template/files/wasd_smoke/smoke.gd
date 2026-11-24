extends Node
## Maaack's Menus Template smoke test: the main menu shows its buttons and opens the options menu, a volume change
## reaches the audio server and the player's saved settings, New Game changes to the game scene, and there the pause
## controller opens the pause menu on ui_cancel and pauses the game until the menu closes.

const ID := "maaacks-menus-template"
const KIT := "res://addons/maaacks_menus_template/"
const GAME := "res://wasd_smoke/game.tscn"


func _ready() -> void:
	# The main menu changes the scene, which frees this one: the test runs from a node under the root.
	var driver := Node.new()
	driver.name = "SmokeDriver"
	driver.set_script(load("res://wasd_smoke/driver.gd"))
	get_tree().root.add_child.call_deferred(driver)
