extends Control
## A loading screen of the game's own: it notes what the loader tells it.


func _ready() -> void:
	get_tree().root.set_meta(&"own_screen_shown", true)


func set_progress(part: float) -> void:
	get_tree().root.set_meta(&"own_screen_progress", part)


func set_tip(tip: String) -> void:
	get_tree().root.set_meta(&"own_screen_tip", tip)
