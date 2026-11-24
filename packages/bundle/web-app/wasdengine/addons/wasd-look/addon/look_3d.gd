# SPDX-License-Identifier: CC0-1.0
# Lighting that looks right in one node: a sky with clouds, a sun with shadows, light bounced up from the ground, fog
# that fades the distance into the sky, exposure, glow, and contact shading, set by a `look` such as "noon",
# "golden_hour", "overcast", or "night", by an `hour` of a day that runs, or around a photographed sky. It is the
# scene's WorldEnvironment and owns its sun.
#
# The Compatibility renderer, which every Web build uses, adds each light that casts shadows on top of the finished
# picture instead of into the light the picture is made from, so the same sun comes out far brighter there than on
# Forward+ and Mobile, and it loses much of a sky's light on the way to the scene. This node gives its sun the energy
# and color that show the same picture on each renderer, and its skies hand each renderer their light as it takes it
# (look_tone.gdshaderinc).
class_name WasdLook3D
extends WorldEnvironment

## The moon took over from the sun as the light, or the sun from the moon: the moment to switch lamps on or off. The
## first hour of a day's clock tells which light is up, too.
signal night_changed(is_night: bool)
## The picture's values were set again: after a look, each step of a fade or of the day's clock, or a property. The
## moment to hand `get_horizon_color()` to whatever else fades into the sky.
signal applied

const SKY_SHADER := preload("res://addons/wasd_look/look_sky.gdshader")
const PANORAMA_SHADER := preload("res://addons/wasd_look/look_panorama.gdshader")
const READ_SHADER := preload("res://addons/wasd_look/look_read.gdshader")

## How much of the sky's light and of a sun of energy 1 an ordinary surface throws back, per unit of sky brightness
## and sun brightness: fitted to pictures of the same scenes on Forward+ and Compatibility.
const _SKY_PART := 0.34
const _SUN_PART := 0.36

## A look by name: one of WasdLookPresets.names(). Setting it sets the sun's place and the clouds too, and stops the
## day's clock.
@export var look := "noon": set = set_look
## Compass direction the sun shines from, in degrees: 0 is from -Z (north), 90 from +X (east).
@export_range(-180.0, 360.0, 0.1) var sun_azimuth := -35.0: set = _set_sun_azimuth
## Degrees of the sun above the horizon. Below 5 its light fades, and at 0 it is out.
@export_range(-90.0, 90.0, 0.1) var sun_elevation := 55.0: set = _set_sun_elevation
## How much of the sky the clouds cover, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var clouds := 0.35: set = _set_clouds
## How fast the clouds drift (1 is a light wind, 0 stops them) and the compass direction they drift toward.
@export_range(0.0, 20.0, 0.01) var cloud_drift := 1.0
@export_range(-180.0, 360.0, 0.1) var cloud_heading := 70.0
## Multiply the look's sun, sky light, fog, and exposure. 1 keeps the look.
@export_range(0.0, 4.0, 0.01) var sun_strength := 1.0: set = _set_sun_strength
@export_range(0.0, 4.0, 0.01) var ambient_strength := 1.0: set = _set_ambient_strength
@export_range(0.0, 8.0, 0.01) var fog_strength := 1.0: set = _set_fog_strength
@export_range(0.25, 4.0, 0.01) var exposure := 1.0: set = _set_exposure
## Meters at which the world has faded into the sky completely: set it to where the terrain or the level ends, so
## that its far edge never shows against the sky. 0 leaves the look's fog, which thins the distance without an end.
@export_range(0.0, 20000.0, 1.0) var view_distance := 0.0: set = _set_view_distance
## How far the sky is clouded over, from 0 to 1, on top of any look or hour: the sky and its light go gray, the sun
## weakens, clouds close, stars go, fog thickens. WASD Weather sets it; so may the game.
@export_range(0.0, 1.0, 0.01) var overcast := 0.0: set = _set_overcast
## Fog on top of the look's own, as a density per meter: 0.005 veils the distance as rain does, 0.03 is thick fog
## that hides everything beyond 80 meters. Thick fog takes the sky too. WASD Weather sets it; so may the game.
@export_range(0.0, 0.2, 0.0001) var added_fog := 0.0: set = _set_added_fog
## Whether the sun casts shadows.
@export var shadows := true: set = _set_shadows
## Fast: no edge smoothing, short hard shadows. Balanced: 2x edge smoothing, soft shadows that stay fine on what is
## within two meters of the camera, such as a face in a close-up, and noise against steps in the sky's gradients.
## Best: 4x and longer, softer shadows. Leave as set: the node keeps its hands off the viewport's and the project's
## settings.
@export_enum("Fast", "Balanced", "Best", "Leave as set") var quality := 1: set = _set_quality

