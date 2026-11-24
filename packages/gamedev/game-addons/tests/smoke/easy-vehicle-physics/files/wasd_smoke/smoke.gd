extends Node3D
## Easy Vehicle Physics smoke test (render run on the Compatibility renderer): the four cars drive forward on the
## throttle, on a ground that is in a group of the level's own and in "Road"; the arcade car steers, brakes to a
## stop, reverses the way the guide's input lines do, and reports its speed, gear, and wheels; a car on "Grass"
## reads that surface, and back on a ground in no surface group the road's; the engine sound follows its car; and the
## cars show in the picture.

const ID := "easy-vehicle-physics"
const CARS := ["arcade_car", "simcade_car", "drift_car", "monster_truck"]

## What a player holds: forward, back, and steering from -1 (right) to 1 (left).
var held_forward := 0.0
var held_back := 0.0
var held_steer := 0.0


func _ready() -> void:
	get_tree().create_timer(120.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


## The guide's input lines: in reverse gear the two pedals change places.
func _drive(car: Vehicle) -> void:
	car.steering_input = held_steer
	if car.current_gear == -1:
		car.throttle_input = held_back
		car.brake_input = held_forward
	else:
		car.throttle_input = held_forward
		car.brake_input = held_back


func _seconds(car: Vehicle, seconds: float) -> void:
	for _i: int in int(seconds * Engine.physics_ticks_per_second):
		_drive(car)
		await get_tree().physics_frame


func _ground(at: Vector3, groups: Array[String]) -> void:
	var ground := StaticBody3D.new()
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(400, 1, 400)
	shape.shape = box
	ground.add_child(shape)
	var mesh := MeshInstance3D.new()
	var cube := BoxMesh.new()
	cube.size = Vector3(400, 1, 400)
	mesh.mesh = cube
	ground.add_child(mesh)
	ground.position = at + Vector3.DOWN * 0.5
	for group: String in groups:
		ground.add_to_group(group)
	add_child(ground)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	Engine.physics_ticks_per_second = 120
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.2, 0.5, 0.9)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	add_child(world)
	var camera := Camera3D.new()
	camera.position = Vector3(9, 3, 9)
	add_child(camera)
	# A ground whose first group is the level's own, as levels often have, and that is a road.
	_ground(Vector3.ZERO, ["level_ground", "Road"])
	_ground(Vector3(1000, 0, 0), ["Grass"])
	# A ground in a group of the level's own only, which names no surface.
	_ground(Vector3(2000, 0, 0), ["level_floor"])
	var cars: Array[Vehicle] = []
	for index: int in CARS.size():
		var car := (load("res://addons/gevp/scenes/%s.tscn" % [CARS[index]]) as PackedScene).instantiate() as Vehicle
		if car == null:
			return _fail("%s.tscn is not a Vehicle" % [CARS[index]])
		car.position = Vector3(index * 6.0, 1.0, 0)
		add_child(car)
		cars.append(car)
	camera.look_at(Vector3(9, 0.5, 0))
	for _i: int in 60:
		await get_tree().physics_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/cars.png"))
	# The cars are neither the sky's blue nor the ground's white.
	var painted := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			var sky := absf(pixel.r - 0.2) + absf(pixel.g - 0.5) + absf(pixel.b - 0.9) < 0.2
			if not sky and maxf(pixel.r, maxf(pixel.g, pixel.b)) - minf(pixel.r, minf(pixel.g, pixel.b)) > 0.25:
				painted += 1
	if painted < 600:
		return _fail("the picture has %d samples of the cars' paint" % [painted])
	for car: Vehicle in cars:
		if car.wheel_array.size() != 4 or absf(car.global_position.y) > 0.8 or car.global_basis.y.y < 0.95:
			return _fail("%s rests at %s with %d wheels" % [car.name, car.global_position, car.wheel_array.size()])
		if car.wheel_array[0].surface_type != "Road":
			return _fail("a wheel on a ground in the groups level_ground and Road reads the surface %s" % [car.wheel_array[0].surface_type])

	# Full throttle for five seconds: every car drives forward, along its -Z, and stays upright.
	for car: Vehicle in cars:
		car.throttle_input = 1.0
	for _i: int in 5 * Engine.physics_ticks_per_second:
		await get_tree().physics_frame
	for index: int in cars.size():
		var car := cars[index]
		# The monster truck rears up under full throttle; the others stay level.
		var level := 0.5 if CARS[index] == "monster_truck" else 0.9
		if car.global_position.z > -25.0 or car.speed < 8.0 or car.global_basis.y.y < level or car.current_gear < 1:
			return _fail("%s is at %s at %.1f m/s in gear %d, upright %.2f, after five seconds of throttle" % [CARS[index], car.global_position, car.speed, car.current_gear, car.global_basis.y.y])
		if index > 0:
			car.throttle_input = 0.0
			car.brake_input = 1.0

	# The arcade car, driven by the guide's input lines: it steers left, brakes to a stop, reverses, and drives on.
	var arcade := cars[0]
	held_forward = 0.4
	held_steer = 1.0
	var heading := arcade.global_rotation.y
	await _seconds(arcade, 2.0)
	if angle_difference(heading, arcade.global_rotation.y) < 0.3:
		return _fail("steering left turned the arcade car by %.2f rad" % [angle_difference(heading, arcade.global_rotation.y)])
	held_forward = 0.0
	held_steer = 0.0
	held_back = 1.0
	await _seconds(arcade, 4.0)
	if arcade.speed > 3.0 and arcade.current_gear != -1:
		return _fail("the arcade car still moves at %.1f m/s after four seconds of braking" % [arcade.speed])
	# Holding back at rest shifts into reverse and drives backward.
	await _seconds(arcade, 3.0)
	var backward := arcade.linear_velocity.dot(arcade.global_basis.z)
	if arcade.current_gear != -1 or backward < 1.0:
		return _fail("holding back at rest left gear %d and %.1f m/s backward" % [arcade.current_gear, backward])
	# Holding forward stops it and drives on forward.
	held_back = 0.0
	held_forward = 1.0
	await _seconds(arcade, 5.0)
	var onward := arcade.linear_velocity.dot(-arcade.global_basis.z)
	if arcade.current_gear < 1 or onward < 3.0:
		return _fail("holding forward out of reverse left gear %d and %.1f m/s forward" % [arcade.current_gear, onward])
	if arcade.motor_rpm < 500.0:
		return _fail("the motor turns at %.0f rpm" % [arcade.motor_rpm])

	# A car on a ground in the group Grass reads that surface, with less grip than the road's.
	var rally := (load("res://addons/gevp/scenes/simcade_car.tscn") as PackedScene).instantiate() as Vehicle
	rally.position = Vector3(1000, 1.0, 0)
	add_child(rally)
	var sound := (load("res://addons/gevp/scenes/engine_sound.tscn") as PackedScene).instantiate() as AudioStreamPlayer3D
	sound.set(&"vehicle", rally)
	rally.add_child(sound)
	rally.throttle_input = 1.0
	for _i: int in 2 * Engine.physics_ticks_per_second:
		await get_tree().physics_frame
	if rally.wheel_array[0].surface_type != "Grass" or rally.wheel_array[0].current_cof >= arcade.wheel_array[0].current_cof:
		return _fail("on grass a wheel reads %s with grip %.2f, against %.2f on the road" % [rally.wheel_array[0].surface_type, rally.wheel_array[0].current_cof, arcade.wheel_array[0].current_cof])
	if absf(sound.pitch_scale - rally.motor_rpm / 4000.0) > 0.05:
		return _fail("the engine sound plays at %.2f for a motor at %.0f rpm" % [sound.pitch_scale, rally.motor_rpm])

	# Set down as the guide says on the ground that names no surface, the car lands upright and drives like on the road
	# again, although the simcade car names Dirt first among its surfaces.
	rally.throttle_input = 0.0
	rally.global_position = Vector3(2000, 1.0, 0)
	rally.linear_velocity = Vector3.ZERO
	rally.angular_velocity = Vector3.ZERO
	rally.previous_global_position = rally.global_position
	for wheel: Wheel in rally.wheel_array:
		wheel.previous_global_position = wheel.global_position
	var highest := rally.global_position.y
	for _i: int in Engine.physics_ticks_per_second:
		await get_tree().physics_frame
		highest = maxf(highest, rally.global_position.y)
	if highest > 1.5 or rally.global_basis.y.y < 0.95:
		return _fail("a car set down 1 m above the ground rose to %.1f m and is upright %.2f" % [highest, rally.global_basis.y.y])
	var road_cof: float = rally.coefficient_of_friction["Road"]
	if rally.wheel_array[0].surface_type != "Road" or not is_equal_approx(rally.wheel_array[0].current_cof, road_cof):
		return _fail("on a ground that names no surface a wheel reads %s with grip %.2f, against the road's %.2f" % [rally.wheel_array[0].surface_type, rally.wheel_array[0].current_cof, road_cof])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
