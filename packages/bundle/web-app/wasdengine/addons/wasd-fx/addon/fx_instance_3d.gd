# SPDX-License-Identifier: CC0-1.0
# One effect that is playing: its layers of particles and its light. WasdFx makes these, ages them, and takes them
# back when they are over. Keep the one a looping effect returns, to move it or to `stop()` it.
class_name WasdFxInstance3D
extends Node3D

## The effect is over: every particle of a burst has died, or a stopped loop has faded out. Then the node waits to
## be used again by a later play of the same effect, which starts without the connections made for this one.
signal finished

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


func _process(delta: float) -> void:
	age += delta
	for material: ShaderMaterial in _materials:
		material.set_shader_parameter(&"age", age)
	if looping and _library != null and _library.get(&"wind") != _wind:
		# An effect that runs on leans with the wind as it changes, and is drawn as far as the wind carries it.
		_wind = _library.get(&"wind")
		var own_wind := global_basis.inverse() * _wind
		for material: ShaderMaterial in _materials:
			material.set_shader_parameter(&"wind", own_wind)
		_fit(_wind)
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


## Sets the box each layer is drawn within: wide enough for the effect at its scale, and for how far `wind` carries
## the layer's particles in their lives.
func _fit(wind: Vector3) -> void:
	for index: int in _materials.size():
		var material := _materials[index]
		var size: float = material.get_shader_parameter(&"scale")
		var carried: float = material.get_shader_parameter(&"carried")
		var life: float = material.get_shader_parameter(&"life")
		(get_child(index) as MultiMeshInstance3D).custom_aabb = AABB(Vector3.ONE * -16.0 * size, Vector3.ONE * 32.0 * size).grow(wind.length() * carried * life)
