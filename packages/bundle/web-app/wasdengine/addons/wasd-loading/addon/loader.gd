# SPDX-License-Identifier: CC0-1.0
# Scene changes behind a loading screen that also work in Web builds, from anywhere in the game:
# `await WasdLoader.change_scene("res://level.tscn")`. The installation adds this script as the autoload `WasdLoader`.
#
# A Web build runs on one thread: Godot's background loading loads in the foreground there, the page stands still,
# and a loading screen that waits for it never shows. This loader lists everything the scene is made of and loads
# it a few files a frame, so the screen draws, the bar moves, and the browser does not call the page unresponsive.
# Then it shows the new scene to the graphics card from above, behind the screen, with the things the game will
# spawn later among it, for as long as the card needs: every shader is compiled before the player sees a frame, and
# the first explosion or the first enemy does not stall the game.
class_name WasdSceneLoader
extends Node

## How much of the loading is done, from 0 to 1.
signal progress_changed(part: float)
## The new scene is in the tree and the loading screen has gone.
signal finished(scene: Node)

## The game's own loading screen: a scene whose root is a Control that fills the window. If it has the methods
## `set_progress(part: float)` and `set_tip(tip: String)`, they are called. Null shows the built-in screen.
var screen_scene: PackedScene
## What the built-in screen shows: a title (empty for the game's name), its colors, and lines of advice of which
## each load shows one.
var title := ""
var background := Color(0.06, 0.07, 0.09)
var accent := Color(0.96, 0.76, 0.32)
var tips: PackedStringArray = []
## The screen stays at least this long, so that a short load does not flash it.
var min_seconds := 0.5
## Milliseconds of loading a frame, before the frame is given back to drawing.
var frame_budget_ms := 8.0
## Whether the new scene is shown to the graphics card before the player sees it, and how many meters round the
## scene's camera that showing reaches.
var warm_up := true
var warm_up_reach := 300.0
## Seconds the whole scene stays before the graphics card at the least, in a Web build: a browser compiles shaders in
## the background, and the loader waits until that is done.
var warm_up_seconds := 1.0

var _busy := false
var _layer := CanvasLayer.new()
var _screen: Control
var _held: Array[Resource] = []
## The scenes named in `also`, kept loaded while the scene they came with is the current one: a shader is compiled
## for as long as something holds it, and no longer.
var _kept: Array[Resource] = []


func _init() -> void:
	# The loader works while the game is paused: it pauses the new scene itself until the screen has gone.
	process_mode = Node.PROCESS_MODE_ALWAYS
	_layer.layer = 120
	_layer.visible = false
	add_child(_layer)


## Whether a scene change is under way.
func is_loading() -> bool:
	return _busy


## Changes to the scene at `path` behind the loading screen and returns its root once the screen has gone; null if
## the scene cannot be loaded or another change is under way. `also` lists scenes that the game spawns later, such
## as enemies, projectiles, and effects: each is loaded with the level, and shown once behind the screen so that
## its shaders are compiled too (its `_ready` runs for that moment). A path that holds no scene changes nothing. A
## scene that does not load once the old one has gone brings the old one back, new from its file, and returns null.
func change_scene(path: String, also: PackedStringArray = []) -> Node:
	if _busy:
		push_warning("WasdLoader: a scene change is under way; %s was not loaded." % [path])
		return null
	if not ResourceLoader.exists(path, "PackedScene"):
		push_error("WasdLoader: there is no scene at %s." % [path])
		return null
	_busy = true
	var began := Time.get_ticks_msec()
	var tree := get_tree()
	var was_paused := tree.paused
	await _show_screen()
	# The scene that ends goes first, so that its memory is free before the next one loads.
	var left := ""
	if tree.current_scene != null:
		left = tree.current_scene.scene_file_path
		tree.current_scene.queue_free()
		tree.current_scene = null
	await tree.process_frame
	var wanted := PackedStringArray([path])
	wanted.append_array(also)
	await _load_in_steps(wanted, 0.0, 0.8)
	var scene := _instantiate(path)
	var changed := scene != null
	if not changed:
		_held.clear()
		also = PackedStringArray()
		if left != "" and left != path:
			push_error("WasdLoader: %s did not load; back to %s." % [path, left])
			await _load_in_steps(PackedStringArray([left]), 0.8, 0.84)
			scene = _instantiate(left)
		else:
			push_error("WasdLoader: %s did not load." % [path])
		if scene == null:
			await _hide_screen()
			_busy = false
			return null
	_report(0.86)
	await tree.process_frame
	# The new scene waits, paused, until the player can see it.
	tree.paused = true
	tree.root.add_child(scene)
	tree.current_scene = scene
	_kept.clear()
	var guests: Array[PackedScene] = []
	for extra: String in also:
		var kept := ResourceLoader.load(extra)
		if kept != null:
			_kept.append(kept)
		if kept is PackedScene:
			guests.append(kept)
	if warm_up:
		await _warm_up(scene, guests)
	_held.clear()
	_report(1.0)
	while Time.get_ticks_msec() - began < min_seconds * 1000.0:
		await tree.process_frame
	tree.paused = was_paused
	await _hide_screen()
	_busy = false
	if not changed:
		return null
	finished.emit(scene)
	return scene


