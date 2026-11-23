// SPDX-License-Identifier: CC0-1.0
// A creature of a WasdFlock3D: a bird, a fish, or a butterfly. The shader gives it its place on a path that never
// repeats within minutes, turns it to face where it goes, and beats its wings or tail, so the whole flock is one draw
// call and no script runs for its members. It draws on the Forward+, Mobile, and Compatibility renderers.
shader_type spatial;
render_mode cull_disabled;

// Seconds since the flock began; WasdFlock3D counts them, so a paused game holds the flock still.
uniform float clock = 0.0;
// 0 birds, 1 fish, 2 butterflies.
uniform int kind = 0;
// How far the flock roams from its node, and the height of the band it keeps to, in meters.
uniform float radius = 25.0;
uniform float height = 6.0;
// Meters a second.
uniform float speed = 7.0;
// How far a member strays from the middle of the flock, in meters.
uniform float spread = 6.0;
// A creature's wingspan or length, in meters, and how much members differ in it.
uniform float size = 0.8;
uniform float size_variety : hint_range(0.0, 1.0) = 0.3;
// Beats of wings or tail, in radians a second.
uniform float beat_rate = 14.0;
// Meters from the camera beyond which a creature is not drawn, where it would be a flickering speck; 0 draws all.
uniform float sight = 0.0;
// Where and when something startled the flock, in the node's space and on its clock, and how hard.
uniform vec3 scare_place = vec3(0.0);
uniform float scare_clock = -1000.0;
uniform float scare_strength = 0.0;
uniform float roughness : hint_range(0.0, 1.0) = 0.7;
uniform float metallic : hint_range(0.0, 1.0) = 0.0;

// Where a member is at a time, in the node's space. `seed` holds four numbers from 0 to 1 of the member's own.
vec3 place_at(float t, vec4 seed) {
	vec3 place;
	if (kind == 2) {
		// A butterfly keeps near a spot of its own and wanders round it.
		float away = sqrt(seed.x) * radius;
		vec3 home = vec3(cos(seed.y * 6.2832) * away, (seed.z - 0.5) * height, sin(seed.y * 6.2832) * away);
		float pace = speed * (0.7 + seed.w * 0.6);
		place = home + vec3(
			sin(t * 0.9 * pace + seed.x * 6.2832) * 1.2 + sin(t * 0.23 * pace + seed.z * 6.2832) * 0.8,
			sin(t * 3.1 + seed.y * 6.2832) * 0.18 + sin(t * 0.5 * pace + seed.w * 6.2832) * 0.3,
			cos(t * 0.7 * pace + seed.z * 6.2832) * 1.2 + cos(t * 0.31 * pace + seed.x * 6.2832) * 0.8);
	} else {
		// Birds and fish travel together: the flock's middle goes round its node, and each member drifts about it.
		float turn = t * speed / max(radius * 0.7, 0.5);
		vec3 middle = vec3(cos(turn) * radius * 0.7, sin(turn * 0.53) * height * 0.3, sin(turn) * radius * (0.55 + 0.15 * sin(turn * 0.31)));
		float drift = (kind == 1 ? 1.3 : 0.5) * (0.6 + seed.w * 0.8);
		vec3 own = vec3(
			sin(t * drift + seed.x * 6.2832),
			sin(t * drift * 0.7 + seed.y * 6.2832) * (height / max(spread * 2.0, 0.01)),
			cos(t * drift * 0.83 + seed.z * 6.2832));
		place = middle + own * spread * (0.35 + 0.65 * seed.z);
	}
	// Startled, the members fly apart from what startled them, and upward if they are birds, then come back.
	float since = t - scare_clock;
	if (scare_strength > 0.0 && since > 0.0 && since < 12.0) {
		vec3 from = place - scare_place;
		// The start reaches as far as the flock is wide, and no less than five meters.
		float near = 1.0 / (1.0 + dot(from, from) / max(spread * spread * 4.0, 25.0));
		vec3 away = normalize(from + vec3(seed.x - 0.5, kind == 1 ? seed.y - 0.5 : 0.6 + seed.y, seed.z - 0.5));
		float swell = smoothstep(0.0, 0.25, since) * exp(-since * 0.45);
		place += away * scare_strength * swell * near * (6.0 + seed.w * 6.0) * (kind == 2 ? 0.25 : 1.0);
	}
	return place;
}

