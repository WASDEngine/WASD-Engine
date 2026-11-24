// SPDX-License-Identifier: CC0-1.0
// Marks on surfaces: WasdDecals3D draws all marks of one kind with it, as flat quads just above the surface. A mark is
// a frame of a texture, or one of the kinds drawn here without any texture: a bullet hole, a scorch mark, a splat,
// cracks, a footprint. A drawn mark has relief, so that light catches one side of a pit or a crack and the edge of a
// spill. Each mark carries its tint and its own shape, and fades in its last moments. It draws on the Forward+,
// Mobile, and Compatibility renderers, where Decal nodes do not draw.
shader_type spatial;
render_mode blend_mix, depth_draw_never, cull_back;

uniform sampler2D marks : source_color, filter_linear_mipmap, repeat_disable;
// Columns and rows of marks in the texture.
uniform vec2 frames = vec2(1.0, 1.0);
// 0 draws the texture; 1 a bullet hole, 2 a scorch mark, 3 a splat, 4 cracks, 5 a footprint.
uniform int kind = 0;
// The pool's clock in seconds, which the node advances and starts again from 0 every 64 seconds, moving the marks'
// ends with it.
uniform float clock = 0.0;
// Seconds a mark takes to fade at the end of its life.
uniform float fade = 1.0;
// 0 draws the marks lit by the scene's lights, 1 with their own colors.
uniform float unlit = 0.0;
// How wet the marks look, from 0 (dry, matt) to 1 (a fresh spill that mirrors the light).
uniform float shine : hint_range(0.0, 1.0) = 0.0;

varying float life_left;
varying float frame_index;
varying float shape_seed;
varying float mark_side;

void vertex() {
	// Custom data: when the mark ends, on the pool's clock (0 for a mark that stays, below 0 for one that has ended), its
	// frame, and its own number.
	life_left = INSTANCE_CUSTOM.x == 0.0 ? 1000.0 : INSTANCE_CUSTOM.x - clock;
	frame_index = INSTANCE_CUSTOM.y;
	shape_seed = INSTANCE_CUSTOM.z;
	// The mark's side in meters.
	mark_side = length(MODEL_MATRIX[0].xyz);
}

float wasd_hash(vec2 at) {
	vec3 p = fract(vec3(at.xyx) * 0.1031);
	p += dot(p, p.yzx + 33.33);
	return fract((p.x + p.y) * p.z);
}

float wasd_noise(vec2 at) {
	vec2 cell = floor(at);
	vec2 within = fract(at);
	within = within * within * (3.0 - 2.0 * within);
	return mix(mix(wasd_hash(cell), wasd_hash(cell + vec2(1.0, 0.0)), within.x),
		mix(wasd_hash(cell + vec2(0.0, 1.0)), wasd_hash(cell + vec2(1.0, 1.0)), within.x), within.y);
}

// How near `at` is to the line from `from` along `way` for `reach`, as 1 on the line and 0 a `wide` away from it. The
// line thins toward its end.
float wasd_line(vec2 at, vec2 from, vec2 way, float reach, float wide) {
	vec2 off = at - from;
	float along = clamp(dot(off, way), 0.0, reach);
	float thin = wide * (1.0 - 0.8 * along / reach);
	return 1.0 - smoothstep(thin * 0.5, thin, length(off - way * along));
}

