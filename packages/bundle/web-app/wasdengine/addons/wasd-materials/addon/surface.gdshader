// SPDX-License-Identifier: CC0-1.0
// Every surface of WASD Materials: concrete, bricks, planks, metal, rock, sand, and the rest are this one shader
// with other numbers. It needs no texture file and no UV map: it lays its patterns out in meters of the world (or
// of the object), from three sides, so a wall, a floor, and a boulder all come out at the right scale.
shader_type spatial;

// One small picture made in code and shared by every surface: red and green hold the slope of a noise, blue its
// height, alpha a second noise that knows nothing of the first.
uniform sampler2D grain : repeat_enable, filter_linear_mipmap_anisotropic;
// The surface's color, a second color that shows in blotches, and how much of the surface the blotches take.
uniform vec3 color : source_color = vec3(0.6);
uniform vec3 color_spots : source_color = vec3(0.5);
uniform float spots : hint_range(0.0, 1.0) = 0.3;
// Meters across one repeat of the broad unevenness, how many times finer the grain is, and how far both are drawn
// out along the first axis of each side (wood grain, brushed metal).
uniform float size = 2.0;
uniform float fine = 7.0;
uniform float drawn_out = 1.0;
// How much the broad and the fine unevenness shade the color, and how much they bump the surface.
uniform float shade = 0.25;
uniform float shade_fine = 0.2;
uniform float bump = 0.5;
uniform float bump_fine = 0.5;
// How dark the hollows of the fine unevenness are: the shade that small pits and pores hold.
uniform float hollows : hint_range(0.0, 1.0) = 0.15;
// Specks of another color strewn through the surface, such as the stones in concrete: how many, and their color.
uniform float specks : hint_range(0.0, 1.0) = 0.0;
uniform vec3 speck_color : source_color = vec3(0.3);
uniform float roughness : hint_range(0.0, 1.0) = 0.8;
uniform float roughness_spread = 0.15;
uniform float metallic : hint_range(0.0, 1.0) = 0.0;
// A pattern of pieces: 0 none, 1 bricks (every other row set off by half), 2 tiles, 3 planks (every row set off by
// its own amount), 4 lines only, as on a builder's grid. A piece's length and height in meters, the gap between
// pieces in meters and its color, how deep it lies, and how much pieces differ from one another.
uniform int pattern = 0;
uniform vec2 piece = vec2(0.24, 0.08);
uniform float gap = 0.012;
uniform vec3 gap_color : source_color = vec3(0.7);
uniform float gap_depth = 0.6;
uniform float piece_spread = 0.15;
// Wear: where the second noise runs high the surface gives way to another, such as bare steel under paint or
// rust on steel. How much of the surface, its color, and how rough and how metallic it is.
uniform float wear : hint_range(0.0, 1.0) = 0.0;
uniform vec3 wear_color : source_color = vec3(0.4);
uniform float wear_roughness = 0.5;
uniform float wear_metallic = 0.0;
// Glints as on snow and sand, from 0 to 1.
uniform float sparkle : hint_range(0.0, 1.0) = 0.0;
// True lays the pattern out in the object's own meters, so that it moves and turns with the object.
uniform bool with_object = false;

varying vec3 place;
varying vec3 facing;

void vertex() {
	if (with_object) {
		place = VERTEX;
		facing = NORMAL;
	} else {
		place = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
		facing = normalize(MODEL_NORMAL_MATRIX * NORMAL);
	}
}

float wasd_hash(vec2 at) {
	return fract(sin(dot(at, vec2(127.1, 311.7))) * 43758.5453);
}

