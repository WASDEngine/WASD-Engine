---
description: "Godot game runs through LibGodot for deployments and maintainers configuring the runtime, its install, frame streaming, and timeouts, or debugging the godot_* tools, the Game tab, the godot Remote, and the /api/godot.frames route."
kind: "package-reference"
---

# @deepseek-ai/dsh-godot

English | [中文](README.zh.md)

## Summary

Let the agent run the Session's Godot game, see it in screenshots, play it with keys, mouse, and input actions, read its logs and errors, and check GDScript without running it. You watch and play the same game in the Game tab of the right sidebar. WASD Engine Web and Desktop turn the plugin on by default. Games run through LibGodot, which you install once from the Game tab, or through an installed Godot editor; only LibGodot on macOS runs them without a window. Each Session runs one game at a time; game audio plays only on the Host.

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

Choose this plugin when the agent should test a Godot game by running and playing it, and when the user should watch or play that game beside the conversation. The plugin starts its own Godot process for the Session's project and never connects to a Godot editor that the user has open. Loading the plugin registers its tools, prompt section, Remote, and frame route; no Godot process starts and nothing is downloaded until a game or a script check starts or the user installs the runtime.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the `godot` row into every Web and Desktop profile and puts its data directory under the harness home: `~/.wasdengine/godot`, or `$DSH_HOME/godot` when `DSH_HOME` is set.

```yaml
- id: godot
  name: '@deepseek-ai/dsh-godot'
  config:
    dataRoot: !!js dshHomePath('godot')
```

The Host plugin requires the `tools`, `systemPrompt`, `workingDirectory`, `subprocess`, `agents`, and `typert` services. It registers the frame route only while a `connection` service exists, screenshots also need the `attachments` and `llm` services, and **Play** in the Game tab needs the `sessionController` service, which resumes a Session that has no live Agent. The row also carries the package's browser half, the Game tab and the Godot tool cards, which need the right sidebar of Web and Desktop.

### Turn the plugin off or change its settings

A profile patch overrides the row by its id. Add the entry to `$DSH_HOME/profiles/<name>/cordis.patch.yml`, where `$DSH_HOME` is `~/.wasdengine` when unset and the standard profile names are `web` and `desktop`. Restart Web or Desktop after editing the patch. The switch on the Game tools tab of the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) adds and removes this `disabled` entry through the plugin manager, which applies the change or says that it waits for a restart.

```yaml
- id: godot
  disabled: true
```

A disabled row withdraws the tools, the prompt section, the Remote, the frame route, and the Game tab, and stops every running game. A patch that sets `config` replaces the row's whole configuration, so restate `dataRoot` beside the fields you change:

```yaml
- id: godot
  config:
    dataRoot: !!js dshHomePath('godot')
    streamFps: 15
    agentRunsMuted: false
```

### Configuration

[`src/index.ts`](src/index.ts) declares and validates these fields. Loading fails when `dataRoot`, `libgodotPath`, `runnerPath`, or `godotExecutable` holds a relative path, when only one of `libgodotPath` and `runnerPath` is set, or when `runtimeManifestUrl` is not an http or https URL.

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | required | Absolute directory for the managed runtime and the copies of the harness scripts |
| `runtimeVersion` | `4.7.2-wasd.1` | Version of the managed runtime: its folder name under `runtime/` and the version its manifest must describe |
| `runtimeManifestUrl` | `https://github.com/WASDEngine/WASDEngine/releases/download/libgodot-4.7.2-wasd.1/manifest.json` | Release manifest that the install downloads |
| `libgodotPath` | `''` | Absolute LibGodot library; set together with `runnerPath` |
| `runnerPath` | `''` | Absolute `godot_runner` executable; set together with `libgodotPath` |
| `godotExecutable` | `''` | Absolute Godot editor executable, used when no LibGodot runtime resolves; empty searches `PATH` and, on macOS, `/Applications` |
| `embedded` | `true` | Render LibGodot runs on macOS without a window |
| `streamFps` | `30` | Frames per second streamed to the Game tab, 1 to 60 |
| `streamQuality` | `0.7` | JPEG quality of streamed frames, 0.1 to 1 |
| `streamMaxWidth` | `1280` | Largest streamed frame width in pixels, 64 to 4096 |
| `importBeforeRun` | `true` | Import the project's assets before each run |
| `importTimeoutMs` | `180000` | Deadline of the import step and of one `godot_check` |
| `startTimeoutMs` | `60000` | Deadline from the launch until the game connects |
| `requestTimeoutMs` | `15000` | Deadline of a screenshot, evaluation, scene tree, pause, or resume request, the longest silence of the game while any request waits, and the real time that a wait, a step, or an input sequence of the agent may take beyond the time it needs at 10 frames per second |
| `stopGraceMs` | `3000` | Time a stopped game gets to quit before it is terminated, and the termination grace of every Godot process |
| `processOutputBytes` | `1048576` | Bytes of console output kept per stream of each Godot process, at least 1024 |
| `maxLogEntries` | `5000` | Log entries kept per run |
| `maxRuns` | `4` | Games that may run at once across all Sessions, each counted until its process ended |
| `agentRunsMuted` | `true` | Whether runs that the agent starts have no audio unless `godot_run` says otherwise |

