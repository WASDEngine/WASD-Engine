// SPDX-License-Identifier: CC0-1.0
// An outline of even width in pixels round a mesh: the mesh once more, turned inside out and pushed outward along
// its normals. It wants smooth normals: where a mesh's faces do not share normals, as at a cube's corners, the
// line opens.
shader_type spatial;
render_mode unshaded, cull_front, shadows_disabled;

uniform float width = 2.0;
uniform vec3 color : source_color = vec3(0.05, 0.05, 0.07);

void vertex() {
	vec4 shown = PROJECTION_MATRIX * (MODELVIEW_MATRIX * vec4(VERTEX, 1.0));
	vec3 outward = mat3(PROJECTION_MATRIX) * (MODELVIEW_NORMAL_MATRIX * NORMAL);
	vec2 push = normalize(outward.xy + vec2(0.00001));
	shown.xy += push * width * 2.0 / VIEWPORT_SIZE * shown.w;
	POSITION = shown;
}

void fragment() {
	ALBEDO = color;
}
