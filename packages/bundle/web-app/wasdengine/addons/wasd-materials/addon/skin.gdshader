// SPDX-License-Identifier: CC0-1.0
// Skin: light wraps a little way round a limb or a cheek, and comes out warm where light turns to shade, as it
// does from skin that light has entered. Skin in the shade keeps its warmth instead of taking the sky's blue, its
// hollows are dim and warm instead of gray, and a shadow that falls on it is not black. Its oily parts shine, in
// patches and through pores instead of in one sheet, the lines of its picture are pressed into it, and its edges
// catch a soft sheen. It stands in for subsurface scattering, which Web builds do not draw.
shader_type spatial;

uniform sampler2D picture : source_color, filter_linear_mipmap_anisotropic;
uniform sampler2D relief : hint_normal, filter_linear_mipmap_anisotropic;
uniform bool has_relief = false;
// Where skin is glossy and where matte: a picture whose green is the roughness, as a glTF material's is.
uniform sampler2D gloss : hint_roughness_g, filter_linear_mipmap;
uniform bool has_gloss = false;
// How open each point lies to the sky: a picture whose red is 1 in the open and 0 deep in a hollow, as a glTF
// material's occlusion is. The scene's own light is dimmed by it, a lamp's and the sun's only a little.
uniform sampler2D shade : hint_default_white, filter_linear_mipmap;
uniform bool has_shade = false;
// The small picture of noise that every surface shares, which gives skin its pores and its patches.
uniform sampler2D grain : filter_linear_mipmap, repeat_enable;
uniform vec3 tint : source_color = vec3(1.0);
uniform float roughness : hint_range(0.0, 1.0) = 0.5;
// How far light wraps round into the shade, and the color of light that has passed through skin.
uniform float soft : hint_range(0.0, 1.0) = 0.36;
uniform vec3 under : source_color = vec3(0.9, 0.3, 0.2);
// How much warmer skin is in the scene's own light than in a lamp's or the sun's: the blood under it.
uniform float warmth : hint_range(0.0, 1.0) = 0.3;
// The share of the sun's light that still reaches skin in a shadow, through the skin and off what is near.
uniform float leak : hint_range(0.0, 0.5) = 0.3;
// How much of a light comes back at the skin from the viewer's side, as off a pale wall or a photographer's
// reflector: it keeps the side of a face that is turned from the sun from going flat and dark.
uniform float fill : hint_range(0.0, 0.5) = 0.12;
// How much skin shines where it is glossy, and the soft sheen along its edges, from the fine hairs on it.
uniform float shine : hint_range(0.0, 2.0) = 0.75;
uniform float sheen : hint_range(0.0, 1.0) = 0.15;
// How deep the pores are: they break a highlight up, as skin's does, where the view is close.
uniform float pores : hint_range(0.0, 1.0) = 0.3;
// How deep the picture's own lines are pressed into the skin: wrinkles, the lips' edge, the folds beside the nose.
uniform float creases : hint_range(0.0, 2.0) = 0.45;
// Whether the relief is that of a face's folds: the grooves that a smile presses into it, beside the nose, at the
// mouth's corners, and under the eyes, and a frown's, between the brows and over the chin. Such a mesh says in its
// second UV map where a smile folds it (U) and where a frown does (V), as the mpfb guide's humans do, and the
// grooves are pressed in by how far the face smiles and frowns now, which WasdFace3D sets as the face moves.
uniform bool has_folds = false;
uniform vec2 folds = vec2(0.0);

const vec3 WARM = vec3(1.0, 0.8, 0.68);
const vec3 WEIGHTS = vec3(0.2126, 0.7152, 0.0722);

// How fair the skin is at this point: blood shows through fair skin, and dark skin that is made as warm turns red.
varying float fair;

// How red a color is beside how light it is: the same on a wrinkle as on the skin round it, and more on a lip.
float ruddy(vec3 color) {
	return (color.r - (color.g + color.b) * 0.5) / max(dot(color, WEIGHTS), 0.05);
}