@export_group("Day")
## Hour of the day from 0 to 24, or -1 for no clock. An hour blends the looks in `day_looks` and moves the sun, then
## the moon, along their arcs.
@export_range(-1.0, 24.0, 0.001) var hour := -1.0: set = set_hour
## Minutes a whole day takes while the game runs; 0 stops the clock at `hour`.
@export_range(0.0, 1440.0, 0.1) var day_minutes := 0.0
## Degrees above the horizon of the sun at noon and of the moon at midnight, and the compass direction of both then.
@export_range(10.0, 90.0, 0.1) var day_peak_elevation := 62.0
@export_range(-180.0, 360.0, 0.1) var day_peak_azimuth := 180.0
## The looks of a day: pairs of an hour and the look that hour shows, in order; the hours between blend. The sun rises
## at 6 and sets at 18.
@export var day_looks: Array = [[0.0, "night"], [5.3, "night"], [6.3, "dawn_mist"], [8.6, "noon"], [15.4, "noon"], [17.0, "golden_hour"], [17.7, "sunset"], [18.4, "night"], [24.0, "night"]]

@export_group("Photographed sky")
## A photographed sky (an HDRI as an equirectangular picture) to show instead of the drawn one. The look still gives
## the sun, fog, and exposure; `find_sun_in_panorama()` lines the sun up with the picture's.
@export var panorama: Texture2D: set = set_panorama
## Degrees the picture is turned about the vertical, clockwise seen from above.
@export_range(-180.0, 360.0, 0.1) var panorama_turn := 0.0: set = _set_panorama_turn
## Multiplies the picture's brightness. At 1 the picture is as bright as the look's drawn sky, whatever exposure it
## was taken at.
@export_range(0.05, 8.0, 0.01) var panorama_brightness := 1.0: set = _set_panorama_brightness

## The sun (or the moon, at night). Its energy and direction belong to this node.
var sun := DirectionalLight3D.new()
## Light thrown back up by the ground; it casts no shadows.
var bounce := DirectionalLight3D.new()

var _values: Dictionary = WasdLookPresets.values("noon")
## The values that show: the look's, clouded over by `overcast`.
var _shown: Dictionary = _values
var _sky := Sky.new()
var _sky_material := ShaderMaterial.new()
var _panorama_material := ShaderMaterial.new()
var _cloud_offset := Vector2.ZERO
## Whether a wind drives the clouds, and their own drift and heading from before it took them over.
var _wind_drives := false
var _own_drift := Vector2.ZERO
var _compatibility := RenderingServer.get_current_rendering_method() == "gl_compatibility"
var _night := false
## True while several values change at once, so that the picture is worked out once at the end.
var _holding := false
## The fade that runs, if any.
var _fade: Tween
## The average color (as light) of the photographed sky without its sun, its color at the horizon, and where its
## sun is, read when it is set.
var _panorama_color := Color(0.4, 0.5, 0.7)
var _panorama_horizon := Color(0.6, 0.7, 0.8)
var _panorama_sun := Vector2(0.0, 45.0)
## The photographed sky that a pass is reading, if any, and whether find_sun_in_panorama() was called since the sky
## was set, for the sun to move when that reading lands.
var _reading: Texture2D
var _sun_wanted := false


func _init() -> void:
	var noise := FastNoiseLite.new()
	noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	noise.frequency = 0.011
	noise.fractal_octaves = 5
	var cloud_noise := NoiseTexture2D.new()
	cloud_noise.noise = noise
	cloud_noise.seamless = true
	cloud_noise.width = 256
	cloud_noise.height = 256
	cloud_noise.generate_mipmaps = true
	_sky_material.shader = SKY_SHADER
	_sky_material.set_shader_parameter(&"cloud_noise", cloud_noise)
	_sky_material.set_shader_parameter(&"cloud_offset", _cloud_offset)
	_panorama_material.shader = PANORAMA_SHADER
	_sky.sky_material = _sky_material
	_sky.radiance_size = Sky.RADIANCE_SIZE_128
	# The sky's light is worked out again a part per frame while the clouds drift or the day runs.
	_sky.process_mode = Sky.PROCESS_MODE_INCREMENTAL
	environment = Environment.new()
	environment.background_mode = Environment.BG_SKY
	environment.sky = _sky
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	environment.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	# The skies undo this tone curve where the Compatibility renderer applies it to the sky's light, and that renderer
	# keeps brightness above white only while glow is on: both stay as set here.
	environment.tonemap_mode = Environment.TONE_MAPPER_AGX
	environment.glow_enabled = true
	environment.glow_bloom = 0.0
	environment.glow_hdr_threshold = 1.0
	environment.glow_hdr_scale = 2.0
	for level: int in range(1, 8):
		environment.set("glow_levels/%d" % [level], [0.0, 0.5, 1.0, 0.0, 0.0, 0.0, 0.0][level - 1])
	environment.adjustment_enabled = true
	environment.fog_sky_affect = 0.0
	sun.name = "Sun"
	sun.sky_mode = DirectionalLight3D.SKY_MODE_LIGHT_ONLY
	bounce.name = "Bounce"
	bounce.sky_mode = DirectionalLight3D.SKY_MODE_LIGHT_ONLY
	bounce.shadow_enabled = false
	bounce.light_specular = 0.0
	bounce.rotation_degrees = Vector3(90, 0, 0)
	add_child(sun)
	add_child(bounce)
	_apply()


