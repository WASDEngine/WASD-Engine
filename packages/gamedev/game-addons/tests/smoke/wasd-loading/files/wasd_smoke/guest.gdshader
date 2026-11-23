shader_type spatial;
// A shader that only the guest uses.
void fragment() {
	ALBEDO = vec3(0.2, 0.5 + 0.5 * sin(UV.y * 30.0), 0.9);
}
