// SPDX-License-Identifier: CC0-1.0
// What weather leaves on things: snow that settles on what faces up, and wetness that darkens surfaces, makes them
// shine, and stands in puddles on level ground. It is drawn over a mesh's own material (GeometryInstance3D's
// material_overlay), which stays as it is underneath.
shader_type spatial;
render_mode blend_mix, depth_draw_never, cull_back;

uniform float snow : hint_range(0.0, 1.0) = 0.0;
uniform float wet : hint_range(0.0, 1.0) = 0.0;
// How hard it rains now, from 0 to 1: rain ruffles the puddles.
uniform float rain : hint_range(0.0, 1.0) = 0.0;
uniform vec3 snow_color : source_color = vec3(0.9, 0.93, 0.97);
// How much of the sky and the lamps a puddle mirrors, per color.
uniform vec3 puddle_color : source_color = vec3(0.56, 0.6, 0.64);
uniform sampler2D noise : repeat_enable, filter_linear_mipmap;
// Meters across one repeat of the snow's and the puddles' unevenness.
uniform float patch_size = 6.0;

varying vec3 world_place;
varying vec3 world_normal;

void vertex() {
	world_place = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	world_normal = normalize(MODEL_NORMAL_MATRIX * NORMAL);
}

void fragment() {
	vec3 facing = normalize(world_normal);
	vec2 at = world_place.xz;
	// The finer unevenness lies askew to the coarse one, so that neither shows its repeat.
	vec2 fine_at = mat2(vec2(0.866, 0.5), vec2(-0.5, 0.866)) * at / (patch_size * 0.31) + vec2(0.37, 0.61);
	float coarse = texture(noise, at / patch_size).r;
	float fine = texture(noise, fine_at).r;
	float uneven = coarse * 0.6 + fine * 0.4;
	// Snow lies where a surface faces up, first in patches with thin edges, then everywhere; walls stay bare.
	float settled = smoothstep(1.0 - snow * 1.1, 1.4 - snow * 1.1, facing.y * 0.75 + uneven * 0.45) * smoothstep(0.05, 0.4, facing.y) * step(0.001, snow);
	// Water darkens everything a little, makes it shine, and stands in puddles where level ground dips: none while
	// things are only damp, a third of the ground when they are soaked. A puddle is a dark wet rim round a mirror.
	float level = smoothstep(0.92, 0.985, facing.y);
	float puddle = smoothstep(0.0, 0.12, uneven - mix(0.9, 0.5, wet)) * level * step(0.001, wet) * (1.0 - settled);
	float mirror = smoothstep(0.5, 0.72, puddle);
	float damp = wet * 0.5;
	float water = max(damp, puddle * 0.92) * (1.0 - settled);
	// The surface's shape: snow lies in soft lumps, and rain ruffles standing water with small waves that cross one
	// another, near the eye only: far off they are finer than a pixel.
	const float STEP = 0.03;
	vec2 lumps = vec2(texture(noise, fine_at + vec2(STEP, 0.0)).r, texture(noise, fine_at + vec2(0.0, STEP)).r) - fine;
	vec2 ruffle = cos(dot(at, vec2(17.0, 9.0)) + TIME * 7.0) * vec2(0.88, 0.47)
		+ cos(dot(at, vec2(-13.0, 24.0)) - TIME * 6.1) * vec2(-0.48, 0.88)
		+ cos(dot(at, vec2(31.0, -19.0)) + TIME * 9.3) * vec2(0.85, -0.52)
		+ cos(dot(at, vec2(-27.0, -33.0)) - TIME * 8.2) * vec2(-0.63, -0.77);
	ruffle *= 0.016 * rain * (1.0 - smoothstep(0.02, 0.07, length(fwidth(at))));
	vec2 lean = lumps * -5.0 * settled + ruffle * (mirror + 0.4 * damp) * (1.0 - settled);
	NORMAL = normalize((VIEW_MATRIX * vec4(normalize(facing + vec3(lean.x, 0.0, lean.y)), 0.0)).xyz);
	// Thin snow shows the wet ground through it, blue-gray; deep snow is white, and blue in the hollows of its
	// drifts.
	vec3 snow_shade = snow_color * mix(vec3(0.74, 0.8, 0.9), vec3(1.0), smoothstep(0.25, 0.95, settled)) * mix(vec3(0.82, 0.88, 0.97), vec3(1.0), smoothstep(0.15, 0.8, coarse * 0.75 + fine * 0.25));
	// A grain of a few centimeters, so that a wide field of snow is not one flat tone.
	vec2 cell = floor(at * 30.0);
	snow_shade *= 0.965 + 0.07 * fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
	ALBEDO = mix(mix(vec3(0.012, 0.014, 0.016), puddle_color, mirror), snow_shade, settled);
	METALLIC = mirror * (1.0 - settled);
	// Damp ground shines most where the eye looks along it.
	ROUGHNESS = mix(mix(0.18, 0.03, mirror), 0.7, settled);
	SPECULAR = mix(1.0, 0.5, settled);
	ALPHA = max(settled * 0.97, water);
}