func _enter_tree() -> void:
	# The quality belongs to the viewport the node is in, which may be another one each time the node enters a tree.
	_apply_quality()


func _ready() -> void:
	# Other WASD packs find the scene's look in this group, and ask it for the light and the horizon's color; WASD
	# Weather tells the wind to every node of the second group that has a `set_wind`.
	add_to_group(&"wasd_look")
	add_to_group(&"wasd_wind")


func _process(delta: float) -> void:
	if cloud_drift != 0.0 and panorama == null and clouds > 0.0:
		var heading := deg_to_rad(cloud_heading)
		_cloud_offset -= Vector2(sin(heading), -cos(heading)) * (cloud_drift * 0.0005 * delta)
		_cloud_offset = Vector2(fposmod(_cloud_offset.x, 1.0), fposmod(_cloud_offset.y, 1.0))
		_sky_material.set_shader_parameter(&"cloud_offset", _cloud_offset)
	if hour >= 0.0 and day_minutes > 0.0:
		hour = fposmod(hour + delta * 24.0 / (day_minutes * 60.0), 24.0)


## Takes the wind, in meters a second along the world's axes: the clouds drift where it blows, the faster the
## harder it blows. No wind, as WASD Weather tells when it leaves, gives the clouds back the `cloud_drift` and
## `cloud_heading` they had before a wind took them over.
func set_wind(wind: Vector3) -> void:
	var flat := Vector2(wind.x, wind.z)
	if flat.length() <= 0.01:
		if _wind_drives:
			_wind_drives = false
			cloud_drift = _own_drift.x
			cloud_heading = _own_drift.y
		return
	if not _wind_drives:
		_wind_drives = true
		_own_drift = Vector2(cloud_drift, cloud_heading)
	cloud_heading = rad_to_deg(atan2(flat.x, -flat.y))
	cloud_drift = flat.length() * 0.5


## Sets every value to a look's and stops the day's clock and a fade. An unknown name gives "noon" and a warning.
func set_look(value: String) -> void:
	if not WasdLookPresets.LOOKS.has(value):
		push_warning("WasdLook3D: no look named %s; the looks are %s." % [value, ", ".join(WasdLookPresets.names())])
	_stop_fade()
	look = value
	hour = -1.0
	_values = WasdLookPresets.values(value)
	_take_place_from_values()
	_apply()


## Changes single values of the look that shows, by the names in WasdLookPresets.BASE, such as
## `{"sky_top": Color(0.3, 0.2, 0.5), "fog": 0.01}`: the way to a look of the game's own. Numbers are kept as the
## look's own are (`"fog": 0` as 0.0); a color must be a Color. A change of `look`, a fade, or the day's clock
## replaces them.
func set_values(changes: Dictionary) -> void:
	for key: String in changes:
		if not WasdLookPresets.BASE.has(key):
			push_warning("WasdLook3D: no look value named %s; the names are %s." % [key, ", ".join(WasdLookPresets.BASE.keys())])
			continue
		var own: Variant = WasdLookPresets.BASE[key]
		if own is Color and changes[key] is not Color:
			push_warning("WasdLook3D: the look value %s is a Color, not %s." % [key, changes[key]])
			continue
		_values[key] = type_convert(changes[key], typeof(own))
	# The sun's place and the clouds are properties of their own: only those named change.
	_holding = true
	for key: String in ["sun_azimuth", "sun_elevation", "clouds"]:
		if changes.has(key):
			set(key, _values[key])
	_holding = false
	_apply()


## Fades to another look over `seconds`: colors, energies, the sun's place, and the clouds move from their values now to
## the look's. It stops the day's clock. Setting `look`, a running `hour`, or another fade stops the fade where it
## is, and its Tween's `finished` comes right after.
func fade_to(next: String, seconds: float) -> Tween:
	_stop_fade()
	hour = -1.0
	var from := _values.duplicate()
	from["sun_azimuth"] = sun_azimuth
	from["sun_elevation"] = sun_elevation
	from["clouds"] = clouds
	var to := WasdLookPresets.values(next)
	var step := func(weight: float) -> void:
		_values = WasdLookPresets.blend(from, to, weight)
		_take_place_from_values()
		_apply()
	_fade = create_tween()
	_fade.tween_method(step, 0.0, 1.0, seconds)
	_fade.tween_callback(func() -> void:
		# The fade ends here: setting the look it ends at must not stop it as one that another cuts short.
		_fade = null
		look = next)
	return _fade


## Stops the fade that runs, if any, where it is. A killed Tween does not finish by itself: its `finished` is emitted
## once the call that stopped it is over, so that whoever waits for it goes on after that call and cannot run inside it.
func _stop_fade() -> void:
	if _fade == null:
		return
	var stopped := _fade
	_fade = null
	stopped.kill()
	(func() -> void: stopped.finished.emit()).call_deferred()


