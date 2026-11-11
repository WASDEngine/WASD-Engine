---
name: shaker
description: Shaker 1.0.7 is installed in this project. It shakes the screen and objects in 2D and 3D through the Shaker autoload, ShakerComponent2D/3D nodes with presets, ShakerComponent for any property, and area emitters. Load before adding camera shake, hit shake, or other shake effects.
---

# Shaker 1.0.7

Shaker adds an offset to properties every frame and removes it again, so the target returns to its rest value when the shake ends (within float rounding). The installer registered the autoload `Shaker` (`res://addons/shaker/src/Shaker.gd`); all other names below are global classes.

## Pieces

- Shake types (Resources) produce the values. 2D (`Vector2`): `ShakerTypeRandom2D`, `ShakerTypeSineWave2D`, `ShakerTypeSquareWave2D`, `ShakerTypeSawtoothWave2D`, `ShakerTypeBrownianShake2D`, `ShakerTypeNoiseShake2D`, `ShakerTypeCurve2D`, `ShakerTypeAudioBus2D`. The same names end in `1D` (`float`, for rotation or any float property) and `3D` (`Vector3`). Common properties: `amplitude`, `offset`, `BlendingMode` (`ShakerTypeBase.BlendingModes.Add`, `Override`, `Multiply`, `Subtract`, `Average`, `Max`, `Min`), `fade_in`, `fade_out`, `start_percent`, `end_percent`. Sine waves add `frequency` and `phase`; random types add `seed`.
- `ShakerPreset2D`: `PositionShake: Array[ShakerTypeBase2D]`, `RotationShake: Array[ShakerTypeBase1D]`, `ScaleShake: Array[ShakerTypeBase2D]`. `ShakerPreset3D`: the same three arrays of `ShakerTypeBase3D`.
- `ShakerComponent2D` (Node2D) / `ShakerComponent3D` (Node3D): shakes its parent's `position`, `rotation`, and `scale` with `shakerPreset`. Properties: `intensity` (1.0), `duration` (seconds; 0 = until `stop_shake()`), `shake_speed`, `fade_in`, `fade_out`, `AutoPlay`, `custom_target` plus `Targets` (shake other nodes instead of the parent). Methods: `play_shake()`, `stop_shake()` (fades out), `force_stop_shake()` (stops now); `ShakerComponent3D` also has `shake(preset, mode, duration)` to add a one-off shake on top. Signals: `shake_started`, `shake_fading_out`, `shake_finished`.
- `ShakerComponent` (Node): shakes named properties of its parent (or `Targets`): `shakerProperty: Array[ShakerProperty]`, where `ShakerProperty.new("offset", shake_type)` pairs a property name with a shake type whose value type matches the property. Same playback API and signals.
- Autoload `Shaker`: `shake_property(property: ShakerProperty, node, duration, speed = 1.0, intensity = 1.0, fade_in = 0.25, fade_out = 2.0) -> ShakerComponent`; `shake_by_preset(preset, node, duration, speed = 1.0, intensity = 1.0, fade_in = 0.25, fade_out = 2.0)` (returns nothing); `shake_emit_2d(world_position, preset, max_distance, duration)` and `shake_emit_3d(...)` (see Area shake). Each temporary node frees itself when done.
- Bundled 3D presets: `res://addons/shaker/data/resources/strong_shake3D.tres`, `shaker_earthquake3D.tres`, `box_opening3D.tres`.

## Camera shake on a hit (2D)

Shake `Camera2D.offset`, not `position`: game code that sets the camera position every frame would fight the shake.

```gdscript
func on_player_hit() -> void:
	var jolt := ShakerTypeRandom2D.new()
	jolt.amplitude = Vector2(8, 8)
	Shaker.shake_property(ShakerProperty.new("offset", jolt), $Camera2D, 0.3)
```

For 3D cameras shake `h_offset` and `v_offset` with 1D types: `ShakerProperty.new("h_offset", ShakerTypeRandom1D.new())` (`amplitude` is a float, in meters).

