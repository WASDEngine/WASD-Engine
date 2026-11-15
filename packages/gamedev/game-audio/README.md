---
description: "Audio for the agent: the audio_search and audio_review tools of every Session and of WASD Engine's MCP server, which list a game project's sound effects, dialogue, and music and measure them as the Audio tab plays them, with a picture of each sound's waveform and spectrogram; and the browser-safe audio module that the Audio tab and the SuperCollider tools share."
kind: "package-reference"
---

# @deepseek-ai/dsh-game-audio

English | [中文](README.zh.md)

## Summary

The audio plugin lets agents, which cannot listen, review a game's sound effects, dialogue, and music. `audio_search` lists the project's sounds with their kind, format, and length. `audio_review` measures one sound as WASD Engine's Audio tab plays it: peak and loudness, clipping, silence at either end, spectrum, loop seam, stereo channels, and Godot import, with a waveform and spectrogram picture, and can open the sound in the user's Audio tab. Agents connected through WASD Engine's MCP server get the same tools. The `./audio` export holds the formats, header probe, measurements, and picture that the Audio tab and game tools share.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `game-audio` into every Web and Desktop profile, after the Audio tab's row `ui-game-audio`, without configuration:

```yaml
- id: game-audio
  name: '@deepseek-ai/dsh-game-audio'
```

The plugin needs the `tools` and `workingDirectory` services. With the `attachments` and `llm` services it gives the picture to a Session whose model accepts images, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tools to connected agents. No Game tools switch lists it.

| Field | Default | Meaning |
|---|---|---|
| `measureTimeoutMs` | `60000` | Time a window has to read, decode, and measure one sound for `audio_review`; a call's wait behind other calls' sounds does not count |
| `maxReviewSeconds` | `300` | Longest stretch one `audio_review` call measures, in seconds |
| `maxPreviewBytes` | `268435456` | Largest file a window reads to measure it, 256 MiB |
| `maxFolders` | `2000` | Folders one project walk lists, the project folder included |
| `maxSounds` | `5000` | Sounds one project walk collects |

### The tools

| Tool | What it does |
|---|---|
| `audio_search` | Walks the project folder for WAV, MP3, Ogg Vorbis and Opus, FLAC, and AIFF files, skipping hidden folders and `node_modules`, reads each one's headers, and lists the sounds with their kind, format, encoding, channels, sample rate, length, and size, and how many of each kind each folder holds. `query` ranks names that start with it, then names and paths that contain it, then paths that hold its letters in order; `kind` (`effect`, `dialogue`, or `music`) and `folder` narrow the list; `limit` (1 to 200, default 50) and `offset` page it |
| `audio_review` | Asks a WASD Engine window that may read the Session to decode one sound at its own sample rate and measure it: peak and RMS levels per channel, loudness after ITU-R BS.1770, silence below -60 dBFS at the start and end, the strongest spectral component and the centroid of the sound without its DC offset (none for a sound that holds nothing else), where the loop the game plays meets its own start, and how two channels correlate and balance. It reads how Godot imports the sound from the `.import` file beside it, returns the waveform and spectrogram picture unless `picture` is false or the model takes text only, and with `show` opens the sound in the Audio tab of the Session the user follows: a subagent's or teammate's opens in its lead's. `start` and `end` measure part of a long track, at most `maxReviewSeconds`; a sound longer than the Audio tab decodes (its `maxDecodedSeconds`, 20 minutes by default), or whose decoded samples would take more memory than its `maxDecodedBytes` (512 MiB by default), fails with `AUDIO_TOO_LARGE` before the window decodes it |

A sound's kind comes from the first word of its file name, or of its folders from the nearest, that names one: `sfx`, `fx`, `sound`, `foley`, `ui`, or `ambience` for sound effects, `voice`, `vo`, `dialogue`, `speech`, `narrator`, or `bark` for dialogue, and `music`, `bgm`, `ost`, `soundtrack`, `song`, or `jingle` for music. A path without such a word is music from 30 seconds on and a sound effect otherwise.

The review's text warns about what a game plays badly: samples that reach full scale and clip, samples that are NaN or infinite, which the figures count as silence, a peak 40 dB or more above full scale, as an unstable filter makes, a DC offset, a sound effect or line that starts with 50 ms or more of silence and so plays late, a seam that clicks where Godot loops the sound, channels in opposite phase, and stereo files whose channels hold the same samples.

The seam is that of the loop the game plays, measured from the samples on either side of its jump in the whole decoded sound, wherever the measured stretch lies: between the loop points of Godot's import, a WAV import's in sample frames and an Ogg or MP3 import's from its offset to the end of the sound, or between those of the first loop a WAV file's sampler chunk stores, which Godot follows by default: forward, back and forth, or backward, by the loop's type, and a loop of a type Godot does not play is no loop; a sound that nothing loops repeats whole. A ping-pong loop has no seam, a backward loop's jump joins the same two frames as a forward one's, and the review says when a loop lies outside the sound or its points cannot be placed, instead of measuring another seam.