void vertex() {
	vec4 seed = INSTANCE_CUSTOM;
	vec3 here = place_at(clock, seed);
	vec3 ahead = place_at(clock + 0.12, seed) - here;
	vec3 forward = length(ahead) > 0.0001 ? normalize(ahead) : vec3(0.0, 0.0, 1.0);
	// A creature does not dive or climb as steeply as its path may.
	forward = normalize(vec3(forward.x, forward.y * 0.5, forward.z));
	vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
	vec3 up = cross(forward, right);
	vec3 shape = VERTEX;
	float beat = sin(clock * beat_rate * (0.85 + seed.x * 0.3) + seed.y * 6.2832);
	if (kind == 0) {
		// A bird beats its wings for a while and glides for a while.
		float beating = smoothstep(-0.3, 0.2, sin(clock * 0.7 + seed.z * 40.0));
		float along = abs(shape.x) * 2.0;
		shape.y += along * along * (beat * 0.22 * beating + 0.04);
		shape.x *= 1.0 - 0.12 * abs(beat) * beating;
	} else if (kind == 1) {
		// A fish swims with its tail: the wave grows from the head back.
		float back = clamp(0.5 - shape.z, 0.0, 1.0);
		shape.x += sin(clock * beat_rate * (0.85 + seed.x * 0.3) + seed.y * 6.2832 + shape.z * 5.0) * 0.16 * back * back;
	} else {
		// A butterfly claps its wings over its back, and the tips follow the roots a moment late, so the wings curl.
		float along = abs(shape.x);
		float phase = clock * beat_rate * (0.85 + seed.x * 0.3) + seed.y * 6.2832;
		float angle = 0.25 + beat * 0.95 + sin(phase - 1.1) * 1.3 * along * along;
		shape = vec3(shape.x * cos(angle), shape.y + along * sin(angle), shape.z);
	}
	shape *= size * (1.0 - size_variety * 0.5 + size_variety * seed.w);
	if (sight > 0.0) {
		// Toward the end of its sight a creature shrinks to nothing, so that none pops out of the picture.
		shape *= 1.0 - smoothstep(sight * 0.75, sight, length((MODELVIEW_MATRIX * vec4(here, 1.0)).xyz));
	}
	VERTEX = here + right * shape.x + up * shape.y + forward * shape.z;
	NORMAL = normalize(right * NORMAL.x + up * NORMAL.y + forward * NORMAL.z);
}

void fragment() {
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	vec3 tint = COLOR.rgb;
#else
	// A member's color is a color as the screen shows it. The Compatibility renderer hands it over as light already;
	// the others hand it over as it is.
	vec3 tint = mix(pow((COLOR.rgb + 0.055) / 1.055, vec3(2.4)), COLOR.rgb / 12.92, step(COLOR.rgb, vec3(0.04045)));
#endif
	// A vertex's UV holds how far it is from the creature's middle toward its edge, and how light that part is: a pale
	// belly, dark wing tips, a dark body.
	vec3 surface = tint * UV.y;
	if (kind == 2) {
		// A butterfly's wings end in a dark border, as a monarch's and a swallowtail's do, and dark veins run from the
		// root to it. UV2 holds, for a point of a wing, its share toward each of the two veins that bound its panel:
		// near a vein, one of them is close to zero.
		float border = smoothstep(0.7, 0.8, UV.x);
		float vein = (1.0 - smoothstep(0.02, 0.05, min(UV2.x, UV2.y))) * smoothstep(0.1, 0.35, UV.x) * step(UV2.x + UV2.y, 1.001);
		// Seen along the wing, scales throw the light back: the wing brightens, and a blue one turns toward cyan.
		float graze = pow(1.0 - abs(dot(normalize(NORMAL), normalize(VIEW))), 2.0);
		vec3 sheen = tint.b > tint.r ? vec3(0.25, 0.85, 1.0) : tint;
		surface = mix(surface, sheen * UV.y, graze * 0.45) * (1.0 + graze * 0.35);
		surface = mix(surface, vec3(0.025, 0.02, 0.02), max(border, vein * 0.75));
	}
	ALBEDO = surface;
	ROUGHNESS = roughness;
	METALLIC = metallic;
}

void light() {
	// A wing and a fin are thin, and light falls through them: neither side is ever dark, and the side away from the
	// light glows a little, as a wing held against the sun does.
	float facing = dot(NORMAL, LIGHT);
	DIFFUSE_LIGHT += (0.4 + 0.6 * abs(facing)) * (facing < 0.0 ? 1.15 : 1.0) * ATTENUATION * LIGHT_COLOR / PI;
}
