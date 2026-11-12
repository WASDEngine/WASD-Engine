---
description: "The right Sidebar's Audio tab: the game project's sound effects, dialogue, and music, searchable, filtered by kind, and grouped by folder with each sound's length, played with its waveform, a repeat that loops it seamlessly, and details of its format, loudness, and peak; it also decodes and measures sounds for the agent's audio_review and opens the sounds an agent shows."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-audio

English | [中文](README.zh.md)

## Summary

The Audio tab lets the user listen to the sounds of the Session's game project without leaving WASD Engine. It lists the project's sound effects, dialogue, and music by folder with their lengths, with search and a kind filter. A click plays a sound with its waveform, which a click or drag scrubs, and the arrow keys move on while one plays. A repeat control loops the sound without a gap, and the details show its format, length, loudness, and peak with notes on problems. The tab also decodes and measures sounds for the agent's `audio_review`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Default composition

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `ui-game-audio` into every Web and Desktop profile, after the Assets tab's row, without configuration:

```yaml
- id: ui-game-audio
  name: '@deepseek-ai/dsh-client-ui-game-audio'
```

The row's Host half is empty; the Loader row exists so the Host serves the `./client` bundle. The browser plugin registers the right Sidebar's `audio` page type with a guide entry at order 46, after the Assets tab's.

| Field | Default | Meaning |
|---|---|---|
| `maxFolders` | `2000` | Folders one walk lists, the project folder included, before it stops and says the list is incomplete |
| `maxSounds` | `5000` | Sounds one walk collects before it stops and says the list is incomplete |
| `maxPreviewBytes` | `268435456` | Largest file the tab reads, 256 MiB; a larger sound shows a notice |
| `maxDecodedSeconds` | `1200` | Longest sound the tab decodes, 20 minutes; a longer sound shows a notice |
| `maxMeasuredSeconds` | `300` | Longest stretch from a sound's start that the details measure |

### What the tab lists

The tab walks the Session's workspace for WAV, MP3, Ogg Vorbis and Opus, FLAC, and AIFF files, skipping hidden folders and `node_modules`, and reads each sound's headers a few at a time for its length. The list groups the sounds under folder headings, which fold their sounds away; typing in the search field ranks sounds by how well their name or path matches. The All, Effects, Dialogue, and Music filter uses the kinds that `@deepseek-ai/dsh-game-audio` gives sounds: a word of the path such as `sfx`, `voice`, or `music`, or else the length. The list walks again when the tab shows and the last walk is older than 2 s or ten times its duration, and when the refresh control is pressed.

### Listening

A click on a sound selects it, decodes it, and plays it; a click on the sound that plays pauses it. The arrow keys move the selection and play the next sound while one plays. The player shows the waveform, which a click or a drag moves the playhead along, the position and length, the play control, the repeat control, which loops the sound sample-accurately, and the volume. One player serves the window, so one sound plays at a time across Sessions, and a sound stops when another is chosen, when its file changes, or when the tab closes. The selected sound reads again when its file changes, so a sound the agent made again plays as it is now.

### Details

Below the player the tab shows the sound's kind, format with its encoding, sample rate, and channels, length, size, loudness in LUFS, and peak in dBFS, measured by the same functions that the agent's `audio_review` uses. Notes name samples that clip, silence of 50 ms or more before a sound effect or line, a click where the sound repeats while the repeat control is on, two channels that hold the same sound, a DC offset, and a sound longer than the details measure.

### Answers to the agent

For a `game-audio/measure` request of a Session that the window may read, the plugin reads the sound, decodes it at its own sample rate, measures the requested stretch, and draws the waveform and spectrogram picture as a PNG on a canvas when the request asks for it, one request at a time. A request of another scope goes to the next window. For `game-audio/reveal`, the plugin opens the sound in that Session's Audio tab, after showing the Session when another one is on screen.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tab adds no Host service: it lists the workspace with `workspaceFiles.list`, reads headers and files with `workspaceFiles.readBytes`, and follows the selected file with the `file` resource. Browsers decode WAV, MP3, Ogg, and FLAC through an `OfflineAudioContext` created at the rate the headers name, so the samples keep the file's rate; AIFF files decode with `decodeAiff` from `@deepseek-ai/dsh-game-audio/audio`, which the client bundle inlines. The player is one `AudioContext` for the window, created on the first play, with one gain node for the volume and a new `AudioBufferSourceNode` for each start.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Config, each Session's state, the tab type and seats, the player, and the answers to the measure and reveal events |
| [`src/client/AudioTab.tsx`](src/client/AudioTab.tsx) | The tab body: search, filter, player, list, and the empty and failed states |
| [`src/client/SoundList.tsx`](src/client/SoundList.tsx) | The list with its folder headings and keyboard movement |
| [`src/client/SoundPlayer.tsx`](src/client/SoundPlayer.tsx) | Reading and decoding the selected sound, the waveform, the controls, and the details |
| [`src/client/source.ts`](src/client/source.ts) | One Session's walk, header probes, and choices |
| [`src/client/scan.ts`](src/client/scan.ts) | The workspace walk |
| [`src/client/rows.ts`](src/client/rows.ts) | The list rows: kinds, filter, search, folders, and arrow movement |
| [`src/client/read.ts`](src/client/read.ts) | Complete and windowed reads |
| [`src/client/decode.ts`](src/client/decode.ts) | Decoding, the measurements, and the picture |
| [`src/client/agent.ts`](src/client/agent.ts) | The answer to a measure request |
| [`src/client/playback.ts`](src/client/playback.ts) | The window's player |
| [`src/client/peaks.ts`](src/client/peaks.ts) | The waveform's shape |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the agent's audio tools and the tab beside this one.

- [game-audio](../game-audio/README.md) — the agent's audio tools and the shared audio module.
- [ui-game-assets](../ui-game-assets/README.md) — the Assets tab for the project's 2D and 3D art.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-game-audio`, whose `audio_review` renders the measurements and picture this package makes as bounded tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tab plays and shows; they are current package constraints.

- **No live list** — the list follows the project only when the tab shows or the refresh control is used; the selected sound itself reloads as it changes.
- **Whole-file decoding** — a sound decodes completely before it plays, so a long music track takes a moment and memory in proportion to its length.
- **Browser formats** — a WAV file in an encoding the browser does not decode, such as ADPCM, shows a notice instead of playing.
- **Fixed skip rule** — the walk always skips hidden folders and `node_modules`; sounds kept in a hidden folder do not show.
- **Volume is not kept** — the volume and the repeat control reset when WASD Engine starts again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`decodeAudioData` resamples to its context's rate, so the decoding context takes the rate from the file's headers; a file whose headers name none decodes at 48 kHz. Chromium starts an `AudioContext` suspended until a user gesture, so the player creates its context on the first play, which a click or key press starts.

</details>
