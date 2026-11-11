extends Node3D
## Sky3D smoke test (render run): freezes game time, renders noon and midnight, and checks the sun
## light, the day/night state, and the brightness of the rendered sky and ground. Saves noon.png and night.png.

var failures: PackedStringArray = []
var sky: Sky3D


func _ready() -> void:
	sky = $Sky3D
	# Sky3D creates SunLight, MoonLight, SkyDome and TimeOfDay when it enters the tree; set its
	# time properties from code after that (in the .tscn they would be dropped).
	sky.game_time_enabled = false
	_run.call_deferred()


func _expect(label: String, ok: bool) -> void:
	if not ok:
		failures.append(label)


func _render(hour: float, file: String) -> Dictionary:
	sky.current_time = hour
	for i in 12:
		await get_tree().process_frame
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	var light_dir := -sky.sun.global_transform.basis.z  # direction the sun light travels
	return {
		"time": sky.tod.game_time,
		"day": sky.is_day(),
		"sun_energy": sky.sun.light_energy,
		"light_dir_y": light_dir.y,
		"sky": _mean_luminance(image, 0.05, 0.35),
		"ground": _mean_luminance(image, 0.75, 0.95),
	}


func _mean_luminance(image: Image, from: float, to: float) -> float:
	var total := 0.0
	var count := 0
	for y in range(int(image.get_height() * from), int(image.get_height() * to), 4):
		for x in range(0, image.get_width(), 4):
			total += image.get_pixel(x, y).get_luminance()
			count += 1
	return total / count


func _run() -> void:
	var noon := await _render(12.0, "noon.png")
	var night := await _render(0.0, "night.png")
	print("noon ", noon)
	print("night ", night)
	_expect("noon game_time %s" % noon.time, noon.time == "12:00:00")
	_expect("noon is day", noon.day)
	_expect("noon sun energy %f" % noon.sun_energy, noon.sun_energy > 0.5)
	_expect("noon sun shines down %f" % noon.light_dir_y, noon.light_dir_y < -0.3)
	_expect("night game_time %s" % night.time, night.time == "00:00:00")
	_expect("night is night", not night.day and sky.is_night())
	_expect("night sun energy %f" % night.sun_energy, is_zero_approx(night.sun_energy))
	_expect("night sun below horizon %f" % night.light_dir_y, night.light_dir_y > 0.3)
	_expect("noon sky brighter %f vs %f" % [noon.sky, night.sky], noon.sky > 0.3 and noon.sky > night.sky * 3.0)
	_expect("noon ground brighter %f vs %f" % [noon.ground, night.ground], noon.ground > night.ground * 2.0)
	if failures.is_empty():
		print("SMOKE_PASS sky3d")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(failures))
		get_tree().quit(1)
