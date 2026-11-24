# SPDX-License-Identifier: CC0-1.0
# Effects by name, from anywhere in the game: `WasdFx.play("explosion", position)`. The installation adds this
# script as the autoload `WasdFx`. Every effect is a few layers of cards that one shader moves, so there is no
# particle system to set up, nothing to load, and one shader to compile for all of them. Effects that are over go
# back into a store and are used again.
class_name WasdFxLibrary
extends Node

const SHADER := preload("res://addons/wasd_fx/fx.gdshader")
const FLASH_SHADER := preload("res://addons/wasd_fx/thing_flash.gdshader")
const OUTLINE_SHADER := preload("res://addons/wasd_fx/thing_outline.gdshader")
const DISSOLVE_SHADER := preload("res://addons/wasd_fx/thing_dissolve.gdshader")
## Effects of one name kept for use again.
const STORE_SIZE := 16

## How brightly smoke, dust, and other covering particles are lit, from 0 to 1: 1 by day, about 0.25 at night. Left
## at -1, a WasdLook3D in the scene tells it, and without one it is 1.
var light_level := -1.0
## The pull on sparks, debris, and drops, in meters per second squared.
var gravity := Vector3(0.0, -9.8, 0.0)
## The wind in meters a second along the world's axes: smoke, steam, dust, and embers go with it, flames lean, and
## what flies free, such as sparks, does not. WASD Weather sets it; so may the game.
var wind := Vector3.ZERO

var _noise: NoiseTexture2D
var _card := QuadMesh.new()
var _swarms := {}
var _stores := {}
## What flashes and what is outlined now, by the node's instance id: [the meshes, the material, what was over each
## mesh before].
var _flashing := {}
var _outlined := {}


func _init() -> void:
	var source := FastNoiseLite.new()
	source.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	source.frequency = 0.03
	source.fractal_octaves = 3
	_noise = NoiseTexture2D.new()
	_noise.noise = source
	_noise.seamless = true
	_noise.width = 128
	_noise.height = 128
	_noise.generate_mipmaps = true
	_card.size = Vector2.ONE


func _ready() -> void:
	# WASD Weather tells the wind to every node of this group that has a `set_wind`.
	add_to_group(&"wasd_wind")


## The names of the effects.
func names() -> PackedStringArray:
	return WasdFxEffects.names()


func set_wind(value: Vector3) -> void:
	wind = value


## Plays an effect at a place in the world and returns it. A burst ends by itself; an effect that runs on, such as
## "fire" or "smoke", keeps running until the returned node's `stop()`. Options, all optional:
## `normal` (Vector3): the surface's normal or the effect's direction, which the effect's own +Y turns to; up when
## left out. `scale` (float): 1 is the size the effect was made at. `color` (Color): multiplies the effect's
## colors, so a white effect such as "magic" takes it whole. `parent` (Node3D): the effect becomes its child and
## moves with it, as a muzzle flash does with a gun.
func play(effect: String, at: Vector3, options := {}) -> WasdFxInstance3D:
	if not WasdFxEffects.EFFECTS.has(effect):
		push_warning("WasdFx: no effect named %s; the effects are %s." % [effect, ", ".join(names())])
		return null
	var instance := _take(effect)
	var parent: Node = options.get("parent", self)
	if instance.get_parent() != parent:
		if instance.get_parent() != null:
			instance.get_parent().remove_child(instance)
		parent.add_child(instance)
	var normal: Vector3 = options.get("normal", Vector3.UP)
	var size: float = options.get("scale", 1.0)
	var tint: Color = options.get("color", Color.WHITE)
	var up := normal.normalized() if normal.length_squared() > 0.000001 else Vector3.UP
	# The effect's +Y along the normal, with any steady pair of axes beside it.
	var side := up.cross(Vector3.FORWARD if absf(up.dot(Vector3.FORWARD)) < 0.99 else Vector3.RIGHT).normalized()
	instance.global_transform = Transform3D(Basis(side, up, side.cross(up)), at)
	var lit := light_level if light_level >= 0.0 else _scene_light_level()
	var definition: Dictionary = WasdFxEffects.EFFECTS[effect]
	var layers: Array = definition["layers"]
	var to_own := instance.global_basis.inverse()
	for index: int in layers.size():
		var layer: Dictionary = layers[index]
		var material := instance._materials[index]
		var falls: float = layer.get("gravity", 0.0)
		var rises: float = layer.get("rise", 0.0)
		material.set_shader_parameter(&"pull", to_own * (gravity * falls - gravity.normalized() * rises * size))
		material.set_shader_parameter(&"wind", to_own * wind)
		material.set_shader_parameter(&"scale", size)
		material.set_shader_parameter(&"tint", tint)
		material.set_shader_parameter(&"variation", randf())
		material.set_shader_parameter(&"light_level", lit)
		material.set_shader_parameter(&"age", 0.0)
		material.set_shader_parameter(&"fade", 1.0)
		# The box the layer is drawn within: wide enough for the effect, and for how far the wind carries it.
		(instance.get_child(index) as MultiMeshInstance3D).custom_aabb = AABB(Vector3.ONE * -16.0 * size, Vector3.ONE * 32.0 * size).grow(wind.length() * float(layer.get("carried", 0.0)) * float(layer.get("life", 1.0)))
	if instance._light != null:
		var light: Dictionary = definition["light"]
		instance._light.light_color = (light["color"] as Color) * Color(tint.r, tint.g, tint.b)
		instance._light.omni_range = float(light["range"]) * size
		instance._light.position = Vector3(0.0, float(light.get("height", 0.2)) * size, 0.0)
		instance._light_energy = light["energy"]
		instance._light_seconds = light.get("seconds", 1.0)
		instance._light.light_energy = instance._light_energy
		instance._light.visible = true
	instance.age = 0.0
	instance._fade = 1.0
	instance._fade_seconds = 0.0
	instance._library = self
	instance._wind = wind
	instance.visible = true
	instance.set_process(true)
	return instance


