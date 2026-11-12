# Game tools

English | [中文](gamedev.zh.md)

The fork-owned [`packages/gamedev/`](../../packages/gamedev/README.md) group lets the agent make game assets with Blender, GIMP, and SuperCollider and run, test, and play the Session's Godot game. Blender, GIMP, and SuperCollider run without a window behind MCP servers; each server serves its tools to every Session and runs one long-lived application worker for each Session that calls them. Godot runs each Session's game as its own process through LibGodot, never through an installed Godot editor, gives the agent native `godot_*` tools, and streams the game to the Game tab in the right sidebar, where the user watches and plays it; the Assets tab beside it shows the project's images and models. Native `polyhaven_*` tools find CC0 HDRIs, textures, and 3D models in Poly Haven's library and download them into the game project. Native `elevenlabs_*` tools find or clone voices for characters and save speech, sound effects, and music into the game project, made by the WASDEngine API with ElevenLabs and charged to the signed-in account's plan. The `game_addons` tool installs curated third-party Godot and Blender add-ons into a game project, and only that project's Sessions see their usage guides as skills. An MCP server of its own offers the same tools to other agents on the computer, such as Claude Code or Codex, whose games play in the same Game tab. This page describes how the packages connect and the formats their processes exchange; the package READMEs own configuration, tool catalogs, model-visible text, and limitations.

## Composition

The WASDEngine patch file [`game-tools.cordis.patch.yml`](../../packages/bundle/web-app/wasdengine/game-tools.cordis.patch.yml) is the last entry of the `@deepseek-ai/dsh-web-app` bundle's `dsh.bundle.patch` list, so every Web and Desktop profile inserts its rows: the seven tool rows below, `ui-game-tools`, which mounts the [Game tools tabs](#game-tools-tabs) and takes no configuration, `ui-game-assets`, which mounts the [Assets tab](#assets-tab), and `game-mcp` and `ui-game-mcp`, the [MCP server for other agents](#mcp-server-for-other-agents) and its browser half. Each application row sets `dataRoot` to `dshHomePath('<row>')`: the row's folder under the harness home, `~/.wasdengine/<row>`, or `$DSH_HOME/<row>` when `DSH_HOME` is set; the `polyhaven` row keeps no files there and sets no configuration, and the `elevenlabs` row keeps no files there and sets only `apiOrigin`, the expression of the account sign-in's `inferenceOrigin`. The `game-addons` row also names its catalog, `wasdengine/addons/` of the `@deepseek-ai/dsh-web-app` package, and its Blender add-on store, `dshHomePath('game-addons', 'blender')`, which the `blender` row's `addonStore` names too. A profile patch turns a row off with `- id: <row>` and `disabled: true`, the entry that the switch on the Plugins page's Game tools tab also writes. [FORK.md](../../wasdengine/FORK.md#game-tools) records the fork change and what to check after an upstream merge.

| Row | Package | Agent tools | Application process |
|---|---|---|---|
| `blender` | [`@deepseek-ai/dsh-blender`](../../packages/gamedev/blender/README.md) | `mcp__wasd_blender__<tool>`, from the MCP server `wasd_blender` | For each calling Session, one Python worker: the `bpy` module that the Desktop app ships, which the Windows app unpacks on first use, or that a managed virtual environment holds, or an installed Blender in background mode |
| `elevenlabs` | [`@deepseek-ai/dsh-elevenlabs`](../../packages/gamedev/elevenlabs/README.md) | Native `elevenlabs_voices`, `elevenlabs_speech`, `elevenlabs_sound_effect`, `elevenlabs_music`, `elevenlabs_clone_voice`, and `elevenlabs_delete_voice` | None: the Host requests the WASDEngine API with the account token and writes the audio files |
| `game-addons` | [`@deepseek-ai/dsh-game-addons`](../../packages/gamedev/game-addons/README.md) | Native `game_addons`, and the usage guides of a project's add-ons as skills | None: the Host downloads and unpacks add-on archives, edits `project.godot`, and imports the project through the `godot` row |
| `gimp` | [`@deepseek-ai/dsh-gimp`](../../packages/gamedev/gimp/README.md) | `mcp__wasd_gimp__<tool>`, from the MCP server `wasd_gimp` | For each calling Session, one GIMP 3 `gimp-console` process that runs the worker as a Python batch command: the runtime that the Desktop app ships on macOS and Windows, or an installed GIMP 3 |
| `godot` | [`@deepseek-ai/dsh-godot`](../../packages/gamedev/godot/README.md) | Native `godot_*` tools and a `godot` system-prompt section | One game process per Session: `godot_runner` hosting LibGodot |
| `polyhaven` | [`@deepseek-ai/dsh-polyhaven`](../../packages/gamedev/polyhaven/README.md) | Native `polyhaven_search`, `polyhaven_asset`, and `polyhaven_download` | None: the Host requests the Poly Haven API and writes the downloaded files |
| `supercollider` | [`@deepseek-ai/dsh-supercollider`](../../packages/gamedev/supercollider/README.md) | `mcp__wasd_supercollider__<tool>`, from the MCP server `wasd_supercollider` | For each calling Session, one bridge process with one sclang, which runs scsynth offline for each render: the runtime that the Desktop app ships, or a headless sclang that `sclangPath` names |

Activation installs, downloads, and starts no application. The Blender, GIMP, and SuperCollider rows start only their MCP server process, which starts the application at the first tool call, and the Godot row starts a game only when a tool or the Game tab asks for one, and the Poly Haven and ElevenLabs rows make their first request at their first tool call, and the game add-ons row downloads an add-on only when one is installed; a call that needs a missing application fails with installation steps, and an ElevenLabs call while signed out asks for a sign-in. The three MCP servers are built on the library [`@deepseek-ai/dsh-app-mcp`](../../packages/gamedev/app-mcp/README.md). Its `materializePayload` copies each script that a package hands to an application to `<dataRoot>/payload/<digest>/<file name>`, where `<digest>` is the first 16 hexadecimal digits of the content's SHA-256. The copy is needed because a packaged Desktop app keeps package files inside `app.asar`, which only Electron's `fs` can read; the Godot package uses the function for its two GDScript files. The MCP server names carry a `wasd_` prefix so that they stay apart from `blender`, `gimp`, or `supercollider` servers that a user configures. The fork's bundled `godot-project` skill directs the agent to the `godot_*`, `mcp__wasd_blender__*`, `mcp__wasd_gimp__*`, `mcp__wasd_supercollider__*`, `polyhaven_*`, `elevenlabs_*`, `game_addons`, and `godot_script` tools when they are present.

| Process | Started by | Ends | Talks to |
|---|---|---|---|
| Blender, GIMP, or SuperCollider MCP server, the package's built `lib/worker.js` under the Host's executable, or `src/worker.ts` through tsx in a source launch | The MCP client, from the server entry that the plugin registers | When the MCP client closes the connection, for example after the plugin is disposed | The MCP client over stdio; its worker over stdin and file descriptor 3 |
| Blender, GIMP, or SuperCollider worker | The MCP server, at a Session's first tool call that finds no running worker for that Session | When it exits, when the server shuts down, or when the server stops it after a timeout, a protocol violation, a cancelled call, `workerIdleTimeoutMs` without calls, or to make room or free memory for another Session's worker | Its MCP server; the SuperCollider worker also its sclang |
| sclang, and scsynth during a render | The SuperCollider worker, at its start; sclang runs scsynth through a shell for each render | sclang when the worker closes its input, when code exits it, or when the worker's process group is stopped; scsynth when its render ends | sclang: the worker, over its standard input and output; scsynth: none, sclang reads its output file and log |
| Godot game | `ctx.godot`, through `ctx.subprocess`, once per run | When the run is stopped or the game quits; the harness script also quits when its connection closes, and `godot_runner` exits with the Host process | `ctx.godot` over one loopback TCP connection |
| Godot import step, script check, script, or Web export | `ctx.godot`: the import step before a run, before a `godot_check` or `godot_script` whose project changed since its last import, and for each `ctx.godot.importProject` call, the check for each `godot_check` call, the script for each `godot_script` call, and the export for each Web export; at most `maxHeadlessProcesses` checks, scripts, imports for other plugins, and exports run at once | When Godot finishes, or after `importTimeoutMs` (`exportTimeoutMs` for an export) | None; `ctx.godot` reads its output |

## Application MCP servers

Blender, GIMP, and SuperCollider use the same process model, which `@deepseek-ai/dsh-app-mcp` implements:

