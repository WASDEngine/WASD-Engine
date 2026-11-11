extends Node2D

# Shaker 1.0.7 smoke: the Shaker autoload shakes Camera2D.offset, a ShakerComponent2D shakes its parent's
# position, and Shaker.shake_by_preset shakes a Node3D with a bundled preset. Each target must move during
# the shake and be back at rest after it ends.

const STRONG_SHAKE_3D := "res://addons/shaker/data/resources/strong_shake3D.tres"

var _failures: PackedStringArray = []


func _check(ok: bool, what: String) -> void:
	if not ok:
		_failures.append(what)


func _ready() -> void:
	await _run()
	if _failures.is_empty():
		print("SMOKE_PASS shaker")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(_failures))
		get_tree().quit(1)


func _distance(a: Variant, b: Variant) -> float:
	if a is Vector2 or a is Vector3:
		return a.distance_to(b)
	return absf(float(a) - float(b))


# Polls target.property every frame until `finished` fires or `max_seconds` pass.
# Returns the largest distance from `rest`, or -1.0 when `finished` never fired.
func _peak_until(target: Object, property: StringName, rest: Variant, finished: Signal, max_seconds: float) -> float:
	var state := {"done": false}
	finished.connect(func() -> void: state.done = true, CONNECT_ONE_SHOT)
	var peak := 0.0
	var started := Time.get_ticks_msec()
	while not state.done and Time.get_ticks_msec() - started < max_seconds * 1000.0:
		await get_tree().process_frame
		peak = maxf(peak, _distance(target.get(property), rest))
	return peak if state.done else -1.0


func _run() -> void:
	# 1. Any property, through the autoload: Camera2D.offset with random noise.
	var camera := Camera2D.new()
	add_child(camera)
	var noise := ShakerTypeRandom2D.new()
	noise.amplitude = Vector2(12, 12)
	var component: ShakerComponent = Shaker.shake_property(ShakerProperty.new("offset", noise), camera, 0.4)
	_check(component != null, "shake_property returned null")
	if component != null:
		var peak := await _peak_until(camera, &"offset", Vector2.ZERO, component.shake_finished, 3.0)
		_check(peak > 1.0, "camera offset peak %s, expected > 1 px" % peak)
		_check(camera.offset.is_equal_approx(Vector2.ZERO), "camera offset did not return to rest: %s" % camera.offset)

	# 2. A ShakerComponent2D child shakes its parent Node2D with a preset.
	var player := Node2D.new()
	player.position = Vector2(100, 50)
	add_child(player)
	var wave := ShakerTypeSineWave2D.new()
	wave.amplitude = Vector2(6, 6)
	wave.frequency = Vector2(5, 3)
	var preset := ShakerPreset2D.new()
	preset.PositionShake = [wave]
	var shaker_2d := ShakerComponent2D.new()
	shaker_2d.shakerPreset = preset
	shaker_2d.duration = 0.4
	player.add_child(shaker_2d)
	shaker_2d.play_shake()
	var peak_2d := await _peak_until(player, &"position", Vector2(100, 50), shaker_2d.shake_finished, 3.0)
	_check(peak_2d > 1.0, "Node2D position peak %s, expected > 1 px" % peak_2d)
	_check(player.position.distance_to(Vector2(100, 50)) < 0.001, "Node2D did not return to rest: %s" % player.position)

	# 3. A Node3D shaken by a bundled ShakerPreset3D through the autoload.
	var prop := Node3D.new()
	prop.position = Vector3(1, 2, 3)
	add_child(prop)
	var preset_3d: ShakerPreset3D = load(STRONG_SHAKE_3D)
	_check(preset_3d != null, "could not load %s" % STRONG_SHAKE_3D)
	if preset_3d != null:
		Shaker.shake_by_preset(preset_3d, prop, 0.4)
		var temp: Node = Shaker.get_child(Shaker.get_child_count() - 1)
		_check(temp is ShakerComponent3D, "shake_by_preset did not add a ShakerComponent3D")
		if temp is ShakerComponent3D:
			var peak_3d := await _peak_until(prop, &"position", Vector3(1, 2, 3), temp.shake_finished, 3.0)
			_check(peak_3d > 0.01, "Node3D position peak %s, expected > 0.01" % peak_3d)
			_check(prop.position.distance_to(Vector3(1, 2, 3)) < 0.001, "Node3D did not return to rest: %s" % prop.position)