## Flashes a thing in one color, as when it is hit: every mesh and CSG shape under `node`, `node` included, for
## `seconds`. A second flash before the first is over starts it again.
func flash(node: Node, color := Color.WHITE, seconds := 0.12) -> void:
	var id := node.get_instance_id()
	if not _flashing.has(id):
		var material := ShaderMaterial.new()
		material.shader = FLASH_SHADER
		_flashing[id] = _cover(node, material)
	var now: Array = _flashing[id]
	var over := now[1] as ShaderMaterial
	over.set_shader_parameter(&"color", color)
	over.set_shader_parameter(&"strength", 1.0)
	if now.size() > 3 and now[3] is Tween:
		(now[3] as Tween).kill()
	var fade := create_tween()
	fade.tween_property(over, ^"shader_parameter/strength", 0.0, maxf(seconds, 0.01)).set_ease(Tween.EASE_IN)
	fade.tween_callback(func() -> void:
		_uncover(_flashing.get(id, []))
		_flashing.erase(id))
	now.resize(4)
	now[3] = fade


## Draws an outline of `width` pixels round a thing: what the player aims at, has selected, or can pick up. It
## stays until `clear_outline(node)`. It wants smooth normals; on a plain box the line opens at the corners.
func outline(node: Node, color := Color(1.0, 0.85, 0.3), width := 3.0) -> void:
	var id := node.get_instance_id()
	if not _outlined.has(id):
		var material := ShaderMaterial.new()
		material.shader = OUTLINE_SHADER
		_outlined[id] = _cover(node, material)
	var over := (_outlined[id] as Array)[1] as ShaderMaterial
	over.set_shader_parameter(&"color", color)
	over.set_shader_parameter(&"width", width)


## Takes the outline off a thing again.
func clear_outline(node: Node) -> void:
	var id := node.get_instance_id()
	_uncover(_outlined.get(id, []))
	_outlined.erase(id)


## Dissolves a thing away over `seconds`: it is eaten in patches with a glowing edge, as a defeated enemy or a
## spent pickup goes. Await it; the thing is hidden at the end and, with `free` true, freed. For the seconds it
## takes, each mesh wears a plain material in its own color and picture. Options: `color` (Color): the edge's
## glow; `patch_size` (float, 1.0): meters across the patches; `free` (bool, false).
func dissolve(node: Node, seconds := 0.8, options := {}) -> void:
	var worn := _wear_dissolve(node, options)
	for material: ShaderMaterial in worn:
		material.set_shader_parameter(&"gone", 0.0)
		create_tween().tween_property(material, ^"shader_parameter/gone", 1.0, seconds)
	await get_tree().create_timer(seconds).timeout
	if not is_instance_valid(node):
		return
	if node is Node3D:
		(node as Node3D).visible = false
	_restore_dissolve(node)
	if options.get("free", false):
		node.queue_free()