void fragment() {
	vec3 normal = normalize(facing);
	// How much each of the three sides counts here: nearly all of one on a flat face, a blend round a curve.
	vec3 side = pow(abs(normal), vec3(6.0));
	side /= side.x + side.y + side.z;
	// The three sides' own flat coordinates, in meters; the up axis is the second one on walls.
	vec2 at_x = place.zy;
	vec2 at_y = place.xz;
	vec2 at_z = place.xy;
	vec2 draw = vec2(1.0 / drawn_out, 1.0);
	vec4 broad_x = texture(grain, at_x * draw / size);
	vec4 broad_y = texture(grain, at_y * draw / size);
	vec4 broad_z = texture(grain, at_z * draw / size);
	vec4 fine_x = texture(grain, at_x * draw * fine / size + vec2(0.37, 0.61));
	vec4 fine_y = texture(grain, at_y * draw * fine / size + vec2(0.37, 0.61));
	vec4 fine_z = texture(grain, at_z * draw * fine / size + vec2(0.37, 0.61));
	vec4 broad = broad_x * side.x + broad_y * side.y + broad_z * side.z;
	vec4 small = fine_x * side.x + fine_y * side.y + fine_z * side.z;

	// The surface's lean from its bumps, side by side, in the space the pattern lies in.
	vec2 lean_x = (broad_x.rg - 0.5) * bump + (fine_x.rg - 0.5) * bump_fine;
	vec2 lean_y = (broad_y.rg - 0.5) * bump + (fine_y.rg - 0.5) * bump_fine;
	vec2 lean_z = (broad_z.rg - 0.5) * bump + (fine_z.rg - 0.5) * bump_fine;

	// The color: blotches of the second color, shaded by the unevenness.
	vec3 tone = mix(color, color_spots, smoothstep(0.42, 0.62, broad.a * 0.7 + small.a * 0.3) * spots);
	tone *= 1.0 + (broad.b - 0.5) * shade * 2.0 + (small.b - 0.5) * shade_fine * 2.0;
	tone *= 1.0 - hollows * smoothstep(0.38, 0.16, small.b) * (0.6 + 0.4 * smoothstep(0.6, 0.3, broad.b));
	if (specks > 0.0) {
		tone = mix(tone, speck_color, smoothstep(1.0 - specks * 0.3, 1.0 - specks * 0.3 + 0.04, small.a) * 0.85);
	}
	float rough = roughness + (small.b - 0.5) * roughness_spread * 2.0 + (broad.a - 0.5) * roughness_spread;
	float metal = metallic;

	// Pieces, laid out on the side that counts most here.
	if (pattern > 0) {
		vec2 at = side.x > side.y && side.x > side.z ? at_x : (side.y > side.z ? at_y : at_z);
		float row = floor(at.y / piece.y);
		float set_off = pattern == 1 ? 0.5 * mod(row, 2.0) : (pattern == 3 ? wasd_hash(vec2(row, 7.0)) : 0.0);
		vec2 in_rows = vec2(at.x / piece.x + set_off, at.y / piece.y);
		vec2 which = floor(in_rows);
		vec2 within = fract(in_rows);
		// Meters to the nearest edge of the piece, along and across.
		vec2 to_edge = min(within, 1.0 - within) * piece;
		vec2 soft = max(fwidth(at), vec2(0.0005));
		vec2 open = 1.0 - smoothstep(vec2(gap * 0.5), vec2(gap * 0.5) + soft * 1.5 + gap * 0.25, to_edge);
		float in_gap = max(open.x, open.y);
		if (pattern == 4) {
			// A builder's grid: lines only, a stronger one every fifth piece.
			float fifth = max(step(mod(which.x + step(0.5, within.x), 5.0), 0.5) * open.x, step(mod(which.y + step(0.5, within.y), 5.0), 0.5) * open.y);
			tone = mix(tone, gap_color, in_gap * (0.45 + 0.55 * fifth));
		} else {
			// Every piece has a shade and a tint of its own, and one in eight is a darker one.
			float own = wasd_hash(which);
			float other = wasd_hash(which + vec2(31.7, 5.3));
			tone = mix(tone, color_spots * (0.9 + 0.2 * small.b), other * min(piece_spread * 2.5, 0.7));
			tone *= (1.0 + (own - 0.5) * piece_spread * 2.0) * mix(1.0, 0.74, step(0.875, other) * min(piece_spread * 4.0, 1.0));
			// A piece's edge lies in the shade of the gap beside it.
			tone *= 1.0 - 0.3 * gap_depth * smoothstep(gap * 3.5, gap * 0.5, min(to_edge.x, to_edge.y));
			tone = mix(tone, gap_color * (0.85 + 0.3 * small.b), in_gap);
			rough = mix(rough, 0.95, in_gap);
			// The edge of a piece slopes down into the gap.
			vec2 slope = sign(within - 0.5) * smoothstep(vec2(gap * 2.5), vec2(gap * 0.5), to_edge) * (1.0 - in_gap) * gap_depth;
			if (side.x > side.y && side.x > side.z) {
				lean_x += slope;
			} else if (side.y > side.z) {
				lean_y += slope;
			} else {
				lean_z += slope;
			}
		}
	}

	// Wear: the other surface where the second noise runs high.
	if (wear > 0.0) {
		float wearing = broad.a * 0.88 + small.a * 0.12 + (0.5 - small.b) * 0.06;
		float worn = smoothstep(1.0 - wear, 1.0 - wear + 0.05, wearing);
		// Round a worn patch the coat is thin: a paler rim, as of an undercoat.
		tone = mix(tone, tone * 1.25 + 0.08, smoothstep(1.0 - wear - 0.07, 1.0 - wear, wearing) * (1.0 - worn) * 0.8);
		tone = mix(tone, wear_color * (0.8 + 0.4 * small.b), worn);
		rough = mix(rough, wear_roughness, worn);
		metal = mix(metal, wear_metallic, worn);
	}

	vec3 bumped = normalize(normal
		+ vec3(0.0, lean_x.y, lean_x.x) * side.x
		+ vec3(lean_y.x, 0.0, lean_y.y) * side.y
		+ vec3(lean_z.x, lean_z.y, 0.0) * side.z);
	NORMAL = normalize(with_object ? MODEL_NORMAL_MATRIX * bumped : bumped);
	NORMAL = normalize((VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
	ALBEDO = clamp(tone, vec3(0.0), vec3(1.0));
	ROUGHNESS = clamp(rough, 0.03, 1.0);
	METALLIC = metal;
	if (sparkle > 0.0) {
		// Grains that catch the light as the eye moves past them.
		vec2 grain_at = (side.y > 0.5 ? at_y : (side.x > side.z ? at_x : at_z)) * 220.0;
		float glint = step(1.0 - 0.012 * sparkle, wasd_hash(floor(grain_at) + floor(VIEW.xy * 14.0)));
		ROUGHNESS = mix(ROUGHNESS, 0.05, glint);
		SPECULAR = mix(0.5, 1.0, glint);
	}
}
