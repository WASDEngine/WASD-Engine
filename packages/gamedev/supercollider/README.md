---
description: "Headless SuperCollider tools over MCP for deployments and maintainers configuring the data directory, the sclang and scsynth executables, and timeouts, or debugging the mcp__wasd_supercollider__ tools, the runtime search, the bridge that runs sclang, and the offline renders."
kind: "package-reference"
---

# @deepseek-ai/dsh-supercollider

English | [中文](README.zh.md)

## Summary

Let the agent design sound effects and music in SuperCollider code and render them offline into audio files in the game project. Nothing plays aloud, so every render and analysis returns levels, loudness, silence, and spectrum figures and a waveform and spectrogram image to judge the sound by. WASD Engine Web and Desktop turn the tools on by default; the Desktop app ships SuperCollider without its graphical interface, and elsewhere the tools use an installed one. Each conversation gets its own interpreter; a crash, a timeout, or a long pause discards its SynthDefs and variables.

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

Choose these tools when the agent should make game audio as files: sound effects, interface sounds, ambiences, and music loops. The plugin starts its own sclang, the SuperCollider language, with its own user folders, and never connects to a SuperCollider that the user has open. Activating the plugin registers its MCP server, `wasd_supercollider`, and nothing else: no search or start happens before the first tool call, so the plugin loads on machines without SuperCollider.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the `supercollider` row into every Web and Desktop profile and puts its data directory under the harness home: `~/.wasdengine/supercollider`, or `$DSH_HOME/supercollider` when `DSH_HOME` is set.

```yaml
- id: supercollider
  name: '@deepseek-ai/dsh-supercollider'
  config:
    dataRoot: !!js dshHomePath('supercollider')
```

The plugin requires the `mcpManager` service, which the `mcp-manager` row of the [`dsh-web-app`](../../bundle/web-app/README.md) bundle provides. In another composition, mount [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) beside this row and set an absolute `dataRoot`.

### Turn the tools off or change their settings

A profile patch overrides the row by its id. Add the entry to `$DSH_HOME/profiles/<name>/cordis.patch.yml`, where `$DSH_HOME` is `~/.wasdengine` when unset and the standard profile names are `web` and `desktop`. Restart Web or Desktop after editing the patch. The switch on the Game tools tab of the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) adds and removes this `disabled` entry through the plugin manager, which applies the change or says that it waits for a restart.

```yaml
- id: supercollider
  disabled: true
```

A disabled row withdraws the tools and the server instructions from the model and stops the running interpreter. A patch that sets `config` replaces the row's whole configuration, so restate `dataRoot` beside the fields you change:

```yaml
- id: supercollider
  config:
    dataRoot: !!js dshHomePath('supercollider')
    sclangPath: /opt/supercollider-headless/sclang
```

### Configuration

