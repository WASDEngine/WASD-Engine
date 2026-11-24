extends "res://addons/wasd_crowd/bake_crowd.gd"
## The smoke test's prepare step: saves the smoke test's waving pole as a scene file, then bakes that file with
## bake_crowd.gd the way godot_script runs it, before any scene tree runs.


func _initialize() -> void:
	var maker: Node3D = preload("res://wasd_smoke/smoke.gd").new()
	var pole: Node3D = maker.call(&"_pole")
	maker.free()
	for part: Node in pole.find_children("*", "", true, false):
		part.owner = pole
	var scene := PackedScene.new()
	scene.pack(pole)
	pole.free()
	if ResourceSaver.save(scene, OS.get_cmdline_user_args()[0]) != OK:
		_done("CROWD_FAILED: the pole's scene did not save.", 1)
		return
	super._initialize()