Agents connected through WASD Engine's MCP server reach the tools under the provider `audio`, each with a required `project`, the absolute path of the game project's folder; both are marked read-only, run in the connected agent's Session of that project, take sound paths from the `project` folder also when a game project registered above it holds the Session, and send the picture as PNG bytes after the result's text. `search_game_tools` reports the provider ready, adding while no WASD Engine window is open that `audio_review` fails until the user opens one.

### The audio module

The `./audio` export is browser-safe and has no dependencies: the client bundle purity gate admits `@deepseek-ai/dsh-game-audio/audio`, and only it, as an inline wire layer, so the Audio tab inlines it while the Host tools and SuperCollider import it.

| Export | What it does |
|---|---|
| `audioFormatOf`, `AUDIO_EXTENSIONS` | The listed formats by lowercase extension, with the media type and whether a browser decodes the format |
| `audioCategoryOf`, `pathWords` | The kind of a sound from its path and length |
| `probeAudio` | What a file's headers say, from a few small byte windows: WAV and AIFF chunks with a WAV sampler chunk's first loop and its type, FLAC STREAMINFO, an MP3's Xing, Info, or VBRI frame count less the LAME encoder delay and padding, or an estimate from its first frame's bit rate, and an Ogg stream's last granule position; a crafted file may state less than it holds |
| `decodePlan`, `DecodePlanError` | How much audio a browser's decoder can make of a file, counted from all of its bytes before it is decoded, as the decoder reads them: a WAV file's samples to the end of the file, the samples of every FLAC frame header whose CRC-8 matches, whatever its STREAMINFO states, the chain of MP3 frames a decoder follows from the first, and the Ogg pages of the first audio stream whose CRC-32 matches, at the most each Opus or Vorbis packet yields; the count stops at a given length. For MP3 and Ogg the plan holds only the frames and pages it counted, which the window decodes alone, so the decoder cannot make more audio than the plan allows |
| `openAiff`, `decodeAiff` | AIFF and AIFC samples, which browsers do not decode: integer PCM of 8 to 32 bits in either byte order, unsigned 8-bit, and 32-bit and 64-bit float; `openAiff` locates them and reads one at a time without copying them, and `decodeAiff` copies them all |
| `analyzeAudio`, `integratedLoudness`, `loopSeam`, `seamFrames`, `stereoImage`, `seamClicks`, `FAR_BEYOND_FULL_SCALE` | The measurements of interleaved float samples, which count each NaN or infinite sample and read it as silence, so every figure stays finite; `loopSeam` measures a loop's seam from the frames that `seamFrames` names on either side of its jump, and `FAR_BEYOND_FULL_SCALE`, a peak of +40 dBFS, is where the audio tools and SuperCollider's analysis warn of a fault rather than a level |
| `drawAudioImage`, `describeAudioImage` | The picture as raw RGB, and the sentence that states its panels and grid |
| `analyzeAudioSteps`, `stereoImageSteps`, `drawAudioImageSteps`, `finish` | The same measurements and picture as generators that pause after about `STEP_FRAMES` frames or one picture column: `finish` runs one to its end at once, and the Audio tab runs them a slice at a time between the page's events |
| `AUDIO_ERROR` | The tools' error codes, with which a window answers a request it cannot fulfil |

The `./png` export, `encodePng`, encodes the picture's RGB pixels as a PNG file with `node:zlib`, so only Host code imports it: the SuperCollider tools and `godot_audio`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`audio_review` resolves the path inside the project folder, checks its format and that a file is there, reads its headers and Godot import on the Host, and emits the scoped waterfall event `game-audio/measure` with the Session's Agent as scope, naming the loop the game plays, in seconds, as the loop whose seam to measure. The request names the sound from the folder in the Session's header, against which the window resolves the Session's paths, so an agent whose working directory moved below the project folder, as after `working_directory` or for a subagent started in a subfolder, measures the file it named. The Remote events allowlist forwards the request to the windows that may read the Session; the first browser plugin that answers reads the file through `workspaceFiles.readBytes`, decodes it, measures the window, and draws the picture, and the plugin's fallback rejects with `AUDIO_NO_WINDOW` when no window answers. While the Host's optional `typertGateway` reports no window connected, a review fails with `AUDIO_NO_WINDOW` at once instead of emitting the request, which the gateway would keep for a window that connects later. Every window answers every request it may, one sound at a time, so the Host sends one request at a time, in the order the calls came: a call's time limit, `measureTimeoutMs`, counts from its request, not from the start of its wait behind other calls, and a call that ends while it waits leaves the line without a request. The tool has no time limit of its own. The Host validates every field of the answer with bounds before it reaches a result: finite numbers, at most 64 channels, and a PNG of at most 16 MiB. A window's own failure keeps its message and code, such as `AUDIO_UNREADABLE`, and names the sound as the agent named it. `show` emits `game-audio/reveal` for the root of the caller's subagent tree, found through the optional `subagents` service, or for the caller's own Session when it has no live root; the Audio tab answers by opening the sound.