<a id="runtime"></a>
### Godot runtime

Each run and each `godot_check` resolves the runtime again and takes the first match:

1. `runnerPath` and `libgodotPath`: a LibGodot runner and library that you built or installed yourself.
2. The runtime that the Desktop app ships in this package's `libgodot/<platform>-<arch>/` folder, which a packaged app reads from `app.asar.unpacked`, used only when its `runtime.json` names this version, platform, and architecture and its runner and library exist.
3. The managed runtime in `<dataRoot>/runtime/<runtimeVersion>/`, under the same conditions.
4. `godotExecutable`: an installed Godot editor executable.
5. `godot`, then `godot4`, on `PATH`.
6. On macOS, `Contents/MacOS/Godot` of a `Godot*.app` bundle in `/Applications`, trying the bundle names in reverse alphabetical order.

A configured path that is not a usable file fails the call with a message that names the field, and the search does not continue. Because the shipped and the managed runtime come before `godotExecutable`, either one takes precedence over it. Desktop packaging puts the shipped runtime in place ([LibGodot in the Desktop app](../../../wasdengine/FORK.md#libgodot-in-the-desktop-app)); a source checkout and an npm install ship none and use the managed runtime. When nothing resolves, `godot_run` and `godot_check` fail and ask for the runtime to be installed from the Game tab or configured.

A LibGodot run on macOS with `embedded: true` passes `--embedded`, and the [patched LibGodot](../../../wasdengine/libgodot/BUILD.md#the-patch) renders the game with Metal into a layer that no window shows: no game window opens, and the Game tab and screenshots are the only views of the game. Every other run opens a normal game window on the Host's desktop: LibGodot on Linux and Windows, LibGodot on macOS with `embedded: false`, and every run of an editor executable. The Game tab streams those runs as well.

<a id="managed-runtime"></a>
### Install the managed runtime

The managed runtime is Godot 4.7.2 built as LibGodot with the WASD Engine patches; the [LibGodot build guide](../../../wasdengine/libgodot/BUILD.md) describes the runner, the archive, `runtime.json`, and the manifest. **Install Godot** in the Game tab, shown while the runtime is missing or failed, calls the `installRuntime` Remote method, which:

1. downloads `runtimeManifestUrl` and requires its `version` to equal `runtimeVersion`;
2. picks the artifact for the Host's `<platform>-<arch>` key, such as `darwin-arm64`;
3. downloads the archive from the artifact's `url`, resolved against the manifest URL, and checks its size and SHA-256 while it arrives;
4. extracts the archive with `tar` into a staging folder, checks that the runner and the library are there, and writes `runtime.json`;
5. renames the staging folder to `<dataRoot>/runtime/<runtimeVersion>/` under a file lock; when another Host process installed the runtime meanwhile, it keeps that one.

While the install runs, every Game tab shows Downloading Godot with a percentage, then Verifying Godot and Unpacking Godot. A second request joins the running install; closing the tab stops only its wait, and unloading the plugin cancels the install. The download and staging files are removed after success and failure alike, and a failure shows its cause: an unreachable manifest or its HTTP status, an invalid manifest or one for another version, no build for the platform, a download error, a size or SHA-256 mismatch, or an archive without the runtime files. `wasdengine/libgodot/build.sh --install <dataRoot>` installs a local build in the same place.

<a id="game-runs"></a>
### Game runs

One Session runs at most one game. `godot_run` and the Game tab's **Play** stop the Session's current game before they start the next one, and the Host runs at most `maxRuns` games across all Sessions; a game counts until its process ended, also while it stops after its Session closed. When the Session's Agent ends, for example because the Session closes, its game stops, and unloading the plugin stops every game.

A run uses the folder that its `project` argument names, relative to the working directory, or else the nearest `project.godot`: the plugin searches the working directory and three folder levels below it, breadth first in name order, and skips `.git`, `node_modules`, `.godot`, and `.agents`. A `scene` must be the `res://` path of an existing file or a `uid://` reference; without one, the game opens the project's main scene. `width` and `height` set the window size together, from 1 to 16384 pixels.

A run moves through these phases:

1. `preparing` from the creation of the run until its import step or launch begins, which follows at once. The plugin resolves the project, the scene, and the runtime before it stops the Session's previous game and creates the run, so a problem with one of them fails the call and leaves the previous game running; a `maxRuns` refusal comes after the previous game stopped.
2. `importing` while Godot's headless `--import` updates the project's import data, when `importBeforeRun` is set. Its errors and warnings enter the run's log; an import that exits abnormally adds a warning and the run continues, and one that exceeds `importTimeoutMs` fails the run.
3. `starting` from the launch until the game connects to the Host. The plugin listens on a random loopback port of `127.0.0.1`, passes the game a random token, and fails the run when no game presents the token within `startTimeoutMs`.
4. `running` or `paused` while the game is connected.
5. `exited`, `crashed`, or `failed` after it ended. A game that quits by itself with exit code 0, or that the user or the agent stopped, ends `exited`. Any other exit ends `crashed`, and so does a game that closes its connection but keeps running for `stopGraceMs`. A run that fails before the game connects ends `failed`. Crash and failure messages quote the last 20 lines of the process output.

Stop asks the game to quit and terminates the process when it still runs after `stopGraceMs`; from the moment a stop begins, the game takes no further requests, and Game tab input for it is dropped. While any request waits, a game that sends nothing for `requestTimeoutMs` fails the waiting requests with `The game stopped responding`; a running game reports its status at least once a second. When the Host gives up on a wait, a step, or an input sequence, because its caller cancelled it or the game stopped responding, it asks the game to drop the request, and a dropped input sequence releases the keys, buttons, and actions that it still holds. The LibGodot runner exits when the Host process exits, and the harness quits the game when its connection to the Host closes.

Runs that the agent starts use Godot's `Dummy` audio driver unless `godot_run` passes `muted: false` or `agentRunsMuted` is `false`. Runs started from the Game tab play audio.

<a id="harness"></a>
### The harness

The harness is not copied into the project: each run passes the package's `runtime/wasd_harness.gd` with Godot's `--script` option from its copy in `<dataRoot>/payload/`, and `project.godot` and the project's scenes and scripts stay unchanged. The import step writes the same import data as the Godot editor. The harness is the game's main loop: it opens the main scene or the requested one with the project's autoloads, keeps serving the Host while the game is paused, records printed lines and errors with their script backtraces through a Godot `Logger`, and answers the Host's screenshot, frame stream, input, wait, step, pause, resume, cancel, evaluation, scene tree, and quit requests over the loopback connection.

<a id="tools"></a>
### Tools

Every tool works on the calling Session's game; a call outside a Session fails.

| Tool | Arguments | Result |
|---|---|---|
| `godot_run` | `project`, `scene`, `width`, `height`, `muted` | Starts or restarts the game and waits until it runs, then reports its phase, project, scene, window size, renderer, Godot version, and windowless and muted flags, and up to 20 errors and warnings logged while importing and starting; a game that fails to start, or ends within a second after it starts running, fails the call |
| `godot_stop` | none | `Stopped the game.` after the game ended, or `No game was running.` |
| `godot_screenshot` | `max_width` (default 1280, 64 to 4096) | One PNG image of the game window, scaled down to `max_width` pixels, with the image size, the window size, the frame number, and whether the game is paused |
| `godot_input` | `events` (at most 256), `screenshot`, `coordinate_space` | Runs the events in order, with waits and holds in real time, then reports the event, frame, and second counts and the current frame; `screenshot: true` adds a screenshot. A sequence ends early once its waits, one frame per wait and one to start at 10 frames per second, plus `requestTimeoutMs` of real time have passed, and reports the events that ran |
| `godot_wait` | `seconds` or `frames`, `screenshot` | Lets that much unpaused game time or that many frames (1 to 100000) pass; refuses `seconds` while the game is paused, and ends a wait early, reporting the game time and frames that passed, once its seconds, or its frames at 10 frames per second, plus `requestTimeoutMs` of real time have passed, for example because the game paused itself |
| `godot_control` | `action` (`pause`, `resume`, or `step`), `frames` | Pauses or resumes the game, or runs `frames` frames (default 1, at most 100000) and pauses again; a step ends early when the game is paused, resumed, or stepped again meanwhile, for example from the Game tab, and once its frames at 10 frames per second plus `requestTimeoutMs` of real time have passed, and the result says which; reports the pause state and the frame |
| `godot_eval` | `expression`, `node` | Evaluates a Godot `Expression` in the running game with `scene`, `root`, and `tree` defined and the node at `node`, or the current scene, as the base; returns the value as JSON and its Godot type |
| `godot_scene_tree` | `node`, `depth` (default 6, at most 64), `max_nodes` (default 400, at most 5000) | An indented outline of node names, classes, scripts, positions, sizes, hidden nodes, Label and Button text, and disabled processing |
| `godot_logs` | `since`, `levels`, `limit` (default 200, at most 1000) | Log entries after the cursor `since`, or after this Session's previous read, and the next cursor |
| `godot_check` | `paths`, `project` | Loads GDScript files in a headless Godot without running the game and lists the problems per file |

`godot_screenshot`, `godot_input`, `godot_wait`, `godot_control`, `godot_eval`, and `godot_scene_tree` need a connected game. Before the Session's first run they fail with `No game is running in this Session; call godot_run first.`, while the game starts or stops with `The game is starting or stopping; call godot_run to wait for it.`, and after the game ended they name its phase and quote the crash or failure message.

With `screenshot: true`, `godot_input` and `godot_wait` check that the model route can see images before they send anything to the game, and fail without acting when it cannot. A screenshot that fails after the events or the wait does not fail the call, because the game already acted: the result text says `The screenshot after the events failed: <reason>` or `The screenshot after the wait failed: <reason>`.

`godot_input` takes `key` events with a Godot key name such as `W`, `Space`, `Left`, `Enter`, or `Escape`, or a `keycode`; `text`, typed character by character; `mouse_button` with `left`, `right`, `middle`, or a wheel button at `x` and `y`; `mouse_motion`; `action` for an input map action such as `ui_accept`, with an optional `strength`; `joy_button` and `joy_axis` for a joypad `device`; and `{ "wait": seconds }`, which pauses the sequence for that much real time. A press stays down until its release event or until its `hold` time, also real time, ends. The game runs one input sequence at a time, the Game tab's input included, in arrival order. An agent sequence's limit counts from when the game receives it, so a sequence that waits behind other input can end before its first event; Game tab input has no limit, so a batch that waits behind an agent sequence still delivers its key and button releases. Mouse coordinates are pixels of the current run's latest screenshot, which the plugin scales to window pixels, so a pointer event before the run's first screenshot fails; `coordinate_space: "window"` takes window pixels instead.

Each result ends with the error, script error, and shader error entries that the run logged since the Session's previous Godot tool call, at most 10 and then a count, and a failure's message carries the same report. `godot_run` reports the problems of the import and startup itself, and `godot_logs` marks every entry up to its next cursor as reported, including entries that its `levels` filter left out.

A run keeps its newest `maxLogEntries` log entries. Each entry carries a sequence number that increases across all runs of the Host, its source (`game` for the harness logger, `process` for console output of the Godot process, `import` for the import step), its level (`stdout`, `stderr`, `warning`, `error`, `script_error`, or `shader_error`), the message, which the plugin cuts at 4,000 characters, and the file, line, function, and script backtrace when Godot reports them. Console output of the game process enters the log after the game closed its connection, and all of it when the game failed to start. `godot_logs` reports when entries after its cursor were already discarded.

`godot_check` starts one headless Godot that loads each script through `runtime/wasd_check.gd`, bypassing the resource cache. It creates no autoload and opens no scene, so the only project code that it runs is what loading runs: the static initializers of the loaded scripts and the custom resource loaders and savers that the project declares as global classes. It checks the files and folders that `paths` names, as `res://` paths or paths relative to the working directory, or every `.gd` file of the project, at most 400. Without `project`, it uses the project of the Session's current or last run, else the nearest one. It lists the errors and warnings that Godot logged in `res://` files while a script loaded, so an error in a preloaded script names that script; a script without such entries gets the first engine error, if any. The check fails when Godot ends, or exceeds `importTimeoutMs`, before it reported every script. Scripts that name a singleton autoload check as in a game, except that a scene autoload is typed as `Node`, so the check does not report type errors in uses of a scene autoload's members.

Result text stays within 6,000 characters and ends with `… (output shortened)` when cut, and quoted log messages stay within 500 characters. `godot_logs` ends its page before the text budget, and its next cursor follows the last listed entry.

<a id="connected-agents"></a>
### Tools for connected agents

Agents on the computer that connect through WASD Engine's MCP server, [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md), get the same ten tools from the plugin's provider in [`src/mcp.ts`](src/mcp.ts), built by the same `godotToolDefinitions` with three differences:

- Every tool takes `project`, the absolute path of the folder that holds `project.godot`, of a folder up to three levels above it, or of the `project.godot` file; without it, a call uses the agent's previous project and fails with `Pass project: the absolute path of the folder that holds project.godot.` before the agent's first. The call runs for the agent's own Session in that game project, which the MCP server creates on first use, so the run, its logs, and the Game tab are that Session's.
- The `godot_run` description says that the game plays in the WASD Engine window, `godot_check` takes absolute paths where the Session's tool takes paths relative to the working directory, and `godot_logs` reads after the entries the agent last read.
- Screenshots return as PNG bytes in the result instead of attachments for a model route, with no model check; each is requested at a width that keeps its longest edge at most 1,568 pixels and its area at most 1,150,000 pixels, the sizes agents take without resizing.

`godot_run` also asks the WASD Engine window to show the Session, whose Game tab then opens for the run. The provider reports the runtime's readiness to `search_game_tools`: `ready`, `starting` while the managed runtime installs, or `unavailable` with the runtime message.

<a id="game-tab"></a>
### Game tab

The browser half adds the Game tab to the right sidebar. Open it from the Game card of the sidebar's [guide](../../client/ui-sidebar-right/README.md#the-guide). When a run that the agent started is in progress in the Session on screen, the tab opens by itself once per run while the page stays loaded, also when the user switches to that Session later; a tab the user closed stays closed for that run. The tab follows the Session's game, whoever started it, also in a Session without a live Agent, for example after a Host restart, where it shows no run until one starts.

- **Play** runs the main scene of the project of the Session's last run, or of the nearest project when the Session has no run, and resumes a Session without a live Agent first, as sending a message does. While a run is in progress it reads **Restart** and runs the project again with the scene and window size that the run was started with. It is disabled until a runtime resolves.
- **Stop** stops the run in progress.
- **Pause** and **Resume** pause and continue a running game, and **Step one frame** advances a paused game by one frame.
- **Install Godot** appears while the runtime is missing or failed.

The status area shows the install progress, the run's phase, its frame rate, the scene file, with its `res://` path as a tooltip, and the renderer. An action that the Host refuses shows a message that can be dismissed, and each control stays disabled while its own request runs. When another running Web or Desktop app writes the Session, Play shows `This session is open in another running Web or Desktop app. Quit that app and try again.`

The game view draws the newest streamed frame, fitted into the tab with bars on two sides, and streams only while the follow stream delivers, the tab is visible, and the game is running or paused. Click the game to give the view focus. While it has focus, the view sends mapped keys to the game and keeps them from the page; unmapped keys, IME composition, and presses with the Meta key (Command or Windows) held stay with the page and the app. A character typed with AltGr, which Windows reports as Ctrl+Alt, reaches the game with its text; other Ctrl chords carry no text. On Windows Desktop, application shortcuts such as Ctrl+W do not run while the view has focus, so the game receives those keys; on macOS Desktop, chords with Command stay with the app. Shift+Esc never reaches the game: it gives the keyboard back to the page, and the view shows `Press Shift+Esc to release the keyboard` for a few seconds after it takes focus. Mouse buttons, motion, and wheel steps over the image reach the game in game window pixels, and a drag that started on the image continues outside it. When the game captures the mouse, the next press locks the pointer to the view and motion reaches the game as relative movement; the lock ends when the game releases the mouse, or when the browser ends it. Losing focus releases every key and button that the view holds.

Input travels in batches of at most 256 events, one per repaint, with consecutive mouse motions merged; the next batch waits until the Host accepted the previous one. The Host forwards one batch at a time to the game and drops the oldest queued events beyond 256. Input for a run that has ended is dropped. When a batch fails for another reason, the tab logs the failure once until a batch succeeds again and sends the failed batch's key and mouse button releases again with the next batch, or when the view loses focus, so that the game does not keep a key or button held.

The **Logs** drawer under the view shows the run's error and warning counts; opened, it lists the newest entry first, with its `res://` file and line. The tab keeps the 500 newest entries of the current run, and when more than 200 entries arrive between two updates of the follow stream, it receives only the newest 200. When a run ends, the view shows whether the game exited, crashed, or could not start, with its exit code or signal and the quoted output. When the follow stream ends after its snapshot, the tab follows the Session again at once and keeps the last state. When it stops before a snapshot, the tab follows again after 1 s, doubling the delay up to 30 s, or at once when the user presses **Retry**; meanwhile it shows `Lost the connection to the game.` with **Retry** above the last state, and the game view neither streams frames nor takes input.

In the conversation, calls of `godot_screenshot`, `godot_input`, and `godot_wait` render as Game screenshot, Game input, and Game wait rows. A row's summary shows the screenshot size, the first line of the result, Failed, or Stopped; expanded, it shows the screenshot, which opens a larger preview, and the result text. The other Godot tools use the standard tool row.

<a id="remote-and-frames"></a>
### Remote methods and the frame route

The Game tab calls the Host through the `godot` Remote namespace. Every method except `installRuntime` takes the Session id first, and none needs a live Agent: `follow`, `stop`, `control`, and `input` act on the Session's run, and `run` first resumes a Session without a live Agent through the `sessionController` service, as a prompt does.

| Method | Returns | Purpose |
|---|---|---|
| `follow(session)` | stream of `GodotFollowItem` | A `snapshot` of the run, the runtime state, the newest 200 log entries, and the log cursor, then `run`, `logs`, and `runtime` items; items coalesce while the reader is behind. A Session without a live Agent has no run (`null`), also once its Agent ended, and the run that a later Agent starts arrives in the same stream, which ends when the call is cancelled or the plugin unloads |
| `run(session, request)` | `GodotRunView` | Resumes a Session without a live Agent, then starts or restarts the game with `project`, `scene`, `width`, `height`, and `muted` (default `false`); returns once the game is launched, and the follow stream reports its progress; cancelling the call stops only the wait for a resume that began |
| `stop(session)` | nothing | Returns after the game ended, and refuses with `godot/not-running` when the Session has no run; cancelling the call stops only the wait |
| `control(session, request)` | `GodotRunView` | `pause`, `resume`, or `step` with `frames` from 1 to 100000 |
| `input(session, runId, events)` | nothing | Queues at most 256 events for the named run without waiting for the game |
| `installRuntime()` | `GodotRuntimeView` | Installs the managed runtime, or joins the install that runs, and returns after it settled |

Refusals carry these codes: `godot/no-project` with the searched `directory`, `godot/runtime-unavailable`, `godot/not-running`, `godot/stale-run` for input meant for a run that is no longer current, `godot/too-many-runs` with the `limit`, `godot/request-failed` when the game refused a request or did not answer, and `gateway/bad-request` for invalid events, sizes, or frame counts. A `run` whose resume fails carries the Session controller's code, such as `session/not-found`, or `session/writer-held` while another Host process writes the Session. LiveShare classifies every method as owner-only and excludes the namespace from shares.

The game view reads `GET /api/godot.frames?session=<SessionId>&run=<runId>`, an exact Connection route that only owner Peers reach; the plugin registers it while a `connection` service exists. The route answers 400 when a parameter is missing and 404 when the Session has no live run with that id. Otherwise it streams `application/octet-stream` with `Cache-Control: no-store, no-transform` until the run ends or the request is aborted. The body is a sequence of records:

| Offset | Bytes | Field |
|---|---|---|
| 0 | 4 | JPEG length `N`, unsigned little-endian |
| 4 | 2 | Frame width in pixels, unsigned little-endian |
| 6 | 2 | Frame height in pixels, unsigned little-endian |
| 8 | 4 | Frame sequence number within the run, unsigned little-endian |
| 12 | `N` | JPEG bytes |

The harness streams frames only while at least one frame response is open, at `streamFps` frames per second and JPEG quality `streamQuality`, scaled down to at most `streamMaxWidth` pixels wide. Frames that arrive while the reader has not taken the previous record replace one another, so a slow reader receives the newest frame. The Game tab reopens a frame response that fails or ends after 250 ms, doubling the delay up to 4 s while attempts deliver no frame.

<a id="data-directory"></a>
### Files under the data directory

| Path | Contents | Lifetime |
|---|---|---|
| `payload/<hash>/wasd_harness.gd`, `payload/<hash>/wasd_check.gd` | Copies of the harness and the check script outside the Desktop application archive; `<hash>` is the first 16 hex digits of the script's SHA-256 | Reused while the script is unchanged; earlier versions stay |
| `runtime/<runtimeVersion>/` | The managed runtime: the runner, the LibGodot library, and `runtime.json` | Kept; a new `runtimeVersion` installs beside it |
| `runtime/.download-<id>.tar.gz`, `runtime/.staging-<id>/`, `runtime/<runtimeVersion>.lock` | The archive, the extracted files, and the writer lock of an install in progress | Removed when the install ends |

The plugin writes nothing else under `dataRoot`; screenshots go to the attachment store.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs of Settings › Built-in plugins and the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`. The file embeds the Godot Engine logo, copyright © 2017 Andrea Calabró, unaltered in a 36 × 36 canvas, with a `viewBox` added so that it scales: `misc/logo/icon.svg` of Godot 4.7.2 in the [Godot repository](https://github.com/godotengine/godot), also in the [Godot press kit](https://godotengine.org/press/). The logo is licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), not under this repository's license. Godot and the Godot logo are trademarks of the Godot Foundation, used under its [trademark policy](https://godot.foundation/policies-and-procedures/trademark-policy) to identify the Godot integration. WASD Engine is not affiliated with or endorsed by the Godot Foundation. The Game tab, its guide entry, and the Godot tool cards keep the package's own game controller glyph.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package has a Host face and a Client face. The Host face is the `godot` service, a Typert Remote service: its constructor validates the configuration, registers the tools and the prompt section, and registers the frame route while a `connection` service exists. It owns a runtime manager, which resolves and installs runtimes and publishes the runtime view to every follow stream, and a registry of per-Session state keyed by the live Agent: the current run, the log and new-error cursors, and the frame of the latest screenshot; the registry also keeps the follow streams of each Session id, which outlive the Agent. Starts and stops of one Session run one at a time.

A run owns its import process, its loopback listener, its game process, and its timers, and releases all of them when it ends. The [harness protocol](../../../docs/subsystems/gamedev.md#harness-protocol) defines the messages that the run and the harness exchange: the token handshake, requests and their answers, status, logs, frames, and screenshot images.

The Client face mounts the generated `godot` Remote first and the UI after it, and withdraws the UI before the Remote. One follow source per Session folds the follow stream into the tab's state while anything reads it. The game view reads the frame route with `fetch`, decodes the newest JPEG record with `createImageBitmap`, and draws it on the next repaint.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host plugin: configuration, prompt section, Remote methods, and frame route |
| [`src/runtime.ts`](src/runtime.ts) | Runtime resolution, the managed install, and the runtime view |
| [`src/runs.ts`](src/runs.ts) | Per-Session state, run replacement, and the run limit |
| [`src/run.ts`](src/run.ts) | One run: import step, launch, handshake, requests, logs, frames, and shutdown |
| [`src/protocol.ts`](src/protocol.ts) | Message framing and validation on the harness connection |
| [`src/tools.ts`](src/tools.ts) | Tool declarations, result text, and new-error reports |
| [`src/check.ts`](src/check.ts) | Static script check |
| [`src/project.ts`](src/project.ts) | Project search, `project.godot` settings, and `res://` paths |
| [`src/input.ts`](src/input.ts), [`src/logs.ts`](src/logs.ts) | Input validation and screenshot coordinates; the log ring and its cursors |
| [`src/follow.ts`](src/follow.ts), [`src/frames.ts`](src/frames.ts) | Follow stream and frame route |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: the Remote, the Game tab, the tool cards, and the automatic opening |
| [`src/client/GameTab.tsx`](src/client/GameTab.tsx) | Game tab body: toolbar, game view, and log drawer |
| [`src/client/input.ts`](src/client/input.ts), [`src/client/frames.ts`](src/client/frames.ts) | Keyboard and mouse capture; frame reading and drawing |
| [`runtime/wasd_harness.gd`](runtime/wasd_harness.gd) | In-game harness |
| [`runtime/wasd_check.gd`](runtime/wasd_check.gd) | Script loader of `godot_check` |

### Verify against a real runtime

From the repository root, run the end-to-end suite with `WASD_LIBGODOT_DIR` set to a folder that holds `godot_runner` and the LibGodot library under the name that `wasdengine/libgodot/build.sh` installs, `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`, such as an installed macOS or Linux runtime. It imports a test project, runs it, windowless on macOS, calls the screenshot, input, wait, log, evaluation, scene tree, control, check, and stop tools, reads the frame route, and runs a second project whose stretch mode letterboxes the game; without the variable, the suite is skipped.

```sh
WASD_LIBGODOT_DIR="$HOME/.wasdengine/godot/runtime/4.7.2-wasd.1" \
pnpm run test:e2e packages/gamedev/godot/tests/godot-runner.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Game development tools](../README.md) — the package group and its other game applications.
- [Game tools subsystem](../../../docs/subsystems/gamedev.md) — the run lifecycle, the harness protocol, input events, and the Game tab's channels.
- [LibGodot runtime](../../../wasdengine/libgodot/BUILD.md) — the runner, the macOS patch, and how runtimes are built, installed, and published.
- [Right sidebar](../../client/ui-sidebar-right/README.md) — the dock that holds the Game tab.
- [Connection](../../client/connection/README.md) — exact routes and owner Peers.
- [LiveShare](../../experimental/liveshare/README.md) — what share viewers may call.
- [Godot command line](https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html) — upstream options such as `--script`, `--import`, and `--headless`.

-----

<a id="model-experience"></a>
## Model Experience

### Godot tool declarations

#### What the model sees

The plugin registers 10 tools in the global tool layer when it loads, so they reach every Agent whose tool set does not exclude them, whether or not a Godot runtime or project exists: `godot_run`, `godot_stop`, `godot_screenshot`, `godot_input`, `godot_wait`, `godot_control`, `godot_eval`, `godot_scene_tree`, `godot_logs`, and `godot_check`, with the names, descriptions, and parameter schemas that [`src/tools.ts`](src/tools.ts) declares. The only configured text is the `muted` description of `godot_run`, `Run without audio. Default: <agentRunsMuted>.`

#### Token effect

The 10 declarations come to about 6,700 characters of JSON with the default configuration, names included, and enter every request that offers them; `godot_input` is the largest at about 2,500 characters.

#### KV Cache effect

One configuration always yields identical declarations, registered before the first request, so the tool-definition prefix stays stable. A change of `agentRunsMuted` changes the `godot_run` declaration, and disabling the row removes all 10 declarations; either change can invalidate reuse from the first changed definition onward.

### Godot section in the system prompt

#### What the model sees

The plugin registers a global system prompt section named `godot` at the order of the `TOOL_COMPUTER_USE` position, with this constant text; the section is static, so it stays in the prompt of an Agent whose tool set excludes the Godot tools.

##### Godot section text

```markdown
# Godot games

When the working directory holds a Godot project, test it with the godot_* tools:
1. godot_run starts or restarts the game and reports import and startup errors.
2. godot_screenshot shows the current frame. godot_input sends keys, text, mouse clicks and motion (in screenshot pixels), and input actions; godot_wait lets game time pass. Look again after acting.
3. godot_logs reads printed output and errors; godot_eval and godot_scene_tree inspect the running scene; godot_control pauses, resumes, or steps frames.
4. Fix the first error, then call godot_run again. godot_check finds GDScript errors without running the game.
The user can watch and play the running game in the Game panel.
```

#### Token effect

The section adds 704 characters to every system prompt while the plugin is loaded.

#### KV Cache effect

The text is constant and present from the first request, so it keeps the system prompt stable; enabling or disabling the row adds or removes the section, and the [system prompt's cache rules](../../core/system-prompt/README.md#model-experience) decide how much of the prefix stays reusable.

### Tool results, screenshots, and new-error reports

#### What the model sees

Each result carries one text block of at most 6,000 characters; `godot_screenshot`, and `godot_input` or `godot_wait` with `screenshot: true`, add one PNG image block, stored as the attachment `godot-frame-<frame>.png`, and the text states the image size that the model receives, which `godot_input` mouse coordinates refer to; when that screenshot fails after the events or the wait, the text gives the reason instead. Each result, and each failure message, ends with the error-level entries logged since the Session's previous Godot call: `New errors since your last Godot call:`, up to 10 lines of the form `[<level>, <source>] <file>:<line> (<function>): <message>` that omit absent parts and the `game` source, and `… and <n> more; read them with godot_logs.` when more remain. Failures reach the model as `Error: <message>`, say what to call next, and quote the last 20 lines of process output after a crash or a failed start; without a runtime, `godot_run` and `godot_check` fail with the message below.

##### Missing runtime message

```markdown
No Godot runtime is installed. Install the WASD Engine Godot runtime from the Game panel, or set libgodotPath and runnerPath, or godotExecutable, in the Godot plugin configuration.
```

#### Token effect

Arguments, result text, and images stay in the conversation until compaction. The plugin bounds each result's text at 6,000 characters and each quoted log message at 500, the new-error report at 10 entries, `godot_logs` at 1,000 entries per call (200 by default), and `godot_scene_tree` at 5,000 nodes (400 by default); each screenshot adds one image, at most `max_width` pixels wide (1280 by default) and sized further by the model route's image request target.

#### KV Cache effect

Append-only: calls and their results follow the existing request prefix and do not invalidate it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe current gaps of the Godot runs, the Game tab, and the runtime.

- **Games run with the Host user's full access** — the game, the import step, and `godot_check` run as ordinary child processes of the Host. The [sandbox](../../sandbox/sandbox-policy/README.md) of the Session's permission mode, such as `read-only` or `workspace-write`, does not confine them, and they never ask for [approval](../../interaction/user-approval/README.md) the way that `bash` commands can. Game code that `godot_run` starts, the scripts that `godot_check` loads, and the expressions that `godot_eval` evaluates, which can run any GDScript including `OS.execute`, can read and write every file that the Host user can and start other programs. `project` accepts an absolute path or a path outside the working directory, so `godot_run` and `godot_check` run any project that the Host user can read.
- **The managed runtime needs a published release** — **Install Godot** downloads the manifest and the archive from the GitHub release that `runtimeManifestUrl` names, `libgodot-4.7.2-wasd.1` of `WASDEngine/WASDEngine` by default. The [LibGodot runtime workflow](../../../wasdengine/libgodot/BUILD.md#release) must publish that release first; until then the install fails with the manifest's HTTP status, and a Host without access to GitHub needs `runnerPath` and `libgodotPath`, or an installed editor.
- **Three platforms** — the release workflow builds macOS arm64, Linux x64, and Windows x64. On another platform, such as an Intel Mac, the install fails because the manifest has no build for it, and games run only through a local LibGodot build or an installed editor.
- **A window outside macOS** — only LibGodot on macOS runs a game without a window. On Linux and Windows, and with an editor executable on every platform, each run, including each agent run, opens a game window on the Host's desktop.
- **No gamepads in the Game tab** — the tab forwards keyboard and mouse input only, so a gamepad connected to the browser's computer does not reach the game; the agent can send joypad button and axis events with `godot_input`.
- **Audio only on the Host** — the Game tab streams frames without sound. Game audio plays through the Host machine's audio output, so a browser on another computer hears nothing, and agent runs are muted by default.
- **LiveShare viewers cannot see the game** — LiveShare classifies every `godot` method as owner-only and excludes the namespace from shares, and the frame route answers 403 to non-owner Peers, so a viewer can neither watch nor play.
- **One game per Session** — **Play** in the Game tab and `godot_run` replace each other's run, and the Host runs at most `maxRuns` games across all Sessions.
- **Game tab input waits behind the agent's input** — the game runs one input sequence at a time, so while an agent sequence runs, for example `{ "wait": 30 }`, keys and clicks from the Game tab reach the game only after that sequence ends, at the latest when its real-time limit ends.
- **Application shortcuts pause in the game view on Windows Desktop** — while the view has focus, no application shortcut or menu accelerator runs until Shift+Esc or a click elsewhere releases it.
- **No C# scripts on the managed runtime** — LibGodot is built without .NET, so C# scripts do not load. An installed managed runtime also takes precedence over `godotExecutable`, so a .NET editor set there runs games only while no managed runtime is installed.
- **Editor executables are not version-checked** — the harness and the check script extend Godot's `Logger` class and read `ScriptBacktrace` frames; an editor without those classes cannot start a run.
- **The harness replaces a custom main loop** — runs pass the harness with `--script`, so a project whose `application/run/main_loop_type` names its own `SceneTree` or `MainLoop` class runs under the harness instead.
- **The Game tab can show an outdated runtime state** — the tab resolves the runtime when it starts following a Session and after an install, so a Godot editor installed while the tab is open appears after the tab follows a Session again, for example after a page reload.
- **Screenshots need an image-capable route** — `godot_screenshot` and the `screenshot` option fail on a model route without image input or without an attachment store, so the agent cannot see the game there; `godot_input` and `godot_wait` fail before they act.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
