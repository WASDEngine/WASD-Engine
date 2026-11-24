// SPDX-License-Identifier: CC0-1.0
// A shaft of light in dusty air: the beam of a spotlight, sun through a window or between trees. For every pixel the
// shader works out the stretch of the eye's line that lies inside the shaft and before anything solid, and adds
// the light of the dust along it: most in the shaft's middle and near its source, none outside. So the shaft looks
// like lit air from any side and from within. No light is cast: pair it with a real light.
shader_type spatial;
render_mode unshaded, blend_premul_alpha, depth_draw_never, depth_test_disabled, cull_front, shadows_disabled, fog_disabled;

#include "res://addons/wasd_light/light_color.gdshaderinc"

uniform vec3 color : source_color = vec3(1.0, 0.93, 0.78);
uniform float energy = 0.3;
// The shaft's shape in its own space, where it runs along -Z from its source: its length, half its width and
// height at the source, how many times wider it is at its end, and whether it is round.
uniform float shaft_length = 8.0;
uniform vec2 opening = vec2(0.5, 0.5);
uniform float spread = 3.0;
uniform bool is_round = true;
// Where along the shaft (0 at its source, 1 at its end) it starts to fade out.
uniform float fade_from : hint_range(0.0, 1.0) = 0.25;
// How much drifting dust breaks it up, how large the dust clouds are in meters, and how fast they drift.
uniform sampler2D dust_noise : repeat_enable, filter_linear_mipmap;
uniform float dust : hint_range(0.0, 1.0) = 0.35;
uniform float dust_size = 1.6;
uniform float dust_speed = 0.06;
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

// Narrows the stretch [enters, leaves] of the line `from + t * along` to where `a + b * t` is not above zero.
void wasd_clip(float a, float b, inout float enters, inout float leaves) {
	if (abs(b) < 0.000001) {
		if (a > 0.0) {
			leaves = -1.0;
		}
	} else if (b > 0.0) {
		leaves = min(leaves, -a / b);
	} else {
		enters = max(enters, -a / b);
	}
}

void fragment() {
	vec3 world_ray = normalize(world_vertex - CAMERA_POSITION_WORLD);
	vec3 from = local_camera;
	vec3 along = mat3(to_local_x, to_local_y, to_local_z) * world_ray;
	// The shaft is a box that widens from its source to its end: six flat sides. Its half width at depth s (meters
	// from the source) is opening * (1 + widen * s).
	float widen = (spread - 1.0) / shaft_length;
	float enters = 0.0;
	float leaves = 1000000.0;
	wasd_clip(from.z, along.z, enters, leaves);
	wasd_clip(-from.z - shaft_length, -along.z, enters, leaves);
	wasd_clip(from.x - opening.x * (1.0 - widen * from.z), along.x + opening.x * widen * along.z, enters, leaves);
	wasd_clip(-from.x - opening.x * (1.0 - widen * from.z), -along.x + opening.x * widen * along.z, enters, leaves);
	wasd_clip(from.y - opening.y * (1.0 - widen * from.z), along.y + opening.y * widen * along.z, enters, leaves);
	wasd_clip(-from.y - opening.y * (1.0 - widen * from.z), -along.y + opening.y * widen * along.z, enters, leaves);
	// What is solid ends the lit air there.
	float depth = texture(depth_texture, SCREEN_UV).r;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	vec4 seen = INV_PROJECTION_MATRIX * vec4(vec3(SCREEN_UV, depth) * 2.0 - 1.0, 1.0);
#else
	vec4 seen = INV_PROJECTION_MATRIX * vec4(SCREEN_UV * 2.0 - 1.0, depth, 1.0);
#endif
	leaves = min(leaves, length(seen.xyz / seen.w));
	float through = leaves - enters;
	if (through <= 0.0) {
		discard;
	}
	// The light of the dust along the stretch, read at eight places. Where the shaft is wider its light is spread
	// thinner, as a lamp's is: the air glows less there, by the square of the width, down from a width of half a
	// meter.
	const int STEPS = 8;
	float gathered = 0.0;
	float mean_opening = (opening.x + opening.y) * 0.5;
	for (int step_index = 0; step_index < STEPS; step_index++) {
		vec3 place = from + along * (enters + through * (float(step_index) + 0.5) / float(STEPS));
		float deep = -place.z;
		float wider = 1.0 + widen * deep;
		vec2 across = place.xy / (opening * wider);
		// Brightest along the middle, dissolving toward the sides.
		float middle = is_round ? clamp(1.0 - dot(across, across), 0.0, 1.0) : clamp(1.0 - pow(pow(abs(across.x), 3.0) + pow(abs(across.y), 3.0), 0.8), 0.0, 1.0);
		float part = deep / shaft_length;
		float half_width = mean_opening * wider;
		gathered += middle * middle * middle * (1.0 - smoothstep(fade_from, 1.0, part)) * smoothstep(0.0, 0.08, part) * min(0.25 / (half_width * half_width), 4.0);
	}
	float motes = 1.0;
	if (dust > 0.0) {
		vec3 middle_world = CAMERA_POSITION_WORLD + world_ray * (enters + through * 0.5);
		vec2 drift = vec2(TIME * dust_speed, TIME * dust_speed * 0.6);
		float cloud = texture(dust_noise, middle_world.xz / dust_size + drift).r * 0.6 + texture(dust_noise, middle_world.xy / (dust_size * 0.45) - drift * 1.7).r * 0.4;
		motes = mix(1.0, smoothstep(0.1, 0.9, cloud) * 1.4, dust);
	}
	wasd_layer(wasd_to_light(color) * energy * 1.5 * gathered / float(STEPS) * through * motes, 1.0, FRAGCOORD.xy, ALBEDO, ALPHA);
}
