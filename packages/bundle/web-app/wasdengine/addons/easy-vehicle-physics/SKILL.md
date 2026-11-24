---
name: easy-vehicle-physics
description: Easy Vehicle Physics is installed in this project. Its Vehicle is a rigid body on four ray-cast wheels with suspension, an engine with an automatic gearbox, tire grip by surface, and steering, traction, and stability assists, and four tuned cars are ready to drive, an arcade racer, a simcade car, a drift car, and a monster truck. Load before adding a car that the player or traffic drives.
---

# Easy Vehicle Physics (2025-08-17)

`res://addons/gevp/` (MIT, by David Shoemaker; the car models are Kenney's CC0 Car Kit; global classes, no plugin to enable; the demos and debug screens are left out, and one function is changed so that ground in a level's own groups works). A `Vehicle` is a `RigidBody3D` with four `Wheel` ray casts; three of them on a generated road ran at 60 frames a second in a Web build. The class names `Vehicle` and `Wheel` are the add-on's: name the game's own classes otherwise.

## A car that drives

```gdscript
const CAR := preload("res://addons/gevp/scenes/arcade_car.tscn")

var car: Vehicle

func _ready() -> void:
	car = CAR.instantiate() as Vehicle
	car.position = Vector3(0, 1, 0)        # a car faces its -Z; start it a little above the ground
	add_child(car)

func _physics_process(_delta: float) -> void:
	var forward := Input.get_action_strength("accelerate")
	var back := Input.get_action_strength("brake")
	car.steering_input = Input.get_axis("steer_right", "steer_left")     # 1 is left
	car.handbrake_input = Input.get_action_strength("handbrake")
	# Holding back at rest shifts into reverse, and in reverse the two pedals change places.
	if car.current_gear == -1:
		car.throttle_input = back
		car.brake_input = forward
	else:
		car.throttle_input = forward
		car.brake_input = back
```

The actions are the game's own; define them in the project's input map. Traffic and rivals are the same car with the inputs set by code.

| Scene in `res://addons/gevp/scenes/` | Drives like |
|---|---|
| `arcade_car.tscn` | a racing game's car: much grip, strong assists, forgiving |
| `simcade_car.tscn` | a road car with assists that keep it in hand |
| `drift_car.tscn` | rear-wheel drive set up to slide and hold a drift |
| `monster_truck.tscn` | tall, soft, bouncy, few assists |

## What a car tells

`car.speed` in m/s (times 3.6 for km/h), `car.motor_rpm`, `car.current_gear` (-1 reverse, 0 neutral), `car.throttle_amount`, and `car.wheel_array`: each `Wheel` has `is_colliding()`, `last_collision_point`, `slip_vector` (x sideways, y along), and `surface_type`.

- Engine sound: instance `engine_sound.tscn` as a child of the car and set its `vehicle` to the car; its pitch follows the motor.
- Tire smoke with `wasd-fx`: for each wheel, when `wheel.is_colliding()` and `absf(wheel.slip_vector.x) > 1.0`, `WasdFx.play("dust", wheel.last_collision_point)` a few times a second.
- A chase camera with `phantom-camera`, or a `Camera3D` that eases toward `car.global_position + car.global_basis.z * 6.0 + Vector3.UP * 2.5` and looks at the car.

## Ground

The ground needs a collider. A wheel takes its surface from the ground body's groups, and the first of them that is `Road`, `Dirt`, or `Grass` sets grip, tire stiffness, and rolling resistance; a ground in none of them drives like the road. Put off-road ground in `Dirt` or `Grass`: `terrain_body.add_to_group("Grass")`. With `road-generator`, set `road.collider_group_name = "Road"`.

## Tuning and another look

Every setting is an exported property of the car with a tooltip: `max_torque` and `max_rpm` (power), `gear_ratios` and `final_drive`, `max_steering_angle`, `front_brake_bias`, `mass`, and `tire_stiffnesses`, `coefficient_of_friction`, and `rolling_resistance` by surface. Change them on the instance before `add_child`, when the car reads them; after a change later, call `car.initialize()`.

For a model of the game's own, keep a preset's physics and swap the meshes: the car's `body` node is a `MeshInstance3D`, and each wheel's mesh sits under its `Wheel` node. Move each `Wheel` to its hub on the new model and set `front_tire_radius` and `rear_tire_radius` to the new wheels, then `car.initialize()`.

## Pitfalls

- It runs at Godot's default 60 physics ticks a second with three of the cars. The monster truck, and any car that jitters or flips, needs `physics/common/physics_ticks_per_second=120` in `project.godot`; handling changes with the tick rate, so tune after choosing it.
- A car set on the ground with code (`car.global_position = …`) keeps its speed: zero `linear_velocity` and `angular_velocity` too.
- Slopes and jumps work on any collider; a curb higher than the suspension travels (0.15 m) stops a wheel.
- Tire smoke by particle sub-emitters, as the add-on's own demo makes it, draws nothing in Web builds; that scene is left out.

## Check it

`godot_run`, hold the throttle with `godot_input` for three seconds, and read `car.speed` with `godot_eval`: above 8 m/s, with the car upright (`car.global_basis.y.y` near 1). Then steer and screenshot: the car leans outward and its wheels turn.