void fragment() {
	vec3 shown = texture(picture, UV).rgb * tint;
	fair = smoothstep(0.02, 0.2, dot(shown, WEIGHTS));
	// Lips and other red skin are moister than the rest, and shine more.
	float red = smoothstep(0.1, 0.3, shown.r - (shown.g + shown.b) * 0.5);
	float open = has_shade ? texture(shade, UV).r : 1.0;
	vec3 bump = has_relief ? texture(relief, UV).rgb : vec3(0.5, 0.5, 1.0);
	if (has_relief && has_folds) {
		// A face's folds are pressed in by as much as the face smiles or frowns where the mesh says a smile or a
		// frown folds it. A groove's sides turn to and from a lamp or the sun, and its floor, whose depth is what
		// the relief's blue lacks of a whole normal, shuts out some of the sky's light.
		float pressed = clamp(dot(UV2, folds), 0.0, 1.0);
		vec2 lean = bump.xy * 2.0 - 1.0;
		float whole = sqrt(max(1.0 - dot(lean, lean), 0.04));
		float groove = clamp(2.0 * (1.0 - (bump.b * 2.0 - 1.0) / whole) - 0.04, 0.0, 1.0) * pressed;
		bump = mix(vec3(0.5, 0.5, 1.0), vec3(bump.xy, whole * 0.5 + 0.5), pressed);
		open *= 1.0 - 0.7 * groove;
		shown *= 1.0 - 0.26 * groove;
	}
	// The scene's own light, from the sky and the ground, meets a warmer skin than a lamp does; light() takes
	// the warmth out again for lamps and the sun. What light reaches a deep hollow has passed through flesh.
	vec3 warm = mix(vec3(1.0), WARM, warmth * mix(0.3, 1.0, fair));
	vec3 hollow = mix(vec3(1.0), vec3(1.0, 0.84, 0.76), smoothstep(0.3, 0.8, 1.0 - open) * 0.5 * mix(0.4, 1.0, fair));
	ALBEDO = shown * hollow * warm / max(warm.r, 0.001);
	AO = open;
	AO_LIGHT_AFFECT = 0.2;
	// Skin is glossy and matte in patches a thumb wide, which keeps the sky from lying on it in one even sheet.
	float rough = (has_gloss ? texture(gloss, UV).g : roughness) + (texture(grain, UV * 7.0).a - 0.5) * 0.2;
	ROUGHNESS = clamp(rough * mix(1.0, 0.7, red), 0.2, 1.0);
	// A hollow mirrors no sky.
	SPECULAR = mix(0.2, 0.4, red) * mix(0.4, 1.0, open);
	// Pores: the noise's slope, laid on the skin many times over, and gone where a pore is smaller than a pixel.
	vec2 fine = UV * 140.0;
	float near = 1.0 - smoothstep(0.15, 0.6, max(length(dFdx(fine)), length(dFdy(fine))));
	bump.xy += (texture(grain, fine).rg - 0.5) * 0.3 * pores * near;
	// The picture's own lines: what is painted dark lies deeper than what is painted light beside it.
	vec2 step_over = vec2(1.0 / 700.0, 0.0);
	vec3 before = texture(picture, UV - step_over).rgb;
	vec3 after = texture(picture, UV + step_over).rgb;
	vec3 under_it = texture(picture, UV + step_over.yx).rgb;
	vec3 over_it = texture(picture, UV - step_over.yx).rgb;
	float across = dot(before - after, WEIGHTS);
	float down = dot(under_it - over_it, WEIGHTS);
	// A wrinkle is darker than the skin round it and of the same color. Where the color itself turns, as at the
	// edge of the lips' red, nothing is pressed in: the edge of a color is no groove, and one drawn there runs
	// round the mouth as a dark line on its shaded side.
	float groove = 1.0 - smoothstep(0.04, 0.16, abs(ruddy(before) - ruddy(after)) + abs(ruddy(under_it) - ruddy(over_it)));
	// A line is as deep as it is dark beside the skin round it, whatever the skin's tone; the speckle of a dark
	// picture, which is coarse in so few steps of light, is no line.
	bump.xy += clamp(vec2(across, down) / max(dot(shown, WEIGHTS), 0.14), vec2(-0.2), vec2(0.2)) * creases * 0.6 * (1.0 - red) * groove;
	NORMAL_MAP = bump;
}

void light() {
	float toward = dot(NORMAL, LIGHT);
	float wrapped = clamp((toward + soft) / (1.0 + soft), 0.0, 1.0);
	// A warm band where the light gives way to shade.
	float turning = smoothstep(0.0, 0.14, wrapped) * (1.0 - smoothstep(0.14, 0.42, wrapped));
	vec3 warm = mix(vec3(1.0), WARM, warmth * mix(0.3, 1.0, fair));
	vec3 cool = warm.r / max(warm, vec3(0.001));
	// Where a cheek or a limb turns from the sun it lies in its own shadow, which a shadow map draws as a hard line
	// across the skin just where wrapped light fades out by itself: there the wrap alone decides, and a shadow
	// counts in full only on skin that faces the sun.
	float cast = LIGHT_IS_DIRECTIONAL ? mix(1.0, ATTENUATION, smoothstep(0.0, 0.4, toward)) : ATTENUATION;
	// A shadow on skin is filled a little by the light that the skin round it passes on.
	float reach = LIGHT_IS_DIRECTIONAL ? mix(leak, 1.0, cast) : ATTENUATION;
	DIFFUSE_LIGHT += (vec3(wrapped) + under * turning * 0.2 * mix(0.3, 1.0, fair)) * cool * reach * LIGHT_COLOR / PI;
	// The light that comes back from the viewer's side, where the light itself falls short: half of it where the
	// light is shut out. Skin that the light meets full on gets none, or it would burn out.
	DIFFUSE_LIGHT += fill * clamp(dot(NORMAL, VIEW), 0.0, 1.0) * (1.0 - wrapped * (LIGHT_IS_DIRECTIONAL ? cast : 1.0)) * cool
			* (LIGHT_IS_DIRECTIONAL ? mix(0.5, 1.0, cast) : ATTENUATION) * LIGHT_COLOR / PI;
	// The highlight of oily skin: small and bright where the skin is glossy, wide and faint where it is matte.
	float shiny = 2.0 / max(pow(ROUGHNESS, 4.0), 0.0005) - 2.0;
	float facing = clamp(dot(NORMAL, normalize(LIGHT + VIEW)), 0.0, 1.0);
	float glint = pow(facing, shiny) * (shiny + 8.0) / 25.0;
	SPECULAR_LIGHT += glint * 0.04 * shine * clamp(toward, 0.0, 1.0) * ATTENUATION * LIGHT_COLOR;
	// The sheen: light that grazes the skin on the side it comes from.
	float edge = pow(1.0 - clamp(dot(NORMAL, VIEW), 0.0, 1.0), 4.0);
	SPECULAR_LIGHT += edge * sheen * 0.12 * wrapped * ATTENUATION * LIGHT_COLOR;
}
