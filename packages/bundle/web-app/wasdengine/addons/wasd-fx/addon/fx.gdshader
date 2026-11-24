// SPDX-License-Identifier: CC0-1.0
// Every particle of WASD FX: sparks, smoke, flames, flashes, rings, debris, droplets, glints. One shader moves each
// card from the effect's age and four random numbers, so an effect costs no particle system and nothing on the
// processor, and the whole library compiles as one shader. A layer of an effect is one MultiMesh with this
// shader and its own values.
shader_type spatial;
render_mode unshaded, blend_premul_alpha, depth_draw_never, cull_disabled, shadows_disabled, fog_disabled;

#include "res://addons/wasd_fx/fx_color.gdshaderinc"

// Time: seconds since the effect began, how long one particle lives, after how many seconds a burst's first
// particle is born and over how many more the rest, whether the layer runs on and on, how much of it shows while
// it fades out, and a random number per play.
uniform float age = 0.0;
uniform float life = 1.0;
uniform float delay = 0.0;
uniform float spawn_over = 0.0;
uniform bool looping = false;
uniform float fade = 1.0;
uniform float variation = 0.0;
// Motion in the effect's own space, where +Y is the surface's normal or the effect's direction. Directions: 0 all
// round, 1 a cone about +Y as wide as `spread` (1 a half sphere), 2 outward in the XZ plane, 3 straight along +Y.
uniform int shape = 0;
uniform float spread = 0.6;
uniform float radius = 0.0;
uniform vec3 offset = vec3(0.0);
uniform vec2 speed = vec2(1.0, 3.0);
uniform vec3 pull = vec3(0.0, -9.8, 0.0);
uniform float drag = 0.0;
// The wind in the effect's own space, in meters a second, and how much of it a particle takes on: all of it for
// smoke, none for a spark.
uniform vec3 wind = vec3(0.0);
uniform float carried = 0.0;
// For an effect that runs on while the wind changes: how far the air has gone in the effect's own space since it
// began, in meters, and the same at every `way_step` seconds of its age, the sample of age k * way_step in
// ways[k % 24], `way_count` samples so far. A particle goes the way the air went in its life, so a new wind carries
// on what is in the air without moving it at once. With no samples the wind has been the same all along. Before the
// effect began, the air went at `first_wind`, the wind it began with: its first particles were already in the air.
uniform vec3 way = vec3(0.0);
uniform vec3 ways[24];
uniform float way_step = 0.25;
uniform int way_count = 0;
uniform vec3 first_wind = vec3(0.0);
uniform float wobble = 0.0;
uniform float scale = 1.0;
// A card: meters across at birth and at death, how much cards differ in size, how much a card stretches along its
// flight, how fast it turns, and whether it lies in the effect's XZ plane instead of facing the camera.
uniform vec2 size = vec2(0.1, 0.3);
uniform float size_variance = 0.4;
uniform float stretch = 0.0;
uniform float spin = 0.0;
uniform bool lies_flat = false;
// What a card shows: 0 a soft dot, 1 a puff of smoke, 2 a streak, 3 a ring, 4 a star, 5 a square.
uniform int look = 0;
// Color and opacity at birth, at `mid_at` of the life, and at death; brightness; whether every card has a color of
// its own; how much of the picture behind passes (1 adds light as fire does, 0 covers as smoke does); and how
// brightly covering cards are lit.
uniform vec4 color_start : source_color = vec4(1.0);
uniform vec4 color_mid : source_color = vec4(1.0);
uniform vec4 color_end : source_color = vec4(1.0, 1.0, 1.0, 0.0);
uniform float mid_at : hint_range(0.01, 0.99) = 0.3;
uniform vec4 tint : source_color = vec4(1.0);
uniform float energy = 1.0;
uniform bool rainbow = false;
uniform float through = 1.0;
uniform float light_level = 1.0;
// How much of a covering card's brightness is its own, whatever the scene's light: smoke lit by the fire under it.
uniform float self_lit = 0.0;
uniform sampler2D noise : repeat_enable, filter_linear_mipmap;

varying float lived_part;
varying float shown;
varying vec4 seed;
varying vec2 card;

