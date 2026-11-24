// SPDX-License-Identifier: CC0-1.0
// What falls from the sky in WASD Weather: rain as streaks along its flight, snow as soft flakes that wander. The
// shader moves every card; the cards fill a box of air that stays round the camera, each keeps its place in the
// world, and one that leaves the box on one side comes back on the other.
shader_type spatial;
render_mode unshaded, blend_premul_alpha, depth_draw_never, cull_disabled, shadows_disabled, fog_disabled;

#include "res://addons/wasd_weather/weather_color.gdshaderinc"

uniform vec3 color : source_color = vec3(0.82, 0.87, 0.93);
uniform float opacity = 0.75;
// How much of what lies behind a card it hides: little for water, most for a flake.
uniform float solidity = 0.6;
// How brightly the scene is lit, from 0 to 1: rain and snow are seen by the light that falls on them.
uniform float light_level = 1.0;
// The box of air in meters and where its middle is in the world.
uniform vec3 box = vec3(20.0, 14.0, 20.0);
uniform vec3 box_middle = vec3(0.0);
// How far everything has fallen and been blown, in meters, and how fast it goes now in meters a second; how wide
// a card is, how long a streak is for each meter a second (0 for a round flake), and how far a flake wanders on
// its own.
uniform vec3 way = vec3(0.0);
uniform vec3 flight = vec3(0.0, -9.0, 0.0);
uniform float width = 0.014;
uniform float streak = 0.07;
uniform float wander = 0.0;
uniform float clock = 0.0;

varying float shown;
varying vec2 card;

void vertex() {
	vec4 seed = INSTANCE_CUSTOM;
	// Every card has a pace of its own, one of six, so that the way may start over after a hundred boxes without a
	// card leaving its place; and a length, a width, and a lean of its own, so that no two look alike.
	float pace = 0.85 + 0.06 * floor(seed.w * 5.999);
	float own = fract(seed.x * 13.7 + seed.z * 7.3);
	vec3 place = seed.xyz * box + way * pace;
	if (wander > 0.0) {
		place += wander * vec3(sin(clock * (0.7 + seed.w) + seed.x * 40.0), 0.0, sin(clock * (0.6 + seed.x) + seed.z * 40.0));
	}
	vec3 offset = mod(place - box_middle + box * 0.5, box) - box * 0.5;
	vec3 edge = 1.0 - smoothstep(vec3(0.4), vec3(0.5), abs(offset) / box);
	shown = edge.x * edge.y * edge.z * (0.3 + 0.7 * fract(seed.w * 6.0 + seed.y));
	vec3 seen = (VIEW_MATRIX * vec4(box_middle + offset, 1.0)).xyz;
	// Nothing right before the eye: a streak there would cross the whole screen.
	shown *= smoothstep(0.6, 1.6, -seen.z);
	// A card is never thinner than a pixel and a half, or it would flicker in and out between the pixels; one that
	// had to be widened is fainter instead.
	float pixel = max(-seen.z, 0.1) * 2.0 / (abs(PROJECTION_MATRIX[1][1]) * VIEWPORT_SIZE.y);
	float own_width = width * (0.6 + 1.0 * own);
	float wide = max(own_width, pixel * (streak > 0.0 ? 1.5 : 2.0));
	// One that had to be widened is fainter: far rain thins out, and far snow more so.
	shown *= streak > 0.0 ? sqrt(own_width / wide) : own_width / wide;
	card = (UV - 0.5) * 2.0;
	vec2 corner = card * wide;
	if (streak > 0.0) {
		vec3 flight_seen = (VIEW_MATRIX * vec4(flight * pace + vec3(seed.z - 0.5, 0.0, own - 0.5) * 1.2, 0.0)).xyz;
		float flat_speed = length(flight_seen.xy);
		vec2 forward = flat_speed > 0.0001 ? flight_seen.xy / flat_speed : vec2(0.0, -1.0);
		corner = forward * card.x * max(streak * (0.4 + 1.4 * seed.z * seed.z) * flat_speed, wide) + vec2(-forward.y, forward.x) * card.y * wide;
	}
	seen.xy += corner * 0.5;
	POSITION = PROJECTION_MATRIX * vec4(seen, 1.0);
}

void fragment() {
	// A streak is brightest at its head and thins to nothing behind; a flake is a soft dot.
	float solid = streak > 0.0 ? pow(clamp(1.0 - abs(card.y), 0.0, 1.0), 1.5) * smoothstep(-1.0, 0.5, card.x) * smoothstep(1.0, 0.8, card.x) : pow(clamp(1.0 - length(card), 0.0, 1.0), 1.8);
	float covers = clamp(opacity * solid * shown, 0.0, 1.0);
	wasd_layer(wasd_to_light(color) * max(light_level, 0.3) * covers, 1.0 - covers * solidity, FRAGCOORD.xy, ALBEDO, ALPHA);
}
