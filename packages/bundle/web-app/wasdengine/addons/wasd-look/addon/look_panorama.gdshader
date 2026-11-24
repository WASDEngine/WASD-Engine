// SPDX-License-Identifier: CC0-1.0
// The sky of WasdLook3D when it shows a photographed sky (an HDRI). The picture's own sun is far brighter than
// anything else in it and casts no shadows, so the light the sky gives the scene stops at 1; the node's sun, which
// does cast shadows, lights the scene from the same direction instead.
shader_type sky;

#include "res://addons/wasd_look/look_tone.gdshaderinc"

uniform sampler2D panorama : source_color, filter_linear, repeat_enable;
// Whether the picture holds light (an HDR picture) instead of color values (a PNG or JPEG).
uniform bool picture_is_light = true;
uniform float sky_energy = 1.0;
// Turns of the picture about the vertical, clockwise seen from above, from 0 to 1.
uniform float turn = 0.0;

void sky() {
	vec3 color = texture(panorama, SKY_COORDS - vec2(turn, 0.0)).rgb;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	// This renderer reads every picture as it is stored; the others turn color values into light as they read.
	if (!picture_is_light) {
		color = wasd_light(color);
	}
#endif
	COLOR = wasd_sky_out(color * sky_energy, AT_CUBEMAP_PASS);
}
