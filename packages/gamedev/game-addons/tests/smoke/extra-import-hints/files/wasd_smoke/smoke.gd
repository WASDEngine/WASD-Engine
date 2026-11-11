extends Node3D

# Extra Import Hints smoke: hints.glb (made with Blender 5.2.3) holds Floor-col (Godot's own hint),
# Box-convrigidonly, Crate-rigidonly, and an empty Mallet-rigidonly with a visual mesh and two
# -trueconvcolonly children. The imported scene must hold the node types and shapes the hints promise, and
# the generated RigidBody3D must fall onto the floor and come to rest.

var _failures: PackedStringArray = []


func _check(ok: bool, what: String) -> void:
	if not ok:
		_failures.append(what)


func _ready() -> void:
	await _run()
	if _failures.is_empty():
		print("SMOKE_PASS extra-import-hints")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(_failures))
		get_tree().quit(1)


func _children_of_type(node: Node, type: String) -> Array[Node]:
	var found: Array[Node] = []
	for child in node.get_children():
		if child.is_class(type):
			found.append(child)
	return found


func _shape_of(shape_node: Node) -> String:
	if shape_node is CollisionShape3D and shape_node.shape != null:
		return shape_node.shape.get_class()
	return "none"


func _run() -> void:
	var packed: PackedScene = load("res://wasd_smoke/hints.glb")
	_check(packed != null, "hints.glb did not import")
	if packed == null:
		return
	var model := packed.instantiate()

	# -convrigidonly: RigidBody3D with one convex collider and no mesh.
	var box := model.get_node_or_null("Box") as RigidBody3D
	_check(box != null, "Box is not a RigidBody3D: %s" % model.get_node_or_null("Box"))
	if box != null:
		var shapes := _children_of_type(box, "CollisionShape3D")
		_check(shapes.size() == 1 and _shape_of(shapes[0]) == "ConvexPolygonShape3D", "Box collider is not convex")
		_check(_children_of_type(box, "MeshInstance3D").is_empty(), "Box kept a mesh")

	# -rigidonly: RigidBody3D with one concave (trimesh) collider and no mesh.
	var crate := model.get_node_or_null("Crate") as RigidBody3D
	_check(crate != null, "Crate is not a RigidBody3D: %s" % model.get_node_or_null("Crate"))
	if crate != null:
		var shapes := _children_of_type(crate, "CollisionShape3D")
		_check(shapes.size() == 1 and _shape_of(shapes[0]) == "ConcavePolygonShape3D", "Crate collider is not concave")

	# An empty with -rigidonly keeps its visual child; -trueconvcolonly children become convex colliders.
	var mallet := model.get_node_or_null("Mallet") as RigidBody3D
	_check(mallet != null, "Mallet is not a RigidBody3D: %s" % model.get_node_or_null("Mallet"))
	if mallet != null:
		_check(mallet.get_node_or_null("MalletVisual") is MeshInstance3D, "Mallet lost its visual mesh")
		for collider_name in ["Head_collider", "Handle_collider"]:
			_check(_shape_of(mallet.get_node_or_null(collider_name)) == "ConvexPolygonShape3D", "Mallet/%s is not a convex CollisionShape3D" % collider_name)

	# Godot's own -col hint still works next to the add-on: a mesh with a StaticBody3D child.
	var floor_mesh := model.get_node_or_null("Floor") as MeshInstance3D
	_check(floor_mesh != null, "Floor is not a MeshInstance3D")
	if floor_mesh != null:
		_check(_children_of_type(floor_mesh, "StaticBody3D").size() == 1, "Floor has no StaticBody3D")

	# The generated body is a working physics body: drop the box onto the floor.
	if box == null or floor_mesh == null:
		model.free()
		return
	box.position = Vector3(0, 2, 0)
	if mallet != null:
		mallet.position = Vector3(3, 1, 0)
	if crate != null:
		crate.freeze = true
		crate.position = Vector3(-3, 1, 0)
	add_child(model)
	for frame in 150:
		await get_tree().physics_frame
	_check(box.position.y > 0.2 and box.position.y < 0.35, "box did not land on the floor: y = %s" % box.position.y)
	_check(box.linear_velocity.length() < 0.1, "box is still moving: %s" % box.linear_velocity)
