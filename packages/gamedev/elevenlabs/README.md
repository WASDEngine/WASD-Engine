---
description: "ElevenLabs for the agent: the elevenlabs_voices, elevenlabs_speech, elevenlabs_sound_effect, elevenlabs_music, elevenlabs_clone_voice, and elevenlabs_delete_voice tools of every Session and of WASD Engine's MCP server, which find or clone voices for characters and save speech, sound effects, and music into the game project, made by the WASD Engine API and charged to the signed-in account's plan."
kind: "package-reference"
---

# @deepseek-ai/dsh-elevenlabs

English | [中文](README.zh.md)

## Summary

The ElevenLabs plugin lets the agent voice a game's characters and make its sound effects and music with [ElevenLabs](https://elevenlabs.io). It finds voices in ElevenLabs' Voice Library or its default voices, or clones one from the user's recordings, speaks lines with Eleven v4 Turbo, makes sound effects with SFX v3, and composes music with Music v2.5, saving each as an `.mp3` or `.wav` file in the game project. The WASD Engine API makes the audio with its own ElevenLabs key and charges it to the signed-in account's plan. Agents connected through WASD Engine's MCP server get the same tools.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `elevenlabs` into every Web and Desktop profile, with the WASDEngine API origin, the same expression as the account sign-in's `inferenceOrigin` in [`gateway.cordis.patch.yml`](../../bundle/base/wasdengine/gateway.cordis.patch.yml):

```yaml
- id: elevenlabs
  name: '@deepseek-ai/dsh-elevenlabs'
  config:
    apiOrigin: !!js >-
      ctx.get('launchEnvironment')?.getFrom('WASDENGINE_ORIGIN', ['process', 'user-env'])?.value || 'https://api.wasdengine.com'
```

The Game tools tabs of Settings › Built-in plugins and the Plugins page list the row, and the Plugins page's switch turns it off with `- id: elevenlabs` and `disabled: true` in the profile patch. Activation makes no request. The plugin needs the `tools` and `workingDirectory` services; each call reads the account token of the `deepseekAccount` service, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tools to connected agents.

| Field | Default | Meaning |
|---|---|---|
| `apiOrigin` | `https://api.wasdengine.com` | Origin of the WASD Engine API; the account sign-in releases its token only to its `inferenceOrigin`, so the two must match |
| `searchTimeoutMs` | `30000` | Time limit of one `elevenlabs_voices` call |
| `generationTimeoutMs` | `210000` | Time limit of one `elevenlabs_speech` or `elevenlabs_sound_effect` call |
| `musicTimeoutMs` | `660000` | Time limit of one `elevenlabs_music` call |

### The tools

| Tool | What it does |
|---|---|
| `elevenlabs_voices` | Lists voices for `query`, a description such as "old British wizard", in ElevenLabs' Voice Library, with `source` `default` its default voices, or with `source` `mine` the voices the account cloned, with each voice's id, name, gender, age, accent, language, use case, and description. `gender`, `age`, `accent`, `language`, and `use_case` filter the list; `page` and `limit` (1 to 30, default 10) page it. Free |
| `elevenlabs_speech` | Speaks `text` (at most 5,000 characters) in the voice `voice_id` with Eleven v4 Turbo and saves it at `path`. Audio tags in square brackets, such as `[whispers]`, direct the delivery; `language`, `speed` (0.7 to 1.2), `stability`, `similarity`, `style` (0 to 1), `seed`, `previous_text`, and `next_text` shape it |
| `elevenlabs_sound_effect` | Makes a sound effect from `prompt` with SFX v3 and saves it at `path`; `duration_seconds` (0.5 to 30) fixes its length, `loop` makes it repeat without a seam, and `prompt_influence` (0 to 1) sets how closely it follows the prompt |
| `elevenlabs_music` | Composes music from `prompt` with Music v2.5 and saves it at `path`; `duration_seconds` (3 to 300) fixes its length and `instrumental` leaves out vocals |
| `elevenlabs_clone_voice` | Clones a voice named `name` from the `samples`, 1 to 5 `.wav` or `.mp3` recordings of one speaker, after the user confirms consent; `description` and `remove_background_noise` are optional. The new voice speaks only for the account |
| `elevenlabs_delete_voice` | Deletes the account's clone `voice_id`, which frees its place |

