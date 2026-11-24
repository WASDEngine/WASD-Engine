// SPDX-License-Identifier: CC0-1.0
// An outline of even width in pixels round a thing: the thing once more, turned inside out and pushed outward
// along its normals, over its own materials. It wants smooth normals: at hard edges, as on a plain box, the line
// opens.
shader_type spatial;
render_mode unshaded, cull_front, shadows_disabled, fog_disabled;

uniform vec3 color : source_color = vec3(1.0, 0.85, 0.3);
uniform float width = 3.0;

void vertex() {
	vec4 shown = PROJECTION_MATRIX * (MODELVIEW_MATRIX * vec4(VERTEX, 1.0));
	vec3 outward = mat3(PROJECTION_MATRIX) * (MODELVIEW_NORMAL_MATRIX * NORMAL);
	shown.xy += normalize(outward.xy + vec2(0.00001)) * width * 2.0 / VIEWPORT_SIZE * shown.w;
	POSITION = shown;
}

void fragment() {
	ALBEDO = color;
}
