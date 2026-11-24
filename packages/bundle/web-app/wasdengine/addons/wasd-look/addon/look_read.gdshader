// SPDX-License-Identifier: CC0-1.0
// A pass with which WasdLook3D reads the light of a photographed sky where the renderer hands a picture back only as
// bytes cut off at 1, as the Compatibility renderer does in Web builds. Each pixel of the pass holds the average light
// of one block of the picture: its three values divided by the power of two that brings the largest of them to 1 or
// just under, and that power, plus 128, in the fourth byte.
shader_type canvas_item;
render_mode blend_disabled, unshaded;

uniform sampler2D picture : filter_nearest, repeat_disable;
// Texels of the picture in one block, across and down.
uniform ivec2 block = ivec2(1, 1);

void fragment() {
	ivec2 blocks = max(textureSize(picture, 0) / block, ivec2(1));
	ivec2 start = min(ivec2(UV * vec2(blocks)), blocks - 1) * block;
	vec3 light = vec3(0.0);
	for (int y = 0; y < block.y; y++) {
		for (int x = 0; x < block.x; x++) {
			light += max(texelFetch(picture, start + ivec2(x, y), 0).rgb, vec3(0.0));
		}
	}
	light /= float(block.x * block.y);
	float power = clamp(ceil(log2(max(max(light.r, max(light.g, light.b)), 1e-30))), -127.0, 127.0);
	vec3 part = light / exp2(power);
	// log2 can come out a little low: the largest part stays at 1 or under.
	if (max(part.r, max(part.g, part.b)) > 1.0) {
		power += 1.0;
		part *= 0.5;
	}
	COLOR = vec4(part, (power + 128.0) / 255.0);
}