`path` is relative to the Session's working directory or absolute, and its extension picks the file type: `.mp3` or `.wav` for speech and sound effects, `.mp3` for music. A call checks the path and every argument before the paid request: a path that names a folder or an existing file, unless `replace` is true, costs nothing. The file is written through a temporary file beside it and appears complete or not at all. A result names the file, its size, the audio's length, and, for a looping sound effect and for music, the Godot import option that loops it.

Agents connected through WASD Engine's MCP server reach the tools under the provider `elevenlabs`, without a Session: `elevenlabs_voices` is marked read-only, the speech, sound effect, and music tools require `path` as an absolute path, and `elevenlabs_clone_voice` requires absolute `samples` and `consent: true`. Their audio is charged to the account WASD Engine is signed in to, and the server refuses every call while it is signed out.

### Prices and the account

The WASD Engine API charges each generation to the AI usage of the account's plan at ElevenLabs' API prices: speech by the characters of its text, sound effects and music by the length of the audio returned. Voice searches and failed generations cost nothing. Once the plan's AI usage is used up, a call fails with the API's "Usage limit reached" message and asks the agent to have the user upgrade or turn on auto recharge. While WASD Engine is signed out, every call asks the agent to have the user sign in; a token the API refuses (HTTP 401) is reported to the account service, which signs the account out when it is still the stored one.

### Voice clones

`elevenlabs_clone_voice` clones a voice with ElevenLabs Instant Voice Cloning for the signed-in account alone: the WASD Engine API refuses the clone to every other account as an unknown voice, and `elevenlabs_voices` lists it only with `source` `mine`. Cloning needs a Pro or Max plan; it costs nothing, each account keeps up to three clones, and `elevenlabs_delete_voice` frees one. The recordings must be one speaker, 10 seconds to 5 minutes in all, best 1 to 2 minutes of clear speech, each at most 10 MB; they go to the API and on to ElevenLabs, and the plugin keeps no copy.

ElevenLabs makes its account holder confirm, for every clone, the right and consent to clone the voice. Before anything is sent, the user confirms this statement, version `2026-11-11` ([`src/consent.ts`](src/consent.ts)): "These recordings are of my own voice, or of a person who gave me express permission to clone their voice for this purpose, and I will not use the cloned voice to impersonate, deceive, or harm anyone." In a Session, the tool asks through WASD Engine's approval prompt (`ctx.approval`), in the user's language, and a clone that is not approved sends nothing; the Session's audit log records the question and the answer. An agent connected through the MCP server must show its user the statement and pass `consent: true`, because WASD Engine's prompt does not reach it. The API records with each clone the statement's version, where it was confirmed (`app` or `mcp`), and the token that asked.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs of Settings › Built-in plugins and the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`: a package-local sound wave in the WASD Engine keycap purple, not ElevenLabs' logo. WASD Engine is not affiliated with, made by, or endorsed by ElevenLabs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each call posts one JSON object to the API: `POST /v1/audio/voices`, `/v1/audio/speech`, `/v1/audio/sound-effects`, or `/v1/audio/music` on `apiOrigin`; a clone posts multipart form data to `POST /v1/audio/voices/clone`, and a deletion calls `DELETE /v1/audio/voices/<voice id>`; each goes the token that `deepseekAccount.resolveToken` releases for that URL in `x-dsh-auth-token`, and never follows redirects. A generation's answer is the audio file with its length in milliseconds in `x-audio-duration-ms`; the client reads at most 64 MiB of audio and 4 MiB of JSON. An error answer carries the API's message, which the client words for the agent by status.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the account token, tool registration, and the game MCP provider |
| [`src/api.ts`](src/api.ts) | The API client: voice search, generations, and error wording |
| [`src/tools.ts`](src/tools.ts) | The tool definitions, argument checks, file writing, and result text |
| [`src/consent.ts`](src/consent.ts) | The consent statement, its version, and the approval prompt in eight languages |
| [`src/mcp.ts`](src/mcp.ts) | The tools for connected agents, their `consent` parameter, and the provider's instructions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the MCP server that offers the tools to other agents and how the game tools connect.

- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.
- [ElevenLabs models](https://elevenlabs.io/docs/overview/models) — Eleven v4 Turbo, SFX v3, and Music v2.5.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `elevenlabs_voices`, with the optional `query`, `source`, `gender`, `age`, `accent`, `language`, `use_case`, `page`, and `limit`; `elevenlabs_speech`, with `text`, `voice_id`, `path`, and the optional `language`, `speed`, `stability`, `similarity`, `style`, `seed`, `previous_text`, `next_text`, and `replace`; `elevenlabs_sound_effect`, with `prompt`, `path`, and the optional `duration_seconds`, `loop`, `prompt_influence`, and `replace`; `elevenlabs_music`, with `prompt`, `path`, and the optional `duration_seconds`, `instrumental`, and `replace`; `elevenlabs_clone_voice`, with `name`, `samples`, and the optional `description` and `remove_background_noise`; and `elevenlabs_delete_voice`, with `voice_id`. The descriptions name the models, give example descriptions, mention audio tags, say that each generation costs AI usage from the user's WASD Engine plan, music the most, and say that a clone needs the speaker's permission, which the user confirms in WASD Engine. A connected agent sees the same tools, with `path` and `samples` described as absolute paths, a required `consent` on the clone tool, and the provider's instructions, which quote the consent statement, under `## ElevenLabs`.

#### Token effect

The six declarations come to about 7,500 characters of JSON; the provider's instructions add about 1,300 characters to the MCP server's instructions.

#### KV Cache effect

The declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

A voice search names the search and its filters, then one line per voice with its id, name, labels, and description cut to 160 characters, whether a next page exists, and that the id goes to `elevenlabs_speech`. A generation names the file, its size, whether it replaced a file, the audio's length, the model, and for speech the voice and character count; a looping sound effect and music add the Godot import option that loops them. A failure says what to change: an argument out of range, a path that exists, a voice the API refused, a used-up plan, or a signed-out app. A clone names the voice, its id, the recordings, and how many of its clones the account keeps; a deletion names the voice and the clones left.

#### Token effect

A voice search is about 250 characters per voice, for 10 voices by default and at most 30. A generation is one or two sentences.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tools offer; they are current package constraints.

- **No listening** — the agent cannot hear the audio; it judges a result by its length, and the user listens to the file.
- **Generic conversation rows** — the Web UI shows the tool calls in the generic tool row, without a player.
- **No voice design** — the tools use existing voices and clones from recordings; they do not design a voice from a description.
- **One file per call** — a dialogue of several speakers is one call per line, and music has no composition plan or sections.
- **Music is MP3** — the API offers music only as MP3, which loops in Godot with the gap of MP3 encoder padding.
- **Library voices can be withdrawn** — when a voice's owner removes it from the Voice Library, it keeps working for the notice period the owner set, 30 days to 2 years, then stops; files already made keep playing, and new lines need another voice.
- **Consent is the user's word** — the tools cannot tell whose voice a recording holds; they record the user's confirmation, and the speaker's permission is the user's responsibility.
- **Clones share the service's voice slots** — every clone takes a custom voice slot in the service's one ElevenLabs workspace, so while the service keeps as many clones as its limit allows, new clones fail until some are deleted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The API's audio routes pin the ElevenLabs models and output formats, refuse voices whose owners set a custom price, and measure the audio they bill. Speech and sound effects come back as 44.1 kHz 128 kbps MP3 or 48 kHz 16-bit WAV, and music as 48 kHz 192 kbps MP3. The request fields are the tools' arguments under the same names, plus `format`, `mp3` or `wav`, from the file's extension; the voice search sends `limit` as `page_size`. A clone sends `name`, `description`, `remove_background_noise`, `consent` (`true`), `consent_statement` (the version), `consent_channel` (`app` or `mcp`), and each recording as `files`; the API refuses a statement version it does not know.

</details>
