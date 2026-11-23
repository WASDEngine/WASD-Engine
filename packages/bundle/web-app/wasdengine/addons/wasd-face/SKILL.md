---
name: wasd-face
description: WASD Face 1.0.0 is installed in this project. WasdFace3D gives a character's face life in one node, with blinks, eyes and a head that turn to what the character looks at and glance as a person's do, a mouth that shapes the syllables of any voice recording as it plays, in Web builds too, and feelings, on every model that has face blend shapes or eye bones, such as an MPFB human with a face, a VRM model, or a model with ARKit's shapes. Load before a character is seen up close or speaks.
---

# WASD Face 1.0.0

`res://addons/wasd_face/` (CC0, written by WASD Engine; global classes, no plugin to enable). An MPFB human blinked, looked around, and spoke a recorded line with it at 60 fps in a Web build.

## Give a model a face

```gdscript
var face := WasdFace3D.add_to(model)      # null when the model has no face to move
```

It adds one `WasdFace3D` under the model's `Skeleton3D` (`WasdFace3D.fits(model)` asks without adding). A `WasdCharacter3D` of `wasd-character` does this by itself: its face is `hero.face`, or null. From then on the face blinks every few seconds and its eyes wander a little, over any animation that plays.

A human that the `mpfb` guide's `wasd_mpfb` made is also dressed, where `wasd-materials` is installed: `add_to` has `WasdSurface.human(model)` give it skin, eyes, a mouth, lashes, and hair that hold up close. Install both add-ons for such a human: with the materials it comes in with, its lashes smear into a band over each eye and its teeth take the sky's blue. `WasdFace3D.dress_humans = false`, set before, keeps a model's own materials.

The face moves what the model has, and keeps still where a part is missing. `face.has("blink")`, `"mouth"`, `"eyes"`, and `"head"` tell:

| Part | The model needs | Names it knows, without regard to case or to `_`, `.`, and spaces |
|---|---|---|
| blink | a blend shape for each lid, or one for both | `blink_l` and `blink_r`, `eyeBlinkLeft` and `eyeBlinkRight`, `Fcl_EYE_Close_L` and `_R`; `blink`, `eyesClosed`, `Fcl_EYE_Close` |
| mouth | a blend shape that opens it | `mouth_open`, `jawOpen`, `mouthOpen`, `aa`, `A`, `viseme_aa`, `Fcl_MTH_A` |
| eyes | two eye bones | `LeftEye` and `RightEye` (a retargeted humanoid), `eye_l` and `eye_r`, `eye.L` and `eye.R` |
| head | a head bone | `Head`, `head` |

Where they come from: an MPFB human gets all four, teeth, and a tongue from `wasd_mpfb.human()` and `add_face(body)` in Blender (the `mpfb` guide); VRM models and most avatar models bring them; a model made in Blender needs shape keys by these names on the head's mesh, and a mouth that is modelled inside, since through the open mouth of a head that is a shell the scene shows. `face.shapes()` lists every blend shape of the model's meshes.

## Looking

```gdscript
face.look_target = player              # any Node3D; null looks ahead again
face.look_at_point(Vector3(4, 1.5, 0))  # or a point of the world
face.look_ahead()
```

The head takes `head_share` (0.6) of a turn to the side and more of one up or down, up to `head_reach` (45 degrees), of which the neck takes a third, and the eyes the rest, up to `eye_reach` (28); each eye aims by itself, so they meet on what is near. Eyes that look at something do not rest on one spot of it: they go from one of its eyes to the other and to its mouth, now and then away and back, and blink on the way to something new. A target that is a character with a face, such as a `WasdCharacter3D`, is looked at in its face, and one without at the height of its eyes, not at its feet. What is behind the head is not looked at. `head_share = 0.0` leaves the head to the animation, so only the eyes follow. A model that does not face +Z at rest sets `face.front`.

The face's node sits between the eyes and faces as the head does: `face.global_position` is where a camera or another character looks at this one, as in `camera.look_at(guard.face.global_position)`. In a conversation give each speaker the other as target, and the player's camera to whoever addresses the player.

## Speaking

