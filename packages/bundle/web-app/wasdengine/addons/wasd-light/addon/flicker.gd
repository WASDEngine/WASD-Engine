# SPDX-License-Identifier: CC0-1.0
# Makes a light's brightness live: a candle, a torch, a fire, a neon tube, a failing lamp, a slow pulse. Add it as a
# child of the Light3D (or name the light in `light`); it moves the light's energy round the value the light had,
# and with it the energy of every WasdHalo3D under that light.
class_name WasdFlicker
extends Node

enum Style { CANDLE, TORCH, FIRE, NEON, FAILING, PULSE }

## How the light moves: Candle (gentle), Torch, Fire (strong, fast), Neon (a fine shimmer), Failing (cuts out now
## and then), Pulse (slow and even).
@export var style := Style.CANDLE
## How far the brightness moves, from 0 (still) to 1, and how fast (1 is the style's own speed).
@export_range(0.0, 1.0, 0.01) var amount := 0.5
@export_range(0.05, 8.0, 0.01) var speed := 1.0
## The light to move; left empty, the parent.
@export var light: Light3D

var _base_energy := 1.0
var _halos: Array[WasdHalo3D] = []
var _halo_energies: PackedFloat32Array = []
var _time := 0.0
var _phase := randf() * 100.0
var _out_until := 0.0


func _ready() -> void:
	if light == null:
		light = get_parent() as Light3D
	if light == null:
		push_warning("WasdFlicker: no Light3D to move; add it under a light or set `light`.")
		set_process(false)
		return
	_base_energy = light.light_energy
	for child: Node in light.find_children("*", "MeshInstance3D", true, false):
		if child is WasdHalo3D:
			_halos.append(child)
			_halo_energies.append((child as WasdHalo3D).energy)


func _process(delta: float) -> void:
	# A light or halo that the game has freed is let go.
	if not is_instance_valid(light):
		return
	_time += delta * speed
	var level := _level(_time + _phase)
	light.light_energy = _base_energy * level
	for index: int in range(_halos.size() - 1, -1, -1):
		if not is_instance_valid(_halos[index]):
			_halos.remove_at(index)
			_halo_energies.remove_at(index)
			continue
		_halos[index].energy = _halo_energies[index] * level


## Sets the brightness the light flickers round, for a light whose energy the game changes while it flickers.
func set_base_energy(energy: float) -> void:
	_base_energy = energy


## The light's brightness at a time, as a part of its own energy.
func _level(at: float) -> float:
	match style:
		Style.CANDLE:
			return 1.0 - amount * 0.35 * (0.5 + 0.3 * sin(at * 7.3) + 0.2 * sin(at * 13.1 + 1.7) * sin(at * 2.9))
		Style.TORCH:
			return 1.0 - amount * 0.5 * (0.5 + 0.25 * sin(at * 11.0) + 0.15 * sin(at * 23.7 + 0.8) + 0.1 * sin(at * 5.1))
		Style.FIRE:
			return 1.0 - amount * 0.7 * (0.5 + 0.2 * sin(at * 17.0) + 0.18 * sin(at * 31.3 + 2.1) + 0.12 * sin(at * 7.7) * sin(at * 3.1))
		Style.NEON:
			return 1.0 - amount * 0.12 * (0.5 + 0.5 * sin(at * 120.0) * sin(at * 9.0))
		Style.FAILING:
			if at < _out_until:
				return 0.05 if fmod(at * 30.0, 2.0) < 1.2 else 0.9
			if randf() < amount * 0.02:
				_out_until = at + randf_range(0.05, 0.5)
			return 1.0 - amount * 0.1 * (0.5 + 0.5 * sin(at * 90.0))
		_:
			return 1.0 - amount * 0.5 * (0.5 + 0.5 * sin(at * 2.0))