[`src/index.ts`](src/index.ts) declares and validates these fields. Each budget is a whole number of milliseconds from 1 to 2,147,483,647. Activation fails when `dataRoot`, or a `sclangPath` or `scsynthPath` that is not empty, holds a relative path, and when `requestTimeoutMs` is not at least 30 s less than `toolCallTimeoutMs`.

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | required | Absolute directory for the interpreter's user folders, render scratch files, the class library configuration, and the worker class copy |
| `sclangPath` | `''` | Absolute sclang executable of a headless SuperCollider build; empty uses the runtime that the Desktop app ships (see [Find SuperCollider](#find-supercollider)) |
| `scsynthPath` | `''` | Absolute scsynth executable for the offline renders; empty uses the scsynth beside `sclangPath`, or that of the shipped runtime |
| `toolCallTimeoutMs` | `900,000` | Budget of one tool call, including an interpreter start; a request, including a `timeout_seconds` of `render_audio` or `execute_sclang`, may use all of it but the last 30 s, which a worker start and the result keep |
| `startupTimeoutMs` | `30,000` | Budget for the MCP server to connect and list its tools; listing the tools starts no SuperCollider |
| `readyTimeoutMs` | `60,000` | Budget for sclang to compile its class library and report ready |
| `requestTimeoutMs` | `600,000` | Default budget of one request, at least 30 s less than `toolCallTimeoutMs`; when it expires, the interpreter stops and its state is lost |
| `graceMs` | `3,000` | Time the worker gets to exit after the `shutdown` request, and again after SIGTERM, before SIGKILL; the bridge also gives sclang this long to quit after its input closes |
| `maxLogBytes` | `65,536` | Bytes of recent interpreter output kept for error messages |
| `maxWorkers` | `4` | Most interpreters that run at once, one for each calling Session, from 1 to 16 |
| `workerIdleTimeoutMs` | `600,000` | Time without a call after which a Session's interpreter stops and its variables and SynthDefs are lost |

<a id="find-supercollider"></a>
### Find SuperCollider

The tools run SuperCollider headless only. The server looks for sclang and scsynth each time a worker starts, on the first tool call and on the call after a stop, and takes the first match in this order:

1. `sclangPath`, when it is not empty, with `scsynthPath` or the scsynth in the same folder.
2. The runtime that the Desktop app ships, in the package's `runtime/<platform>-<arch>/` folder, which a packaged app reads from `app.asar.unpacked`; its `runtime.json` names the programs and folders inside it.

The server never starts an installed SuperCollider: the macOS application links sclang against Qt, so even without a window macOS shows it as an open app, and the application ships only Qt's Cocoa platform, so it cannot run off screen either. On macOS, a `sclangPath` inside an application bundle (`*.app/Contents/`) fails the call with a message that says so. Every sclang starts with `QT_QPA_PLATFORM=offscreen`, which the shipped runtime ignores and which keeps a configured Qt build of sclang off the screen, or stops it from starting where Qt has no offscreen platform.

A non-empty `scsynthPath` replaces the scsynth that the search found. A configured path that does not name an executable file fails the call with a message that names the setting, and so does a shipped runtime whose `runtime.json` is unreadable, describes another platform, or names a missing program; the search does not continue past either. When neither matches, the call fails before it touches `dataRoot` with the missing runtime message that [Model Experience](#model-experience) quotes. The search runs at every worker start, so the Host needs no restart after the runtime is installed.

The runtime that the Desktop apps for macOS on Apple silicon and Windows x64 ship is SuperCollider built from source without Qt, its IDE, and supernova, so it holds sclang, scsynth, the UGen plugins, the class library without its GUI classes, and the class help files; [BUILD.md](../../../wasdengine/supercollider/BUILD.md) describes how it is built and published, and [SuperCollider in the Desktop app](../../../wasdengine/FORK.md#supercollider-in-the-desktop-app) how packaging ships it. A source checkout gets it with `wasdengine/supercollider/build.sh --out <folder> --install packages/gamedev/supercollider/runtime`, or by unpacking a `supercollider-<version>` release archive into that folder; an npm install has none and needs `sclangPath`.

<a id="interpreter"></a>
### One interpreter per conversation

sclang starts in its IDE mode, which reads commands from its standard input, with a class library configuration that the server writes to `sclang_conf.yaml` in the worker's own folder, `<dataRoot>/workers/<pid>/<n>/`, which is sclang's working directory; the command line names the file relative to it, because sclang on Windows reads its arguments in the ANSI code page, which cannot hold every character of a user's folder name. For the shipped runtime, the configuration replaces the default class library paths with the runtime's class library; a configured sclang keeps its default paths, so its system-wide extensions load. Either way, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` point sclang's user configuration and user data folders into `home/` in that folder on macOS and Linux, so the user's own extensions, quarks, and synthdefs stay out; sclang on Windows ignores both and uses the user's own `%LOCALAPPDATA%\SuperCollider` folder. On every platform the worker class skips the user's startup files. The configuration adds the folder of `WasdWorker.sc`, the worker class, which also makes `Server:boot` throw: there is no audio device, so code that boots a real-time server fails with a message that points to `render_audio`.

Each Session that calls the tools gets its own interpreter ([one worker per Session](../app-mcp/README.md#one-worker-per-session)), and its state persists between that Session's calls: environment variables such as `~kick`, interpreter variables `a` to `z`, SynthDefs added with `.add`, and anything else that code defines. Agents connected through WASD Engine's MCP server share one interpreter among themselves. An interpreter stops after `workerIdleTimeoutMs` without calls, and a fresh interpreter starts with none of that state.

<a id="tools"></a>
### Tools

The model calls each tool as `mcp__wasd_supercollider__<name>`, and every path argument is absolute. A failed call returns an error result whose text names the cause. Agents connected through WASD Engine's MCP server, [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md), call the same tools as `supercollider_<name>`, and share one interpreter among themselves.

| Tool | Arguments | Result |
|---|---|---|
| `render_audio` | `code`, `path`, `duration`, `channels`, `sample_rate`, `sample_format`, `normalize_db`, `timeout_seconds` | What was rendered and the file's format and size, the analysis report, the image, and the text that the code and scsynth posted |
| `analyze_audio` | `path`, `start`, `end` | The file's format, channels, sample rate, duration, and size, the analysis report of the window, and the image |
| `execute_sclang` | `code`, `timeout_seconds` | The error with its details, as an error result, then the value of the last expression as code with its class, and the posted text |
| `class_info` | `names` or `search` | For each named class: its superclasses, the public methods that it and its metaclass define with argument names and defaults, and its help text; for a search: the classes whose name contains the text, and those whose help summary does |

`render_audio` evaluates `code` and renders its value with scsynth in non-real-time mode:

- A UGen graph function becomes a SynthDef that plays from the start. A function that returns audio-rate signals writes them to the file, and one channel plays in every channel when `channels` asks for more; a function that writes audio to a bus itself, with `Out.ar`, `ReplaceOut.ar`, `OffsetOut.ar`, or `XOut.ar`, renders 2 channels unless `channels` says otherwise. `LocalOut` and `Out.kr` write no audio to a bus, so the value of a function that uses only them still plays. A function that returns control-rate or scalar values and writes no audio to a bus fails the call, and so does a SynthDef that writes none.
- A SynthDef plays with its default arguments; one without an `Out` UGen fails the call.
- A pattern renders through `asScore(duration)`, and a Score or a list of score events renders as it is. Both play SynthDefs by name, so every SynthDef that `SynthDescLib.global` holds, such as those added with `.add` and `\default`, is sent to scsynth before the first event; events after `duration` are dropped. They render 2 channels unless `channels` says otherwise.

scsynth renders 32-bit float WAV into the scratch folder, with the runtime's plugin folder as `-U` for the shipped runtime. The worker then measures its peak, and with `normalize_db` scales the sound so that its peak reaches that level; it writes exactly `duration` seconds, rounded to whole samples, to `path` in the format of its extension: `.wav`, `.aif` or `.aiff`, `.flac`, or `.ogg` (Ogg Vorbis). `sample_format` (`int16`, `int24`, or `float`, default `int16`) applies to the first three; FLAC refuses `float`. `sample_rate` defaults to 44,100 Hz, Godot's default mix rate. Missing folders are created and an existing file is replaced. Sound after `duration` is cut off, and samples beyond full scale clip in the integer formats.

The analysis reads the float copy of the render, scaled by the normalization gain, or for `analyze_audio` a float copy of the window between `start` and `end` (the whole file by default, at most 600 s), which the worker decodes with libsndfile; the server deletes each copy after reading it. The report gives:

- Peak and RMS levels in dBFS, overall and per channel when there are several.
- Integrated loudness after ITU-R BS.1770-4 in LUFS, with every channel weighted 1; windows shorter than one 400 ms block, or without blocks above the gates, are not measured.
- Silence below -60 dBFS at the start and at the end.
- The frequency of the strongest component of the spectrum averaged over up to 64 frames of 8,192 samples, and the spectral centroid.
- Warnings for samples that reach full scale, and for a DC offset of 0.01 or more.

The image is a 1,024-pixel-wide PNG: the waveform of each channel (of the channel mix for more than two channels) on top, with columns that reach full scale in red, and a spectrogram of the channel mix below, from 20 Hz to the Nyquist frequency on a logarithmic axis with dotted lines at 100 Hz, 1 kHz, and 10 kHz, over a 90 dB range. Dotted vertical lines mark a time step that draws at most 12 lines. The result text describes the image the same way.

`execute_sclang` compiles `code` as the body of a function and runs it inside a Routine on the AppClock, so `.wait` and `Condition` work, and the call ends when the code does. Code that does not compile returns sclang's parse error in the posted text. A thrown error returns its class, message, and, for a method error, the receiver and arguments.

`class_info` reads the help file of each class, `HelpSource/Classes/<name>.schelp`, as plain text of at most 4,000 characters: the summary, the related classes, the description, the methods with their arguments, and the examples. It lists at most 60 methods of each kind and 100 search matches.

<a id="data-directory"></a>
### Files under the data directory

| Path | Contents |
|---|---|
| `payload/<digest>/WasdWorker.sc` | The worker class, copied out of the package for each content version; earlier versions stay |
| `workers/<pid>/<n>/` | One interpreter's folder in the folder of its server process, deleted after the interpreter stops; a starting server deletes the folders of server processes that have exited |
| `workers/<pid>/<n>/sclang_conf.yaml` | The class library configuration of that interpreter |
| `workers/<pid>/<n>/home/config/`, `workers/<pid>/<n>/home/data/` | sclang's user configuration and data folders, such as `SuperCollider/synthdefs/` |
| `workers/<pid>/<n>/scratch/` | Request parameter files, which the worker class deletes after reading, and the score, log, and float audio files of renders and analyses, which the worker and the server delete after use |

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs of Settings › Built-in plugins and the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`. The file embeds the SuperCollider cube logo by Nathan Ho (2015) unaltered in a 36 × 36 canvas: `icons/sc_logo.svg` of SuperCollider 3.14.1 in the [SuperCollider repository](https://github.com/supercollider/supercollider). SuperCollider, including its artwork, is licensed under the [GNU General Public License version 3](https://www.gnu.org/licenses/gpl-3.0.html), not under this repository's license, and `icon.svg` is shared under the same license. The icon refers to the SuperCollider integration only. WASD Engine is not affiliated with or endorsed by the SuperCollider project.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin spans four processes. The Host plugin registers a stdio MCP server, `wasd_supercollider`, with the MCP server manager for its own lifetime; the `wasd_` prefix keeps it apart from a `supercollider` server that a user configures. The manager runs the server entry, `lib/worker.js`, under the Host's own executable with `ELECTRON_RUN_AS_NODE=1`, so the Desktop app needs no separate Node installation; a source launch of the harness runs `src/worker.ts` through tsx instead. The server answers MCP discovery at once and starts no worker until a tool call arrives.

sclang cannot read the worker protocol's JSON request lines, and code running inside it cannot capture the text it posts, so the worker is a bridge: the same server entry, run again with the bridge plan in `argv[2]` and `--sclang-bridge` in `argv[3]`, and with the server's own loader flags, such as tsx's in a source launch. The bridge speaks the [worker protocol](../app-mcp/README.md#run-the-worker) and runs sclang as its child:

```text
<sclang> -i wasd -l sclang_conf.yaml
```

The command runs in the worker's folder, `<dataRoot>/workers/<pid>/<n>/`, which holds `sclang_conf.yaml`.

An IDE name other than `none` turns off sclang's readline input, so sclang interprets its standard input in chunks that end with ESC (0x1b). The bridge first sends `WasdWorker.boot("<token>", "<file>")`, whose JSON file names scsynth, the plugin folder, the scratch folder, and the help folder; the worker class sets `Score.program` and posts `<token> READY {"version": …}`, and the bridge then writes the protocol's ready line. For each request, the bridge writes the parameters to a JSON file, because sclang string literals hold at most 8,191 bytes, and sends `WasdWorker.dispatch(<id>, "<method>", "<file>")`. The worker class reads and deletes the file, runs the handler of the same name in a Routine, and posts `<token> END <id> <JSON reply>` after a newline. The bridge adds the text that sclang posted since the previous reply, at most 20,000 characters kept as its first and last halves, to the reply's `output`, or to the traceback of a failure, and drops the `<name> : setting clientID to <n>.` lines that creating a Server object posts. The token is 32 random hexadecimal digits per bridge, so posted text cannot pose as a reply.

The bridge leads the worker's process group and keeps sclang in it, and sclang runs scsynth through a shell in the same group, so stopping the worker stops every process of a render; on Windows, which has no process groups, the server stops the bridge's process tree instead. sclang runs scsynth through `sh` on macOS and Linux and through `cmd.exe` on Windows, so the worker class quotes paths for that shell and replaces the shell with scsynth with `exec` only outside Windows. The bridge ends with sclang's exit code when sclang exits, with 1 when sclang cannot start or either side breaks the protocol (a reply to another request, a reply that is not JSON, a request while one runs, or a worker class that did not load), and with 2 without a valid plan. At `shutdown` or the end of its input, it sends sclang `0.exit`, because sclang on Windows does not quit at the end of its input, ends sclang's input, and kills sclang when it has not quit after `graceMs`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host plugin: the configuration schema, with the shared fields spread in, and the server registration |
| [`src/worker.ts`](src/worker.ts) | Server process entry: `runAppMcpServer` with the SuperCollider options, worker starter, tools, and instructions, or with `--sclang-bridge` the bridge bound to this process |
| [`src/environment.ts`](src/environment.ts) | The sclang and scsynth search, the shipped runtime's `runtime.json`, the worker's folders, class library configuration, and bridge plan, and setup notes |
| [`src/sclang-bridge.ts`](src/sclang-bridge.ts) | The bridge: the plan, sclang's environment, request files and commands, and protocol replies |
| [`src/sclang-output.ts`](src/sclang-output.ts) | Reply lines in sclang's post output, and the bounded output between them |
| [`src/tools.ts`](src/tools.ts) | Tool declarations, worker requests, reply validation, the analysis report, and help text |
| [`src/audio.ts`](src/audio.ts) | Float WAV reading, levels, BS.1770 loudness, silence, the FFT, and the average spectrum |
| [`src/image.ts`](src/image.ts), [`src/png.ts`](src/png.ts) | The waveform and spectrogram image, its description, and PNG encoding |
| [`src/schelp.ts`](src/schelp.ts) | Plain text of SCDoc help files |
| [`src/instructions.ts`](src/instructions.ts) | Server name and instructions |
| [`sc/WasdWorker.sc`](sc/WasdWorker.sc) | Worker class: boot, dispatch, JSON replies, one handler per method, and the `Server:boot` override |

The shared [`dsh-app-mcp`](../app-mcp/README.md) package owns the shared Config fields and the server registration, the server process, the worker protocol client, the supervisor, the result size bounds, and the setup host.

### Verify against real SuperCollider

From the repository root, run the end-to-end suite. It runs against the shipped runtime when the package's `runtime/<platform>-<arch>/` folder holds one, as `wasdengine/supercollider/build.sh --install` leaves it, and skips without it.

```sh
pnpm run test:e2e packages/gamedev/supercollider/tests/supercollider-worker.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Game development tools](../README.md) — the package group and its other game applications.
- [App MCP runtime](../app-mcp/README.md) — the server process, the worker protocol, supervision, and result bounds.
- [SuperCollider runtime build](../../../wasdengine/supercollider/BUILD.md) — how the runtime that the Desktop app ships is built and published.
- [MCP server manager](../../mcp/mcp-manager/README.md) — plugin-registered servers, their status, and restarts.
- [MCP client](../../mcp/mcp-client/README.md) — tool naming, server instructions, and image admission.
- [SuperCollider documentation](https://doc.sccode.org/) — the upstream reference for the code that the tools run.

-----

<a id="model-experience"></a>
## Model Experience

### SuperCollider tool declarations

#### What the model sees

The model sees 4 tools named `mcp__wasd_supercollider__<name>` with the descriptions and input schemas that [`src/tools.ts`](src/tools.ts) declares and [`model-surface.spec.ts.snap`](tests/__snapshots__/model-surface.spec.ts.snap) pins; the generated tool catalog does not list MCP server tools. In `render_audio` and `execute_sclang`, the `timeout_seconds` description names the `requestTimeoutMs` default in seconds, and its maximum is `toolCallTimeoutMs` less 30 s, in whole seconds. The server lists the tools without starting SuperCollider, so the model sees them whether or not SuperCollider is available.

#### Token effect

The 4 declarations come to about 4,400 characters of JSON, names included, and enter every request while the server's tools are registered.

#### KV Cache effect

One configuration always yields identical declarations, so a reconnect keeps the tool-definition prefix stable. The tools register when the server finishes discovery after the Host starts; a request assembled earlier has no SuperCollider tools, and the first request after registration can lose reuse from the first changed definition onward. A change of `requestTimeoutMs` or `toolCallTimeoutMs` changes the `render_audio` and `execute_sclang` declarations, and a disabled row removes all 4.

### Server instructions in the system prompt

#### What the model sees

After the server connects, the MCP client adds the instructions from [`src/instructions.ts`](src/instructions.ts) to the system prompt under the heading `### MCP server: wasd_supercollider`.

##### SuperCollider server instructions

```markdown
SuperCollider runs headless behind these tools: sclang, its language, keeps state between calls, and scsynth renders sound offline into files. There is no audio device, so nothing plays aloud and real-time servers cannot boot: judge a sound by the measurements and the waveform and spectrogram image that render_audio and analyze_audio return. SuperCollider keeps one interpreter for each conversation: environment variables such as ~kick and SynthDefs added with .add persist between calls until SuperCollider restarts after a crash or a timeout, or stops after a long pause in the calls. The first result after a start names the version.

Paths are absolute. Resolve relative names against your working directory. Write game audio inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Make, look, adjust:
- render_audio evaluates code and renders its value for exactly duration seconds: a UGen graph function such as { Pan2.ar(SinOsc.ar(440), 0) * Env.perc(0.01, 0.5).kr(2) }, a SynthDef, a pattern such as Pbind, or a Score. A function's output channels set the file's channels unless channels is given. Patterns play SynthDefs added with .add, or \default. Sound that is still playing at the end is cut off.
- Read its report: peak and RMS levels, loudness in LUFS, clipping, silence at the start and end, and the dominant frequency. Look at the image: the waveform of each channel above, the spectrogram below. Fix clipping, unintended silence, clicks (thin vertical lines in the spectrogram at onsets or at the end), and harsh highs before calling a sound done.
- analyze_audio reports on any audio file the same way, optionally on a time window.
- execute_sclang runs code to define SynthDefs, build patterns and data, and inspect state. Its result is the value of the last expression as code, and posted text (postln) returns as output. The code runs in a Routine, so .wait works.
- class_info shows classes with their methods, argument names, and defaults, and their help text; check UGen arguments there instead of guessing. Its search finds classes by name.

Game audio:
- Short effects: mono .wav at 44100 Hz with int16 samples, a peak near -1 dBFS (normalize_db: -1), no silence before the onset, and an envelope that ends at zero within the duration, such as Env.perc(...).kr(2).
- Music and ambience: stereo .ogg (Vorbis). For a loop, render a duration of whole bars at the tempo and make the end flow into the start: let releases and effect tails wrap or finish before the end. Godot imports .wav and .ogg; loop playback is an import setting.
- Keep related sounds at a consistent loudness: compare LUFS, not peaks.
- Keep the SuperCollider source next to the sound, such as sfx/jump.scd beside sfx/jump.wav, so it can be changed and rendered again.
```

#### Token effect

The section adds about 2,800 characters to every request while the server is connected.

#### KV Cache effect

The text is constant, so a reconnect renders an identical section. The section appears when the server first connects and disappears when the row is disabled or the server's reconnect attempts run out; each change alters the assembled system prompt, and the [system prompt's cache rules](../../core/system-prompt/README.md#model-experience) decide how much of the prefix stays reusable.

### Tool results and images

#### What the model sees

Each result has one text block, and `render_audio` and `analyze_audio` add one PNG image, 1,024 pixels wide and 418 or 536 pixels high. After each worker start, the next result begins with `SuperCollider <version> started (<source>) with no SynthDefs or variables defined.` and a blank line, where the source is `the runtime that WASD Engine ships` or `sclang at <path>`. The rest of the text reports what the call did, with the analysis report and the image description for audio; posted text follows `output:` at the end. Error results carry the failure: a missing runtime returns the message below, which names the computer's platform and architecture, here those of an Intel Mac, an error that the worker class reports returns its class and message with `Error code: WORKER_REMOTE`, an `execute_sclang` error returns its class, message, and details, and a stopped worker returns its error code, recent interpreter output, and the notice that its state was lost. The [MCP client](../../mcp/mcp-client/README.md#model-experience) admits images only on model routes that declare image input and gives other routes diagnostic text instead.

##### Missing runtime message

```markdown
WASD Engine's headless SuperCollider is not installed for darwin-x64. The WASD Engine desktop app ships it for macOS on Apple silicon and for Windows x64; a source checkout installs it with `wasdengine/supercollider/build.sh --out <folder> --install packages/gamedev/supercollider/runtime`. WASD Engine does not start an installed SuperCollider, whose application opens as an app. The SuperCollider plugin settings sclangPath and scsynthPath can name another headless build.
```

#### Token effect

Arguments, result text, and admitted images stay in the conversation until compaction. The tools bound their text: posted output keeps at most 20,000 characters, an `execute_sclang` result at most 20,000 characters of code, help text at most 4,000 characters per class, method lists 60 entries per kind, and searches 100 names; the server cuts any text block over 1 MiB of JSON. Each image is a PNG of about 20 to 100 KiB.

#### KV Cache effect

Append-only: calls and their results follow the existing request prefix and do not invalidate it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe current gaps in the SuperCollider tools.

- **Nothing plays aloud** — the tools run without an audio device and refuse to boot a real-time server, so neither the agent nor the user hears a sound through the tools; the user listens to the rendered files, in the game or elsewhere.
- **Connected agents share one interpreter** — agents connected through WASD Engine's MCP server share its variables and SynthDefs, and a long render delays the others' calls.
- **An idle Session loses its interpreter state** — a Session's interpreter stops after `workerIdleTimeoutMs` without calls, or when another Session needs its place among `maxWorkers`.
- **Restarts lose interpreter state** — a crash, an expired `requestTimeoutMs` or `timeout_seconds`, a cancelled running call, or code that calls `0.exit` stops sclang; the variables and SynthDefs are gone, and the fresh interpreter starts with none.
- **SuperCollider runs on macOS arm64, Windows x64, and Linux x64 only** — the Desktop apps for macOS on Apple silicon and Windows x64 ship the runtime, and a Linux checkout can install the release build; Intel Macs have no runtime, and the tools start no installed SuperCollider, so they report the missing runtime there unless `sclangPath` names a headless build.
- **sclang on Windows uses the user's own SuperCollider folder** — it ignores `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, so it creates its user folders in `%LOCALAPPDATA%\SuperCollider` and reads the user's own extensions there unless the class library configuration excludes them, as it does for the shipped runtime; the worker class skips the startup files there.
- **Plugins are the core UGens** — the shipped runtime holds the UGens of SuperCollider itself, not sc3-plugins or other extensions, and its class library has no GUI classes.
- **Loudness weighs every channel equally** — the BS.1770 surround weights do not apply, so files with more than two channels read louder than the standard measures them.
- **Images need an image-capable route** — on a model route without image input, the model receives diagnostic text instead of the waveform and spectrogram.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
