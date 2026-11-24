# SPDX-License-Identifier: CC0-1.0
# Bakes an animated, skinned model into a WasdCrowdData: it plays each clip, works out where every vertex of the
# model's skinned meshes is at each frame, and writes those places and normals into two textures. The game then needs
# no skeleton and no animation player for the crowd. Baking takes seconds to a minute and belongs to making the game,
# not to running it: bake_crowd.gd runs it from godot_script and saves the result as a file.
class_name WasdCrowdBaker
extends RefCounted

const SHADER := preload("res://addons/wasd_crowd/crowd.gdshader")
## Widest texture a bake makes; a model of more vertices takes several rows a frame.
const WIDEST := 2048


## Bakes `clips` of the model under `root` at `fps` frames a second; the model need not be in the scene tree.
## `player` is the animation player that holds the clips; without one the first under `root` is used. Returns null,
## with an error printed, when the model has no skinned mesh or none of the clips.
static func bake(root: Node3D, clips: PackedStringArray, fps := 15.0, player: AnimationPlayer = null) -> WasdCrowdData:
	var skeleton := _first(root, "Skeleton3D") as Skeleton3D
	if skeleton == null:
		push_error("WasdCrowdBaker: %s has no Skeleton3D." % [root.name])
		return null
	if player == null:
		player = _first(root, "AnimationPlayer") as AnimationPlayer
	if player == null:
		push_error("WasdCrowdBaker: %s has no AnimationPlayer; hand one to bake()." % [root.name])
		return null
	var parts: Array[Dictionary] = []
	var total := 0
	for node: Node in _all(root, "MeshInstance3D"):
		var instance := node as MeshInstance3D
		if instance.skin == null or instance.mesh == null or not instance.visible:
			continue
		var binds: Array[int] = []
		var poses: Array[Transform3D] = []
		for bind: int in instance.skin.get_bind_count():
			var bone := instance.skin.get_bind_bone(bind)
			if bone < 0:
				bone = skeleton.find_bone(instance.skin.get_bind_name(bind))
			binds.append(bone)
			poses.append(instance.skin.get_bind_pose(bind))
		for surface: int in instance.mesh.get_surface_count():
			var arrays := instance.mesh.surface_get_arrays(surface)
			var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			if arrays[Mesh.ARRAY_BONES] == null or arrays[Mesh.ARRAY_WEIGHTS] == null or vertices.is_empty():
				continue
			parts.append({"arrays": arrays, "binds": binds, "poses": poses, "first": total, "material": instance.get_active_material(surface),
				"name": "%s_%d" % [instance.name, surface],
				"each": (arrays[Mesh.ARRAY_BONES] as PackedInt32Array).size() / vertices.size()})
			total += vertices.size()
	if parts.is_empty():
		push_error("WasdCrowdBaker: %s has no skinned mesh." % [root.name])
		return null

	var data := WasdCrowdData.new()
	var table := {}
	var frames := 0
	for clip: String in clips:
		if not player.has_animation(clip):
			push_warning("WasdCrowdBaker: %s has no clip named %s. Its clips: %s." % [root.name, clip, ", ".join(player.get_animation_list())])
			continue
		var length := player.get_animation(clip).length
		var count := maxi(roundi(length * fps), 2)
		var short := clip.get_slice("/", clip.get_slice_count("/") - 1)
		table[short] = {"start": frames, "frames": count, "fps": count / length, "length": length, "clip": clip}
		frames += count
	if table.is_empty():
		push_error("WasdCrowdBaker: none of the clips %s are in %s." % [clips, root.name])
		return null
	data.vertices = total
	data.width = mini(total, WIDEST)
	data.rows = ceili(float(total) / data.width)
	var height := data.rows * frames
	var places := PackedFloat32Array()
	places.resize(data.width * height * 4)
	var facings := PackedFloat32Array()
	facings.resize(data.width * height * 4)
	# The skeleton's place within the model, by its parents' transforms: the model need not be in the scene tree.
	var to_root := Transform3D.IDENTITY
	var step: Node = skeleton
	while step != null and step != root:
		if step is Node3D:
			to_root = (step as Node3D).transform * to_root
		step = step.get_parent()
	var low := Vector3.INF
	var high := -Vector3.INF
	var was_playing := player.current_animation
	# Each bone's place in the skeleton at a frame, from the poses the clip gives the bones, parents first: a skeleton
	# outside the scene tree, as the model is in bake_crowd.gd's _initialize(), works out its bones' places once and
	# keeps them, whatever the clip does.
	var order := _bone_order(skeleton)
	var placed: Array[Transform3D] = []
	placed.resize(skeleton.get_bone_count())
	for short: String in table:
		var entry: Dictionary = table[short]
		player.play(entry["clip"])
		for frame: int in entry["frames"]:
			player.seek(frame / float(entry["fps"]), true)
			for bone: int in order:
				var own := skeleton.get_bone_pose(bone) if skeleton.is_bone_enabled(bone) and not skeleton.show_rest_only else skeleton.get_bone_rest(bone)
				var parent := skeleton.get_bone_parent(bone)
				placed[bone] = placed[parent] * own if parent >= 0 else own
			var line: int = (int(entry["start"]) + frame) * data.rows * data.width * 4
			for part: Dictionary in parts:
				var binds: Array[int] = part["binds"]
				var poses: Array[Transform3D] = part["poses"]
				# Where each of the mesh's joints carries a vertex at this frame, in the model's own space.
				var carry: Array[Transform3D] = []
				for bind: int in binds.size():
					carry.append(to_root * placed[binds[bind]] * poses[bind] if binds[bind] >= 0 else to_root)
				var arrays: Array = part["arrays"]
				var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
				var normal_list: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL] if arrays[Mesh.ARRAY_NORMAL] != null else PackedVector3Array()
				var bones: PackedInt32Array = arrays[Mesh.ARRAY_BONES]
				var weights: PackedFloat32Array = arrays[Mesh.ARRAY_WEIGHTS]
				var each: int = part["each"]
				var at: int = line + int(part["first"]) * 4
				for vertex: int in vertices.size():
					var place := Vector3.ZERO
					var facing := Vector3.ZERO
					var rest := vertices[vertex]
					var normal := normal_list[vertex] if not normal_list.is_empty() else Vector3.UP
					for slot: int in each:
						var weight := weights[vertex * each + slot]
						if weight <= 0.0:
							continue
						var joint := carry[bones[vertex * each + slot]]
						place += (joint * rest) * weight
						facing += (joint.basis * normal) * weight
					places[at] = place.x
					places[at + 1] = place.y
					places[at + 2] = place.z
					places[at + 3] = 1.0
					facing = facing.normalized()
					facings[at] = facing.x
					facings[at + 1] = facing.y
					facings[at + 2] = facing.z
					facings[at + 3] = 1.0
					at += 4
					low = low.min(place)
					high = high.max(place)
	if was_playing != "":
		player.play(was_playing)
	else:
		player.stop()
	for short: String in table:
		(table[short] as Dictionary).erase("clip")
	data.clips = table
	data.bounds = AABB(low, high - low)
	for pair: Array in [["positions", places], ["normals", facings]]:
		var image := Image.create_from_data(data.width, height, false, Image.FORMAT_RGBAF, (pair[1] as PackedFloat32Array).to_byte_array())
		image.convert(Image.FORMAT_RGBAH)
		data.set(pair[0], ImageTexture.create_from_image(image))

	# The mesh: every surface as it was, without its bones, and with each vertex's column and row in the second UV map.
	var mesh := ArrayMesh.new()
	for part: Dictionary in parts:
		var source: Array = part["arrays"]
		var arrays := []
		arrays.resize(Mesh.ARRAY_MAX)
		for kind: int in [Mesh.ARRAY_VERTEX, Mesh.ARRAY_NORMAL, Mesh.ARRAY_TANGENT, Mesh.ARRAY_COLOR, Mesh.ARRAY_TEX_UV, Mesh.ARRAY_INDEX]:
			arrays[kind] = source[kind]
		var count: int = (source[Mesh.ARRAY_VERTEX] as PackedVector3Array).size()
		var where := PackedVector2Array()
		where.resize(count)
		for vertex: int in count:
			var index: int = int(part["first"]) + vertex
			where[vertex] = Vector2((index % data.width + 0.5) / data.width, (index / data.width + 0.5) / data.rows)
		arrays[Mesh.ARRAY_TEX_UV2] = where
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		mesh.surface_set_name(mesh.get_surface_count() - 1, part["name"])
		mesh.surface_set_material(mesh.get_surface_count() - 1, _material(part["material"], data))
	mesh.custom_aabb = data.bounds
	data.mesh = mesh
	return data


