// SPDX-License-Identifier: CC0-1.0
// A rope's tube: WasdRope3D hands the rope's points to this shader, which bends one fixed tube along them, so that a
// rope costs one draw call and no mesh is built while the game runs. It draws a laid rope's wound strands with their
// relief, a smooth cable, a wire rope, or a knobby vine, with shadows, on the Forward+, Mobile, and Compatibility
// renderers. A rope far away stays at least a pixel and a half wide, so that it does not break into dots.
shader_type spatial;

// The rope's points in the node's own space, a unit vector across the rope at each, and how many there are.
uniform vec3 points[32];
uniform vec3 sides[32];
uniform int count = 2;
// Half the rope's thickness, and its length, in meters.
uniform float radius = 0.02;
uniform float rope_length = 4.0;
uniform vec3 color : source_color = vec3(0.62, 0.5, 0.34);
// 1 draws the wound strands of a laid rope with their grooves, 0 a smooth cable; and how many strands there are.
uniform float strands : hint_range(0.0, 1.0) = 1.0;
uniform float strand_count = 3.0;
uniform float roughness : hint_range(0.0, 1.0) = 0.9;
uniform float metallic : hint_range(0.0, 1.0) = 0.0;
// How much the thickness swells and narrows along the rope, as a vine's does.
uniform float knobs : hint_range(0.0, 1.0) = 0.0;
// 1 swells the rope into a knot at this node, and at the far end where it is tied.
uniform float knot_start = 0.0;
uniform float knot_end = 0.0;
// 1 closes the far end and binds it with a whipping, as a rope's loose end is.
uniform float loose_end = 0.0;

varying vec3 along_view;
varying float wide;

void vertex() {
	float at = UV.y * float(count - 1);
	int index = min(int(floor(at)), count - 2);
	float part = at - float(index);
	// A smooth curve through the points.
	vec3 before = points[max(index - 1, 0)];
	vec3 from = points[index];
	vec3 to = points[index + 1];
	vec3 after = points[min(index + 2, count - 1)];
	vec3 second = 2.0 * before - 5.0 * from + 4.0 * to - after;
	vec3 third = 3.0 * from - before - 3.0 * to + after;
	vec3 centre = 0.5 * (2.0 * from + (to - before) * part + second * part * part + third * part * part * part);
	vec3 heading = 0.5 * ((to - before) + 2.0 * second * part + 3.0 * third * part * part);
	vec3 along = length(heading) > 0.00001 ? normalize(heading) : vec3(0.0, -1.0, 0.0);
	vec3 side = mix(sides[index], sides[index + 1], part);
	side = side - along * dot(side, along);
	side = length(side) > 0.00001 ? normalize(side) : normalize(cross(along, vec3(0.31, 0.95, 0.07)));
	vec3 outward = side * VERTEX.x + cross(along, side) * VERTEX.z;
	float meters = UV.y * rope_length;
	wide = radius * (1.0 + knobs * 0.35 * (sin(meters * 9.0) * sin(meters * 23.0 + 1.3)));
	// A knot is a lump a few thicknesses long.
	float lump = knot_start * (1.0 - smoothstep(radius * 2.0, radius * 6.0, meters)) + knot_end * (1.0 - smoothstep(radius * 2.0, radius * 6.0, rope_length - meters));
	wide *= 1.0 + 0.9 * lump * sin(clamp(min(meters, rope_length - meters) / (radius * 6.0), 0.0, 1.0) * PI + 0.6);
	// A loose end closes to a point over the last thickness, behind a narrow band of whipping.
	float left = rope_length - meters;
	wide *= mix(1.0, sqrt(clamp(left / (radius * 1.2), 0.0, 1.0)) * (1.0 + 0.18 * smoothstep(radius * 3.0, radius * 3.6, left) * (1.0 - smoothstep(radius * 5.4, radius * 6.0, left))), loose_end);
	// Never thinner on the screen than a pixel and a half.
	float depth = -(MODELVIEW_MATRIX * vec4(centre, 1.0)).z;
	float pixel = (PROJECTION_MATRIX[3][3] > 0.5 ? 1.0 : max(depth, 0.0)) * 2.0 / (PROJECTION_MATRIX[1][1] * VIEWPORT_SIZE.y);
	wide = max(wide, pixel * 0.75);
	VERTEX = centre + outward * wide;
	NORMAL = outward;
	along_view = (MODELVIEW_MATRIX * vec4(along, 0.0)).xyz;
	// Across the rope from 0 to 1, and along it in meters.
	UV = vec2(UV.x, meters);
}

void fragment() {
	// The strands wind once round the rope every seven times its radius.
	float turns = 1.0 / (radius * 7.0);
	float wound = fract(UV.x * strand_count + UV.y * turns * strand_count / 3.0);
	// Each strand is round: high along its middle, low and dark in the groove between it and the next.
	float strand = sin(wound * PI);
	float groove = 1.0 - smoothstep(0.0, 0.5, strand);
	// Fibers run along each strand, the other way round.
	float fiber = 0.88 + 0.12 * sin((UV.x * strand_count - UV.y / (radius * 2.2)) * TAU);
	// A vine is darker here and paler there along its length.
	float patch = 1.0 + knobs * 0.3 * sin(UV.y * 5.0 + 0.8) * sin(UV.y * 13.0);
	// A loose end's whipping is a dark band.
	float left = rope_length - UV.y;
	float whipped = loose_end * smoothstep(radius * 3.0, radius * 3.4, left) * (1.0 - smoothstep(radius * 5.6, radius * 6.0, left));
	ALBEDO = color * patch * mix(1.0, (0.62 + 0.38 * strand) * (1.0 - 0.72 * groove) * fiber, strands * (1.0 - whipped)) * (1.0 - 0.55 * whipped);
	ROUGHNESS = mix(roughness, 1.0, strands * groove * (1.0 - metallic));
	METALLIC = metallic;
	// The strands' relief: the surface leans away from each strand's middle, round the rope and along it.
	vec3 axis = normalize(along_view);
	vec3 round = normalize(cross(axis, NORMAL));
	float slope = cos(wound * PI) * PI * 0.34 * radius * strands * (1.0 - whipped);
	NORMAL = normalize(NORMAL - slope * (round * strand_count / (TAU * radius) + axis * turns * strand_count / 3.0));
}
