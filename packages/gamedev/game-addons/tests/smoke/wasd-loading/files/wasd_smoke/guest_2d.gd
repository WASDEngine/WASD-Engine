extends Node2D
## Something a 2D game spawns later. It tells the smoke test when the view first shows it: only a guest that is drawn
## has its shader compiled.


func _ready() -> void:
	($OnScreen as VisibleOnScreenNotifier2D).screen_entered.connect(func() -> void: get_tree().root.set_meta(&"guest_2d_shown", true))
