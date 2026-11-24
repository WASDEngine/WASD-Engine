shader_type canvas_item;
// A shader that only the 2D guest uses.
void fragment() {
	COLOR = vec4(0.9, 0.4 + 0.4 * sin(UV.x * 30.0), 0.2, 1.0);
}