1. The Host plugin calls `registerAppMcpPlugin`, which checks its path settings and registers a stdio server entry with `ctx.mcpManager` ([MCP](mcp.md)) for the plugin's lifetime. The entry runs the package's server entry with the Host's own executable, which `ELECTRON_RUN_AS_NODE=1` runs as Node in the Desktop app, through tsx when a source launch registers the TypeScript entry, and passes the plugin configuration as one base64url JSON argument.
2. The server entry calls `runAppMcpServer`. The server process answers MCP tool discovery without starting the application, so the tools are listed whether or not the application is installed. The MCP client exposes them as `mcp__<server>__<tool>` and adds the server's instructions to the system prompt.
3. The server lists an experimental capability that makes the Host's MCP client name the calling Session in each tool call; a subagent calls as its own Session, and calls that name none, such as those of the agents connected through the [MCP server for other agents](#mcp-server-for-other-agents), share one worker. A Session's first tool call prepares the application, copies the worker script out of the package, and starts a worker for that Session in a folder of its own under `<dataRoot>/workers/`; Blender may first install the `bpy` module with uv and keeps its user resources in the worker's folder, GIMP gets a profile folder that all its workers share, and SuperCollider gets user folders and a class library configuration in the worker's folder. A `WorkerPool` gives each Session a `WorkerSupervisor`, which runs that Session's calls one at a time against its worker and application state, while the workers of different Sessions run at the same time. Workers start one at a time. A worker without calls for `workerIdleTimeoutMs` stops. The server runs at most as many workers as the [process limits](#process-limits) allow this computer: when that many run, a new Session's first call stops the least recently used worker that runs no call, or fails with `WORKERS_BUSY` when every worker runs one. Each start first needs `minAvailableMemoryBytes` of memory available on the computer; while less is available, it stops idle workers of other Sessions, least recently used first, and fails with `LOW_MEMORY` when none is left. The stopped worker's Session learns on its next call that the state was lost. Facts about a start, such as the application version or a first-use installation, precede the text of the Session's next tool result.
4. Each tool sends one request to the worker method of the same name and turns the reply into text and images. An exception that the worker reports leaves the worker and its state in place. A timeout, a protocol violation, or an exit during a call stops the worker, and that call fails saying that the worker's state was lost; when the worker exits between calls, or a running call is cancelled, the next call fails with that message without running. The Session's next call that runs starts a new worker.
5. When its stdin closes, when its MCP transport closes itself after a failed stdout write or an incoming message that overflows its read buffer, or when SIGTERM or SIGINT arrives, the server stops its workers and exits; a repeated signal does not cut that shutdown short.

