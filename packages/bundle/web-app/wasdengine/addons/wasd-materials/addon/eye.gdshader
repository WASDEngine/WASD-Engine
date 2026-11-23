// SPDX-License-Identifier: CC0-1.0
// An eye: a wet ball in the shade of its lids. The upper lid and its lashes shade the top of an eye and keep the
// sky from mirroring in it, and its corners lie deep between the lids: an eye that is lit evenly from corner to
// corner and mirrors the sky all over is a painted ball, and it stares. A small catchlight keeps its place before
// the viewer wherever the scene's lights stand, as a photographer's lamp would: an eye without one looks dead. It
// is as bright as the light that falls on the eye, and gone in the dark, where an eye that glows is an animal's.
shader_type spatial;

uniform sampler2D picture : source_color, filter_linear_mipmap_anisotropic;
uniform vec3 tint : source_color = vec3(1.0);
// How bright the catchlight is beside the light that falls on the eye.
uniform float catchlight : hint_range(0.0, 2.0) = 1.0;
// How dark the lids' shade lies on the eye.
uniform float lid_shade : hint_range(0.0, 1.0) = 0.5;
// Which way is up for the head and which way it faces, in the world: a face that leans or turns may set them, so
// the shade stays under the lids. A front left at nothing is the model's own.
uniform vec3 head_up = vec3(0.0, 1.0, 0.0);
uniform vec3 head_ahead = vec3(0.0);
// Where the picture has each eye of a mesh that holds both eyes of a face: the middle of the left eye's part of the
// picture, and of the right eye's. Such eyes show the pink flesh of their inner corners, toward the nose: the corner
// belongs to the face, not to the ball, and stays in its place while the eye turns. Without it an eye is white all
// the way to the nose, and looks past what it looks at. Left at nothing, an eye shows no inner corner.
uniform vec4 eye_middles = vec4(0.0);

void fragment() {
	vec3 shown = texture(picture, UV).rgb * tint;
	// Where on the eye this point lies, by where the ball's surface faces: up or down it, and out to a corner.
	vec3 out_of = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
	vec3 up = normalize(head_up);
	vec3 ahead = dot(head_ahead, head_ahead) > 0.01 ? normalize(head_ahead) : normalize((MODEL_MATRIX * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
	// To the character's left: a character faces +Z.
	float across = dot(out_of, normalize(cross(up, ahead)));
	float height = dot(out_of, up);
	float above = smoothstep(-0.05, 0.45, height);
	float below = smoothstep(0.3, 0.7, -height);
	float corner = smoothstep(0.4, 0.9, abs(across));
	float open = 1.0 - lid_shade * min(above * 0.9 + below * 0.4 + corner * 0.65, 1.0);
	// The flesh of the inner corner, toward the nose: the last few millimeters of what the lids leave open. The
	// left eye is the one whose part of the picture this point lies nearer to.
	float side = distance(UV, eye_middles.xy) < distance(UV, eye_middles.zw) ? 1.0 : -1.0;
	float flesh = smoothstep(0.5, 0.64, -across * side) * (1.0 - smoothstep(0.2, 0.5, abs(height)))
			* step(0.05, distance(eye_middles.xy, eye_middles.zw));
	shown = mix(shown, vec3(0.8, 0.5, 0.47), flesh * 0.9);
	// The shade between the lids is warm: it is the lids' own color that lights it. An iris gathers light through
	// the cornea before it and is never as dark as the shade it lies in: a dark eye in the shade of its brow is
	// brown, not a black bead. It gives back a quarter more than a painted ball would.
	vec3 lit = shown * mix(1.0, open, 0.6) * mix(vec3(1.0), vec3(1.0, 0.88, 0.84), corner * 0.6) * (1.25 - 0.25 * flesh);
	// One soft lamp a little up and to the side of the viewer, where the lids do not hide it: a spot that gives
	// back many times the light that falls on it, as the mirror image of the brightest thing before a face does.
	float lamp = (1.0 - smoothstep(0.045, 0.095, length(NORMAL.xy - vec2(-0.12, 0.07)))) * step(0.0, NORMAL.z);
	ALBEDO = mix(lit, vec3(7.0, 6.9, 6.7) * mix(1.0, open, 0.5), clamp(lamp * catchlight, 0.0, 1.0));
	// Wet, but no mirror: an eye that mirrored the whole sky would have blue whites under it.
	ROUGHNESS = 0.26;
	SPECULAR = 0.15;
	// The lids keep the sky off the eye as they keep the light off it.
	AO = open;
	AO_LIGHT_AFFECT = 0.4 * lid_shade;
}
