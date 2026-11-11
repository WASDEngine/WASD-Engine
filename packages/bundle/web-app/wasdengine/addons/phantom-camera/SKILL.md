---
name: phantom-camera
description: Phantom Camera 0.11.0.4 is installed in this project and gives it virtual 2D/3D cameras that drive the real Camera2D/Camera3D (follow, damping, limits, look-at, third person, shake, priority-based tweened switches). Load before adding or changing cameras.
---

# Phantom Camera 0.11.0.4

Installed in `res://addons/phantom_camera/` with its autoload `PhantomCameraManager`. Do not edit that folder; its `.cs` files are for C# only.

## Model

- Keep one real `Camera2D` or `Camera3D` and give it one child node with the script `phantom_camera_host.gd` (class `PhantomCameraHost`). The host must be the camera's child.
- Add `PhantomCamera2D` (Node2D) or `PhantomCamera3D` (Node3D) nodes anywhere. Every frame the host copies the active one's transform (and 2D `zoom`) onto the real camera and makes the camera `top_level`. Never move the real camera or use `Camera2D` smoothing; change the phantom cameras instead.
- Active camera: highest `priority` (int, clamped to >= 0) among visible phantom cameras whose `host_layers` bitmask overlaps the host's `host_layers` (default 1). Avoid equal priorities. Setting `priority` or `visible` switches at once; the camera then tweens with the new camera's `tween_resource` (`PhantomCameraTween`: `duration` seconds, default 1.0; `transition` LINEAR 0, SINE 1, QUINT 2, QUART 3, QUAD 4, EXPO 5, ELASTIC 6, CUBIC 7, CIRC 8, BOUNCE 9, BACK 10; `ease` EASE_IN 0, EASE_OUT 1, EASE_IN_OUT 2, EASE_OUT_IN 3). `tween_on_load` (default true) also tweens at scene start; set it false to start in place.

## Properties

- `follow_mode`: NONE 0, GLUED 1, SIMPLE 2, GROUP 3, PATH 4, FRAMED 5; 3D also THIRD_PERSON 6.
- `follow_target` (Node2D/Node3D), `follow_targets` (array, GROUP), `follow_path` (Path2D/Path3D, PATH), `follow_offset`, `follow_damping` (bool) with `follow_damping_value` (per axis, 0 to 1, default 0.1; higher is slower), `follow_axis_lock`.
- 2D: `zoom` (Vector2, 2 = closer), `snap_to_pixel`, `limit_left/top/right/bottom` (ints; the view stays inside), `limit_target` (NodePath to a TileMapLayer or CollisionShape2D instead of the four ints), `dead_zone_width/height` (0 to 1, FRAMED), `auto_zoom` with `auto_zoom_min/max/margin` (GROUP), `lookahead`.
- 3D: `follow_distance` (FRAMED, GROUP), `look_at_mode` NONE 0, MIMIC 1, SIMPLE 2, GROUP 3 with `look_at_target`, `look_at_targets`, `look_at_offset`, `look_at_damping`; THIRD_PERSON uses `spring_length`, `collision_mask`, `vertical_rotation_offset`, `horizontal_rotation_offset` (radians) and `set_third_person_rotation_degrees(Vector3)` to orbit with the mouse.
- Methods and signals: `is_active()`, `teleport_position()` (snap past damping after a teleport), `became_active`, `became_inactive`, `tween_started`, `tween_completed`; host: `get_active_pcam()`, `pcam_became_active(pcam)`.
- Shake: a `PhantomCameraNoiseEmitter2D`/`3D` node (scripts `phantom_camera_noise_emitter_2d.gd`/`_3d.gd`) with a `noise` resource (`PhantomCameraNoise2D`/`3D`: `amplitude`, `frequency`), `duration`, `growth_time`, `decay_time`; call `emit()`. It shakes only phantom cameras whose `noise_emitter_layer` overlaps the emitter's (`noise_emitter_layer` is 0 on cameras, 1 on emitters), so set the camera's to 1.

## Example (2D: player camera, limits, shake, cut to a shop camera)