// How far the air had gone at an age of the effect, between the samples; before the first one at the wind the effect
// began with, and before the oldest kept, once older ones are let go, at the wind there is now.
vec3 way_at(float when) {
	int newest = way_count - 1;
	float newest_age = float(newest) * way_step;
	if (when >= newest_age) {
		return mix(ways[newest % 24], way, clamp((when - newest_age) / max(age - newest_age, 0.0001), 0.0, 1.0));
	}
	int oldest = max(way_count - 24, 0);
	float oldest_age = float(oldest) * way_step;
	if (when <= oldest_age) {
		return ways[oldest % 24] + (oldest == 0 ? first_wind : wind) * (when - oldest_age);
	}
	float at = when / way_step;
	int before = int(at);
	return mix(ways[before % 24], ways[(before + 1) % 24], at - float(before));
}

void vertex() {
	seed = fract(INSTANCE_CUSTOM + variation * vec4(0.731, 0.317, 0.911, 0.547));
	float own_life = life * (0.65 + 0.35 * seed.z);
	float lived;
	shown = fade;
	if (looping) {
		// Every particle is born again and again, each at its own point of the cycle.
		lived = fract(age / own_life + seed.w) * own_life;
	} else {
		lived = age - delay - seed.w * spawn_over;
		if (lived < 0.0 || lived > own_life) {
			shown = 0.0;
		}
	}
	lived_part = clamp(lived / own_life, 0.0, 1.0);

	float turn = seed.x * TAU;
	vec3 heading;
	if (shape == 0) {
		float height = seed.y * 2.0 - 1.0;
		float across = sqrt(max(1.0 - height * height, 0.0));
		heading = vec3(across * cos(turn), height, across * sin(turn));
	} else if (shape == 1) {
		float tilt = spread * 1.5708 * sqrt(seed.y);
		heading = vec3(sin(tilt) * cos(turn), cos(tilt), sin(tilt) * sin(turn));
	} else if (shape == 2) {
		heading = vec3(cos(turn), 0.0, sin(turn));
	} else {
		heading = vec3(0.0, 1.0, 0.0);
	}
	float fast = mix(speed.x, speed.y, fract(seed.x * 7.13 + seed.y * 3.7)) * scale;
	// Air slows a particle: the way it has gone, and its speed now.
	float gone = drag > 0.0 ? (1.0 - exp(-drag * lived)) / drag : lived;
	vec3 place = offset * scale + heading * (radius * scale + fast * gone) + 0.5 * pull * lived * lived;
	// A particle is born in still air and picks the wind up within half a second. In a steady wind that carries it the
	// wind times (lived - (1 - e^(-2 lived)) / 2); in a changing one, the way the air went from about half a second after
	// its birth, which comes to the same in a steady wind.
	float aloft = clamp(lived, 0.0, own_life);
	float taken = 1.0 - exp(-2.0 * aloft);
	if (way_count == 0) {
		place += wind * carried * (aloft - taken * 0.5);
	} else {
		float picked_up = taken > 0.000001 ? 0.5 - aloft * exp(-2.0 * aloft) / taken : aloft * 0.5;
		place += carried * taken * (way - way_at(age - aloft + picked_up));
	}
	if (wobble > 0.0) {
		place += wobble * scale * lived_part * vec3(sin(lived * 3.1 + seed.x * 40.0), sin(lived * 2.3 + seed.y * 40.0), sin(lived * 2.7 + seed.z * 40.0));
	}
	float across_card = mix(size.x, size.y, pow(lived_part, 0.6)) * (1.0 - size_variance + size_variance * 2.0 * seed.z) * scale * step(0.001, shown);
	card = (UV - 0.5) * 2.0;
	float turned = seed.y * TAU + spin * lived * (seed.x - 0.5) * 2.0;
	vec2 corner = vec2(card.x * cos(turned) - card.y * sin(turned), card.x * sin(turned) + card.y * cos(turned));
	if (lies_flat) {
		VERTEX = place + vec3(corner.x, 0.0, corner.y) * across_card * 0.5;
		// The shader writes POSITION, and Godot then takes it for every vertex: a card that lies flat gives it too.
		POSITION = PROJECTION_MATRIX * (MODELVIEW_MATRIX * vec4(VERTEX, 1.0));
	} else {
		vec3 seen = (MODELVIEW_MATRIX * vec4(place, 1.0)).xyz;
		if (stretch > 0.0) {
			// A streak lies along the way the particle flies, as the eye sees it.
			vec3 flight = heading * fast * exp(-drag * lived) + pull * lived;
			vec3 flight_seen = (MODELVIEW_MATRIX * vec4(flight, 0.0)).xyz;
			float flat_speed = length(flight_seen.xy);
			vec2 forward = flat_speed > 0.0001 ? flight_seen.xy / flat_speed : vec2(0.0, 1.0);
			corner = forward * card.x * (1.0 + stretch * length(flight) / max(scale, 0.001)) + vec2(-forward.y, forward.x) * card.y;
		}
		seen.xy += corner * across_card * 0.5;
		POSITION = PROJECTION_MATRIX * vec4(seen, 1.0);
	}
}

