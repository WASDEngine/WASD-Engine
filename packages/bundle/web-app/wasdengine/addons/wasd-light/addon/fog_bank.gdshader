// SPDX-License-Identifier: CC0-1.0
// Fog that fills a box: mist in a valley, haze in a hall, smoke in a room, steam over a swamp. For every pixel the
// shader works out how far the eye looks through the box before it leaves it or meets something solid, and veils
// the picture by that much, thicker toward the bottom and soft at the sides. It works from inside the box too. It
// stands in for volumetric fog, which Web builds do not draw.
shader_type spatial;
render_mode unshaded, blend_premul_alpha, depth_draw_never, depth_test_disabled, cull_front, shadows_disabled, fog_disabled;

#include "res://addons/wasd_light/light_color.gdshaderinc"

uniform vec3 color : source_color = vec3(0.78, 0.83, 0.88);
// How much a meter of the fog at the box's floor hides, and how fast it thins toward the top (0: even).
uniform float density = 0.08;
uniform float thinning = 3.0;
// How far in from the sides the fog thins out, as a part of the box.
uniform float soft_edges : hint_range(0.0, 0.5) = 0.25;
// Drifting clouds in it: how strong, how large in meters, and how far they have drifted in meters along X and Z.
uniform sampler2D cloud_noise : repeat_enable, filter_linear_mipmap;
uniform float clouds : hint_range(0.0, 1.0) = 0.6;
uniform float cloud_size = 14.0;
uniform vec2 cloud_offset = vec2(0.0);
uniform sampler2D depth_texture : hint_depth_texture, repeat_disable, filter_nearest;

varying flat vec3 local_camera;
varying flat vec3 to_local_x;
varying flat vec3 to_local_y;
varying flat vec3 to_local_z;
varying vec3 world_vertex;

void vertex() {
	mat4 to_local = inverse(MODEL_MATRIX);
	local_camera = (to_local * vec4(CAMERA_POSITION_WORLD, 1.0)).xyz;
	to_local_x = to_local[0].xyz;
	to_local_y = to_local[1].xyz;
	to_local_z = to_local[2].xyz;
	world_vertex = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	// The eye's ray in the world and in the box's own space, where the box reaches from -0.5 to 0.5: a step of one
	// meter along the ray in the world is `local_ray` in the box.
	vec3 world_ray = normalize(world_vertex - CAMERA_POSITION_WORLD);
	vec3 local_ray = mat3(to_local_x, to_local_y, to_local_z) * world_ray;
	vec3 safe_ray = mix(local_ray, vec3(0.00001), lessThan(abs(local_ray), vec3(0.00001)));
	vec3 to_low = (-0.5 - local_camera) / safe_ray;
	vec3 to_high = (0.5 - local_camera) / safe_ray;
	vec3 nearer = min(to_low, to_high);
	vec3 further = max(to_low, to_high);
	float enters = max(max(nearer.x, max(nearer.y, nearer.z)), 0.0);
	float leaves = min(further.x, min(further.y, further.z));
	// What is solid ends the fog there.
	float depth = texture(depth_texture, SCREEN_UV).r;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	vec4 seen = INV_PROJECTION_MATRIX * vec4(vec3(SCREEN_UV, depth) * 2.0 - 1.0, 1.0);
#else
	vec4 seen = INV_PROJECTION_MATRIX * vec4(SCREEN_UV * 2.0 - 1.0, depth, 1.0);
#endif
	leaves = min(leaves, length(seen.xyz / seen.w));
	float through = max(leaves - enters, 0.0);
	// The fog's thickness is taken at the middle of the stretch looked through.
	vec3 middle = local_camera + local_ray * (enters + through * 0.5);
	float by_height = exp(-thinning * clamp(middle.y + 0.5, 0.0, 1.0));
	float by_side = 1.0;
	if (soft_edges > 0.0) {
		by_side = smoothstep(0.0, soft_edges, 0.5 - abs(middle.x)) * smoothstep(0.0, soft_edges, 0.5 - abs(middle.z)) * smoothstep(0.0, soft_edges * 1.6, 0.5 - middle.y);
	}
	float billow = 1.0;
	if (clouds > 0.0) {
		vec3 middle_world = CAMERA_POSITION_WORLD + world_ray * (enters + through * 0.5);
		vec2 at = (middle_world.xz + cloud_offset) / cloud_size;
		// Gathered into banks with thin air between them.
		billow = mix(1.0, smoothstep(0.25, 0.8, texture(cloud_noise, at).r * 0.65 + texture(cloud_noise, at * 2.7 + vec2(0.31, 0.57)).r * 0.35) * 2.2, clouds);
	}
	float hidden = 1.0 - exp(-density * through * by_height * by_side * billow);
	wasd_layer(wasd_to_light(color) * hidden, 1.0 - hidden, FRAGCOORD.xy, ALBEDO, ALPHA);
}