```
[gd_scene load_steps=8 format=3]

[ext_resource type="Script" path="res://addons/phantom_camera/scripts/phantom_camera_host/phantom_camera_host.gd" id="1"]
[ext_resource type="Script" path="res://addons/phantom_camera/scripts/phantom_camera/phantom_camera_2d.gd" id="2"]
[ext_resource type="Script" path="res://addons/phantom_camera/scripts/resources/tween_resource.gd" id="3"]
[ext_resource type="Script" path="res://addons/phantom_camera/scripts/phantom_camera/phantom_camera_noise_emitter_2d.gd" id="4"]
[ext_resource type="Script" path="res://addons/phantom_camera/scripts/resources/phantom_camera_noise_2d.gd" id="5"]

[sub_resource type="Resource" id="Smooth"]
script = ExtResource("3")
duration = 0.6
transition = 1
ease = 2

[sub_resource type="Resource" id="Rumble"]
script = ExtResource("5")
amplitude = 12.0
frequency = 8.0

[node name="Level" type="Node2D"]

[node name="Camera2D" type="Camera2D" parent="."]

[node name="PhantomCameraHost" type="Node" parent="Camera2D"]
script = ExtResource("1")

[node name="Player" type="CharacterBody2D" parent="."]

[node name="PlayerCam" type="Node2D" parent="." node_paths=PackedStringArray("follow_target")]
script = ExtResource("2")
priority = 10
follow_mode = 2
follow_target = NodePath("../Player")
zoom = Vector2(2, 2)
tween_resource = SubResource("Smooth")
tween_on_load = false
noise_emitter_layer = 1
follow_damping = true
limit_left = 0
limit_top = 0
limit_right = 2000
limit_bottom = 1000

[node name="ShopCam" type="Node2D" parent="."]
position = Vector2(1600, 300)
script = ExtResource("2")
tween_resource = SubResource("Smooth")

[node name="Shake" type="Node2D" parent="."]
script = ExtResource("4")
noise = SubResource("Rumble")
duration = 0.3
```

Properties that hold nodes (`follow_target`, `follow_targets`, `follow_path`, `look_at_target`, `look_at_targets`) must be listed in the node header's `node_paths=PackedStringArray(...)`, or they silently stay null; arrays are written `[NodePath("../A"), NodePath("../B")]`. Use `type="Node2D"`/`"Node3D"`/`"Node"` plus `script =` for add-on nodes. For 3D use `Camera3D`, `phantom_camera_3d.gd` and a `Vector3` `follow_offset` such as `Vector3(0, 3, 6)` with `look_at_mode = 2` and `look_at_target`.

```gdscript
func open_shop() -> void:
	$ShopCam.priority = 20  # tweens over 0.6 s

func close_shop() -> void:
	$ShopCam.priority = 0   # PlayerCam (10) is active again

func on_hit() -> void:
	$Shake.emit()
```

## Verify in WASD Engine

Run with `godot_run`, move the player with `godot_input`, then `godot_eval`: `scene.get_node("Camera2D").global_position` should follow `scene.get_node("Player").global_position + follow_offset` (limits and damping aside), and `scene.get_node("Camera2D/PhantomCameraHost").get_active_pcam().name` names the active camera. Read the 2D shake in the camera's `offset`. Confirm framing with `godot_screenshot`.

## Pitfalls

- The camera is placed on the first frames after the scene starts, not in `_ready`.
- Following a CharacterBody/RigidBody makes the camera update in physics frames, and the add-on may print "Physics Interpolation is disabled in the Project Settings" as an error. It is only a tip: set `physics/common/physics_interpolation=true` (then call `reset_physics_interpolation()` after teleports) or add `tips/show_jitter_tips=false` under `[phantom_camera]` in `project.godot`.
- A 3D camera with both a follow mode and a look-at mode prints a "not been fully tested" warning; SIMPLE follow with SIMPLE look-at works.
- 2D limits and dead zones assume the screen is `display/window/size/viewport_width`×`viewport_height`. With the default stretch mode (disabled) and another window size, such as a `godot_run` size, the camera clamps to the wrong spot; set `window/stretch/mode="canvas_items"` under `[display]`.
- 2D and 3D phantom cameras in one scene must use different `host_layers`, or the hosts error.
- The plugin's editor viewfinder, gizmos and updater do not exist at runtime; configure everything in `.tscn` text or code.