## Shows the hour of a day (0 to 24): blends the looks of `day_looks` around it and puts the sun, or at night the moon,
## where that hour has it, and stops a fade. A negative hour stops the clock and keeps the picture as it is.
func set_hour(value: float) -> void:
	var starting := hour < 0.0
	hour = value
	if value < 0.0 or day_looks.is_empty():
		return
	_stop_fade()
	var before: Array = day_looks[0]
	var after: Array = day_looks[day_looks.size() - 1]
	for pair: Array in day_looks:
		if float(pair[0]) <= value:
			before = pair
		else:
			after = pair
			break
	var span := float(after[0]) - float(before[0])
	var weight := clampf((value - float(before[0])) / span, 0.0, 1.0) if span > 0.0 else 0.0
	_values = WasdLookPresets.blend(WasdLookPresets.values(before[1]), WasdLookPresets.values(after[1]), smoothstep(0.0, 1.0, weight))
	# The sun's arc runs from hour 6 to 18 and the moon's through the other half of the day.
	var by_day := value >= 6.0 and value < 18.0
	var along := fposmod(value - (6.0 if by_day else 18.0), 24.0) / 12.0
	_holding = true
	sun_elevation = day_peak_elevation * sin(along * PI)
	sun_azimuth = day_peak_azimuth - 90.0 + 180.0 * along
	_holding = false
	_apply()
	# The clock's first hour tells which light is up, and every change after it.
	if starting or _night == by_day:
		_night = not by_day
		night_changed.emit(_night)


## The color the far world fades into: the fog's, which is the sky's at the horizon and a little darker. For
## materials that fade into the distance by their own means, such as a terrain's haze.
func get_horizon_color() -> Color:
	var color := (environment.fog_light_color.srgb_to_linear() * environment.fog_light_energy).linear_to_srgb()
	return Color(color.r, color.g, color.b)


## Where to begin and end the fade of a material that fades into the distance by its own means, between a begin
## and an end in meters, so that it keeps step with this node's fog: (begin, end, 1, 0), as LiteTerrain's shader
## global `haze_range` takes it. It changes with fog and weather: hand it on at `applied`.
func get_haze_range() -> Vector4:
	var three_quarters_at := 100000.0
	if environment.fog_enabled and environment.fog_mode == Environment.FOG_MODE_DEPTH:
		# Where the fog hides three quarters: the place on its curve, then the distance that curve's place stands for.
		var place := pow(0.75, 1.0 / environment.fog_depth_curve)
		three_quarters_at = (0.5 - sin(asin(1.0 - 2.0 * place) / 3.0)) * environment.fog_depth_end
	elif environment.fog_enabled and environment.fog_density > 0.0:
		three_quarters_at = log(4.0) / environment.fog_density
	# A fade that eases in and out between its begin and end hides three quarters at 0.674 of the way.
	return Vector4(0.0, minf(three_quarters_at / 0.674, 100000.0), 1.0, 0.0)


## How brightly the scene is lit, from 0 to 1, for things that take no light themselves, such as smoke: 1 under a
## high sun, about 0.2 at night.
func get_light_level() -> float:
	var sunlight := sun.light_energy * sun.light_color.srgb_to_linear().get_luminance() if sun.visible else 0.0
	if _compatibility and shadows:
		# The sun's energy on this renderer is lowered; the look's own tells how bright the day is.
		sunlight = float(_shown["sun_energy"]) * sun_strength * smoothstep(0.0, 5.0, sun_elevation) * (_shown["sun_color"] as Color).srgb_to_linear().get_luminance() if sun.visible else 0.0
	var skylight := _sky_light().get_luminance() / _SKY_PART
	return clampf((sunlight * 0.5 + skylight) * environment.tonemap_exposure, 0.12, 1.0)


## Whether the moon is the light now: by the day's clock, or by a look with stars.
func is_night() -> bool:
	return _night if hour >= 0.0 else float(_shown["stars"]) > 0.5


## Shows a photographed sky, or with null the drawn one again. The picture must be a wide equirectangular one, twice
## as wide as high; an HDR picture (.hdr or .exr) lights the scene best.
func set_panorama(value: Texture2D) -> void:
	panorama = value
	_reading = null
	_sun_wanted = false
	if value == null:
		_sky.sky_material = _sky_material
	else:
		_read_panorama(value)
		_panorama_material.set_shader_parameter(&"panorama", value)
		_sky.sky_material = _panorama_material
	_apply()


## Puts the sun where the photographed sky has its brightest spot, so that shadows fall the way the picture's light
## does, and returns that place as (azimuth, elevation) in degrees. Skies without a visible sun, such as an overcast
## one, have no such spot worth following: set `sun_azimuth` and `sun_elevation` by hand for those. In a Web build,
## whose renderer hands pictures back cut off at 1, and for a sky with no light above 1, the sky is read a frame
## after it is set: until then this returns where the sun is, and the sun moves to the picture's when the reading
## lands.
func find_sun_in_panorama() -> Vector2:
	if panorama == null:
		push_warning("WasdLook3D: set a panorama before find_sun_in_panorama().")
		return Vector2(sun_azimuth, sun_elevation)
	_sun_wanted = true
	if _reading != null:
		return Vector2(sun_azimuth, sun_elevation)
	sun_elevation = _panorama_sun.y
	sun_azimuth = _panorama_sun.x + panorama_turn
	return Vector2(sun_azimuth, sun_elevation)