## A new instance of the scene at `path`, or null when the file does not load as a scene.
static func _instantiate(path: String) -> Node:
	var packed := ResourceLoader.load(path) as PackedScene
	return packed.instantiate() if packed != null and packed.can_instantiate() else null


## Loads a resource a few files a frame, without a screen, and returns it: the next level's scene while the player
## still walks through this one, or a large model on demand. Await it.
func load_resource(path: String) -> Resource:
	if not ResourceLoader.exists(path):
		push_error("WasdLoader: there is nothing at %s." % [path])
		return null
	var kept := _held.size()
	await _load_in_steps(PackedStringArray([path]), -1.0, -1.0)
	var resource := ResourceLoader.load(path)
	_held.resize(mini(kept, _held.size()))
	return resource


## Loads everything the resources at `paths` are made of, what others depend on first, a few files a frame. The
## bar moves from `from` to `to`; a negative `from` moves no bar.
func _load_in_steps(paths: PackedStringArray, from: float, to: float) -> void:
	var tree := get_tree()
	var slice := Time.get_ticks_msec()
	# The list: every file once, each after the files it needs.
	var order: PackedStringArray = []
	var seen := {}
	var open: Array[Array] = []
	for path: String in paths:
		open.append([path, false])
	open.reverse()
	while not open.is_empty():
		var top: Array = open.back()
		var path: String = top[0]
		if top[1]:
			open.pop_back()
			order.append(path)
			continue
		top[1] = true
		if seen.has(path):
			open.pop_back()
			continue
		seen[path] = true
		for entry: String in ResourceLoader.get_dependencies(path):
			var needs := _dependency_path(entry)
			if needs != "" and not seen.has(needs):
				open.append([needs, false])
		if Time.get_ticks_msec() - slice >= frame_budget_ms:
			await tree.process_frame
			slice = Time.get_ticks_msec()
	# The loading: one file after another, and a frame for the screen whenever the budget is spent.
	for index: int in order.size():
		var path := order[index]
		if ResourceLoader.exists(path):
			var resource := ResourceLoader.load(path)
			if resource != null:
				_held.append(resource)
		if from >= 0.0:
			_report(lerpf(from, to, float(index + 1) / order.size()))
		if Time.get_ticks_msec() - slice >= frame_budget_ms:
			await tree.process_frame
			slice = Time.get_ticks_msec()


## The path in a line of ResourceLoader.get_dependencies(), which is a path or "uid::type::path".
static func _dependency_path(entry: String) -> String:
	if not entry.contains("::"):
		return entry
	var uid := entry.get_slice("::", 0)
	if uid.begins_with("uid://"):
		var id := ResourceUID.text_to_id(uid)
		if id != ResourceUID.INVALID_ID and ResourceUID.has_id(id):
			return ResourceUID.get_id_path(id)
	return entry.get_slice("::", 2)


