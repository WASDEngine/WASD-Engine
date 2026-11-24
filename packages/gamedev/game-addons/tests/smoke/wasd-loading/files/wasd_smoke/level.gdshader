shader_type spatial;
// A shader of the level's own, so that the level has something to compile.
uniform vec3 tone : source_color = vec3(0.8, 0.4, 0.2);

void fragment() {
	ALBEDO = tone * (0.6 + 0.4 * sin(UV.x * 40.0));
}