The [app-mcp README](../../packages/gamedev/app-mcp/README.md#use-this-package) owns the registration fields, the result bounds, the error codes, and the restart rules.

### Worker protocol

A server and its worker speak protocol 1: one UTF-8 JSON object per line, requests on the worker's stdin and replies on its file descriptor 3. The worker's stdout and stderr carry only application logs, of which the server keeps the newest `maxLogBytes` bytes for failure messages.

```text
stdin  request  {"id": <integer>, "method": "<method>", "params": {<parameters>}}
fd 3   ready    {"ready": true, "protocol": 1, "app": "<blender, gimp, or supercollider>", "version": "<application version>", "python": "<Python version>"}
fd 3   success  {"id": <integer>, "ok": true, "result": <JSON value>}
fd 3   failure  {"id": <integer>, "ok": false, "error": {"type": "<exception class>", "message": "<text>", "traceback": "<text>"}}
```

- The ready line comes first on fd 3, within the server's ready budget: Blender's `startupTimeoutMs`, or the `readyTimeoutMs` of GIMP and SuperCollider. `python` names the Python version of the Blender and GIMP workers; the SuperCollider worker leaves it out. The server kills a worker that exits first, writes another line, or stays silent, and the call fails with `WORKER_START_FAILED`.
- The server writes one request at a time, numbering them from 1, and waits for the reply that carries that id; `traceback` is optional. A line that is not a valid reply, a reply to another id, or a line longer than 32 MiB makes the server stop the worker.
- Method names are the tool names, except that `analyze_audio` sends `decode_audio`. Every worker also answers `shutdown` and then exits, and exits when stdin closes; the Blender worker also answers `ping`.
- A failure reply reports an exception that the worker caught while it handled the request, and the worker keeps running. `execute_python` reports an exception raised by the agent's code inside a success reply, and the tool turns it into an error result.
- While `execute_python` runs the agent's code, the Blender and GIMP workers replace `sys.stdin` with an empty stream, so the code cannot consume requests, and return the code's captured Python output in the reply.
- On POSIX the worker leads its own process group. The server stops a worker with a `shutdown` request and a closed stdin, then sends SIGTERM and SIGKILL to the group after grace periods, and it sends SIGKILL to the group whenever the worker exits, which ends the processes that the worker left behind. On Windows it ends the worker's process tree with `taskkill /T /F`.

| | Blender worker | GIMP worker |
|---|---|---|
| Script | [`wasd_blender_worker.py`](../../packages/gamedev/blender/py/wasd_blender_worker.py) | [`wasd_gimp_worker.py`](../../packages/gamedev/gimp/py/wasd_gimp_worker.py) |
| Command | `<runtime python> -I -X utf8 -B -u <script>` for the `bpy` module inside the app, `<python> -I -X utf8 -u <script>` for the one that the Windows app unpacks or a managed environment holds, or `<Blender> --background --factory-startup -noaudio --python-exit-code 1 --python <script>` | `<gimp-console> -n -s -c --batch-interpreter=python-fu-eval -b 'import runpy; runpy.run_path("<script>", run_name="__main__")' --quit`, with `GIMP3_DIRECTORY` set to `<dataRoot>/profile` |
| Requests | Read from file descriptor 0 directly, because Blender can replace `sys.stdin` | Read by GIMP's Python plug-in process, which inherits stdin and fd 3 |
| Exit | `os._exit(0)` after the `shutdown` reply, because Blender can crash in its exit handlers after some exporters ran. At the end of stdin without a `shutdown` request, or once nothing reads fd 3, which a worker thread checks every second also during a request, the server is gone, and the worker kills its process group with SIGKILL when it leads one, or exits | The script returns and GIMP quits through `--quit`. On POSIX a watchdog process kills GIMP when the plug-in process ends without finishing, because GIMP keeps running and holds fd 3 open |

<a id="supercollider-bridge"></a>
### SuperCollider bridge

sclang reads commands from its terminal input and cannot capture the text that its code posts, so the SuperCollider worker is a bridge process between the protocol above and one sclang child. The bridge is the server entry itself, run with the bridge plan, a base64url JSON object like the server options, in `argv[2]` and `--sclang-bridge` in `argv[3]`. sclang runs in its IDE mode, which reads standard input in chunks that each end with ESC (0x1b), with `XDG_CONFIG_HOME` and `XDG_DATA_HOME` under `<dataRoot>/home/` and a class library configuration that adds the worker class [`WasdWorker.sc`](../../packages/gamedev/supercollider/sc/WasdWorker.sc). Parameters travel in JSON files in `<dataRoot>/scratch/`, because sclang string literals hold at most 8,191 bytes, and replies are lines of post output that start a new line with a token of 32 random hexadecimal digits:

```text
stdin of sclang   WasdWorker.boot("<token>", "<boot parameters file>")<ESC>
stdout of sclang  <token> READY {"version": "<SuperCollider version>", "helpSource": "<folder>"}
stdin of sclang   WasdWorker.dispatch(<id>, "<method>", "<parameters file>")<ESC>
stdout of sclang  <token> END <id> {"ok": true, "result": {<fields>}}
stdout of sclang  <token> END <id> {"ok": false, "error": {"type": "<error class>", "message": "<text>", "traceback": "<text>"}}
```

- After `READY`, the bridge writes the protocol's ready line with `app` `supercollider` and the version. Output before `READY` stays in the log; an `ERROR: Command line parse failed` line before it means that the worker class did not load, and the bridge ends.
- The bridge sends one request at a time. It answers a method name with characters other than lowercase letters, digits, and underscores, and strings with NUL characters, with a failure itself. The worker class deletes each parameter file after reading it, runs the method's handler in a Routine on the AppClock, and posts the reply after a newline.
- The text that sclang posts between two replies belongs to the second: the bridge adds it to the result as `output`, or to the failure's `traceback`, keeps at most 20,000 characters as the first and last halves, and drops one trailing newline and each `<name> : setting clientID to <n>.` line.
- A reply to a request that is not pending, a reply that is not JSON of these forms, or a request while another is pending ends the bridge with exit code 1, and sclang's exit ends it with sclang's exit code.
- A render runs `exec <scsynth> -N <score> _ <float WAV> <sample rate> WAV float <options> > <log> 2>&1` through sclang's shell, with `-U <plugins>` for the runtime that the Desktop app ships; the worker class posts the log's lines other than scsynth's start and packet notices.

## Godot runs

`ctx.godot`, the `GodotController` service that `@deepseek-ai/dsh-godot` exports by default, owns every game run of the Host. It keeps one current run per live Agent, so each Session has its own game, and refuses to start a run while the run limit of runs have not ended, counting a closed Session's run until its game process ended, or while the computer has less than `minAvailableMemoryBytes` of memory available ([process limits](#process-limits)). Starts and stops of one Session run one at a time, and a start stops the Session's current run before it launches the next. Disposing an Agent stops its run, after which the Session has no run until a later Agent starts one; disposing the plugin stops every run, ends every follow stream, and cancels a running runtime install. The `godot_*` tools and the Game tab's `godot` Remote act on the same runs.

### Runtime resolution

A run launches the first runtime that resolves:

1. `runnerPath` and `libgodotPath`, when configured.
2. The runtime that the Desktop app ships in the package's `libgodot/<platform>-<arch>/` folder, which a packaged app reads from `app.asar.unpacked`, when its `runtime.json` has format 1, names this version, platform, and architecture, and the runner and library that it names exist.
3. The managed runtime in `<dataRoot>/runtime/<runtimeVersion>/`, under the same conditions.

Desktop packaging fills the `libgodot` folder, as [LibGodot in the Desktop app](../../wasdengine/FORK.md#libgodot-in-the-desktop-app) describes; a source checkout and an npm install have none. A configured path that is not a usable file is a configuration failure and is never skipped. No Godot editor is ever started, because an editor runs the game in a window. When nothing resolves, `godot_run` and `godot.run` fail with a message that names the Game tab's install action and these settings.

Every Godot process starts as `godot_runner --libgodot <library> --parent-pid <Host process id> -- <Godot arguments>`: the runner hosts the one Godot instance that its process may hold, and it exits when the Host process exits. On macOS the game's arguments include `--embedded`, which renders without a window; on Linux and Windows the game opens a window.

`godot.installRuntime` installs the managed runtime. It fetches the release manifest at `runtimeManifestUrl`, whose `version` must equal `runtimeVersion`, takes the artifact for `<platform>-<arch>` in Node's names (for example `darwin-arm64`), checks its size and SHA-256 while it downloads, extracts it with `tar` into a staging folder, writes `runtime.json`, and renames the folder into place under a file lock. Concurrent callers join one install, and the runtime view reports its progress. [BUILD.md](../../wasdengine/libgodot/BUILD.md) describes the runner, the LibGodot patch, and how runtimes are built and published.

<a id="run-lifecycle"></a>
### Run lifecycle

| Phase | Meaning |
|---|---|
| `preparing` | The run exists and has not begun its import step or its launch |
| `importing` | The import step runs |
| `starting` | The game process runs, and `ctx.godot` waits for the harness handshake |
| `running`, `paused` | The harness script is connected; its latest `status` message, or the answer to a pause, resume, or step request, sets which |
| `exited` | Final: the run was stopped, or the game exited with code 0 |
| `crashed` | Final: the process ended otherwise after the handshake, or kept running for `stopGraceMs` after it closed its connection |
| `failed` | Final: the start ended before the handshake |

A start through `godot_run` or `godot.run` takes these steps; `godot.run` first resumes a Session that has no live Agent. A failure before the handshake ends the run as `failed`; its `message` explains the failure and quotes up to the last 20 lines of the game process's output.

1. Find the project: the `project` argument, a folder or `project.godot` path relative to the Session's working directory; without it, the shallowest `project.godot` at most three folder levels below the working directory, searched breadth first in name order, skipping `.git`, `node_modules`, `.godot`, and `.agents`. A `scene` must name an existing `res://` file or be a `uid://` reference.
2. Resolve the runtime, copy `wasd_harness.gd` and `wasd_check.gd` out of the package, stop the Session's current run, and check the run limit.
3. With `importBeforeRun`, wait until the Host's other import steps, checks, and Web exports of the project have ended, then run `--headless --path <project> --import` within `importTimeoutMs`. Its `ERROR:`, `SCRIPT ERROR:`, `SHADER ERROR:`, and `WARNING:` lines become `import` log entries; a nonzero exit adds a warning that imported resources may be incomplete, and the start continues.
4. Listen on `127.0.0.1` on an ephemeral port, and draw a token of 32 hexadecimal digits.
5. Spawn the game in the project folder with the Godot arguments below, without `ELECTRON_RUN_AS_NODE`, collecting at most `processOutputBytes` of stdout and of stderr.
6. Within `startTimeoutMs`, the harness script connects and authenticates as the [harness protocol](#harness-protocol) describes, and the run becomes `running`.

```text
--path <project> [--embedded] --script <wasd_harness.gd> [--audio-driver Dummy] [--resolution <width>x<height>]
  -- --wasd-port=<port> --wasd-token=<token> [--wasd-scene=<scene>]
```

`--audio-driver Dummy` mutes a run. A run that the agent starts is muted unless the call says otherwise or `agentRunsMuted` is off; a run that the Game tab starts plays audio unless its request sets `muted`.

`godot_stop`, `godot.stop`, a restart, and disposal stop a run the same way: `ctx.godot` sends `quit`, waits up to `stopGraceMs` for the process to exit, then aborts the process, which makes the subprocess service terminate it, and settles once the process is gone.

<a id="harness-protocol"></a>
### Harness protocol

[`runtime/wasd_harness.gd`](../../packages/gamedev/godot/runtime/wasd_harness.gd) is the game's main loop, a `SceneTree` script that `--script` loads. It opens `--wasd-scene` or the project's main scene, lets autoloads load as usual, keeps processing while the game is paused, captures every printed message and engine error through a `Logger`, and serves one loopback TCP connection to `ctx.godot`. The script runs from its payload copy, outside the project. Messages in both directions use this framing:

```text
message   u32 LE length N (1 to 64 MiB), then N bytes: u8 kind, payload
kind 1    UTF-8 JSON object                                            both directions
kind 2    u32 LE seq, u16 LE width, u16 LE height, PNG or JPEG bytes   harness to Host: a streamed frame
kind 3    u32 LE request id, PNG or JPEG bytes                         harness to Host: a screenshot image
```

- The harness connects to `127.0.0.1` on the `--wasd-port` port and sends `hello` first. Until a connection presents the run's token, `ctx.godot` accepts messages of at most 64 KiB on it and destroys it on anything but a `hello` whose `token` matches in a constant-time comparison; it measures each message against the limit in force when it reads that message, so messages after the `hello` in the same read may use the 64 MiB limit. A `hello` with another `protocol` fails the start.
- After the handshake, `ctx.godot` closes its listener and every other connection.
- The harness quits the game when the connection closes or a write fails.

| `type` | Fields | Sent |
|---|---|---|
| `hello` | `protocol` (1), `token`, `pid`, `godot` (the Godot version string), `project` (`application/config/name`), `mainScene`, `displayServer`, `renderingDriver`, `renderingMethod`, `width`, `height`, and, when the game draws into the macOS embedded display server's layer, `layer`: its CAContext `context` and the game window pixels per layer point, `scale` | First, once |
| `status` | `frame`, `fps`, `paused`, `scene` (the current scene's `res://` file, or empty), `mouseMode`, `width`, `height`, `droppedLogs` | Every second, and in the frame where the current scene or the mouse mode changes |
| `logs` | `entries`, each with `level`, `message`, `time_ms`, and when known `file`, `line`, `function`, `code`, and `backtrace` frames of `function`, `file`, and `line` | In each frame that has new entries; entries logged before the connection follow once it opens |
| `result` | `id`, `ok`, `error` when `ok` is false, and the result fields of the request | In answer to a request |

The harness logger keeps at most 4,000 unsent entries, drops the oldest beyond that, and counts them in `droppedLogs`. Its levels are `stdout` and `stderr` for printed messages and `error`, `warning`, `script_error`, and `shader_error` for engine errors.

`ctx.godot` sends requests as kind 1 objects with a `type` and an integer `id`, numbered from 1 within each run:

| `type` | Parameters | Result fields | Deadline in `ctx.godot` |
|---|---|---|---|
| `stream` | `fps` (0 stops; at most 60), `quality` (JPEG quality, 0.1 to 1), `maxWidth` (64 to 4,096), `lossless` (PNG frames while preparing a PNG frame keeps up with `fps`) | `fps`, `quality`, `maxWidth`, `lossless` | `requestTimeoutMs` |
| `pace` | `maxFps` (0 restores the game's own `Engine.max_fps`; otherwise the cap, or the game's own when that is lower) | `maxFps`, the resulting `Engine.max_fps` | `requestTimeoutMs` |
| `screenshot` | `format` (`png` or `jpeg`), `maxWidth`, `quality` | `format`, `width`, `height`, `windowWidth`, `windowHeight`, `frame`, `paused`, and a kind 3 image with the request id | `requestTimeoutMs` |
| `input` | `events`, as [input events](#input-events) describes; optional `timeoutMs` | `events`, `frames`, `seconds` (real time), `frame`, `timedOut`, `cancelled` | None; an agent's sequence carries `timeoutMs` of its waits, one frame per wait and one to start at 10 frames per second, plus `requestTimeoutMs`, and Game tab input carries none |
| `pause`, `resume` | None | `paused`, `frame` | `requestTimeoutMs` |
| `step` | `frames` (1 to 100,000); optional `timeoutMs` | `frames`, `seconds`, `frame`, `paused`, `timedOut`, `cancelled` | None; it carries `timeoutMs` of its frames at 10 frames per second plus `requestTimeoutMs` |
| `wait` | `frames` or `seconds`; optional `timeoutMs` | `frames`, `seconds`, `frame`, `paused`, `timedOut`, `cancelled` | None; it carries `timeoutMs` of its seconds, or of its frames at 10 frames per second, plus `requestTimeoutMs` |
| `eval` | `expression`, `node` | `value`, `valueType` | `requestTimeoutMs` |
| `tree` | `node`, `depth` (0 to 64, default 6), `maxNodes` (1 to 5,000, default 400) | `tree`, `truncated` | `requestTimeoutMs` |
| `cancel` | `request`, the id of a pending `wait`, `step`, or `input` request | `cancelled` | Not awaited |
| `quit` | `exitCode` | `quitting` | Not awaited |

- A refused request answers `ok: false` with `error` text; an unknown `type` is refused.
- A request without a deadline still fails when the harness sends nothing at all for `requestTimeoutMs` while `ctx.godot` waits; frames, status, and logs count as activity. When `ctx.godot` gives up on a wait, step, or input request, because its caller aborted or the harness went silent, it sends `cancel` with that request's id unless the run is stopping.
- A screenshot answer is complete once its JSON result and its image have both arrived, in either order. Screenshots and frames show the game window at its pixel size: the root viewport where the project's stretch mode and aspect place it, with black where the window shows bars, so at full size an image pixel is the window pixel at the same position. The harness then scales the image down to at most `maxWidth` pixels wide, and streams at most `fps` frames per second of real time, also while the game is paused or `Engine.time_scale` is 0.
- `step` resumes the game, lets that many frames run, then pauses it; a `pause`, a `resume`, or a newer `step` ends a running step with `cancelled: true`, and the game stays paused after `pause` and running after the others. `wait` counts the frames that run after it arrives, while its `seconds` count only unpaused game time, which `Engine.time_scale` scales. A `wait`, `step`, or `input` request with `timeoutMs` ends once that many milliseconds of real time have passed since it arrived, answering what ran with `timedOut: true`; a step that ends so pauses the game. `cancel` ends the pending request whose id is `request` the same way with `cancelled: true`, and answers `cancelled` with whether one was pending. A request that runs to its end answers `timedOut` and `cancelled` as false.
- `eval` parses a Godot `Expression` with the inputs `tree`, `root`, and `scene` (the current scene) and runs it on `node` or, without one, on the current scene.
- `ctx.godot` sends `quit` with `id` 0 and does not wait for its answer.
- **Frame rate of a game nobody shows.** `ctx.godot` sends `pace` with `hiddenFps` (10 by default) to a windowless game once `hiddenDelayMs` (30 s by default) passed since the game connected, since the last view of it ended, or since its last request settled. A view is a `godot.view` stream, which the Game tab holds while it shows the run's picture, or a frame stream. A new view, and any request other than `pace` and `stream`, first sends `pace` with `maxFps` 0, so the request runs at the game's own frame rate. A game with a window, on Linux and Windows, is never capped.

<a id="input-events"></a>
### Input events

`GodotInputEvent` is one input event in game window pixels. The `godot_input` tool, the `godot.input` Remote method, and the harness share it.

| Event | Fields | Harness effect |
|---|---|---|
| `key` | `key`, a name that Godot's `OS.find_keycode_from_string` accepts (such as `W`, `Space`, `Left`, or `Enter`), or `keycode`; `pressed`; optional `echo`, `unicode`, and `hold` | An `InputEventKey` whose keycode, physical keycode, and key label are that key |
| `text` | `text` | A press and a release with `unicode` for each character |
| `mouse_button` | `button` (`left`, `right`, `middle`, `wheel_up`, `wheel_down`, `wheel_left`, or `wheel_right`), `pressed`, `x`, `y`; optional `double`, `factor`, and `hold` | An `InputEventMouseButton` at the position, with the updated button mask |
| `mouse_motion` | `x`, `y`; optional `dx` and `dy` | An `InputEventMouseMotion` whose relative motion is (`dx`, `dy`) |
| `action` | `action` (an input map action), `pressed`; optional `strength` (0 to 1) and `hold` | An `InputEventAction` |
| `joy_button` | `button`, `pressed`; optional `device` | An `InputEventJoypadButton` |
| `joy_axis` | `axis`, `value` (−1 to 1); optional `device` | An `InputEventJoypadMotion` |
| `focus` | `focused` | The application focus-in or focus-out notification |
| `{"wait": <seconds>}` | None | Holds the rest of the sequence for that many seconds of real time |

Key and mouse events also take `shift`, `ctrl`, `alt`, and `meta`.

- `ctx.godot` validates events where they enter, at `godot_input` and `godot.input`: a call carries 1 to 256 events, unknown fields are refused, a `key` event needs `key` or `keycode`, and numbers must be finite. The `godot_input` schema offers every kind except `focus`.
- `godot_input` reads pointer coordinates as pixels of the Session's latest screenshot of the current run and scales them by `windowWidth / width` and `windowHeight / height`; with `coordinate_space: "window"` it passes them unchanged.
- The harness runs one sequence at a time, in arrival order. It applies the events in order up to each `wait`, and it answers once the last event is applied; an event that it cannot apply, such as an unknown key name or input action, fails the request after the earlier events took effect. `hold` schedules the matching release that many seconds of real time after the press without holding the sequence. A sequence that ends early or fails releases the keys, mouse buttons, input actions, and joypad buttons that it pressed and did not release, including those that a `hold` would release later; an early end answers `events` with the number of events that ran.
- The Game tab's input reaches the run through `godot.input`, which returns without waiting for the game. `ctx.godot` keeps one `input` request in flight per run and queues later events behind it: consecutive `mouse_motion` events merge into one with the latest position and summed deltas, and beyond 256 queued events the oldest are dropped. Sequences from the agent and from the Game tab share the harness's order. Game tab requests carry no `timeoutMs`, so a batch that waits behind an agent's sequence still runs, releases included, once that sequence ends, at the latest at its limit.

### Logs

Each run keeps its newest `maxLogEntries` entries in a ring of `GodotLogEntry` values. One sequence numbers the entries of every run of the plugin, so a cursor orders entries across runs.

| Field | Meaning |
|---|---|
| `seq` | Host-wide sequence number |
| `runId` | Run that logged the entry |
| `source` | `game` from the harness logger, `process` from the game process's output, or `import` from the import step; the type also admits `check`, but `godot_check` reports in its tool result and writes no entries |
| `level` | `stdout`, `stderr`, `warning`, `error`, `script_error`, or `shader_error` |
| `message` | Text; a longer message keeps its first 4,000 characters |
| `file`, `line`, `function` | Location, when known |
| `backtrace` | Script frames, most recent call first |
| `time` | Host receive time in milliseconds since the epoch |

The game process's output becomes `process` entries when a start fails and for output after the connection closed; while the harness is connected, its logger reports the game's output instead. `error`, `script_error`, and `shader_error` entries count in the run's `errorCount`, and `warning` entries in its `warningCount`. Each Godot tool result lists up to 10 error-level entries logged since the Session's previous Godot tool call and counts the rest; the [package README](../../packages/gamedev/godot/README.md) describes the tools.

### Script check

Scripts resolve `class_name` classes, `uid://` paths, and imported assets through the project's import data, so `godot_check` first runs the import step of a run, `--headless --path <project> --import` within `importTimeoutMs`, when that data may be older than the project's files: when no import of the project that exited with code 0 began since the plugin loaded, when the class cache `global_script_class_cache.cfg` is missing from the project's data folder, or when a file that the import reads has a modification or status change time after the start of the last such import. The walk over the project skips what Godot's import skips, as the [package README](../../packages/gamedev/godot/README.md#tools) lists. An import that exits abnormally or runs out of time puts a warning at the start of the result instead of failing the check. `ctx.godot` runs the import steps, checks, and Web exports of one project one at a time and keeps the start times in memory.

The check then loads the scripts without running the game, in one headless process: `--headless --path <project> --script <wasd_check.gd> -- <res:// paths>`, for at most 400 scripts, within `importTimeoutMs`. [`wasd_check.gd`](../../packages/gamedev/godot/runtime/wasd_check.gd) loads each script with the resource cache bypassed, after the script that `plugin.cfg` names when the script lies in a folder under `res://addons/`, as the editor loads an add-on's plugin first, and prints one line for it, and `ctx.godot` reads the lines that start with the marker:

```text
WASD_CHECK {"path": "<res path>", "loaded": <boolean>, "errors": [{"level": "<level>", "message": "<text>", "file": "<res path>", "line": <line>, "function": "<name>"}]}
```

A script without a line, because the process crashed or ran out of time, fails the check with the end of the process output.

The check is a `SceneTree` script that creates no autoload: before Godot creates the project's autoloads, it points every autoload entry at itself, which Godot refuses to instantiate because it is not a `Node`, and it restores the entries before the first load. Singleton autoload names stay registered, so scripts that use them compile; the analyzer types a script autoload from its script and a scene autoload as `Node`. No autoload `_init`, `_ready`, or `_process` runs; loading runs the static initializers of the loaded scripts, and Godot creates the custom resource loaders and savers that the project declares as global classes.

<a id="process-limits"></a>
## Process limits

Blender, GIMP, and SuperCollider workers and Godot games are whole application processes: on an Apple M3 Pro, one Blender render of the default scene at 1280×720 peaked at 1.5 GiB (Cycles) to 1.7 GiB (EEVEE) of memory, and one game of a small 3D project at 0.9 GiB. Each kind of process gets a limit from the computer that runs the Host. `processLimit` of `@deepseek-ai/dsh-app-mcp` takes the smallest of the configured maximum (`maxWorkers` of each application, `maxRuns` of Godot), the computer's physical memory divided by the memory for each process (`workerMemoryBytes`, `runMemoryBytes`) and rounded to the nearest whole number, and its logical processors divided by the processors for each process (`workerCores`, `runCores`) and rounded down; the limit is at least 1. On the default settings, 8 GiB and 4 logical processors for each process:

| Computer | Workers of each application, and games |
|---|---|
| 8 GiB of memory, 8 logical processors | 1 |
| 16 GiB, 8 logical processors | 2 |
| 18 GiB, 12 logical processors | 2 |
| 32 GiB, 16 logical processors | 4 |

Before each start of a worker, a game, a script check, a script, an import for another plugin, or a Web export, the starter reads the memory that the operating system reports available, `process.availableMemory()`. While that is less than `minAvailableMemoryBytes`, 1 GiB by default, an application server stops the idle workers of other Sessions of its application, least recently used first, and the start fails with `LOW_MEMORY` or `godot/low-memory` when that does not free enough. The reading covers the whole computer, so the processes of every game tool and of other programs count against it, while the limits are per application. Godot runs at most `maxHeadlessProcesses` script checks and Web exports at once; later ones wait in order for one to end.

Every caller is held to the same limits: the Host's Sessions, subagents, which count as Sessions of their own, and the agents connected through the [MCP server for other agents](#mcp-server-for-other-agents), whose calls reach the same worker pools and the same `ctx.godot`. The [app-mcp README](../../packages/gamedev/app-mcp/README.md#one-worker-per-session) and the [Godot README](../../packages/gamedev/godot/README.md#game-runs) own the fields and refusals.

## Frame stream

`GET /api/godot.frames?session=<SessionId>&run=<runId>` streams a run's frames. `ctx.godot` registers it as an exact `ctx.connection.fetch` route while the Connection service exists, and the Connection answers 403 to a Peer that is not the owner. The route answers 400 when `session` or `run` is missing or empty, 404 unless the run is the Session's current run and has not ended, and otherwise 200 with `application/octet-stream`. Every answer carries `Cache-Control: no-store, no-transform` and `X-Content-Type-Options: nosniff`. The body is a sequence of records:

```text
record    u32 LE image length, u16 LE width, u16 LE height, u32 LE seq, PNG or JPEG bytes
```

The record header puts the length first and the sequence last, unlike the harness's kind 2 payload.

- The run asks the harness to stream, with `streamFps`, `streamQuality`, `streamMaxWidth`, and `streamLossless`, while at least one frame response is open, and sends `stream` with `fps` 0 when the last one closes.
- The harness takes each frame from the root viewport's texture. With a RenderingDevice it calls `RenderingDevice.texture_get_data_async` from the render thread and receives the 8-bit RGBA pixels some frames later; on the Compatibility renderer, and for a texture in another format, it calls `Texture2D.get_image()` on the main thread. A `WorkerThreadPool` task converts, scales, and letterboxes the frame and encodes it: as a PNG file while `lossless` is on and preparing a PNG frame takes at most 1/`fps` seconds, and as a JPEG file at `quality` otherwise. One copy and one encoding run at a time, and they overlap. The [package README](../../packages/gamedev/godot/README.md#remote-and-frames) describes when a stream switches between PNG and JPEG.
- Every message to the Host waits in a queue and leaves through `StreamPeerTCP.put_partial_data` as the connection takes it, so the game's main thread never waits for the Host; the harness starts no frame while the queue holds bytes, and sends what is left, waiting for the connection, when it exits.
- The body produces a record only when the reader asks for one: a frame that arrives before the reader took the previous record replaces it, so a slow reader always receives the newest frame.
- The body ends when the run ends or the request is aborted.

## Game tab

The package's `./client` export, a Web platform plugin, mounts the generated `godot` Remote and then registers:

- the right sidebar tab type `godot-game`, of kind `godot`, with built-in priority, kept mounted while hidden, and a guide entry at order 40; its body and title fill the `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` slots of the [right sidebar](sidebar-right.md);
- `tool.call.toolview` cards for `godot_screenshot`, `godot_input`, and `godot_wait`, which show a result's screenshot;
- its copy, in the `godot` locale namespace.

| Data | Channel | When |
|---|---|---|
| Run, runtime, and logs | The Session's `godot.follow` stream | While the Game tab or the opener described below reads the Session's game state |
| Layer | `dshDesktop.gameLayer.show` and `hide` of the macOS Desktop app, and the mask of `#root` | While the follow stream delivers, the tab is visible, the run is `running` or `paused` and reports its `layer` and window size, and the page has `dshDesktop.gameLayer` |
| Frames | A `fetch` of `api/godot.frames?session=<SessionId>&run=<runId>`, resolved against `document.baseURI`, with `cache: 'no-store'` | While the follow stream delivers, the tab is visible, the run is `running` or `paused`, and the tab shows no layer of it |
| Input | `godot.input`, with the run id | While the follow stream delivers, the tab is visible, and the run is `running` or `paused` |
| View | The run's `godot.view` stream, through `ctx.remote.$stream`, which reopens it after a carrier loss | While the follow stream delivers, the tab is visible, and the run is `running` or `paused`, by layer or by frames |
| Actions | `godot.run`, `godot.stop`, `godot.control`, and `godot.installRuntime` | When the user presses a toolbar button; `godot.stop` also when the user closes the tab |

- **Follow stream.** `godot.follow` follows a Session id and needs no live Agent. `ctx.godot` first sends a `snapshot`: the Session's current or last run view, or null while the Session has no live Agent or no run; the runtime view; that run's last 200 log entries; and the cursor. It then sends coalesced changes: `run` with the latest view, and `run: null` when the Session's Agent ends; `logs` with up to the newest 200 entries after the stream's cursor; and `runtime` with the latest runtime view. A run that a later Agent starts arrives in the same stream, which ends when its signal aborts or the plugin unloads. The browser keeps up to 500 entries of the current run, drops the entries of other runs when a `run` item names a new run, and skips entries that it already holds. The Gateway's logical stream reopens the follow stream after a lost connection, starting with a new snapshot. After another end or failure, the browser follows again at once when the stream had delivered its snapshot, and otherwise after 1 s, doubling up to 30 s, or at once when the user presses Retry; until a snapshot arrives it shows a reconnect notice.
- **Opening the tab.** For the Session whose right sidebar is mounted, a run that the agent started (`startedBy: 'agent'`) and that has not ended opens the Game tab once per run id while the client plugin is loaded, also after the Session's scope was released and retained again.
- **Closing the tab.** The plugin registers the right sidebar's close handler for the `godot` kind, which calls `godot.stop` for the tab's Session when the user closes the tab or new content replaces it, without waiting for the game to end. A `godot/not-running` refusal, which a Session without a run receives, is ignored; another failure goes to the browser log, and the game keeps running. Collapsing the sidebar, switching Sessions, and unloading the plugin run no close handler.
- **Layer.** The view asks `dshDesktop.gameLayer.show` to show the run's layer, with the CAContext id, the layer's size in points (the window size divided by `layer.scale`), and the rectangle with the layer's aspect ratio centered in the view's box, its edges on device pixels, in CSS pixels of the layout viewport. Once the Desktop app answers true, the plugin masks that rectangle out of `#root`, with a mask layer that covers the root and subtracts one layer per shown layer's rectangle, so the page is transparent there and the layer behind it shows, while the view under it still receives the pointer, which a clip path would take away; it restores the root's earlier mask when the last layer ends and when the plugin unloads. A frame portaled to `document.body` over the view draws the focus ring and the hints, which inside the root would be cut away with the hole. The view places the layer and the hole again on every animation frame after a resize of the view or the window, or during a pointer drag, until its box stays still for 10 frames, and checks the box every 500 ms. An answer of false, or a failed call, ends the layer and starts the frame stream for that run; the next run tries a layer again. The [fork's Desktop notes](../../wasdengine/FORK.md#game-layer-in-the-desktop-app) describe the main process side.
- **Frames.** The reader parses records as bytes arrive, treating a record that announces no bytes, a zero width or height, or more than 32 MiB as corrupt. It reopens a failed, refused, corrupt, or ended response after 250 ms, doubling the delay up to 4 s while attempts deliver no record. One image decodes at a time with `createImageBitmap`, as a PNG when it starts with the PNG file signature and as a JPEG otherwise, a newer record replaces one that waits, and the newest decoded frame is drawn on the next animation frame onto a canvas that keeps the frame's aspect ratio.
- **Input.** The tab sends keyboard events, and mouse events over the canvas, while the game view has focus, which a click on the view gives it; without focus, pointer motion only updates the position that the next motion starts from. It maps `KeyboardEvent.code` to Godot key names as Godot's web platform does, sending Alt and Meta as keycodes, and leaves key presses combined with Meta to the browser. Shift+Escape never reaches the game: it removes focus from the view. A one-character key carries its text as `unicode` unless Ctrl is held without Alt, so AltGr characters keep their text. On Windows Desktop the view holds the shortcut service's recording state while it has focus. Pointer positions map from the drawn frame, excluding the bars around it, to window pixels; a wheel step becomes a wheel button press and release; and while the game's mouse mode is captured (2), a press locks the pointer and motion sends deltas; a lock that ends while the mode is still captured, as on Esc, removes focus from the view. Events go out once per animation frame, in batches of at most 256 with consecutive motions merged, one batch at a time. Losing focus releases every held key and button and ends the pointer lock. When a batch fails other than for an ended run, its key and mouse button releases go first in the next batch, which a new event or the release on focus loss sends.
- **Actions.** Play calls `godot.run` with the last run's project, or with no project before the first run so that `ctx.godot` searches for the nearest one; Restart, which replaces Play while a run is active, also passes the run's `launch` scene and window size. Stop, Pause, Resume, Step one frame, and Install Godot, which shows while the runtime is missing or failed, call the matching methods. A refused action shows the copy for its Remote error code, `session/writer-held` included.

<a id="game-tools-tabs"></a>
## Game tools tabs

The `ui-game-tools` row mounts [`@deepseek-ai/dsh-client-ui-game-tools`](../../packages/gamedev/ui-game-tools/README.md), a browser plugin with an empty Host half that lists the seven tools where users look for plugins. Settings › Built-in plugins opens on its read-only Game tools tab, ahead of the inventory's Plugin list, and the Plugins page shows a Game tools tab after Installed. Both tabs list Blender, ElevenLabs, the game add-ons, GIMP, Godot, Poly Haven, and SuperCollider with the logo, title, and description from each package's metadata and the Loader state of each row. Neither tab calls a Remote before it first renders.

On the Plugins page, each tool that the profile mounts has a switch while the Host manages the profile. The switch calls `pluginManager.setPluginEnabled` with the tool's Loader entry id: turning a tool off writes `- id: <row>` with `disabled: true` into the profile patch, the override that a user can also write by hand, and turning it on removes an override that holds nothing else. The [plugin manager](../../packages/boot/plugin-manager/README.md#use-this-package) applies the change, or reports that it waits for a restart or that a higher-priority patch overrides it.

Each tool package names `icon.svg` in the `icon` field of its `package.json`, so the Host's package metadata carries the file as a `data:image/svg+xml` URL. The Blender, GIMP, Godot, Poly Haven, and SuperCollider files embed the product's official logo unaltered in the 36 × 36 canvas of package icons; the [Blender](../../packages/gamedev/blender/README.md#plugin-icon), [GIMP](../../packages/gamedev/gimp/README.md#plugin-icon), [Godot](../../packages/gamedev/godot/README.md#plugin-icon), [Poly Haven](../../packages/gamedev/polyhaven/README.md#plugin-icon), and [SuperCollider](../../packages/gamedev/supercollider/README.md#plugin-icon) READMEs credit each logo and state its license and trademark terms. The [ElevenLabs](../../packages/gamedev/elevenlabs/README.md#plugin-icon) file is a package-local sound wave, not ElevenLabs' logo, and the [game add-ons](../../packages/gamedev/game-addons/README.md#plugin-icon) file is a WASD Engine keycap with a plus.

<a id="game-add-ons"></a>
## Game add-ons

The `game-addons` row mounts [`@deepseek-ai/dsh-game-addons`](../../packages/gamedev/game-addons/README.md). Its catalog holds one folder per add-on with `addon.json`, an entry that pins one release's archive URL, SHA-256, and size, and `SKILL.md`, the add-on's usage guide. The plugin loads and checks the whole catalog when it starts. Every Session sees one fixed tool, `game_addons`, and one fixed system prompt section, `game-addons`, whatever its project holds, so the cached prefix stays the same; the guides reach the model only as skills of the projects that use them.

| Step | What happens |
|---|---|
| Discovery | The `game-addons` section lists every catalog add-on with the stages at which it helps and when to use it; `game_addons` `search` ranks the catalog for the game's need and shows sizes, conflicts, and when to skip each one; `guide` returns a guide before installation |
| Decision | The agent installs or removes an add-on when it decides that the game needs it, without asking the user under any approval policy; the section tells it when an add-on is worth installing and to tell the user what it added, with the license |
| Godot installation | The archive downloads once into `<dataRoot>/archives/<sha256>.zip` and must match its pin; one folder of it unpacks through `.wasdengine/staging/` into `res://addons/<folder>/`; `project.godot` gets the editor plugin, autoloads, and settings that the plugin's `_enable_plugin()` would add; `THIRD_PARTY_NOTICES.md` gets the license; `.wasdengine/addons.json` records the add-on; and `ctx.godot.importProject` imports the project |
| Blender installation | The extension unpacks once into `<blenderStore>/<module>/` and its asset pack, if any, into `<dataRoot>/blender-assets/<id>/`, the store's `catalog.json` lists every catalog Blender add-on with its setup script and asset folder, and the project's record lists it; a worker's `wasd_addons.enable("<id>")` enables it and runs its setup script, and does both again after factory settings load |
| Guides | The skill provider `game-addons` lists, for a Session's working directory, the guide of each catalog add-on that its Godot project has installed or holds in `addons/`, at rank 550, and a watcher on `addons/` and `.wasdengine/` refreshes the list |
| Removal | The recorded paths, the add-on's `project.godot` entries, and its notice go; settings that another installed add-on also sets stay; the result names the files that still use the add-on |

`godot_script` runs the command-line runners of the GUT and GdUnit4 add-ons: it imports the project when it changed since its last import, then runs a SceneTree script with `--headless --script`. LibGodot hides the script's exit code, so a test run's result shows in what it prints. The Session header's Add-ons button opens a dialog that installs and removes add-ons through the `gameAddons` Remote at the user's click; LiveShare keeps the Remote for the owner. The catalog's smoke tests run end to end in `packages/gamedev/game-addons/tests/catalog.e2e.ts`.

<a id="assets-tab"></a>
## Assets tab

The `ui-game-assets` row mounts [`@deepseek-ai/dsh-client-ui-game-assets`](../../packages/gamedev/ui-game-assets/README.md), a browser plugin with an empty Host half that registers the right sidebar's `assets` page type, with a guide entry at order 45, after the Game tab's. Its body shows the 2D and 3D art of the Session's game project: a dropdown sorted into the project's folders, with search and an All / 2D / 3D filter, above a view of the chosen asset. Images show in a zoomable view; models show on a three.js stage that turns, zooms, pans, and plays their animations; a Blender file shows the model of the same name that the project holds, such as the GLB that the Blender tools export.

| Data | Channel | When |
|---|---|---|
| Asset list | `workspaceFiles.list`, breadth first from the workspace root, at most six folders at a time, skipping hidden folders and `node_modules` | When the tab shows or the dropdown opens and the last scan is older than 2 s or ten times its duration, and when the user presses refresh |
| Viewed file | `workspaceFiles.readBytes`: one complete read, or byte windows above the Host's complete-file cap | When an asset is chosen, and again for each new version that its `file` resource reports |
| Files a model names | `GET api/file?path=<absolute path>`, resolved against the viewed file's folder | While three.js loads a glTF buffer or image, an OBJ material library or texture, or an FBX or Collada texture |

The tab keeps no game process and calls no tool: it reads the files that the agent and the game tools write, so a texture that GIMP saves or a model that Blender exports appears once the list is scanned again, and the viewed file reloads as it changes.

<a id="mcp-server-for-other-agents"></a>
## MCP server for other agents

The `game-mcp` row mounts [`@deepseek-ai/dsh-game-mcp`](../../packages/gamedev/game-mcp/README.md), through which other agents on the computer, such as Claude Code or Codex, use the game tools. Its Host plugin listens on `127.0.0.1` at `/mcp`, port 9273 by default, and serves the Streamable HTTP transport of the 2026-07-28 MCP revision and, statelessly, of the 2025 revisions. Every request must pass the MCP SDK's localhost Host and Origin checks and carry `Authorization: Bearer <token>`, the token in `<dataRoot>/token`.

| Tools | Provider | How calls run |
|---|---|---|
| `search_game_tools`, `call_game_tool` | `game-mcp` | The server searches the providers' tools and their readiness, or calls one by name |
| `godot_*` | `godot`, through `godotMcpProvider` in [`src/mcp.ts`](../../packages/gamedev/godot/src/mcp.ts) | The Session's own tool definitions, built by `godotToolDefinitions` with wording for absolute project paths, for the connected agent's Session; screenshots return as PNG bytes |
| `polyhaven_*` | `polyhaven`, through `polyHavenMcpProvider` in [`src/mcp.ts`](../../packages/gamedev/polyhaven/src/mcp.ts) | The Session's own tool definitions, which need no Session; preview images return as JPEG bytes, and a download needs an absolute folder |
| `elevenlabs_*` | `elevenlabs`, through `elevenLabsMcpProvider` in [`src/mcp.ts`](../../packages/gamedev/elevenlabs/src/mcp.ts) | The Session's own tool definitions, which need no Session; each file and recording needs an absolute path, a clone needs `consent: true` from the agent's user, and the audio is charged to the account WASD Engine is signed in to |
| `game_addons` | `game`, through `gameAddonMcpProvider` in [`src/mcp.ts`](../../packages/gamedev/game-addons/src/mcp.ts) | The Session's own tool definition, which needs no Session; projects are absolute folders, and an agent reads a guide with the `guide` action |
| `wasd_export_web`, `wasd_release_game` | `wasd`, through `wasdMcpProvider` in [`src/tools.ts`](../../packages/gamedev/wasd-plugins/src/tools.ts) | The Session's own tool definitions, which need no Session; `project` and `cover_image` are absolute paths, and a release publishes to the site WASD Engine is signed in to |
| `blender_*`, `gimp_*`, `supercollider_*` | `blender`, `gimp`, `supercollider`, through `offerAppTools` in [`@deepseek-ai/dsh-app-mcp`](../../packages/gamedev/app-mcp/README.md) | The MCP client's registered `mcp__wasd_blender__*`, `mcp__wasd_gimp__*`, and `mcp__wasd_supercollider__*` definitions, whose results pass on with their images |

A plugin contributes tools with `ctx.gameMcp.provide()` for its own lifetime, and the server lists a tool only under its provider's prefix. A tool definition runs with an execution of the server's own, so harness tool policies, such as approval prompts, do not apply; the connected agent's harness applies its own.

**Sessions.** Each Godot call names its project by absolute path, or reuses the agent's previous one. The server registers the folder as a game project unless a registered one contains it, and resolves the agent's Session in that project, creating it on first use: one Session per agent and game project, remembered in `<dataRoot>/sessions.json`. The Session runs the game, so its run, logs, and Game tab are those of an ordinary Session, and the user can watch, pause, and play it there.

**The window.** `godot_run` emits the Host event `game-mcp/reveal` with the Session id. The Remote events allowlist forwards it to every window that may read the Session, and the `ui-game-mcp` row's browser plugin, [`@deepseek-ai/dsh-client-ui-game-mcp`](../../packages/gamedev/ui-game-mcp/README.md), opens the Session there; the Game tab then opens for the run, as for any run an agent starts.

**Setup.** Every user signs in to WASD Engine first, and the server refuses tool calls while the account plugin reports no stored sign-in. The same browser plugin then offers Set up with another agent in two places: the Desktop introduction's last step, `settings.account.onboarding.agents`, and the Other agents section of Settings. Both show the AI agents' logos and follow the `gameMcp.watch` stream while they show: the server's state, the endpoint, the setup prompt with the token, and the agents seen since the Host started. [LiveShare](liveshare.md) classifies `gameMcp/watch` as owner-only and never offers the `gameMcp` namespace to share viewers.

<a id="agents-browser"></a>
## Agent's Browser

In the Desktop profile, the `wasd-plugins` row sets `browser`, and [`@deepseek-ai/dsh-wasd-plugins`](../../packages/gamedev/wasd-plugins/README.md#the-agents-browser) gives the Session's agent the `browser_*` tools, which act on a Browser tab of the right sidebar. The Browser tabs live in the window, so each tool call becomes a command that the Host queues and a window carries out:

1. The tool call queues a `WasdBrowserRequest`: an `id`, the calling `sessionId`, the `command`, and the `limits` from the row's configuration: `maxChars`, `loadTimeoutMs`, and `screenshotWidth`.
2. Every window whose Peer may call the endpoint follows `wasdPlugins.browserRequests`, which yields the whole list of untaken requests again after each change.
3. A window takes a request with `wasdPlugins.claimBrowserRequest` while the request's Session is on screen in it, or while it holds that Session's agent tab; only the first claim succeeds. A request that no window takes within `browserClaimTimeoutMs` fails its tool call.
4. The window acts through the `sidebarBrowserAutomation` service of [`@deepseek-ai/dsh-client-ui-sidebar-browser`](../../packages/client/ui-sidebar-browser/README.md), which only the Desktop carrier provides: scripts in the page's main world, trusted input, typed text, and captures of the `<webview>` guest.
5. The window ends the request with `wasdPlugins.settleBrowserRequest` and a `WasdBrowserOutcome`.

| `command.kind` | Fields | The window |
|---|---|---|
| `open` | `url` | Loads the address into the Session's agent tab, opening one first in the Session on screen, shows the tab, and returns the page |
| `read` | None | Returns the page of the agent tab, or of the Browser tab the user has open |
| `click` | `element`, or `x` and `y` in CSS pixels of the viewport | Clicks the control or the point, and returns the page |
| `type` | `element`, `text`, `submit` | Fills the field or chooses the option, presses Enter when `submit` is true, and returns the page |
| `screenshot` | `element` | Captures the visible part of the page, after scrolling the control into view when given |

A `WasdBrowserOutcome` is either `{ ok: true, page, note?, image? }` or `{ ok: false, message }`. `page` holds the page's `url`, `title`, and `text`, whether the text was `truncated`, whether the page was still `loading`, and an optional load `error`; `note` says how the window carried out the command, such as a click by script; `image` holds a screenshot's base64 `data`, its `mediaType`, `width`, and `height`, and the `viewportWidth` and `viewportHeight` in CSS pixels that it shows, from which the tools map screenshot pixels back to the page. The Host refuses an outcome whose text exceeds `maxChars` or whose image data exceeds 32 MiB. [LiveShare](liveshare.md) classifies the three endpoints as owner-only and never offers the `wasdPlugins` namespace to share viewers.

## Remote types

The `godot` Remote methods, listed in the generated Cordis API section, take the Session first as a plain `SessionId`, which needs no live Agent: `follow`, `stop`, `control`, and `input` act on the Session's current run, and `godot.run` resumes a Session without a live Agent through `ctx.sessionController.resolveAgent`, as a prompt does, and passes on its refusals, such as `session/not-found` and `session/writer-held`; `installRuntime` takes no Session. Their types live in the browser-safe [`src/types.ts`](../../packages/gamedev/godot/src/types.ts). [LiveShare](liveshare.md) classifies every `godot/*` endpoint as owner-only and never offers the `godot` namespace to share viewers.

`GodotRunRequest` starts or restarts the Session's game:

| Field | Meaning |
|---|---|
| `project` | Folder holding `project.godot`, relative to the Session's working directory; without it, `ctx.godot` searches for the nearest one |
| `scene` | `res://` or `uid://` scene to run instead of the main scene |
| `width`, `height` | Window size in pixels, given together, each an integer from 1 to 16,384 |
| `muted` | Run with the Dummy audio driver; `godot.run` defaults to false |

`GodotControlRequest` carries an `action`, `pause`, `resume`, or `step`, and for `step` the number of `frames`, an integer from 1 to 100,000 that defaults to 1.

`GodotRunView` describes one run as the tools and the Game tab see it:

| Field | Meaning |
|---|---|
| `runId` | Opaque id, unique within the Host process |
| `phase` | Phase from the [run lifecycle](#run-lifecycle) |
| `startedBy` | `agent` or `user` |
| `projectDir`, `projectName` | Project folder and its `application/config/name`, when set |
| `launch` | Scene and window size of the start request: `scene`, `width`, and `height`, each absent when the request had none; Restart passes them again |
| `scene` | `res://` path of the running scene, when known |
| `width`, `height` | Game window size, once the game reports it |
| `fps`, `frame`, `mouseMode` | Values of the latest `status` message; `mouseMode` is Godot's `Input.MouseMode`: 0 visible, 1 hidden, 2 captured, 3 confined, 4 confined hidden |
| `renderer` | Rendering driver and method, such as `metal / forward_plus` |
| `muted`, `windowless`, `runtime` | Whether audio is muted, whether the run renders without a window, and the runtime kind, `libgodot` or `executable` |
| `layer` | `GodotRunLayer` of a windowless macOS run, once the game reports it, when the LibGodot build publishes it: the CAContext `context` through which a process of the same login session displays the game's layer with a CALayerHost, and `scale`, the game window pixels per layer point |
| `exitCode`, `signal` | How the process ended |
| `message` | Failure or crash explanation, with the end of the process output |
| `errorCount`, `warningCount` | Error-level and warning entries of the run |
| `startedAt` | Start time in milliseconds since the epoch |

`GodotRuntimeView` describes runtime availability:

| `state` | Meaning and fields |
|---|---|
| `ready` | A runtime resolves: `kind`, `windowless`, and for the managed runtime its Godot `version` |
| `missing` | Nothing resolves and the managed runtime can be installed; `message` says how |
| `installing` | An install runs; once it reports progress, `progress` holds its `phase` (`downloading`, `verifying`, or `extracting`), `completedBytes`, and `totalBytes` |
| `failed` | The last install failed, or a configured path is unusable; `message` says why |

`GodotFollowItem` is one item of the follow stream:

| `type` | Fields |
|---|---|
| `snapshot` | `run` (or null), `runtime`, `logs` (at most 200), and `cursor` |
| `run` | `run`, the latest view |
| `logs` | `entries` (at most 200, oldest first) and `cursor` |
| `runtime` | `runtime` |

`GodotViewItem` is the one item of a view stream, `{ type: 'shown' }`, which `ctx.godot` sends once the view counts.

The package adds these Remote error codes:

| Code | Details | Raised when |
|---|---|---|
| `godot/no-project` | `directory` | No `project.godot` matches the request, or its `scene` is neither an existing `res://` file nor a `uid://` reference |
| `godot/runtime-unavailable` | `message` | No runtime resolves, or a configured runtime path is unusable |
| `godot/not-running` | None | The Session has no run, or its game does not accept requests |
| `godot/stale-run` | `runId` | `input` names a run that is not the Session's current run |
| `godot/too-many-runs` | `limit` | Other Sessions' games, including those of closed Sessions that are still stopping, already fill the run limit |
| `godot/low-memory` | `availableBytes`, `requiredBytes` | The computer has less than `minAvailableMemoryBytes` of memory available as the run starts |
| `godot/request-failed` | `message` | The game refused a request or did not answer in time |

Invalid input events, window sizes, and step frame counts fail with `gateway/bad-request`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgameaddons--gameaddons"></a>

### `ctx.gameAddons` — `GameAddons`

Owner of the add-on catalog, the `game_addons` tool, the `game-addons` system prompt section, the add-on guides' skill provider, and the `gameAddons` Remote.

```ts cordis-catalog
/**
 * The catalog with each add-on's presence in the game project of a folder, for the Add-ons dialog.
 * @param directory - absolute folder: the project folder or a folder up to three levels above it.
 * @param signal - cancellation.
 * @returns the project folder, every catalog add-on, and their icons.
 * @throws GodotProjectError when the folder has no Godot project.
 */
@Remote async project(directory: string, signal: AbortSignal): Promise<GameAddonsProjectView>

/**
 * Install an add-on that the user chose in the Add-ons dialog.
 * @param directory - absolute folder of the game project, or up to three levels above it.
 * @param id - catalog id.
 * @param signal - cancellation; a cancelled installation leaves the project as it was.
 * @returns the installation.
 */
@Remote async installAddon(directory: string, id: string, signal: AbortSignal): Promise<GameAddonInstallResult>

/**
 * Remove an add-on that the user chose in the Add-ons dialog.
 * @param directory - absolute folder of the game project, or up to three levels above it.
 * @param id - catalog id.
 * @param signal - cancellation before files are deleted.
 * @returns the removal.
 */
@Remote async removeAddon(directory: string, id: string, signal: AbortSignal): Promise<GameAddonRemoveResult>
```

Source: [`packages/gamedev/game-addons/src/index.ts`](../../packages/gamedev/game-addons/src/index.ts)

<a id="ctxgamemcp--gamemcpserver"></a>

### `ctx.gameMcp` — `GameMcpServer`

Owner of the MCP endpoint, its game tool providers, and the connected agents' Sessions.

```ts cordis-catalog
/**
 * Offer a plugin's game tools to connected agents for the calling plugin's lifetime.
 * @param provider - the plugin's identity, readiness, and tools; its tool names start with its id and an underscore.
 * @returns an idempotent disposer that withdraws the tools.
 * @throws when the id is not lowercase letters and digits starting with a letter, or another provider has it.
 */
provide(provider: GameMcpProvider): () => void

/**
 * Follow the server for the window: its state, endpoint, and setup prompt, and the agents seen.
 * @param signal - stream cancellation.
 * @returns the current view, then the view after each change, until cancelled or the plugin is disposed.
 */
@Remote({ mode: 'stream' }) async* watch(signal: AbortSignal): AsyncIterable<GameMcpView>
```

Source: [`packages/gamedev/game-mcp/src/index.ts`](../../packages/gamedev/game-mcp/src/index.ts)

<a id="ctxgodot--godotcontroller"></a>

### `ctx.godot` — `GodotController`

Host owner of Godot runs: tools for the agent, a Remote for the Game tab, and the frame stream.

```ts cordis-catalog
/**
 * Follow the Session's game for the Game tab, without resuming the Session: a Session without a live Agent
 * reports no run until its Agent starts one.
 * @param sessionId - followed Session.
 * @param signal - stream cancellation.
 * @returns a snapshot, then run, log, and runtime changes until cancelled or the plugin is disposed.
 */
@Remote({ mode: 'stream' }) follow(sessionId: SessionId, signal: AbortSignal): AsyncIterable<GodotFollowItem>

/**
 * Start or restart the Session's game from the Game tab; audio plays unless `muted` is set. A Session without a
 * live Agent is resumed first, as a prompt resumes it.
 * @param sessionId - Session whose game starts.
 * @param request - project, scene, window size, and audio.
 * @param signal - cancellation before launch; a resume or a launched run continues for the Session.
 * @returns the new run, launched; the follow stream reports its progress.
 */
@Remote async run(sessionId: SessionId, request: GodotRunRequest, signal: AbortSignal): Promise<GodotRunView>

/**
 * Stop the Session's game.
 * @param sessionId - Session whose run stops.
 * @param signal - cancellation of the wait; stopping continues.
 * @returns after the game ended; `godot/not-running` when the Session has no run.
 */
@Remote async stop(sessionId: SessionId, signal: AbortSignal): Promise<void>

/**
 * Pause, resume, or step the Session's game.
 * @param sessionId - Session whose run changes.
 * @param request - action and step frames.
 * @param signal - cancellation.
 * @returns the run after the change.
 */
@Remote async control(sessionId: SessionId, request: GodotControlRequest, signal: AbortSignal): Promise<GodotRunView>

/**
 * Send user input to the Session's game without waiting for the game to apply it.
 * @param sessionId - Session whose run receives the input.
 * @param runId - run the input was meant for.
 * @param events - at most 256 events in game window pixels.
 * @param signal - cancellation.
 */
@Remote input(sessionId: SessionId, runId: string, events: GodotInputEvent[], signal: AbortSignal): void

/**
 * Count the Session's run as shown while the stream stays open, so a windowless game keeps its own frame rate; the
 * Game tab holds one while it shows the run's picture. The stream yields one item once the view counts and ends when
 * the run ends.
 * @param sessionId - Session whose run is shown.
 * @param runId - the run the tab shows.
 * @param signal - ends the view.
 * @returns the stream.
 */
@Remote({ mode: 'stream' }) async * view(sessionId: SessionId, runId: string, signal: AbortSignal): AsyncIterable<GodotViewItem>

/**
 * Install the managed LibGodot runtime, or join the install already running.
 * @param signal - stops this wait; the install continues.
 * @returns the runtime view after the install settled.
 */
@Remote async installRuntime(signal: AbortSignal): Promise<GodotRuntimeView>

/**
 * Export a project for the Web with the built-in runtime: a single-threaded build without GDExtensions that any
 * static web server can serve and any page can frame. The first export downloads the Web template. The export,
 * which imports the project, waits until the project's import steps and checks in this Host have ended. For other
 * plugins on the Host; the Game tab does not call it.
 * @param request - absolute project folder and output folder.
 * @param signal - cancellation; it stops the export process.
 * @returns the exported files.
 * @throws {GodotProjectError} without `project.godot` in the project folder.
 * @throws {GodotTemplateError} when the Web template cannot be downloaded.
 * @throws {GodotExportError} when the export writes no playable build.
 * @throws {LowMemoryError} when the computer has less than `minAvailableMemoryBytes` available as the export starts.
 */
async exportWeb(request: GodotWebExportRequest, signal: AbortSignal): Promise<GodotWebExport>

/**
 * Import a project with the editor's headless import step, which also loads its enabled editor plugins, for other
 * Host plugins such as the game add-ons installer; the Game tab and the `godot_*` tools do not call it. The step
 * waits for a process slot and for the project's other import steps and checks in this Host.
 * @param projectDir - absolute folder that holds `project.godot`.
 * @param signal - cancellation; it stops the import process.
 * @returns the errors and warnings it logged, with a warning when it did not end normally, or undefined when no Godot
 *   runtime is installed.
 * @throws {GodotProjectError} without `project.godot` in the folder.
 * @throws {GodotScriptError} when the import cannot start.
 * @throws {LowMemoryError} when the computer has less than `minAvailableMemoryBytes` available as the import starts.
 */
async importProject(projectDir: string, signal: AbortSignal): Promise<GodotImportReport | undefined>
```

Types: [SessionId](core.md)

Source: [`packages/gamedev/godot/src/index.ts`](../../packages/gamedev/godot/src/index.ts)

<a id="ctxwasdplugins--wasdplugins"></a>

### `ctx.wasdPlugins` — `WasdPlugins`

Owner of the Web export, release, and Browser tools and of the `wasdPlugins` Remote.

```ts cordis-catalog
/**
 * What a project folder released, for the Release button.
 * @param projectDir - absolute folder of a game project.
 * @param signal - cancellation.
 * @returns whether it is a Godot project, and its game on the site the app is signed in to.
 */
@Remote async project(projectDir: string, signal: AbortSignal): Promise<WasdProjectView>

/**
 * Pages of the WASD Engine site the app is signed in to, or would sign in to.
 * @param signal - cancellation.
 * @returns the Explore page.
 */
@Remote async links(signal: AbortSignal): Promise<WasdSiteLinks>

/**
 * Follow the agents' Browser commands that no window has taken yet, for a window that can drive Browser tabs.
 * @param signal - stream cancellation.
 * @returns the waiting commands, then again after each change, until cancelled or the plugin is disposed.
 */
@Remote({ mode: 'stream' }) browserRequests(signal: AbortSignal): AsyncIterable<WasdBrowserRequests>

/**
 * Take a Browser command for the calling window, which then carries it out and settles it.
 * @param id - the command.
 * @param signal - cancellation.
 * @returns whether the window took it; false when another window did or the command ended.
 */
@Remote claimBrowserRequest(id: string, signal: AbortSignal): boolean

/**
 * End a Browser command the window took, with the page afterwards or why it failed.
 * @param id - the command.
 * @param outcome - how it ended.
 * @param signal - cancellation.
 * @returns whether the outcome reached the waiting tool call; false when the call already ended.
 */
@Remote settleBrowserRequest(id: string, outcome: WasdBrowserOutcome, signal: AbortSignal): boolean
```

Source: [`packages/gamedev/wasd-plugins/src/index.ts`](../../packages/gamedev/wasd-plugins/src/index.ts)

<a id="game-mcp-events"></a>

### `game-mcp/*` events

<a id="game-mcpreveal--emit"></a>

#### `game-mcp/reveal` — emit

A connected agent's call asked the WASD Engine window to show a Session, such as the one whose game it started; the Host forwards it to the windows that may read the Session.

```ts cordis-catalog
/**
 * A connected agent's call asked the WASD Engine window to show a Session, such as the one whose game it
 * started; the Host forwards it to the windows that may read the Session.
 * @mode emit
 * @param sessionId - Session to show.
 */
'game-mcp/reveal'(sessionId: SessionId): void
```

Types: [SessionId](core.md)

Source: [`packages/gamedev/game-mcp/src/types.ts`](../../packages/gamedev/game-mcp/src/types.ts)
<!-- END GENERATED cordis-surface -->
