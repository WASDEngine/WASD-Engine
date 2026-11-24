// SPDX-License-Identifier: CC0-1.0
// Eyelashes and eyebrows from their picture: fine hairs on a card that lies on the skin or stands out from a lid.
// A lash card is seen nearly edge-on, where a picture's smaller copies blur its hairs into a film that tints the
// whole lid: the picture is read sharper than its size on the screen asks for, so that hairs stay thin and dark
// with skin between them. Where the mesh says that the hairs thin out, in the alpha of its vertices' color, as the
// mpfb guide's humans say it toward the tips of their lashes, they fade: from a step away lashes are a dark line
// along the lid, not a fan that lies on it.
shader_type spatial;
render_mode cull_disabled;

uniform sampler2D picture : source_color, filter_linear_mipmap_anisotropic;
uniform vec3 tint : source_color = vec3(1.0);
// How many sizes sharper than the screen asks for the picture is read.
uniform float sharp : hint_range(0.0, 3.0) = 1.0;
// How far what is faint in the picture is cleared away and what is dense made solid: 1 for lashes, whose hairs
// stand apart with skin between them; 0 leaves the picture as it is, for brows, whose hairs lie on a soft shade of
// their own color and are thin and scratched without it.
uniform float clean : hint_range(0.0, 1.0) = 1.0;

void fragment() {
	vec4 shown = texture(picture, UV, -sharp);
	ALBEDO = shown.rgb * tint;
	ALPHA = mix(shown.a, smoothstep(0.05, 0.95, shown.a), clean) * COLOR.a;
	ROUGHNESS = 0.7;
	SPECULAR = 0.15;
}