## A reusable preset in files

```
# res://fx/hit_shake.tres
[gd_resource type="Resource" script_class="ShakerPreset2D" load_steps=3 format=3]

[ext_resource type="Script" path="res://addons/shaker/data/Vector2/ShakerPreset2D.gd" id="1_preset"]
[ext_resource type="Script" path="res://addons/shaker/data/Vector2/ShakerTypeRandom2D.gd" id="2_random"]

[sub_resource type="Resource" id="Resource_random"]
script = ExtResource("2_random")
amplitude = Vector2(8, 8)

[resource]
script = ExtResource("1_preset")
PositionShake = [SubResource("Resource_random")]
```

```
# in a scene: a shaker under the node it shakes
[ext_resource type="Script" path="res://addons/shaker/src/Vector2/shaker_component2D.gd" id="1_shaker"]
[ext_resource type="Resource" path="res://fx/hit_shake.tres" id="2_preset"]

[node name="ShakerComponent2D" type="Node2D" parent="Sprite2D"]
script = ExtResource("1_shaker")
duration = 0.4
shakerPreset = ExtResource("2_preset")
```

Play it with `$Sprite2D/ShakerComponent2D.play_shake()`. In code: `var p := ShakerPreset2D.new()`, `p.PositionShake = [wave]`, then set `shakerPreset` on a `ShakerComponent2D.new()` and add it as a child.

For 3D, `Shaker.shake_by_preset(load("res://addons/shaker/data/resources/strong_shake3D.tres"), $Crate, 0.5)` shakes a Node3D's position and rotation for 0.5 s.

## Area shake (explosions)

Under the node that should react (for example the camera) add a `ShakerComponent2D` with `AutoPlay = true` and `duration = 0`, and under it a `ShakerReceiver2D`. The receiver creates an `Area2D` with an empty `CollisionShape2D`: give it a shape (`receiver.area2D.get_child(0).shape = CircleShape2D.new()`, after the receiver is ready). Then `Shaker.shake_emit_2d(explosion.global_position, preset, 300.0, 0.5)` shakes every receiver within 300 px, less with distance. The emitter area uses physics layer 10. The 3D classes (`ShakerReceiver3D`, `shake_emit_3d`) follow the same pattern.

## Check it in WASD Engine

Shake is motion, so a single screenshot proves little. Read values during the shake with `godot_eval`, for example `scene.get_node("Camera2D").offset` right after triggering it, and again after the duration (it should be back to `Vector2(0, 0)`). For a look, take two or three `godot_screenshot`s in a row while it shakes.

## Pitfalls

- `res://addons/shaker/data/resources/shaker_head_blob3D.tres` is broken (it references a demo file that is not installed) and fails to load. Do not use it.
- A shake type's value type must match the property: `2D` types for `Vector2` properties (`offset`, `position`, `zoom`), `1D` types for floats (`Node2D.rotation`, `Camera3D.h_offset`), `3D` types for `Vector3` properties.
- `duration = 0` means endless: call `stop_shake()` (fade out) or `force_stop_shake()`.
- Do not call `ShakerComponent2D.shake()`: in 1.0.7 it raises `Invalid access to property or key 'x' on a base object of type 'float'` every frame. Use `play_shake()` with `shakerPreset`, or the autoload.
- `Shaker.shake_by_preset` needs a `ShakerPreset2D` with a Node2D, or a `ShakerPreset3D` with a Node3D.
- `fade_in` and `fade_out` are easing curves (as in `ease()`), not seconds; the defaults of `shake_property` (0.25, 2.0) make the peak smaller than `amplitude`.
- Do not tween or animate the same property during a shake; shake a separate property (`offset`) or a parent node instead.

## Do not

- Do not edit files in `res://addons/shaker/`, enable plugins, or remove the `Shaker` autoload; the installer set them up.