## Gives one of the game's own lights that casts shadows its energy and color: on Forward+ and Mobile `energy` and
## `color` as they are, and on Compatibility the values that show the same there, which are lower by an amount that
## depends on how bright the sky's light already makes the scene (next to nothing in a dark room, far lower in
## daylight). `reach` is how much of the light arrives where it matters, from 0 to 1: 1 for a second sun, about 0.3
## at half an OmniLight3D's or SpotLight3D's range. Call it again after the look changes. Lights without shadows
## need no such care: set their energy as usual.
func set_shadowed_light(light: Light3D, energy: float, color := Color.WHITE, reach := 0.3) -> void:
	var wanted := color.srgb_to_linear() * energy
	if _compatibility and energy > 0.0:
		wanted = _browser_light(wanted * reach) / reach
	var strongest := maxf(wanted.r, maxf(wanted.g, wanted.b))
	light.light_energy = strongest
	light.light_color = Color(wanted.r / strongest, wanted.g / strongest, wanted.b / strongest).linear_to_srgb() if strongest > 0.0 else color


## The look's drawn sky on average, as light.
func _drawn_sky_light() -> Color:
	return ((_shown["sky_top"] as Color).srgb_to_linear() + (_shown["sky_horizon"] as Color).srgb_to_linear()) * 0.5


## What an ordinary surface throws back of the sky's light alone.
func _sky_light() -> Color:
	var gain := _SKY_PART * float(_shown["sky_energy"]) * float(_shown["ambient"]) * ambient_strength
	if panorama == null:
		return _drawn_sky_light() * gain
	return _panorama_color * (gain * _panorama_gain())


## What a photographed sky is multiplied by: it is shown as bright as the look's drawn sky would be, whatever
## exposure it was taken at.
func _panorama_gain() -> float:
	return _drawn_sky_light().get_luminance() / maxf(_panorama_color.get_luminance(), 0.0001) * panorama_brightness


## The numbers of the engine's AgX tone curve for this Environment, as the engine works them out: contrast, toe,
## slope, and shoulder.
func _tone_curve() -> Vector4:
	const CROSSOVER := 0.18
	var contrast := environment.tonemap_agx_contrast
	var white := maxf(environment.tonemap_agx_white, 2.0)
	var toe := ((1.0 / CROSSOVER) - 1.0) * pow(CROSSOVER, contrast)
	var slope_under := pow(CROSSOVER, contrast) + toe
	var slope := contrast * pow(CROSSOVER, contrast - 1.0) * toe / (slope_under * slope_under)
	return Vector4(contrast, toe, slope, (white - CROSSOVER) * (white - CROSSOVER) / (1.0 - CROSSOVER) * slope)


## The Compatibility renderer keeps its picture as color values between drawing and the tone curve, and converts
## light to color values and back with these two approximations.
static func _engine_color(light: float) -> float:
	return maxf(1.055 * pow(light, 0.416666667) - 0.055, 0.0)


static func _engine_color_inverse(color: float) -> float:
	return pow((color + 0.055) / 1.055, 2.4)


## The color value the renderer's conversion from color values to light turns into `light`.
static func _engine_light_inverse(light: float) -> float:
	var color := _engine_color(light)
	for _step: int in 4:
		var off := color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878) - light
		color = maxf(color - off / (color * (color * 0.915918033 + 1.364342222) + 0.012522878), 0.0)
	return color


## The light (color as light, times energy) that a light casting shadows needs on the Compatibility renderer to
## show what `light` shows on the others. That renderer draws the scene's other light and each such light as
## pictures of their own, turns each into color values, and adds those; this finds, per color channel, the light
## whose sum reads back as the two lights together. The scene's other light is taken to be the sky's.
func _browser_light(light: Color) -> Color:
	var seen := environment.tonemap_exposure
	var base := _sky_light() * seen
	var part := _SUN_PART * seen
	return Color(_browser_part(light.r, base.r, part), _browser_part(light.g, base.g, part), _browser_part(light.b, base.b, part))


static func _browser_part(light: float, base: float, part: float) -> float:
	if light <= 0.0:
		return 0.0
	var added := _engine_light_inverse(base + part * light) - _engine_color(base)
	return _engine_color_inverse(maxf(added, 0.0)) / part


func _take_place_from_values() -> void:
	_holding = true
	sun_azimuth = _values["sun_azimuth"]
	sun_elevation = _values["sun_elevation"]
	clouds = _values["clouds"]
	_holding = false