## The other way round: a hidden thing appears out of nothing over `seconds`, with the same glowing edge, and
## wears its own materials again at the end. Await it.
func appear(node: Node, seconds := 0.8, options := {}) -> void:
	var worn := _wear_dissolve(node, options)
	for material: ShaderMaterial in worn:
		material.set_shader_parameter(&"gone", 1.0)
		create_tween().tween_property(material, ^"shader_parameter/gone", 0.0, seconds)
	if node is Node3D:
		(node as Node3D).visible = true
	await get_tree().create_timer(seconds).timeout
	if is_instance_valid(node):
		_restore_dissolve(node)


## Puts a material over every mesh and CSG shape under a node and returns [the meshes, the material, what was
## over each before].
func _cover(node: Node, material: Material) -> Array:
	var meshes: Array[GeometryInstance3D] = []
	var before: Array = []
	for part: Node in [node] + node.find_children("*", "GeometryInstance3D", true, false):
		if part is MeshInstance3D or part is CSGShape3D:
			var mesh := part as GeometryInstance3D
			meshes.append(mesh)
			before.append(mesh.material_overlay)
			mesh.material_overlay = material
	return [meshes, material, before]


## Gives every mesh back what was over it, unless something else has taken the place since.
func _uncover(covered: Array) -> void:
	if covered.is_empty():
		return
	var meshes: Array = covered[0]
	for index: int in meshes.size():
		var mesh: GeometryInstance3D = meshes[index]
		if is_instance_valid(mesh) and mesh.material_overlay == covered[1]:
			mesh.material_overlay = (covered[2] as Array)[index]


## Gives every surface under a node the dissolving material in that surface's own color and picture, and returns
## the materials. What the surfaces wore before is kept on the node, for _restore_dissolve().
func _wear_dissolve(node: Node, options: Dictionary) -> Array[ShaderMaterial]:
	var worn: Array[ShaderMaterial] = []
	var kept: Array = []
	for part: Node in [node] + node.find_children("*", "MeshInstance3D", true, false):
		var mesh := part as MeshInstance3D
		if mesh == null or mesh.mesh == null:
			continue
		for surface: int in mesh.mesh.get_surface_count():
			var own := mesh.get_active_material(surface)
			var material := ShaderMaterial.new()
			material.shader = DISSOLVE_SHADER
			material.set_shader_parameter(&"noise", _noise)
			material.set_shader_parameter(&"edge_color", options.get("color", Color(1.0, 0.55, 0.15)))
			material.set_shader_parameter(&"patch_size", options.get("patch_size", 1.0))
			var bounds := mesh.mesh.get_aabb()
			material.set_shader_parameter(&"span", Vector2(bounds.position.y, bounds.end.y))
			if own is BaseMaterial3D:
				material.set_shader_parameter(&"color", (own as BaseMaterial3D).albedo_color)
				material.set_shader_parameter(&"picture", (own as BaseMaterial3D).albedo_texture)
				material.set_shader_parameter(&"roughness", (own as BaseMaterial3D).roughness)
			elif own is ShaderMaterial:
				# A shader of another make: its color and picture by the names such shaders commonly give them.
				for name: StringName in [&"color", &"albedo", &"albedo_color", &"tint"]:
					var value: Variant = (own as ShaderMaterial).get_shader_parameter(name)
					if value is Color:
						material.set_shader_parameter(&"color", value)
						break
				for name: StringName in [&"picture", &"texture_albedo", &"albedo_texture"]:
					var value: Variant = (own as ShaderMaterial).get_shader_parameter(name)
					if value is Texture2D:
						material.set_shader_parameter(&"picture", value)
						break
			kept.append([mesh, surface, mesh.get_surface_override_material(surface), mesh.material_override])
			mesh.set_surface_override_material(surface, material)
			worn.append(material)
		mesh.material_override = null
	node.set_meta(&"wasd_fx_dissolve", kept)
	return worn


func _restore_dissolve(node: Node) -> void:
	for entry: Array in node.get_meta(&"wasd_fx_dissolve", []):
		var mesh: MeshInstance3D = entry[0]
		if is_instance_valid(mesh):
			mesh.set_surface_override_material(entry[1], entry[2])
			mesh.material_override = entry[3]
	node.remove_meta(&"wasd_fx_dissolve")