## The crowd's material for one surface, with the look of the model's own material.
static func _material(source: Material, data: WasdCrowdData) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = SHADER
	material.set_shader_parameter(&"positions", data.positions)
	material.set_shader_parameter(&"normals", data.normals)
	material.set_shader_parameter(&"width", data.width)
	material.set_shader_parameter(&"rows", data.rows)
	var standard := source as BaseMaterial3D
	if standard != null:
		material.set_shader_parameter(&"albedo", standard.albedo_color)
		material.set_shader_parameter(&"albedo_texture", standard.albedo_texture)
		material.set_shader_parameter(&"roughness", standard.roughness)
		material.set_shader_parameter(&"metallic", standard.metallic)
		if standard.transparency != BaseMaterial3D.TRANSPARENCY_DISABLED:
			material.set_shader_parameter(&"alpha_cut", 0.4)
	if material.get_shader_parameter(&"albedo_texture") == null:
		var white := Image.create(4, 4, false, Image.FORMAT_RGBA8)
		white.fill(Color.WHITE)
		material.set_shader_parameter(&"albedo_texture", ImageTexture.create_from_image(white))
	return material


## The skeleton's bones, each after its parent.
static func _bone_order(skeleton: Skeleton3D) -> PackedInt32Array:
	var order := PackedInt32Array()
	var count := skeleton.get_bone_count()
	var listed := {}
	for bone: int in count:
		var chain := PackedInt32Array()
		var step := bone
		while step >= 0 and not listed.has(step) and chain.size() < count:
			chain.append(step)
			step = skeleton.get_bone_parent(step)
		chain.reverse()
		for link: int in chain:
			listed[link] = true
			order.append(link)
	return order


static func _first(under: Node, kind: String) -> Node:
	for child: Node in under.get_children():
		if child.is_class(kind):
			return child
		var deeper := _first(child, kind)
		if deeper != null:
			return deeper
	return null


static func _all(under: Node, kind: String) -> Array[Node]:
	var found: Array[Node] = []
	for child: Node in under.get_children():
		if child.is_class(kind):
			found.append(child)
		found.append_array(_all(child, kind))
	return found