func _apply() -> void:
	if _holding:
		return
	_shown = WasdLookPresets.clouded(_values, overcast) if overcast > 0.0 else _values
	var v := _shown
	var height := deg_to_rad(sun_elevation)
	var turn := deg_to_rad(sun_azimuth)
	var to_sun := Vector3(sin(turn) * cos(height), sin(height), -cos(turn) * cos(height))
	# The light fades out as the sun or moon reaches the horizon.
	var above := smoothstep(0.0, 5.0, sun_elevation)
	var shine := (1.0 if v["sun"] else 0.0) * clampf(sun_strength, 0.0, 1.5)
	var horizon: Color = v["sky_horizon"]
	if panorama == null:
		_sky_material.set_shader_parameter(&"sky_top", v["sky_top"])
		_sky_material.set_shader_parameter(&"sky_horizon", horizon)
		_sky_material.set_shader_parameter(&"ground_horizon", v["ground_horizon"])
		_sky_material.set_shader_parameter(&"ground_bottom", v["ground_bottom"])
		_sky_material.set_shader_parameter(&"sky_energy", v["sky_energy"])
		_sky_material.set_shader_parameter(&"sun_direction", to_sun)
		_sky_material.set_shader_parameter(&"sun_color", v["sun_color"])
		_sky_material.set_shader_parameter(&"sun_shine", shine)
		_sky_material.set_shader_parameter(&"sun_size", v["sun_size"])
		_sky_material.set_shader_parameter(&"sun_glow", v["sun_glow"])
		_sky_material.set_shader_parameter(&"clouds", _clouds_shown())
		_sky_material.set_shader_parameter(&"cloud_color", v["cloud_color"])
		_sky_material.set_shader_parameter(&"stars", v["stars"])
	else:
		# A photographed sky is shown as bright as the look's drawn sky would be, whatever exposure it was taken at.
		var gain := _panorama_gain()
		horizon = (_panorama_horizon * gain).linear_to_srgb()
		_panorama_material.set_shader_parameter(&"sky_energy", float(v["sky_energy"]) * gain)
		_panorama_material.set_shader_parameter(&"turn", panorama_turn / 360.0)
	var seen: float = float(v["exposure"]) * exposure
	var sky_material: ShaderMaterial = _sky.sky_material
	sky_material.set_shader_parameter(&"tone_curve", _tone_curve())
	sky_material.set_shader_parameter(&"tone_exposure", seen)
	sky_material.set_shader_parameter(&"light_gain", float(v["ambient"]) * ambient_strength)

	environment.tonemap_exposure = seen
	var energy: float = float(v["sun_energy"]) * sun_strength * above
	sun.visible = bool(v["sun"]) and energy > 0.0
	sun.shadow_enabled = shadows
	var sun_light := (v["sun_color"] as Color).srgb_to_linear() * energy
	if shadows and _compatibility and energy > 0.0:
		sun_light = _browser_light(sun_light)
	var strongest := maxf(sun_light.r, maxf(sun_light.g, sun_light.b))
	sun.light_energy = strongest
	sun.light_color = (sun_light / strongest).linear_to_srgb() if strongest > 0.0 else v["sun_color"]
	sun.basis = Basis.looking_at(-to_sun, Vector3.UP if absf(to_sun.y) < 0.999 else Vector3.FORWARD)

	bounce.visible = float(v["bounce"]) > 0.0 and sun.visible
	bounce.light_color = v["bounce_color"]
	bounce.light_energy = float(v["bounce"]) * float(v["sun_energy"]) * sun_strength * above * maxf(sin(height), 0.15)

	environment.tonemap_mode = Environment.TONE_MAPPER_AGX
	environment.tonemap_exposure = seen
	environment.adjustment_contrast = v["contrast"]
	environment.adjustment_saturation = v["saturation"]
	# Only what is brighter than white glows, in a tight halo: the one kind of glow the Compatibility renderer makes.
	# The renderers work their glow out differently; these two intensities come nearest to one picture.
	var glow: float = v["glow"]
	environment.glow_enabled = true
	environment.glow_intensity = ((0.3 + 0.5 * glow) if glow > 0.0 else 0.0) * (2.0 if _compatibility else 0.45)
	environment.ssao_enabled = v["contact_shading"]
	environment.ssao_radius = 0.6
	environment.ssao_intensity = 2.0
	# Fog takes the color of the sky at the horizon, so that the far ground fades into the sky.
	var fog: float = (float(v["fog"]) + added_fog) * fog_strength
	var mist: float = float(v["mist"]) * fog_strength
	environment.fog_enabled = fog > 0.0 or mist > 0.0
	# Thin fog leaves the sky alone, which has the horizon's color where the far ground fades; thick fog hides it.
	environment.fog_sky_affect = smoothstep(0.006, 0.04, fog)
	# A little darker than the horizon, so that far ground stands against the sky instead of glowing in it.
	environment.fog_light_color = horizon
	environment.fog_light_energy = float(v["sky_energy"]) * 0.9
	if view_distance > 0.0:
		# Fog that is complete at the view distance, or sooner where the fog itself has hidden nine tenths by then.
		# Its curve is bent so that near the camera, at a quarter of the way or 150 meters, it is as thick as fog
		# of that density is there; the bend has limits, or thick fog would whiten what stands right before the
		# camera.
		var end := minf(view_distance, 2.3 / fog) if fog > 0.0 else view_distance
		var near := minf(end * 0.25, 150.0)
		var along := near / end
		var unbent := along * along * (3.0 - 2.0 * along)
		var wanted := 1.0 - exp(-fog * near)
		environment.fog_mode = Environment.FOG_MODE_DEPTH
		environment.fog_depth_begin = 0.0
		environment.fog_depth_end = end
		environment.fog_depth_curve = clampf(log(maxf(wanted, 0.0001)) / log(unbent), 0.4, 3.0)
		environment.fog_density = 1.0
		environment.fog_enabled = true
	else:
		environment.fog_mode = Environment.FOG_MODE_EXPONENTIAL
		environment.fog_density = fog
	environment.fog_height = v["mist_height"]
	environment.fog_height_density = mist
	applied.emit()