`audio_search` walks the folder on the Host and probes every listed sound, eight at a time; the plugin keeps each probe while the file's size and modification time stay the same, for as many files as `maxSounds`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the probe cache, the measure request and its fallback, the Session's picture attachments, tool registration, and the game MCP provider |
| [`src/tools.ts`](src/tools.ts) | The tool definitions, their arguments, and their values |
| [`src/describe.ts`](src/describe.ts) | The text of the results |
| [`src/loop.ts`](src/loop.ts) | The loop the game plays, from the Godot import and the WAV file's sampler chunk |
| [`src/scan.ts`](src/scan.ts) | The project walk |
| [`src/files.ts`](src/files.ts) | Header probes over a file handle and the Godot import reader |
| [`src/result.ts`](src/result.ts) | Validation of a window's answer and of a stored result's fields |
| [`src/mcp.ts`](src/mcp.ts) | The tools for connected agents and the provider's instructions |
| [`src/types.ts`](src/types.ts) | The browser-safe request, answer, and reveal types and the two events |
| [`src/png.ts`](src/png.ts) | The `./png` module: PNG encoding of the picture on the Host |
| [`src/audio/`](src/audio/index.ts) | The `./audio` module |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the tab that plays the sounds and the server that offers the tools to other agents.

- [ui-game-audio](../ui-game-audio/README.md) — the Audio tab, which answers the measure requests.
- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [supercollider](../supercollider/README.md) — the sound design tools, whose renders use the same measurements and picture.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `audio_search`, with the optional `query`, `kind`, `folder`, `limit`, and `offset`, and `audio_review`, with `path` and the optional `start`, `end`, `picture`, and `show`. The descriptions name the formats, how a sound's kind is found, the measurements, and that the agent cannot listen. A connected agent sees the same tools, each with a required `project`, and the provider's instructions under `## Audio`.

#### Token effect

The two declarations come to about 2,600 characters of JSON; the provider's instructions add about 700 characters to the MCP server's instructions.

#### KV Cache effect

The declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

A search result names the number of sounds with the count of each kind and lists one line per sound with its kind, format, encoding, channels, sample rate, length, and size, followed by each folder's counts. A review result names the sound's kind and format, how Godot imports it, the measured stretch, the levels and loudness, the silence at either end, the spectrum, the loop seam, the stereo channels, a warning for each problem it found, and a sentence that states the picture's panels and grid, followed by the picture as an attachment when the Session's model accepts images. A failure names the cause: a path outside the project, a missing file, a file that is not a sound, a bad argument, no open window, a sound longer than the window decodes or larger once decoded, or a sound the window could not read, decode, or measure.

#### Token effect

A search result is about 120 characters per sound, for 50 sounds by default and at most 200. A review result is about 1,000 characters plus one PNG picture of 1024 pixels by 418 to 536 pixels.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tools measure and where; they are current package constraints.

- **A window decodes the sound** — `audio_review` fails at once while no WASD Engine window is open, because the browser decodes MP3, Ogg, and FLAC; `audio_search` works without one.
- **Length** — a window decodes a whole sound to measure part of it, so a sound longer than the Audio tab decodes, or that would take more memory decoded, cannot be reviewed; an Ogg Vorbis sound counts at the most its packets can yield, so one close to the caps may be refused although it holds less.
- **No transcript** — a review measures dialogue but does not say what is spoken.
- **Fixed kind words** — the kinds come from English path words and length; a project that names its folders otherwise gets sound effects and music by length.
- **No loudness targets** — a review reports loudness and peak but does not compare sounds with each other or with a target level.
- **Formats** — M4A, AAC, WebM, and tracker modules are not listed; a free-format MP3, whose frame headers state no size, and a WAV file in an encoding other than PCM, float, A-law, μ-law, or ADPCM are not decoded, since the window cannot count what they yield; only the first loop of a WAV sampler chunk is read.
- **Generic conversation rows** — the Web UI shows the tool calls in the generic tool row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The measurements and the picture moved here from the SuperCollider package, which imports them for `render_audio` and `analyze_audio`, so both tools report a sound the same way. Godot 4 imports WAV, Ogg Vorbis, and MP3; its WAV import names the loop mode as `edit/loop_mode` (0 follows the file's sampler chunk, 1 is off, 2 forward, 3 ping-pong, 4 backward) with `edit/loop_begin` and `edit/loop_end` in sample frames, and its Ogg and MP3 imports name `loop` and `loop_offset` in seconds.

</details>