void fragment() {
	if (shown <= 0.0) {
		discard;
	}
	float out_from_middle = length(card);
	float solid;
	// Where in its life's colors a card is: the thin rim of a puff of fire is further along, cooler and redder.
	float along = lived_part;
	float shade = 1.0;
	if (look == 0) {
		solid = pow(clamp(1.0 - out_from_middle, 0.0, 1.0), 1.6);
	} else if (look == 1) {
		// A puff: a soft ball that two noises break into lobes and wisps, different for each card, and that is eaten
		// away from its rim as it ages.
		float cloud = texture(noise, card * 0.21 + seed.xy * 7.0 + vec2(0.0, lived_part * 0.12)).r;
		float wisps = texture(noise, card * 0.55 + seed.zw * 5.0 - vec2(0.0, lived_part * 0.2)).r;
		float thick = clamp(1.0 - out_from_middle, 0.0, 1.0) * (0.5 + cloud) * (0.65 + 0.7 * wisps);
		float eaten = mix(0.14, 0.5, lived_part);
		solid = smoothstep(eaten, eaten + 0.28, thick);
		along = clamp(lived_part + (1.0 - clamp((thick - eaten) * 2.2, 0.0, 1.0)) * 0.35, 0.0, 1.0);
		shade = 0.7 + 0.6 * wisps;
	} else if (look == 2) {
		// A streak: bright at its head, thinning to nothing at its tail.
		solid = pow(clamp(1.0 - abs(card.y), 0.0, 1.0), 2.0) * smoothstep(-1.0, 0.5, card.x) * smoothstep(1.0, 0.8, card.x);
	} else if (look == 3) {
		// A ring with a bright inner edge that bleeds outward.
		solid = smoothstep(0.62, 0.8, out_from_middle) * pow(clamp((1.0 - out_from_middle) / 0.2, 0.0, 1.0), 1.4);
	} else if (look == 4) {
		// A star: a soft middle with four long thin rays.
		float rays = pow(clamp(1.0 - abs(card.x) * abs(card.y) * 40.0, 0.0, 1.0), 3.0) * pow(clamp(1.0 - out_from_middle, 0.0, 1.0), 1.3);
		solid = pow(clamp(1.0 - out_from_middle * 2.2, 0.0, 1.0), 1.5) * 1.5 + rays;
	} else {
		solid = step(max(abs(card.x), abs(card.y)), 0.8);
	}
	vec4 now = along < mid_at ? mix(color_start, color_mid, along / mid_at) : mix(color_mid, color_end, (along - mid_at) / (1.0 - mid_at));
	vec3 hue = now.rgb * tint.rgb;
	if (rainbow) {
		hue = clamp(abs(mod(seed.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0) * 0.85 + 0.15;
	}
	float opacity = clamp(now.a * tint.a * solid * shown, 0.0, 1.0);
	// Light that is added passes at full strength; a covering card shows as brightly as the scene is lit.
	wasd_layer(wasd_to_light(hue) * energy * opacity * mix(max(light_level, self_lit) * shade, 1.0, through), 1.0 - opacity * (1.0 - through), FRAGCOORD.xy, ALBEDO, ALPHA);
}