## Shows the scene to the graphics card before the player sees it, from above, behind the loading screen, with the
## guests standing among it. A desktop graphics driver compiles a shader the moment it is first drawn: there the
## ground is shown a patch a frame, so that no frame has every shader to compile. A browser compiles in the
## background and finishes only what stays in the picture: there everything is shown at once and held until the
## frames run evenly again. Last, the scene as its own camera sees it.
func _warm_up(scene: Node, guests: Array[PackedScene]) -> void:
	var tree := get_tree()
	var in_browser := OS.has_feature("web")
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		# A 2D scene shows itself; the guests stand in the middle of the view meanwhile.
		var shown: Array[Node] = []
		for guest: PackedScene in guests:
			shown.append(_seat(guest.instantiate(), scene, get_viewport().get_visible_rect().get_center()))
		await _warm_effects()
		await _hold(in_browser, 0.86, 0.97)
		for node: Node in shown:
			node.queue_free()
		return
	var around := AABB(camera.global_position - Vector3.ONE * warm_up_reach, Vector3.ONE * warm_up_reach * 2.0)
	var boxes := _boxes(scene, around)
	var bounds := AABB(around.get_center() - Vector3.ONE * 5.0, Vector3.ONE * 10.0)
	for index: int in boxes.size():
		bounds = boxes[index] if index == 0 else bounds.merge(boxes[index])
	# As many patches as it takes for none to hold more than a few things: 4 for a small scene, up to 64.
	var side := 1
	var holds := PackedInt32Array()
	while side < 8:
		side += 1
		holds.resize(side * side)
		holds.fill(0)
		var most := 0
		for box: AABB in boxes:
			var at := _patch_of(box.get_center(), bounds, side)
			holds[at] += 1
			most = maxi(most, holds[at])
		if most <= 5:
			break
	var patch := Vector2(bounds.size.x, bounds.size.z) / side
	var middles: Array[Vector3] = []
	for index: int in side * side:
		if holds[index] > 0:
			middles.append(Vector3(bounds.position.x + patch.x * (index % side + 0.5), bounds.end.y, bounds.position.z + patch.y * (index / side + 0.5)))
	if middles.is_empty():
		middles.append(Vector3(bounds.get_center().x, bounds.end.y, bounds.get_center().z))
	var down := Basis(Vector3.RIGHT, Vector3.FORWARD, Vector3.UP)
	var wide := Camera3D.new()
	wide.projection = Camera3D.PROJECTION_ORTHOGONAL
	wide.near = 0.5
	wide.far = bounds.size.y + 40.0
	add_child(wide)
	wide.make_current()
	await _warm_effects()
	# Each guest stands over a patch of its own, the patches in turn.
	var seated: Array[Node] = []
	for number: int in guests.size():
		seated.append(_seat(guests[number].instantiate(), scene, middles[number % middles.size()] + Vector3.UP * 2.0))
	if not in_browser:
		wide.size = maxf(maxf(patch.x, patch.y) * 1.02, 2.0)
		for turn: int in middles.size():
			wide.global_transform = Transform3D(down, middles[turn] + Vector3.UP * 20.0)
			await tree.process_frame
			_report(lerpf(0.86, 0.95, float(turn + 1) / middles.size()))
	wide.size = maxf(maxf(bounds.size.x, bounds.size.z) * 1.02, 2.0)
	wide.global_transform = Transform3D(down, Vector3(bounds.get_center().x, bounds.end.y + 20.0, bounds.get_center().z))
	await _hold(in_browser, 0.86, 0.97)
	for node: Node in seated:
		node.queue_free()
	wide.queue_free()
	if is_instance_valid(camera):
		camera.make_current()
	for _frame: int in 2:
		await tree.process_frame