## Draws every effect once, tiny and for a moment, before the camera that draws the scene, so that the one shader
## they share is compiled before the first real effect: `await WasdFx.warm_up()` behind a loading screen. Without it
## the first effect of a game can stall a frame, most of all in a Web build.
func warm_up() -> void:
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		return
	var before := camera.global_position - camera.global_basis.z * (camera.near + 1.0)
	var shown: Array[WasdFxInstance3D] = []
	for effect: String in ["sparks", "impact", "splash"]:
		var instance := play(effect, before, {"scale": 0.02})
		if instance != null:
			shown.append(instance)
	# The flash, the outline, and the dissolve are shaders of their own: a speck of each is drawn too.
	var specks: Array[MeshInstance3D] = []
	for shader: Shader in [FLASH_SHADER, OUTLINE_SHADER, DISSOLVE_SHADER]:
		var speck := MeshInstance3D.new()
		var quad := QuadMesh.new()
		quad.size = Vector2.ONE * 0.002
		var material := ShaderMaterial.new()
		material.shader = shader
		material.set_shader_parameter(&"noise", _noise)
		quad.material = material
		speck.mesh = quad
		add_child(speck)
		speck.global_position = before
		specks.append(speck)
	await get_tree().process_frame
	await get_tree().process_frame
	for speck: MeshInstance3D in specks:
		speck.queue_free()
	for instance: WasdFxInstance3D in shown:
		instance.age = 100.0


## An effect from the store, or a new one.
func _take(effect: String) -> WasdFxInstance3D:
	var store: Array = _stores.get_or_add(effect, [])
	while not store.is_empty():
		var kept: WasdFxInstance3D = store.pop_back()
		if is_instance_valid(kept):
			return kept
	var definition: Dictionary = WasdFxEffects.EFFECTS[effect]
	var instance := WasdFxInstance3D.new()
	instance.effect = effect
	instance.looping = definition.get("looping", false)
	var longest := 0.0
	for layer_changes: Dictionary in definition["layers"]:
		var layer: Dictionary = WasdFxEffects.LAYER.duplicate()
		layer.merge(layer_changes, true)
		var material := ShaderMaterial.new()
		material.shader = SHADER
		material.set_shader_parameter(&"noise", _noise)
		material.set_shader_parameter(&"looping", instance.looping)
		# Later layers draw over earlier ones: smoke over the fire it comes from.
		material.render_priority = instance._materials.size()
		for key: StringName in [&"life", &"delay", &"spawn_over", &"shape", &"spread", &"radius", &"offset", &"speed", &"drag", &"wobble", &"carried", &"size", &"size_variance", &"stretch", &"spin", &"lies_flat", &"look",
				&"color_start", &"color_mid", &"color_end", &"mid_at", &"energy", &"rainbow", &"through", &"self_lit"]:
			material.set_shader_parameter(key, layer[key])
		var cards := MultiMeshInstance3D.new()
		cards.multimesh = _swarm(layer["count"])
		cards.material_override = material
		cards.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		instance.add_child(cards)
		instance._materials.append(material)
		longest = maxf(longest, float(layer["life"]) + float(layer["delay"]) + float(layer["spawn_over"]))
	instance._seconds = longest
	if definition.has("light"):
		instance._light = OmniLight3D.new()
		instance._light.shadow_enabled = false
		instance.add_child(instance._light)
	instance.finished.connect(_keep.bind(instance))
	return instance


## Takes an effect that is over back into the store.
func _keep(instance: WasdFxInstance3D) -> void:
	var store: Array = _stores.get_or_add(instance.effect, [])
	if store.size() < STORE_SIZE:
		store.append(instance)
	else:
		instance.queue_free()


## The cards of a layer of `count` particles: one mesh for every layer of that count, each card with four random
## numbers that the shader makes its flight from.
func _swarm(count: int) -> MultiMesh:
	if _swarms.has(count):
		return _swarms[count]
	var swarm := MultiMesh.new()
	swarm.transform_format = MultiMesh.TRANSFORM_3D
	swarm.use_custom_data = true
	swarm.mesh = _card
	swarm.instance_count = count
	var random := RandomNumberGenerator.new()
	random.seed = 7919 + count
	for index: int in count:
		swarm.set_instance_transform(index, Transform3D.IDENTITY)
		swarm.set_instance_custom_data(index, Color(random.randf(), random.randf(), random.randf(), (index + random.randf()) / count))
	_swarms[count] = swarm
	return swarm


## How brightly the scene is lit, as a WasdLook3D in it tells, or 1.
func _scene_light_level() -> float:
	for look: Node in get_tree().get_nodes_in_group(&"wasd_look"):
		if look.has_method(&"get_light_level"):
			return look.call(&"get_light_level")
	return 1.0