// A drawn mark's color and cover at `at`, which runs from -1 to 1 across the quad, and its height there as a share
// of the mark's side: below zero for a pit. Every `seed` gives another shape.
vec4 wasd_mark(vec2 at, float seed, out float height) {
	float far = length(at);
	vec2 way = at / max(far, 0.0001);
	vec2 own = vec2(seed * 17.3, seed * 9.1);
	height = 0.0;
	if (kind == 1) {
		// A black puncture in a bowl where the surface chipped off, a breath of soot round it, and short cracks.
		float rim = 0.4 + 0.2 * wasd_noise(way * 2.2 + own) + 0.06 * wasd_noise(way * 9.0 + own.yx);
		float puncture = 0.15 * (0.85 + 0.3 * wasd_noise(way * 3.0 + own.yx));
		float chipped = 1.0 - smoothstep(rim - 0.04, rim, far);
		float hole = 1.0 - smoothstep(puncture * 0.8, puncture, far);
		float soot = (1.0 - smoothstep(rim, 0.92, far)) * 0.3;
		float crack = 0.0;
		for (int ray = 0; ray < 4; ray++) {
			float number = float(ray);
			float heading = (number + wasd_hash(own + number)) * 1.5708;
			crack = max(crack, wasd_line(at, vec2(0.0), vec2(cos(heading), sin(heading)), rim + 0.1 + 0.3 * wasd_hash(own.yx + number), 0.035));
		}
		height = -0.05 * smoothstep(rim, puncture, far) - 0.06 * hole - 0.015 * crack;
		vec3 bare = vec3(0.7, 0.68, 0.64) * (0.75 + 0.35 * wasd_noise(at * 11.0 + own));
		vec3 color = mix(mix(vec3(0.02), bare, chipped), vec3(0.02), max(hole, crack * 0.85));
		return vec4(color, max(max(hole, chipped * 0.92), max(crack * 0.8, soot)));
	}
	if (kind == 2) {
		// Soot: a dark, ragged middle that breaks up into grain toward its edge, streaks thrown outward that thin to
		// nothing, and a wide, faint haze.
		float rim = 0.46 + 0.3 * wasd_noise(way * 2.6 + own) + 0.12 * wasd_noise(way * 9.0 + own.yx);
		float grain = wasd_noise(at * 16.0 + own) * 0.6 + wasd_noise(at * 37.0 + own.yx) * 0.4;
		float core = 1.0 - smoothstep(rim * 0.45, rim * 0.85, far + (grain - 0.5) * 0.12);
		float streaks = wasd_noise(vec2(atan(at.y, at.x) * 7.0, far * 1.5) + own);
		float thrown = (1.0 - smoothstep(rim * 0.5, rim * 1.6, far)) * smoothstep(0.4, 0.8, streaks) * (0.5 + 0.5 * grain);
		float haze = (1.0 - smoothstep(rim * 0.4, 0.97, far)) * 0.16;
		float soot = max(max(core * (0.7 + 0.3 * grain), thrown * 0.6), haze);
		return vec4(vec3(0.03, 0.024, 0.02), soot * 0.88);
	}
	if (kind == 3) {
		// A spill with an uneven edge, thicker and darker toward its rim, and drops thrown outward round it; white, for
		// the tint to color.
		float rim = 0.34 + 0.28 * wasd_noise(way * 1.8 + own) + 0.1 * wasd_noise(way * 5.5 + own.yx);
		float body = 1.0 - smoothstep(rim - 0.04, rim, far);
		vec2 grid = at * 3.4 + own;
		vec2 cell = floor(grid);
		float chance = wasd_hash(cell);
		vec2 off = fract(grid) - 0.5 - (vec2(wasd_hash(cell + 3.7), wasd_hash(cell + 8.3)) - 0.5) * 0.5;
		// A drop is longer along the way it flew.
		float reach = length(vec2(dot(off, way) * 0.55, dot(off, vec2(-way.y, way.x)) * 1.2));
		float large = 0.07 + 0.13 * chance;
		float drop = step(0.45, chance) * (1.0 - smoothstep(large * 0.7, large, reach)) * (1.0 - smoothstep(0.8, 0.95, far));
		float inner = max(smoothstep(0.0, 0.16, rim - far) * body, (1.0 - smoothstep(0.0, large * 0.7, reach)) * drop);
		height = 0.02 * inner;
		float cover = max(body, drop * (0.55 + 0.45 * wasd_hash(cell + 1.9)));
		return vec4(vec3(mix(0.5, 1.0, inner)), cover);
	}
	if (kind == 4) {
		// A crushed middle, and seven thin cracks out of it, each its own length, thinning and wandering as it goes,
		// some with a branch, joined here and there by a broken ring. Beside each crack the surface has flaked pale.
		float angle = atan(at.y, at.x);
		float lines = 0.0;
		float flaked = 0.0;
		for (int ray = 0; ray < 7; ray++) {
			float number = float(ray);
			float heading = (number + wasd_hash(own + number) * 0.8) * 0.8976;
			float length_of = 0.45 + 0.5 * wasd_hash(own.yx + number * 3.1);
			float turned = heading + (wasd_noise(vec2(far * 5.0, number * 7.0) + own) - 0.5) * 0.7 + (wasd_noise(vec2(far * 26.0, number * 3.0) + own.yx) - 0.5) * 0.16;
			float across = abs(mod(angle - turned + PI, TAU) - PI) * far;
			float wide = (0.018 * (1.0 - far / length_of) + 0.005) * (0.6 + 0.8 * wasd_noise(vec2(far * 14.0, number) + own));
			float on_ray = step(far, length_of);
			lines = max(lines, (1.0 - smoothstep(wide * 0.5, wide, across)) * on_ray);
			flaked = max(flaked, (1.0 - smoothstep(wide, wide * 4.0, across)) * on_ray * (1.0 - far / length_of));
			// A branch leaves the crack partway out, to one side.
			float leaves = length_of * (0.3 + 0.4 * wasd_hash(own + number * 5.3));
			float leaving = heading + (wasd_noise(vec2(leaves * 5.0, number * 7.0) + own) - 0.5) * 0.7;
			float branch = leaving + (wasd_hash(own.yx + number * 2.7) < 0.5 ? -1.0 : 1.0) * (0.8 + 0.5 * wasd_hash(own + number * 1.3));
			lines = max(lines, wasd_line(at, vec2(cos(leaving), sin(leaving)) * leaves, vec2(cos(branch), sin(branch)), length_of * 0.3, 0.012));
		}
		float ring = 0.3 + 0.14 * wasd_noise(way * 2.4 + own);
		lines = max(lines, (1.0 - smoothstep(0.003, 0.008, abs(far - ring))) * step(0.52, wasd_noise(way * 3.1 + own.yx)));
		float crushed = 1.0 - smoothstep(0.05, 0.11 + 0.05 * wasd_noise(way * 3.0 + own), far);
		flaked = max(flaked, (1.0 - smoothstep(0.08, 0.2, far)));
		height = -0.02 * lines - 0.025 * crushed - 0.004 * flaked;
		vec3 color = mix(vec3(0.66, 0.64, 0.6) * (0.7 + 0.4 * wasd_noise(at * 13.0 + own)), vec3(0.03), max(lines, crushed * 0.7));
		return vec4(color, max(max(lines * 0.95, crushed * 0.9), flaked * 0.55 * (0.5 + 0.5 * wasd_noise(at * 21.0 + own.yx))));
	}
	// A shoe's sole with its toe toward the picture's top and turned a little outward: a wide ball of the foot, a narrow
	// arch on the outer side, a round heel. The left foot at an even number, the right at an odd one. The heel and the
	// ball press harder than the arch and the toe.
	float side = mod(floor(seed + 0.5), 2.0) < 0.5 ? -1.0 : 1.0;
	float turn = 0.16 * side;
	vec2 foot = mat2(vec2(cos(turn), sin(turn)), vec2(-sin(turn), cos(turn))) * at;
	float ball = length((foot - vec2(0.05 * side, -0.3)) / vec2(0.3, 0.44)) - 1.0;
	float heel = length((foot - vec2(-0.02 * side, 0.6)) / vec2(0.21, 0.24)) - 1.0;
	// The arch joins the two along the foot's outer edge.
	vec2 arch_off = foot - vec2(-0.1 * side, clamp(foot.y, -0.1, 0.5));
	float arch = length(arch_off / vec2(0.13, 0.13)) - 1.0;
	float shape = 1.0 - smoothstep(-0.12, 0.0, min(min(ball, heel), arch));
	float tread = 0.4 + 0.6 * step(0.42, fract(foot.y * 6.0 + 0.3 * sin(foot.x * 9.0)));
	float weight = max(max(1.0 - smoothstep(-0.6, 0.2, heel), (1.0 - smoothstep(-0.7, 0.1, ball)) * 0.85), 0.5);
	height = -0.012 * shape * tread;
	return vec4(vec3(1.0), shape * tread * weight * (0.82 + 0.18 * wasd_noise(foot * 12.0 + own)));
}

