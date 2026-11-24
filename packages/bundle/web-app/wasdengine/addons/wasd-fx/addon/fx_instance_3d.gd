# SPDX-License-Identifier: CC0-1.0
# One effect that is playing: its layers of particles and its light. WasdFx makes these, ages them, and takes them
# back when they are over. Keep the one a looping effect returns, to move it or to `stop()` it.
class_name WasdFxInstance3D
extends Node3D

## The effect is over: every particle of a burst has died, or a stopped loop has faded out. Then the node waits to
## be used again by a later play of the same effect, which starts without the connections made for this one.
signal finished

## Seconds of an effect's age between the samples it keeps of the way the air has gone, and how many it keeps: more
## than the longest life of a particle that the wind carries. The particle shader holds as many.
const WAY_STEP := 0.25
const WAYS := 24

## The effect's name, whether it runs on until stopped, and seconds since it began.
var effect := ""
var looping := false
var age := 0.0

var _materials: Array[ShaderMaterial] = []
var _seconds := 1.0
var _light: OmniLight3D
var _light_energy := 0.0
var _light_seconds := 0.0
var _fade := 1.0
var _fade_seconds := 0.0
var _flicker := randf() * 100.0
var _library: Node
var _wind := Vector3.ZERO
## For an effect that runs on: the wind in its own space, how far the air has gone there since it began, and a sample
## of that way at every WAY_STEP seconds of its age, the one of age k * WAY_STEP in _ways[k % WAYS].
var _own_wind := Vector3.ZERO
var _way := Vector3.ZERO
var _ways := PackedVector3Array()
var _way_count := 0


func _process(delta: float) -> void:
	age += delta
	for material: ShaderMaterial in _materials:
		material.set_shader_parameter(&"age", age)
	if looping:
		if _library != null and _library.get(&"wind") != _wind:
			# An effect that runs on takes the wind as it changes; what is in the air goes on the way the air takes it.
			_wind = _library.get(&"wind")
			_own_wind = global_basis.inverse() * _wind
			for material: ShaderMaterial in _materials:
				material.set_shader_parameter(&"wind", _own_wind)
			_fit(maxf(_own_wind.length(), _fastest_air()))
		_carry(delta)
	if _fade_seconds > 0.0:
		_fade = maxf(_fade - delta / _fade_seconds, 0.0)
		for material: ShaderMaterial in _materials:
			material.set_shader_parameter(&"fade", _fade)
	if _light != null:
		if looping:
			# A fire's light moves with its flames.
			_light.light_energy = _light_energy * _fade * (0.82 + 0.12 * sin((age + _flicker) * 11.0) + 0.06 * sin((age + _flicker) * 23.7))
		else:
			var left := 1.0 - age / _light_seconds
			_light.light_energy = _light_energy * left * left if left > 0.0 else 0.0
			_light.visible = left > 0.0
	if (not looping and age > _seconds) or (_fade_seconds > 0.0 and _fade <= 0.0):
		set_process(false)
		visible = false
		finished.emit()
		if _library != null:
			_library.call(&"_keep", self)


## Ends a looping effect: it fades out over `seconds` and is then taken back.
func stop(seconds := 0.6) -> void:
	_fade_seconds = maxf(seconds, 0.01)


## Starts the way of the air over for a play: a looping effect keeps its samples from its age 0 on, and before that
## the air went at the wind it begins with; a burst keeps none and takes the wind it began with all its life.
func _start_way() -> void:
	_way = Vector3.ZERO
	_ways.resize(WAYS)
	_ways.fill(Vector3.ZERO)
	_way_count = 1 if looping else 0
	for material: ShaderMaterial in _materials:
		material.set_shader_parameter(&"way", _way)
		material.set_shader_parameter(&"ways", _ways)
		material.set_shader_parameter(&"way_count", _way_count)
		material.set_shader_parameter(&"first_wind", _own_wind)


## Adds up the way the air goes in the effect's own space, takes a sample of it at every WAY_STEP seconds of the age,
## read between the last frame and this one, and hands both to the layers.
func _carry(delta: float) -> void:
	var was := _way
	_way += _own_wind * delta
	var taken := false
	while float(_way_count) * WAY_STEP <= age:
		var share := 1.0 - (age - float(_way_count) * WAY_STEP) / maxf(delta, 0.000001)
		_ways[_way_count % WAYS] = was.lerp(_way, clampf(share, 0.0, 1.0))
		_way_count += 1
		taken = true
	if _way.length_squared() > 1000000.0:
		# Only the differences count: all ways move back together, so that the numbers stay small.
		var back := _ways[maxi(_way_count - WAYS, 0) % WAYS]
		_way -= back
		for index: int in WAYS:
			_ways[index] -= back
		taken = true
	for material: ShaderMaterial in _materials:
		material.set_shader_parameter(&"way", _way)
		if taken:
			material.set_shader_parameter(&"ways", _ways)
			material.set_shader_parameter(&"way_count", _way_count)
	if taken:
		_fit(maxf(_own_wind.length(), _fastest_air()))


## The fastest the air went between the samples kept, in meters a second.
func _fastest_air() -> float:
	var fastest := 0.0
	for index: int in range(maxi(_way_count - WAYS, 0), _way_count - 1):
		fastest = maxf(fastest, _ways[(index + 1) % WAYS].distance_to(_ways[index % WAYS]) / WAY_STEP)
	return fastest


## Sets the box each layer is drawn within: wide enough for the effect at its scale, and for how far a wind of `speed`
## meters a second carries the layer's particles in their lives. Every layer's box has the effect's origin as its
## middle, so the layers sort among other see-through things as one, in the order their sorting offsets give.
func _fit(speed: float) -> void:
	for index: int in _materials.size():
		var material := _materials[index]
		var size: float = material.get_shader_parameter(&"scale")
		var carried: float = material.get_shader_parameter(&"carried")
		var life: float = material.get_shader_parameter(&"life")
		(get_child(index) as MultiMeshInstance3D).custom_aabb = AABB(Vector3.ONE * -16.0 * size, Vector3.ONE * 32.0 * size).grow(speed * carried * life)
