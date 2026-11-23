extends Node3D
## VoronoiShatter smoke test: the generator, used from game code without the editor plugin, cuts a box and a torus into
## Voronoi pieces whose meshes together fill the original's bounds, with inner faces as surface 0; the pieces become
## rigid bodies that fall onto a floor and stay above it.

const ID := "voronoi-shatter"


func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


## Cut a mesh instance into pieces, as the guide's shatter() does, and return the bodies.
func _shatter(generator: VoronoiGenerator, target: MeshInstance3D, samples: int) -> Array[RigidBody3D]:
	var config := VoronoiGeneratorConfig.new()
	config.random_seed = 7
	config.num_samples = samples
	var bodies: Array[RigidBody3D] = []
	for piece: VoronoiMesh in generator.create_from_mesh(target, config):
		var body := RigidBody3D.new()
		var mesh := MeshInstance3D.new()
		mesh.mesh = piece.mesh
		var shape := CollisionShape3D.new()
		shape.shape = piece.mesh.create_convex_shape()
		body.add_child(mesh)
		body.add_child(shape)
		add_child(body)
		body.global_transform = target.global_transform * Transform3D(Basis.IDENTITY, -piece.position)
		bodies.append(body)
		piece.free()
	config.free()
	return bodies


func _bounds(bodies: Array[RigidBody3D]) -> AABB:
	var bounds := AABB()
	var first := true
	for body: RigidBody3D in bodies:
		var mesh := body.get_child(0) as MeshInstance3D
		var box := body.global_transform * mesh.mesh.get_aabb()
		bounds = box if first else bounds.merge(box)
		first = false
	return bounds


func _run() -> void:
	var floor_body := StaticBody3D.new()
	var floor_shape := CollisionShape3D.new()
	var floor_box := BoxShape3D.new()
	floor_box.size = Vector3(30, 1, 30)
	floor_shape.shape = floor_box
	floor_body.add_child(floor_shape)
	floor_body.position = Vector3(0, -0.5, 0)
	add_child(floor_body)

	var generator := VoronoiGenerator.new()
	add_child(generator)

	var crate := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = Vector3(1.0, 1.5, 0.6)
	crate.mesh = box
	crate.position = Vector3(2, 1.5, -1)
	crate.rotation_degrees = Vector3(0, 30, 0)
	add_child(crate)
	var ring := MeshInstance3D.new()
	var torus := TorusMesh.new()
	torus.inner_radius = 0.3
	torus.outer_radius = 0.6
	ring.mesh = torus
	ring.position = Vector3(-2, 1.0, 0)
	add_child(ring)
	await get_tree().physics_frame

	for target: MeshInstance3D in [crate, ring]:
		var bodies := _shatter(generator, target, 16)
		if bodies.size() < 8:
			return _fail("%d pieces from 16 samples" % [bodies.size()])
		for body: RigidBody3D in bodies:
			var mesh := (body.get_child(0) as MeshInstance3D).mesh
			if mesh.get_surface_count() < 1 or mesh.get_aabb().size.length() < 0.001:
				return _fail("a piece without geometry")
		var original := target.global_transform * target.mesh.get_aabb()
		var pieces := _bounds(bodies)
		if pieces.position.distance_to(original.position) > 0.08 or pieces.end.distance_to(original.end) > 0.08:
			return _fail("the pieces span %s, the original %s" % [pieces, original])
		target.queue_free()
		for _i: int in 90:
			await get_tree().physics_frame
		for body: RigidBody3D in bodies:
			var at := body.global_position
			if not is_finite(at.length()) or at.y < -0.5:
				return _fail("a piece at %s after the fall" % [at])
		if _bounds(bodies).position.y > 0.3:
			return _fail("the pieces did not fall to the floor")
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