func _apply_quality() -> void:
	# Out of the tree there is no viewport to set: entering one applies the quality.
	if not is_inside_tree() or quality > 2:
		return
	get_viewport().msaa_3d = [Viewport.MSAA_DISABLED, Viewport.MSAA_2X, Viewport.MSAA_4X][quality]
	# A little noise that keeps the sky's wide gradients from showing steps.
	get_viewport().use_debanding = quality > 0
	RenderingServer.directional_soft_shadow_filter_set_quality([RenderingServer.SHADOW_QUALITY_SOFT_LOW, RenderingServer.SHADOW_QUALITY_SOFT_MEDIUM, RenderingServer.SHADOW_QUALITY_SOFT_HIGH][quality])
	RenderingServer.directional_shadow_atlas_set_size([2048, 4096, 4096][quality], true)
	sun.directional_shadow_mode = [DirectionalLight3D.SHADOW_ORTHOGONAL, DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS, DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS][quality]
	sun.directional_shadow_max_distance = [40.0, 80.0, 140.0][quality]
	# Of the four ranges of shadow, the nearest ends two meters from the camera: a shadow map that is spread over
	# more leaves the shadows on a face in a close-up as blocks. The next end at 8 and at 24 or 35 meters.
	sun.directional_shadow_split_1 = [0.1, 0.025, 0.015][quality]
	sun.directional_shadow_split_2 = [0.2, 0.1, 0.06][quality]
	sun.directional_shadow_split_3 = [0.5, 0.3, 0.25][quality]
	sun.directional_shadow_blend_splits = quality > 0
	sun.shadow_blur = [0.8, 1.2, 1.6][quality]


## Reads from a photographed sky where its sun is, how bright the sky is without it, and the color at its horizon.
func _read_panorama(texture: Texture2D) -> void:
	_reading = null
	var image := texture.get_image()
	if image == null or image.is_empty():
		return
	if image.is_compressed():
		image.decompress()
	# A picture in a float format holds light; one in bytes holds color values. The texture tells its own format, which
	# a picture handed back as bytes has lost.
	var is_light := _holds_light(texture.get_format()) or _holds_light(image.get_format())
	_panorama_material.set_shader_parameter(&"picture_is_light", is_light)
	image.convert(Image.FORMAT_RGBAF)
	if not is_light:
		image.srgb_to_linear()
	while image.get_width() > 256 and image.get_width() % 2 == 0 and image.get_height() % 2 == 0:
		image.shrink_x2()
	if is_light and _brightest(image) <= 1.0:
		# The renderer handed the light back cut off at 1, as the Compatibility renderer does in Web builds, or the sky
		# has none above 1: a pass of its own reads it whole.
		_read_through_pass(texture, image.get_size())
		return
	_take_reading(image)


## Reads a photographed sky's light through look_read.gdshader into a picture of `size` pixels, a frame later, and
## takes that reading; the sun then moves to the picture's if find_sun_in_panorama() asked for it meanwhile.
func _read_through_pass(texture: Texture2D, size: Vector2i) -> void:
	_reading = texture
	if not is_node_ready():
		await ready
		if _reading != texture:
			return
	var reader := SubViewport.new()
	reader.size = size
	reader.disable_3d = true
	reader.transparent_bg = true
	reader.render_target_update_mode = SubViewport.UPDATE_ONCE
	var cover := ColorRect.new()
	cover.size = Vector2(size)
	var material := ShaderMaterial.new()
	material.shader = READ_SHADER
	material.set_shader_parameter(&"picture", texture)
	material.set_shader_parameter(&"block", Vector2i(texture.get_size()) / size)
	cover.material = material
	reader.add_child(cover)
	add_child(reader, false, Node.INTERNAL_MODE_BACK)
	await RenderingServer.frame_post_draw
	var bytes := reader.get_texture().get_image()
	reader.queue_free()
	if _reading != texture:
		return
	_reading = null
	if bytes == null or bytes.get_size() != size:
		push_warning("WasdLook3D: the photographed sky could not be read; set sun_azimuth and sun_elevation by hand.")
		return
	bytes.convert(Image.FORMAT_RGBA8)
	var light := Image.create(size.x, size.y, false, Image.FORMAT_RGBAF)
	for y: int in size.y:
		for x: int in size.x:
			var stored := bytes.get_pixel(x, y)
			var power := pow(2.0, roundf(stored.a * 255.0) - 128.0)
			light.set_pixel(x, y, Color(stored.r * power, stored.g * power, stored.b * power))
	_take_reading(light)
	if _sun_wanted:
		find_sun_in_panorama()
	_apply()