void fragment() {
	vec4 mark;
	if (kind == 0) {
		float column = mod(frame_index, frames.x);
		float row = floor(frame_index / frames.x);
		mark = texture(marks, (UV + vec2(column, row)) / frames);
	} else {
		float height;
		mark = wasd_mark(UV * 2.0 - 1.0, shape_seed, height);
		// The surface tilts by the slope of the mark's height, as seen from the camera.
		float meters = height * mark_side;
		vec3 across = dFdx(VERTEX);
		vec3 down = dFdy(VERTEX);
		vec3 first = cross(down, NORMAL);
		vec3 second = cross(NORMAL, across);
		float scale = dot(across, first);
		NORMAL = normalize(abs(scale) * NORMAL - sign(scale) * (dFdx(meters) * first + dFdy(meters) * second));
	}
	float alpha = mark.a * COLOR.a * clamp(life_left / max(fade, 0.001), 0.0, 1.0);
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	vec3 tint = COLOR.rgb;
#else
	// A mark's tint is a color as the screen shows it. The Compatibility renderer hands it over as light already;
	// the others hand it over as it is.
	vec3 tint = mix(pow((COLOR.rgb + 0.055) / 1.055, vec3(2.4)), COLOR.rgb / 12.92, step(COLOR.rgb, vec3(0.04045)));
#endif
	ALBEDO = mix(mark.rgb * tint, vec3(0.0), unlit);
	EMISSION = mark.rgb * tint * unlit;
	ROUGHNESS = mix(1.0, 0.12, shine);
	SPECULAR = 0.5 * shine;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	ALPHA = alpha;
#else
	// The Compatibility renderer blends the colors as the screen shows them and the others blend light itself, where
	// the same cover hides less: this makes a mark cover as much on every renderer.
	ALPHA = 1.0 - pow(1.0 - alpha, 2.2);
#endif
}
