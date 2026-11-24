extends MeshInstance3D
## Something the game spawns later. It tells the smoke test each time one of its kind enters the tree.


func _ready() -> void:
	var seen: int = get_tree().root.get_meta(&"guests_seen", 0)
	get_tree().root.set_meta(&"guests_seen", seen + 1)