```gdscript
face.speak($Voice)                     # once: an AudioStreamPlayer, AudioStreamPlayer2D, or AudioStreamPlayer3D
$Voice.stream = preload("res://voice/guard_halt.mp3")
$Voice.play()                          # the mouth moves while it plays, at any later time too
```

The mouth follows the recording's loudness: wide on loud syllables, less on soft ones, shut in the pauses. Where the model has `mouth_wide` and `mouth_narrow`, each syllable also takes one of a few shapes, and a stressed one lifts the brows and dips the head a little, as speech does. It reads the sound itself, WAV, MP3, or Ogg Vorbis, half a second of it in each of the first frames, which took 1.3 ms in a browser, so it works where no meter can hear the sound, as in a Web build, and a line from `elevenlabs_speech` needs nothing done to it. `mouth_reach` (0.85) is how wide the loudest syllable opens the mouth.

- A line shown as text with no voice: `face.talk(seconds)` moves the mouth in the rhythm of speech, about `text.length() / 15.0` seconds for English.
- A sound with no length, such as a microphone or an `AudioStreamRandomizer`, also moves it by rhythm while it plays.
- A game that moves the mouth itself sets `face.mouth` from 0 to 1.
- For a 2D portrait or a meter, `WasdVoice.level_at(stream, player.get_playback_position())` gives the loudness from 0 to 1, and `WasdVoice.levels(stream)` all of it, 50 values a second.

The lips follow loudness, not the sounds of the words: right at a game's distances and in dialogue close-ups, not for a film's close-up.

## Feelings and expressions

```gdscript
face.feel("smile")                     # a feeling by its name, all of it, over 0.4 s
face.feel("surprised", 1.0, 0.15)      # how much of it, and faster
face.feel("smile", 0.0)                # lets it go
face.express("brows_up", 0.6, 0.1)     # any blend shape by its name, to an amount, over 0.1 s
```

`feel` knows `smile`, `grin`, `sad`, `angry`, `surprised`, `afraid`, and `disgusted`, by an MPFB face's names and a VRM model's (`happy`, `sorrow`, `fun`, ...); `face.feelings()` lists those the model has. Both return false when the model has no such shape. An MPFB face has all seven, each a whole face, brows and eyes with the mouth: `smile` keeps the lips together, `grin` shows the upper teeth. It also has `brows_up`, `brows_down`, `squint`, `mouth_narrow`, `mouth_wide`, and the blink and mouth shapes; `"mouth_open"`, `"blink_l"`, and the other names of the table's first column work on every model, whatever it calls them. Feelings mix: `feel("smile", 0.5)` with `express("brows_up", 0.4)` is a pleased surprise. Asleep or dead is the lids' shapes at 1.0 with `face.blinking = false`. A feeling lets the others go, and `face.feel("")` lets all go. Each comes and goes softly, and folds an MPFB face's skin as it does. Change them as the story does: a smile when greeted, anger when hit.

## Blinks and settings

`face.blink()` blinks now, and the signal `blinked` tells of every blink. A blink before a look to the side reads as a thought.

| Property | Default | |
|---|---|---|
| `blinking`, `blink_every` | true, 4 s | blinks by itself, about so often; now and then twice |
| `eye_reach`, `head_share`, `head_reach` | 28, 0.6, 45 | see Looking |
| `mouth_reach`, `mouth` | 0.85, 0 | see Speaking |
| `liveliness` | 1 | how much the face does unasked: glances, lids that follow the eyes down, syllable shapes, the brows and nods of speech, a passing half smile; 0 leaves only what the game asks for |
| `active` | true | false rests the face: do that for characters far from the camera |

After adding a mesh with face shapes to the model, such as a mask or a beard, call `face.refresh()`.

## Check it

`godot_run`, bring the camera to within a meter of the face, and take `godot_screenshot` three times: at rest, with `face.feel("grin")`, and with `face.mouth = 0.6` and a `look_target` to one side. The eyes must turn and look at the target, the grin must show teeth that are neither gray nor blue, and the mouth must be dark inside. A face that does nothing: `face.has(...)` says which part the model lacks, and `face.shapes()` what its shapes are called.
