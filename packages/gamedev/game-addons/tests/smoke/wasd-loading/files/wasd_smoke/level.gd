extends Node3D
## The level the smoke test changes to: it notes whether it woke up paused, and counts its frames.

var woke_paused := false
var frames := 0


func _ready() -> void:
	woke_paused = get_tree().paused


func _process(_delta: float) -> void:
	frames += 1
