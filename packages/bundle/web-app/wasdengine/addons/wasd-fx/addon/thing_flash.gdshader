// SPDX-License-Identifier: CC0-1.0
// A flash over a thing: one color over its whole surface, as when it is hit. Drawn over the thing's own materials.
shader_type spatial;
render_mode unshaded, blend_mix, depth_draw_never, shadows_disabled, fog_disabled;

uniform vec3 color : source_color = vec3(1.0);
uniform float strength : hint_range(0.0, 1.0) = 1.0;

void fragment() {
	// Not quite solid at its strongest, so that the thing keeps its shading and shape.
	ALBEDO = color;
	ALPHA = strength * 0.72;
}