## Whether pictures of a format hold light, in floats, instead of color values.
static func _holds_light(format: Image.Format) -> bool:
	return (format >= Image.FORMAT_RF and format <= Image.FORMAT_RGBE9995) or format in [Image.FORMAT_BPTC_RGBF, Image.FORMAT_BPTC_RGBFU, Image.FORMAT_ASTC_4x4_HDR, Image.FORMAT_ASTC_8x8_HDR]


## The largest value of any pixel of a picture.
static func _brightest(image: Image) -> float:
	var largest := 0.0
	for y: int in image.get_height():
		for x: int in image.get_width():
			var pixel := image.get_pixel(x, y)
			largest = maxf(largest, maxf(pixel.r, maxf(pixel.g, pixel.b)))
	return largest


## Takes from a photographed sky's light, in a picture shrunk to about 256 pixels across, where its sun is, how bright
## the sky is without it, and the color at its horizon.
func _take_reading(image: Image) -> void:
	var size := image.get_size()
	# First the place of the brightest spot and a rough brightness with the sun cut off, then the sky's brightness
	# and its color at the horizon with everything far above that cut off.
	var brightest := -1.0
	var sun_at := Vector2.ZERO
	var rough := 0.0
	var weight := 0.0
	for y: int in size.y / 2:
		var latitude := (0.5 - (y + 0.5) / size.y) * PI
		for x: int in size.x:
			var value := image.get_pixel(x, y).get_luminance()
			if value > brightest:
				brightest = value
				sun_at = Vector2(x, y)
			rough += minf(value, 4.0) * cos(latitude)
			weight += cos(latitude)
	var limit := 6.0 * rough / maxf(weight, 1.0)
	var total := Color(0, 0, 0)
	var band := Color(0, 0, 0)
	var band_count := 0
	for y: int in size.y:
		var latitude := (0.5 - (y + 0.5) / size.y) * PI
		for x: int in size.x:
			var pixel := image.get_pixel(x, y)
			if latitude > 0.0:
				total += Color(minf(pixel.r, limit), minf(pixel.g, limit), minf(pixel.b, limit)) * cos(latitude)
			if absf(latitude) < 0.07:
				band += Color(minf(pixel.r, limit), minf(pixel.g, limit), minf(pixel.b, limit))
				band_count += 1
	_panorama_color = total / maxf(weight, 1.0)
	if band_count > 0:
		_panorama_horizon = Color(band.r / band_count, band.g / band_count, band.b / band_count)
	# The sun's place is the center of the brightness around the brightest spot.
	var center := Vector2.ZERO
	var center_weight := 0.0
	for y: int in range(maxi(int(sun_at.y) - 2, 0), mini(int(sun_at.y) + 3, size.y)):
		for x: int in range(int(sun_at.x) - 2, int(sun_at.x) + 3):
			var value := image.get_pixel(posmod(x, size.x), y).get_luminance()
			center += Vector2(x + 0.5, y + 0.5) * value
			center_weight += value
	if center_weight > 0.0:
		center /= center_weight
	else:
		center = sun_at + Vector2(0.5, 0.5)
	_panorama_sun = Vector2(fposmod(center.x / size.x * 360.0, 360.0), 90.0 - center.y / size.y * 180.0)

func _set_sun_azimuth(value: float) -> void:
	sun_azimuth = value
	_apply()


func _set_sun_elevation(value: float) -> void:
	sun_elevation = value
	_apply()


func _set_clouds(value: float) -> void:
	clouds = value
	_sky_material.set_shader_parameter(&"clouds", _clouds_shown())


## The clouds that show: a sky four fifths overcast is closed.
func _clouds_shown() -> float:
	return maxf(clouds, minf(overcast * 1.25, 1.0))


func _set_overcast(value: float) -> void:
	overcast = clampf(value, 0.0, 1.0)
	_apply()


func _set_added_fog(value: float) -> void:
	added_fog = maxf(value, 0.0)
	_apply()


func _set_sun_strength(value: float) -> void:
	sun_strength = value
	_apply()


func _set_ambient_strength(value: float) -> void:
	ambient_strength = value
	_apply()


func _set_fog_strength(value: float) -> void:
	fog_strength = value
	_apply()


func _set_exposure(value: float) -> void:
	exposure = value
	_apply()


func _set_view_distance(value: float) -> void:
	view_distance = value
	_apply()


func _set_shadows(value: bool) -> void:
	shadows = value
	_apply()


func _set_quality(value: int) -> void:
	quality = clampi(value, 0, 3)
	_apply_quality()


func _set_panorama_turn(value: float) -> void:
	panorama_turn = value
	_apply()


func _set_panorama_brightness(value: float) -> void:
	panorama_brightness = value
	_apply()
