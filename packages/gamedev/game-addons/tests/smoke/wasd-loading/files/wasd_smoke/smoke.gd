extends Node3D
## WASD Loading smoke test (render run on the Compatibility renderer, the one every Web build uses): the autoload
## changes to a scene behind its loading screen while frames go on being drawn, the bar only moves forward, the new
## scene wakes paused and runs once the screen has gone, what the game spawns later is shown once and stays loaded
## until the next change, a screen of the game's own is told the progress and a tip, a 2D scene loads the same
## way and shows a 2D guest where its camera looks, far from the origin, a second change is refused while one runs,
## a path without a scene changes nothing, a scene that does not load brings back the scene that was left, and a
## resource loads in steps on its own.

const ID := "wasd-loading"


func _ready() -> void:
	# The test goes on after this scene is freed, so it runs on a node of its own under the root.
	var runner := Runner.new()
	get_tree().root.add_child.call_deferred(runner)


class Runner extends Node:
	func _ready() -> void:
		process_mode = Node.PROCESS_MODE_ALWAYS
		get_tree().create_timer(80.0, true).timeout.connect(func() -> void: _fail("timed out"))
		_run()

	func _fail(reason: String) -> void:
		print("SMOKE_FAIL ", reason)
		get_tree().quit(1)

	func _run() -> void:
		var tree := get_tree()
		if RenderingServer.get_current_rendering_method() != "gl_compatibility":
			return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
		var loader: WasdSceneLoader = get_node_or_null("/root/WasdLoader")
		if loader == null:
			return _fail("the installation added no autoload named WasdLoader")
		await tree.process_frame
		var first := tree.current_scene

		# 1. A change behind the built-in screen: frames go on, the bar only moves forward and ends full, the screen
		# shows meanwhile and is gone afterwards.
		loader.min_seconds = 0.3
		loader.title = "Smoke"
		loader.tips = ["Keep your powder dry."]
		var parts: Array[float] = []
		var frames := [0]
		var screen_seen := [false]
		var paused_seen := [false]
		var ran_while_paused := [0]
		var count := func() -> void:
			frames[0] += 1
			var layer := loader.get_child(0) as CanvasLayer
			if layer.visible and layer.get_child_count() > 0 and layer.get_child(0) is WasdLoadingScreen:
				screen_seen[0] = true
			if tree.paused:
				paused_seen[0] = true
				if tree.current_scene != null and tree.current_scene.get(&"frames") != null:
					ran_while_paused[0] = tree.current_scene.get(&"frames")
		tree.process_frame.connect(count)
		loader.progress_changed.connect(func(part: float) -> void: parts.append(part))
		var done: Array[Node] = []
		loader.finished.connect(func(scene: Node) -> void: done.append(scene))
		var began := Time.get_ticks_msec()
		# Called without waiting, the change hands back its unfinished run.
		var pending: Object = loader.call(&"change_scene", "res://wasd_smoke/level.tscn", PackedStringArray(["res://wasd_smoke/guest.tscn"]))
		if not loader.is_loading() or await loader.change_scene("res://wasd_smoke/flat.tscn") != null:
			return _fail("a second change was not refused while the first ran")
		var level: Node = await Signal(pending, &"completed")
		tree.process_frame.disconnect(count)
		if level == null or tree.current_scene != level or level.scene_file_path != "res://wasd_smoke/level.tscn" or is_instance_valid(first):
			return _fail("after the change the current scene is %s and the first scene is %s" % [tree.current_scene, "still there" if is_instance_valid(first) else "gone"])
		var forward := true
		for index: int in range(1, parts.size()):
			forward = forward and parts[index] >= parts[index - 1]
		if parts.is_empty() or not forward or parts[0] != 0.0 or parts[parts.size() - 1] != 1.0 or frames[0] < 12 or not screen_seen[0] or Time.get_ticks_msec() - began < 300:
			return _fail("the load took %d ms and %d frames, the screen was seen %s, progress went %s" % [Time.get_ticks_msec() - began, frames[0], screen_seen[0], parts])
		if (loader.get_child(0) as CanvasLayer).visible or loader.is_loading() or done != [level]:
			return _fail("after the change the screen still shows, the loader is busy, or finished said %s" % [done])

		# 2. The new scene woke paused, stood still behind the screen, and runs now.
		await tree.process_frame
		await tree.process_frame
		if not level.get(&"woke_paused") or not paused_seen[0] or ran_while_paused[0] != 0 or tree.paused or int(level.get(&"frames")) < 1:
			return _fail("the level woke paused %s, ran %d frames behind the screen, the tree is paused %s, and the level has run %s frames" % [level.get(&"woke_paused"), ran_while_paused[0], tree.paused, level.get(&"frames")])
		if get_viewport().get_camera_3d() != level.get_node("Camera"):
			return _fail("the level's own camera is not the current one after the warm-up")

		# 3. What the game spawns later was shown once behind the screen and stays loaded until the next change.
		if int(tree.root.get_meta(&"guests_seen", 0)) != 1 or level.find_child("Guest", true, false) != null or not ResourceLoader.has_cached("res://wasd_smoke/guest.tscn"):
			return _fail("the guest was shown %s times, is still in the level %s, and is cached %s" % [tree.root.get_meta(&"guests_seen", 0), level.find_child("Guest", true, false) != null, ResourceLoader.has_cached("res://wasd_smoke/guest.tscn")])

		# 4. A screen of the game's own is told the progress and a tip; a 2D scene loads the same way; without the
		# warm-up no guest is shown; and the guest of the last change is let go.
		loader.screen_scene = load("res://wasd_smoke/screen.tscn")
		loader.warm_up = false
		var flat: Node = await loader.change_scene("res://wasd_smoke/flat.tscn")
		if flat == null or tree.current_scene != flat or is_instance_valid(level):
			return _fail("the change to the 2D scene left %s current" % [tree.current_scene])
		if not tree.root.get_meta(&"own_screen_shown", false) or tree.root.get_meta(&"own_screen_progress", -1.0) != 1.0 or tree.root.get_meta(&"own_screen_tip", "") != "Keep your powder dry.":
			return _fail("the game's own screen was shown %s, told progress %s and tip %s" % [tree.root.get_meta(&"own_screen_shown", false), tree.root.get_meta(&"own_screen_progress", -1.0), tree.root.get_meta(&"own_screen_tip", "")])
		await tree.process_frame
		if ResourceLoader.has_cached("res://wasd_smoke/guest.tscn") or int(tree.root.get_meta(&"guests_seen", 0)) != 1:
			return _fail("after the next change the guest is still cached, or was shown again")
		loader.warm_up = true
		loader.screen_scene = null
		# The 2D scene's camera looks 2,000 pixels from the origin: a 2D guest stands where it looks, so it is drawn.
		var again: Node = await loader.change_scene("res://wasd_smoke/flat.tscn", ["res://wasd_smoke/guest.tscn", "res://wasd_smoke/guest_2d.tscn"])
		if again == null or int(tree.root.get_meta(&"guests_seen", 0)) != 2:
			return _fail("the warm-up of a 2D scene showed the guest %s times" % [tree.root.get_meta(&"guests_seen", 0)])
		if not tree.root.get_meta(&"guest_2d_shown", false) or again.find_child("Guest2D", true, false) != null:
			return _fail("the warm-up of a 2D scene whose camera looks away from the origin drew the 2D guest %s, and it is still in the scene %s" % [tree.root.get_meta(&"guest_2d_shown", false), again.find_child("Guest2D", true, false) != null])

		# 5. A path that holds no scene changes nothing; a scene that does not load brings back the one that was left.
		var current := tree.current_scene
		var refused: Node = await loader.change_scene("res://wasd_smoke/level.gdshader")
		if refused != null or not is_instance_valid(current) or tree.current_scene != current or loader.is_loading():
			return _fail("a change to a shader's path freed the scene %s, left %s current, and the loader busy %s" % [not is_instance_valid(current), tree.current_scene, loader.is_loading()])
		var broken := FileAccess.open("res://wasd_smoke/broken.tscn", FileAccess.WRITE)
		broken.store_string("[gd_scene format=3]\n\n[node name=\"Broken\" type=\"Node3D\"]\nposition = Vector3(1, 2\n")
		broken.close()
		var back: Node = await loader.change_scene("res://wasd_smoke/broken.tscn")
		DirAccess.remove_absolute(ProjectSettings.globalize_path("res://wasd_smoke/broken.tscn"))
		if back != null or tree.current_scene == null or tree.current_scene.scene_file_path != "res://wasd_smoke/flat.tscn" or is_instance_valid(current) or loader.is_loading():
			return _fail("a scene that did not load left %s current, and the loader busy %s" % [tree.current_scene, loader.is_loading()])

		# 6. A resource loads in steps on its own.
		var packed := await loader.load_resource("res://wasd_smoke/level.tscn") as PackedScene
		if packed == null or not packed.can_instantiate():
			return _fail("load_resource gave %s" % [packed])
		print("SMOKE_PASS ", ID)
		get_tree().quit(0)
