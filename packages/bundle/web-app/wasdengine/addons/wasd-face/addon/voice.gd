# SPDX-License-Identifier: CC0-1.0
# Reads how loud a recorded voice is over time, so that a mouth can move with it in every build: a Web build plays
# sounds outside the engine's mixer, where no bus meter hears them. It decodes the sound itself, through a playback
# of its own that nobody hears, half a second of it each time it is asked, so no frame waits for a long recording.
# It reads every sound that has a length: WAV, MP3, and Ogg Vorbis files and sounds made in code. A microphone, a
# generator, or a randomizer has none, and WasdFace3D moves the mouth by rhythm for those.
class_name WasdVoice
extends RefCounted

## Loudness values a second.
const RATE := 50.0

## Values read each time `level_at` is called for a sound that is not read to its end: half a second.
const _STEP := 25
## The longest sound that is read, in seconds; what follows is taken for silence.
const _LONGEST := 600.0
## Of a sound's samples, every one in this many is measured, which tells its loudness as well as all of them.
const _STRIDE := 4
## A window without sound, among loudness values.
const _SILENT := -1000.0
## How far below a recording's loud moments a sound still opens the mouth, in doublings of its strength: 4.5 are 27 dB.
const _RANGE := 4.5


## What has been read of one sound.
class _Reading:
	## The playback that decodes the sound; none once the sound is read to its end.
	var playback: AudioStreamPlayback
	## The sound's length in seconds.
	var length := 0.0
	## The loudness of each fiftieth of a second read so far: the base 2 logarithm of its strength, or `_SILENT`.
	var raw := PackedFloat32Array()
	## The values of `raw` that hold sound.
	var heard := PackedFloat32Array()
	## The loudness of the sound's loud moments among what has been read: a level of 1.
	var loud := 0.0
	## Values still to read.
	var left := 0


## What has been read of the sounds asked about so far, by the sound's instance id.
static var _known := {}


## Whether a sound's loudness can be read: it has a length and a playback.
static func reads(stream: AudioStream) -> bool:
	return _reading(stream) != null


## The loudness at a time of a sound that is playing, from 0 (silence) to 1 (its loud moments); 0 for a sound that
## cannot be read. Each call reads half a second more of the sound until all of it is read, so a face calls it every
## frame while the sound plays. A time past the end of a sound that loops is taken from its start again.
static func level_at(stream: AudioStream, seconds: float) -> float:
	var reading := _reading(stream)
	if reading == null:
		return 0.0
	if seconds > reading.length + 0.25:
		seconds = fmod(seconds, reading.length)
	var at := int(seconds * RATE)
	# A sound that was started in its middle is read up to there at once.
	_read(reading, maxi(_STEP, at + 1 - reading.raw.size()))
	return _level(reading, at) if at >= 0 and at < reading.raw.size() else 0.0


## How loud a sound is over time: values from 0 to 1, `RATE` a second from its start. It reads the whole sound at
## once, which takes a few milliseconds for each second of it; empty for a sound that cannot be read.
static func levels(stream: AudioStream) -> PackedFloat32Array:
	var all := PackedFloat32Array()
	var reading := _reading(stream)
	if reading == null:
		return all
	_read(reading, reading.left)
	all.resize(reading.raw.size())
	for index: int in all.size():
		all[index] = _level(reading, index)
	return all


## What has been read of a sound, which starts a reading for a sound that is new; none for a sound without a length
## or a playback.
static func _reading(stream: AudioStream) -> _Reading:
	if stream == null:
		return null
	var key := stream.get_instance_id()
	if not _known.has(key):
		var reading: _Reading = null
		var length := stream.get_length()
		var playback := stream.instantiate_playback() if length > 0.0 else null
		if playback != null:
			reading = _Reading.new()
			reading.playback = playback
			reading.length = length
			reading.left = ceili(minf(length, _LONGEST) * RATE)
			playback.start(0.0)
		_known[key] = reading
		# A game's voices come and go: the sounds asked about longest ago are forgotten.
		if _known.size() > 64:
			_known.erase(_known.keys()[0])
	return _known[key]


## Reads more of a sound: up to `count` values, each from the samples of a fiftieth of a second.
static func _read(reading: _Reading, count: int) -> void:
	count = mini(count, reading.left)
	if count <= 0 or reading.playback == null:
		return
	# The playback gives samples at the rate the game's sound runs at.
	var each := AudioServer.get_mix_rate() / RATE
	var done := reading.raw.size()
	var first := roundi(done * each)
	var frames := reading.playback.mix_audio(1.0, roundi((done + count) * each) - first)
	for index: int in count:
		var begin := roundi((done + index) * each) - first
		var end := mini(roundi((done + index + 1) * each) - first, frames.size())
		if end <= begin:
			break
		var sum := 0.0
		var measured := 0
		for frame: int in range(begin, end, _STRIDE):
			sum += frames[frame].length_squared()
			measured += 1
		# A frame is the left and the right sample; less than a two-thousandth of full strength is a quiet room.
		var strength := sqrt(sum / (2.0 * measured))
		var value := log(strength) / log(2.0) if strength > 0.0005 else _SILENT
		reading.raw.append(value)
		if value > _SILENT:
			reading.heard.append(value)
	reading.left = ceili(minf(reading.length, _LONGEST) * RATE) - reading.raw.size()
	if frames.size() < roundi((done + count) * each) - first or not reading.playback.is_playing():
		reading.left = 0
	if reading.left <= 0:
		reading.left = 0
		reading.playback = null
	if not reading.heard.is_empty():
		var sorted := reading.heard.duplicate()
		sorted.sort()
		reading.loud = sorted[int((sorted.size() - 1) * 0.9)]


## One value as a level from 0 to 1: the sound's loud moments are 1, what is `_RANGE` doublings weaker is 0, and so is
## silence. Ears and mouths work in ratios, so a syllable half as strong still opens the mouth most of the way.
static func _level(reading: _Reading, index: int) -> float:
	var level := clampf(1.0 - (reading.loud - reading.raw[index]) / _RANGE, 0.0, 1.0)
	return 0.0 if level < 0.08 else level
