# SPDX-License-Identifier: CC0-1.0
# A soft round shadow on the ground under whatever this node is a child of: a character, a pickup, a flying enemy. Each
# physics frame it casts a ray down, lies on what the ray hits, and shrinks and fades as its parent rises. It stands in
# for a Decal shadow, which Web builds do not draw, and shows where a jumping character will land.
class_name WasdBlobShadow3D
extends MeshInstance3D

## Width of the shadow in meters while its parent stands on the ground.
@export_range(0.05, 20.0, 0.01) var size := 1.0
## How dark the shadow is at its centre, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var darkness := 0.6
## Height above the ground at which the shadow has faded out, in meters.
@export_range(0.5, 100.0, 0.1) var reach := 8.0
## Physics layers the ground is on.
@export_flags_3d_physics var ground_mask := 1
## Meters the shadow floats above the ground, so the two do not flicker.
@export_range(0.001, 0.1, 0.001) var lift := 0.015

var _material := StandardMaterial3D.new()
# The Compatibility renderer blends colors as the screen shows them; the others blend light itself, where the same
# cover darkens less.
var _blends_as_shown := RenderingServer.get_current_rendering_method() == "gl_compatibility"


func _init() -> void:
	var gradient := Gradient.new()
	gradient.set_color(0, Color(0, 0, 0, 1))
	gradient.set_color(1, Color(0, 0, 0, 0))
	var soft := GradientTexture2D.new()
	soft.gradient = gradient
	soft.fill = GradientTexture2D.FILL_RADIAL
	soft.fill_from = Vector2(0.5, 0.5)
	soft.fill_to = Vector2(1.0, 0.5)
	soft.width = 64
	soft.height = 64
	_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_material.albedo_texture = soft
	_material.render_priority = 1
	var quad := QuadMesh.new()
	quad.orientation = PlaneMesh.FACE_Y
	quad.material = _material
	mesh = quad
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	top_level = true


func _physics_process(_delta: float) -> void:
	var above := get_parent() as Node3D
	if above == null or not above.is_inside_tree():
		visible = false
		return
	var from := above.global_position + Vector3.UP * 0.1
	var query := PhysicsRayQueryParameters3D.create(from, from + Vector3.DOWN * (reach + 0.1), ground_mask)
	var body := above as CollisionObject3D
	if body != null:
		query.exclude = [body.get_rid()]
	var hit := get_world_3d().direct_space_state.intersect_ray(query)
	if hit.is_empty():
		visible = false
		return
	var height := maxf(from.y - 0.1 - (hit["position"] as Vector3).y, 0.0)
	var near := 1.0 - clampf(height / reach, 0.0, 1.0)
	var normal := hit["normal"] as Vector3
	var across := normal.cross(Vector3.RIGHT if absf(normal.x) < 0.9 else Vector3.FORWARD).normalized()
	var width := size * (0.6 + 0.4 * near)
	visible = near > 0.0
	global_transform = Transform3D(Basis(across, normal, across.cross(normal)) * Basis.from_scale(Vector3(width, 1.0, width)), (hit["position"] as Vector3) + normal * lift)
	var cover := darkness * near
	if not _blends_as_shown:
		cover = 1.0 - pow(1.0 - cover, 2.2)
	_material.albedo_color = Color(1, 1, 1, cover)