## Keeps the picture as it is while the graphics card takes it in. Outside a browser two frames do. In a browser:
## at least `warm_up_seconds`, and until half a second has passed without a frame that took far longer than its
## neighbors, which is how the browser's compiling shows; six seconds at most.
func _hold(in_browser: bool, from: float, to: float) -> void:
	var tree := get_tree()
	if not in_browser:
		await tree.process_frame
		await tree.process_frame
		return
	var began := Time.get_ticks_msec()
	var last := began
	var even_since := began
	var recent: Array[float] = []
	while true:
		await tree.process_frame
		var now := Time.get_ticks_msec()
		var took := float(now - last)
		last = now
		if recent.size() >= 5:
			var sorted := recent.duplicate()
			sorted.sort()
			if took > maxf(float(sorted[sorted.size() / 2]) * 1.8, 30.0):
				even_since = now
		recent.append(took)
		if recent.size() > 30:
			recent.pop_front()
		var held := (now - began) / 1000.0
		_report(lerpf(from, to, clampf(held / maxf(warm_up_seconds * 2.0, 0.1), 0.0, 1.0)))
		if (held >= warm_up_seconds and now - even_since >= 500) or held >= 6.0:
			return


## The patch of the ground, of `side` by `side`, that a place lies over.
static func _patch_of(place: Vector3, bounds: AABB, side: int) -> int:
	var across := clampi(int((place.x - bounds.position.x) / maxf(bounds.size.x, 0.001) * side), 0, side - 1)
	var along := clampi(int((place.z - bounds.position.z) / maxf(bounds.size.z, 0.001) * side), 0, side - 1)
	return along * side + across


## Puts a guest into the scene at a place, with its particles running.
func _seat(guest: Node, scene: Node, place: Variant) -> Node:
	scene.add_child(guest)
	if guest is Node3D and place is Vector3:
		(guest as Node3D).global_position = place
	elif guest is Node2D and place is Vector2:
		(guest as Node2D).global_position = place
	for part: Node in [guest] + guest.find_children("*", "", true, false):
		if part is GPUParticles3D or part is CPUParticles3D or part is GPUParticles2D or part is CPUParticles2D:
			part.set(&"emitting", true)
	return guest


## WASD FX compiles its one shader on request.
func _warm_effects() -> void:
	var effects := get_node_or_null(^"/root/WasdFx")
	if effects != null and effects.has_method(&"warm_up"):
		await effects.call(&"warm_up")


## The boxes of everything under `scene` that is drawn, as far as they lie within `around`.
func _boxes(scene: Node, around: AABB) -> Array[AABB]:
	var boxes: Array[AABB] = []
	for node: Node in scene.find_children("*", "VisualInstance3D", true, false):
		var drawn := node as VisualInstance3D
		if not drawn.is_visible_in_tree():
			continue
		var box := (drawn.global_transform * drawn.get_aabb()).intersection(around)
		if box.size != Vector3.ZERO:
			boxes.append(box)
	return boxes


func _report(part: float) -> void:
	progress_changed.emit(part)
	if _screen != null and _screen.has_method(&"set_progress"):
		_screen.call(&"set_progress", part)


func _show_screen() -> void:
	if screen_scene != null:
		_screen = screen_scene.instantiate() as Control
	if _screen == null:
		var built := WasdLoadingScreen.new()
		built.title = title if title != "" else str(ProjectSettings.get_setting("application/config/name", ""))
		built.background = background
		built.accent = accent
		_screen = built
	_screen.process_mode = Node.PROCESS_MODE_ALWAYS
	_layer.add_child(_screen)
	if not tips.is_empty() and _screen.has_method(&"set_tip"):
		_screen.call(&"set_tip", tips[randi() % tips.size()])
	_report(0.0)
	_screen.modulate.a = 0.0
	_layer.visible = true
	var fade := create_tween()
	fade.tween_property(_screen, ^"modulate:a", 1.0, 0.15)
	await fade.finished


func _hide_screen() -> void:
	var fade := create_tween()
	fade.tween_property(_screen, ^"modulate:a", 0.0, 0.25)
	await fade.finished
	_layer.visible = false
	_screen.queue_free()
	_screen = null
