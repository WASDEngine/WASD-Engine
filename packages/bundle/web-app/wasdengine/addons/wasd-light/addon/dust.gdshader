// SPDX-License-Identifier: CC0-1.0
// Dust, pollen, embers, snowflakes, or fireflies drifting in a box of air: small glowing cards that the shader
// moves, with no particle system and no work for the processor. Each keeps its place in the world while the box
// moves with the camera, and one that leaves the box on one side comes back on the other.
shader_type spatial;
render_mode unshaded, blend_premul_alpha, depth_draw_never, cull_disabled, shadows_disabled, fog_disabled;

#include "res://addons/wasd_light/light_color.gdshaderinc"

uniform vec3 color : source_color = vec3(1.0, 0.95, 0.85);
uniform float energy = 0.25;
// The box in meters, the size of one mote in meters, and where the box's middle is in the world.
uniform vec3 box = vec3(12.0, 6.0, 12.0);
uniform float mote_size = 0.015;
uniform vec3 box_middle = vec3(0.0);
// How far the air has carried the motes, in meters, and how far each mote wanders on its own.
uniform vec3 drift = vec3(0.0);
uniform float wander = 0.25;
// Seconds on the motes' own clock, which starts over every 600 seconds.
uniform float clock = 0.0;
// How much each mote's brightness comes and goes, from 0 to 1.
uniform float twinkle : hint_range(0.0, 1.0) = 0.5;
// How much the motes keep to the box's upright middle line, from 0 (the whole box) to 1: for dust in a beam.
uniform float gather : hint_range(0.0, 1.0) = 0.0;
uniform float fade_near = 0.5;

varying float shown;

// A pace of a mote's own, in radians a second, rounded to a whole number of turns in the clock's 600 seconds, so
// that the clock starts over without a jump.
float pace(float rate) {
	const float TURN = 6.28318531 / 600.0;
	return round(rate / TURN) * TURN;
}

void vertex() {
	vec4 seed = INSTANCE_CUSTOM;
	vec3 place = seed.xyz * box + drift
		+ wander * vec3(sin(clock * pace(0.3 + seed.w * 0.5) + seed.x * 40.0), sin(clock * pace(0.25 + seed.x * 0.4) + seed.y * 40.0), sin(clock * pace(0.35 + seed.y * 0.5) + seed.z * 40.0));
	// Wrapped into the box round its middle.
	vec3 offset = mod(place - box_middle + box * 0.5, box) - box * 0.5;
	vec3 world = box_middle + offset;
	vec3 edge = 1.0 - smoothstep(vec3(0.35), vec3(0.5), abs(offset) / box);
	edge.x *= mix(1.0, 1.0 - smoothstep(0.0, 0.5, length(offset.xz / box.xz)), gather);
	// Motes differ in brightness as in size, and each comes and goes.
	shown = edge.x * edge.y * edge.z * (0.25 + 0.75 * fract(seed.w * 7.31 + seed.x * 3.7)) * mix(1.0, 0.5 + 0.5 * sin(clock * pace(1.0 + seed.w * 3.0) + seed.z * 60.0), twinkle);
	float sized = mote_size * (0.4 + 1.6 * seed.w * seed.w);
	MODELVIEW_MATRIX = VIEW_MATRIX * mat4(INV_VIEW_MATRIX[0] * sized, INV_VIEW_MATRIX[1] * sized, INV_VIEW_MATRIX[2] * sized, vec4(world, 1.0));
	MODELVIEW_NORMAL_MATRIX = mat3(MODELVIEW_MATRIX);
}

void fragment() {
	float distance_out = length((UV - 0.5) * 2.0);
	float dot_shape = pow(clamp(1.0 - distance_out, 0.0, 1.0), 2.0);
	float near = smoothstep(fade_near * 0.4, fade_near, length(VERTEX));
	wasd_layer(wasd_to_light(color) * energy * dot_shape * shown * near, 1.0, FRAGCOORD.xy, ALBEDO, ALPHA);
}
