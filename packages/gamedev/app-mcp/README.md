---
description: "Build an MCP server that runs a desktop application headless, for application packages such as Blender, GIMP, and SuperCollider: the shared plugin Config fields, registration with the MCP manager and the source launch through tsx, the server process body, tool helpers and the execute_python tool, the JSON-lines worker protocol and restarts, tool result bounds, and copies of shipped files outside app.asar."
kind: "package-reference"
---

# @deepseek-ai/dsh-app-mcp

English | [中文](README.zh.md)

## Summary

Put a desktop application such as Blender, GIMP, or SuperCollider behind MCP tools that run it without a window. A Host plugin spreads the shared `AppMcpConfig` fields into its Config and calls `registerAppMcpPlugin`; its server entry calls `runAppMcpServer` with the application's tools. The first tool call starts one long-lived worker, and calls run one at a time. A timeout, crash, or protocol violation stops the worker: the failed call reports the lost state, and a later call starts a fresh one. Shared setup and tool helpers, `execute_python`, and `materializePayload`, which copies shipped scripts out of `app.asar`, complete the package.

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

This library is a dependency of application plugin packages: it has no plugin entry and no `cordis.yml` row, and the Config fields it defines belong to the plugins that include them. An application package uses it in two processes. Its Host plugin registers an MCP server, and the server process that the MCP client starts serves the tools and owns the application worker.

### When to use it

The Blender, GIMP, and SuperCollider packages depend on the library for their MCP servers; [Blender's plugin](../blender/src/index.ts) and [server entry](../blender/src/worker.ts) show a complete consumer. SuperCollider's language cannot answer the JSON-lines requests itself, so its [worker](../supercollider/README.md#understand-the-implementation) is a bridge process that drives sclang. The Godot package uses only `materializePayload`, to copy its harness scripts. Use the library when an external application must run headless behind tools that the agent calls, and a script inside the application, or a bridge process beside it, can answer the JSON-lines requests described below.

### Configure the plugin

A plugin's `Config` interface extends `AppMcpConfig`, and its schema spreads `AppMcpConfig.dict` into its own object schema, so every app MCP plugin offers these fields with the same defaults and bounds. Each budget is a whole number of milliseconds from 1 to 2,147,483,647.

| Field | Default | Meaning |
|---|---|---|
| `toolCallTimeoutMs` | `900,000` | Budget of one tool call, including a worker start and its first-use setup; a worker request, including an `execute_python` timeout, may use all of it but the last 30 s |
| `requestTimeoutMs` | `600,000` | Default budget of one worker request, at least 30 s less than `toolCallTimeoutMs`; when it expires, the worker stops and its state is lost |
| `graceMs` | `3,000` | Time the worker gets to exit after the `shutdown` request, and again after SIGTERM, before SIGKILL |
| `maxLogBytes` | `65,536` | Bytes of recent worker output, and of setup command output, kept for error messages; a positive whole number |

The plugin declares and documents `dataRoot`, the absolute directory it owns, and `startupTimeoutMs` itself, because their meaning differs between applications.

### Register the server

`registerAppMcpPlugin(ctx, config, plugin)` is the whole `apply` of such a plugin, whose `inject` must include `mcpManager`:

- `dataRoot` and the Config fields that `plugin.paths` names must be absolute paths or empty; otherwise it throws an error that starts with `<plugin.app> plugin:` and names the field.
- `requestTimeoutMs` must be at most `toolCallTimeoutMs` less 30 s; otherwise it throws an error that starts with `<plugin.app> plugin:` and names both budgets. The 30 s cover a worker start and the return of the result, so a request that runs out of time fails with its own error before the MCP client gives up on the call and cancels it with a generic timeout.
- The server receives `dataRoot`, `requestTimeoutMs`, `toolCallTimeoutMs`, `graceMs`, `maxLogBytes`, and the Config fields that `plugin.options` names, each under its Config name.
- The server entry is `worker.ts` beside `plugin.module`, the plugin's `import.meta.url`, when that URL ends in `.ts`, and `worker.js` beside it otherwise.
- The registration is `registerAppMcpServer` with `plugin.serverName` and the Config's `toolCallTimeoutMs` and `startupTimeoutMs`.
- With `plugin.gameMcp`, an `AppGameMcpIdentity` of `id`, `title`, `description`, and `instructions`, the server's tools also reach agents connected through WASD Engine's MCP server, [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md), while that server and the tool registry exist: each tool that the MCP client registered as `mcp__<serverName>__<name>` is offered as `<id>_<name>`, runs the same registered definition, and returns the server's text and images; other content blocks become `[<type> content omitted]`. The provider reports `ready` while the server is connected, `starting` before it connected and while it reconnects, and `unavailable` with the last error after it failed or while it is off.

The compiler checks the field names against the plugin's Config, and only string fields fit `plugin.paths`.

`registerAppMcpServer(ctx, registration)` takes these fields directly, for a plugin with its own entry. It registers the server inside `ctx.effect`, so disposing the plugin removes the server and its tools. The manager starts the server process once the registration settles; the server starts no worker until the first tool call.

| Registration field | Meaning |
|---|---|
| `serverName` | Manager key and tool namespace: tools become `mcp__<serverName>__<tool>`. The manager accepts 1 to 32 ASCII letters, digits, `_`, or `-` |
| `entry` | `file:` URL of the package's server entry: built JavaScript, or TypeScript in a source checkout |
| `options` | JSON object that the entry reads with `decodeServerOptions(process.argv)` |
| `toolCallTimeoutMs` | Milliseconds the MCP client waits for one tool call |
| `startupTimeoutMs` | Milliseconds the MCP client gives one connection attempt, including tool discovery |

From these fields it builds this MCP manager entry:

| Entry field | Value |
|---|---|
| `transport` | `stdio` |
| `command` | `process.execPath`, the Host's own executable |
| `args` | The entry's file path, then the encoded options; for an entry whose path ends in `.ts`, `--import` and the URL of the `tsx/esm` loader come first |
| `env` | `ELECTRON_RUN_AS_NODE=1` and empty `PYTHONPATH`, `PYTHONHOME`, and `VIRTUAL_ENV`, and for a `.ts` entry `TSX_TSCONFIG_PATH` naming the repository's `tsconfig.base.json`, merged over the MCP client's scrubbed Host environment |
| `cwd` | Empty, so the server process starts in the Host's working directory |
| `toolCallTimeoutMs`, `startupTimeoutMs` | The registration's values |
| `closeTimeoutMs` | 15,000 ms, longer than the server's 10 s shutdown budget |
| `reconnect` | Enabled: the first retry after 1 s, each delay doubling up to 30 s, and at most 5 consecutive failed attempts |

In the Desktop app the Host's executable is Electron, which `ELECTRON_RUN_AS_NODE=1` runs as Node, so the Desktop app needs no separate Node installation. The empty Python variables keep a Python setup from the user's shell out of the workers that the server starts.

A `.ts` entry is what a source launch of the harness registers, such as `pnpm dsh web`: the plugin module is then `src/index.ts`, so its entry is `src/worker.ts`. The server runs through tsx's ESM hook like the source launch itself, and `TSX_TSCONFIG_PATH` maps workspace imports to their sources whatever the server's working directory is. The loader is resolved only for a `.ts` entry, so the packaged Desktop app, which registers built `.js` entries, needs no tsx.

`encodeServerOptions` passes the options as one argument, `argv[2]`: unpadded base64url text of their UTF-8 JSON. The MCP manager reads `${…}` in `command`, `args`, `env` values, and `cwd` as a [credential template](../../mcp/mcp-client/README.md#runtime-templates-and-credentials): it refuses every `${…}` that is not a `${credential:REF}` token and resolves the tokens. Base64url text never contains `${`, so option values reach the server unchanged. `decodeServerOptions` throws a `TypeError` that names `argv[2]` when the argument is missing, is not canonical unpadded base64url, or does not decode to a UTF-8 JSON object.

`registerAppMcpServer` throws a `TypeError` when `entry` is not a `file:` URL. The manager throws when the server name is invalid or already taken, including by a configured server with the same name. Either error fails the plugin.

### Run the server process

`runAppMcpServer(definition, process.argv)` is the whole body of a server entry. `definition` gives the server's `name`, `version`, and `instructions`, the `file:` URL of the shipped `workerScript`, and three functions:

- `parseOptions(value)` validates the decoded options. A server builds its strict schema from `AppServerOptionFields`, which hold the `AppServerOptions` fields that every server receives, and its own fields, and calls `parseAppServerOptions(app, schema, value)`. That throws an error that starts with `<app> MCP server options are invalid:` and names each missing, invalid, or unknown field.
- `workers(options, dependencies)` creates the application's `AppWorkers`. Its `start(signal)` prepares the application and starts one worker with `dependencies.start`, which is `JsonLineWorker.start`; `dependencies.workerScript()` returns the real path of a `materializePayload` copy of the worker script under `dataRoot`. Its `takeNotes()` hands over the setup notes gathered since the previous call, such as the version of a worker that started.
- `tools(dependencies)` builds the tools with `AppToolDependencies`: `call` runs a worker method through one `WorkerSupervisor`, whose budgets are `requestTimeoutMs` and `graceMs`; `takeNotes` reads the application's notes; and `dataRoot`, `requestTimeoutMs`, and `maxTimeoutMs`, which is `toolCallTimeoutMs` less 30 s, carry the paths and budgets.

It returns once the server is serving, and the server's shutdown closes the supervisor, which stops the worker. An `argv[2]` that holds no options, or options that `parseOptions` refuses, rejects before anything is served.

### Serve the tools

`runAppMcpServer` serves the tools with `serveAppMcp({ name, version, instructions, tools, onClose })`, which a server entry can also call directly. It first points the global `console` at stderr, so stdout carries only MCP frames, and it restores the console at shutdown. The server answers tool discovery at once and starts nothing else; a tool runs only when the client calls it. Duplicate tool names make `serveAppMcp` reject before it serves.

Each `AppTool` has a `name`, an optional `title`, a `description`, and an `input` Zod raw shape, against which the SDK validates the arguments. Its `run(args, signal)` returns an `AppToolResult`. The signal aborts when the server shuts down and when the client cancels the call, which the MCP client also does when its `toolCallTimeoutMs` expires.

The server maps an `AppToolResult` to MCP content:

- `text` becomes the first text block. Text whose JSON encoding exceeds 1 MiB keeps its first 174,762 UTF-16 code units, without splitting a surrogate pair, followed by `[output truncated: <n> more characters]`.
- `images` follow in order, as `image/png` or `image/jpeg`. Each comes from its `data` bytes or, without them, from the file at `path`, which the server reads and leaves in place. The server does not resize images.
- An image above 4 MiB as base64 (3 MiB of bytes), or one that would bring the result's images above 6 MiB of base64, becomes an `[image omitted: …]` text notice that asks for a smaller image; a later image that fits is still included. An unreadable file, or an image with neither `data` nor `path`, becomes `[image unavailable: <reason>]`.
- `isError: true` marks the result as a failure. The MCP client then fails the call with the result's text, so its images reach the model only as the client's text diagnostics.

A thrown error becomes an error result with one text block: the error's message and, for a `WorkerError`, the last 4,000 characters of the worker's traceback, the last 2,000 characters of its log tail after `Recent worker output:`, and `Error code: <code>`.

The server shuts down on the first of these: stdin ends or closes; the MCP transport closes itself, which it does when a stdout write fails, such as with EPIPE after the client went away, and when an incoming message overflows its read buffer; or SIGTERM or SIGINT arrives. It closes the MCP connection, which aborts running tool calls, and then awaits `onClose` for at most 10 s, once. It reports a failing or unfinished `onClose` on stderr and exits with code 0. The signal listeners stay until the process exits, so a repeated SIGTERM, which the MCP client sends when it escalates a close, cannot end the process before `onClose` finished. Writes to stderr are best effort: a failed one is ignored. The consumer stops its worker in `onClose`, for example with `supervisor.close()`.

### Build the tools

These helpers carry what the application tool sets share:

- `defineAppTool(tool)` types a tool's `run` arguments by its `input` shape and returns the tool for the tool list.
- `workerParams(args)` turns validated arguments into worker parameters, leaving out the omitted ones.
- `replyParser(app)` returns a function that validates a worker reply against a Zod schema; a mismatch throws a `WorkerReplyError` whose message starts with `The <app> worker sent an unexpected <method> reply:` and names each mismatch.
- `withSetupNotes(dependencies, result)` puts the pending setup notes before the result's text, each followed by a blank line; `takeNotes` hands each note over once.
- `formatBytes(bytes)` writes a file size as `512 bytes`, `2.0 KiB`, or `5.0 MiB`.
- `executePythonTool(dependencies, { app, title, description })` is the `execute_python` tool of a Python-scripted application; [Model Experience](#model-experience) shows its declaration and result text.
- `AGENT_IMAGE_MAX_EDGE`, 1,568 pixels, and `AGENT_IMAGE_MAX_BYTES`, 3 MiB, whose base64 form fills the 4 MiB that one image may take, size the images that tools ask their workers for.

### Find the application

A server finds its application through a `SetupHost`: the platform, environment, and home directory of the server process, `isExecutable` for regular files the user may execute, `listDirectory`, which lists a missing or inaccessible directory as empty, and `makeDirectory`. `nodeSetupHost()` binds it to this machine; tests pass a fake host. `firstExecutable(candidates, host)` returns the first candidate that passes `isExecutable`, and `newestFirst` sorts names by the numbers in them, newest first, so `Blender 4.10` precedes `Blender 4.2` and `GIMP 3.0.1` precedes `GIMP 3.0`. `CommandArgv` types an absolute executable followed by its arguments.

<a id="run-the-worker"></a>
### Run the worker

`JsonLineWorker.start(spec, signal)` spawns one worker from `spec.argv`, whose first element is the absolute executable path, in `spec.cwd` with the complete environment `spec.env`; a caller that wants the worker to inherit `process.env` merges it there. The worker and the client exchange UTF-8 JSON lines:

```text
stdin  request   {"id": 1, "method": "<method>", "params": {"<name>": <JSON value>}}
fd 3   ready     {"ready": true, "protocol": 1, "app": "<app>", "version": "<app version>", "python": "<Python version>"}
fd 3   success   {"id": 1, "ok": true, "result": <JSON value>}
fd 3   failure   {"id": 1, "ok": false, "error": {"type": "<exception class>", "message": "<text>", "traceback": "<text>"}}
```

- `python` names the Python version of a Python worker; a worker that runs no Python leaves it out.
- The worker's first line on fd 3 must be the ready line, written within `spec.readyTimeoutMs`. Otherwise the client kills the worker and its process group, drains their output, and rejects the start with `WORKER_START_FAILED`; a cancelled start rejects with the abort reason after the same cleanup.
- Requests run one at a time in call order, and each reply carries the id of the pending request; `traceback` is optional. A request's `timeoutMs` starts when the request is written to stdin.
- Replies use fd 3, so the application's own output on stdout and stderr cannot mix with them. The client keeps the last `spec.logTailBytes` bytes of that output as the log tail for diagnostics.
- Cancelling a queued request only removes it from the queue. Cancelling a dispatched request stops the worker, as a timeout does, because the worker's state is then unknown.
- `close(graceMs)` sends a `shutdown` request and closes stdin. Without an exit after `graceMs` it sends SIGTERM to the worker's process group, and SIGKILL after another `graceMs`. A worker may answer the `shutdown` request before it exits.
- On POSIX the worker leads its own process group. When the worker exits or is stopped, the client sends SIGKILL to every process left in that group.

Worker failures are `WorkerError`s with a `code`, and only `WORKER_REMOTE` leaves the worker running. A stopped worker rejects later requests with its first failure; its owner starts a new one. Out-of-range budgets, such as a zero `timeoutMs`, throw a `RangeError`.

| `code` | Cause | Worker afterwards |
|---|---|---|
| `WORKER_REMOTE` | The worker replied `ok: false`; the error carries `remoteType` and `traceback` | Keeps running with its state |
| `WORKER_TIMEOUT` | No reply within the request's `timeoutMs` | Killed; state lost |
| `WORKER_PROTOCOL` | A line that is not a valid reply, a reply to an id that is not pending, or a line over 32 MiB | Killed; state lost |
| `WORKER_EXITED` | The worker exited, was shut down, or was stopped after a dispatched request was cancelled | Gone; state lost |
| `WORKER_START_FAILED` | The worker could not be spawned, or its first line on fd 3 was not a valid ready line in time | Killed |

### Restart after a stop

`WorkerSupervisor(start, { requestTimeoutMs, closeGraceMs })` owns the worker of one server process, and `call(method, params, { timeoutMs, signal })` runs one worker method through it:

- Calls run one at a time in call order, and a call starts a worker through `start(signal)` when none is running. `timeoutMs` defaults to `requestTimeoutMs` and counts from the call, like the MCP client's tool-call budget: a call that waited for earlier calls gets what is left, and one whose wait spent it all rejects with `WORKER_TIMEOUT` without running and leaves the worker and its state alone.
- `WORKER_REMOTE` passes through, and the worker keeps its state.
- Any other `WorkerError` of a running call waits until the worker process is gone, then rejects with the same code and a message that ends with `; its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker`.
- When the worker exits between calls, or a running call is cancelled, the next call does not run: it fails with a `WORKER_EXITED` message that ends the same way, and the call after it starts a fresh worker.
- A failed or cancelled start reports no lost state, and the next call tries to start a worker again. Cancelling a call before it reaches the worker leaves the worker running.

`close()` refuses further calls with `WORKER_EXITED`, cancels the running call, waits until every call has settled, and shuts the worker down with `closeGraceMs`.

### Copy shipped files to real paths

A packaged Desktop app keeps package files inside its `app.asar` archive, which only Electron's `fs` can read; Blender, GIMP, Godot, and SuperCollider need an ordinary file. `materializePayload(source, dataRoot)` reads the `file:` URL `source` through its path, which Electron's `app.asar` support resolves, and returns the real path of a copy at `<dataRoot>/payload/<first 16 hex digits of the content's SHA-256>/<file name>`.

- A copy with identical bytes is reused without a write; a copy with other bytes is replaced.
- The bytes go to a temporary file in the same directory, which is then renamed into place, so readers never see a partial file. The copy has mode `0o644` before the umask.
- Each content version gets its own directory.
- A `source` that is not a `file:` URL throws a `TypeError`; read and write failures reject with the filesystem error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Three processes take part: the Host, the server process that the MCP client starts from the entry, and the worker that the server starts inside the application. Only the server process speaks MCP. Keeping the application out of the MCP stream lets the server answer discovery without starting the application, return a worker crash as a tool result instead of a lost connection, and restart the worker without reconnecting MCP. The MCP SDK's stdio client can start a short-lived copy of the server before the serving process; because no worker starts before the first tool call, that copy never starts the application.

| File | Contents |
|---|---|
| [`src/index.ts`](src/index.ts) | The shared `AppMcpConfig` fields and the package exports; the Config schema lives here so that the config catalog can read the plugins' spreads |
| [`src/plugin.ts`](src/plugin.ts) | `registerAppMcpPlugin`: path checks, server options from the Config, and the entry beside the plugin module |
| [`src/register.ts`](src/register.ts) | Host registration, the source launch through tsx, and the fixed manager entry fields |
| [`src/options.ts`](src/options.ts) | The `argv[2]` options codec, the shared option fields, and their validation |
| [`src/app-server.ts`](src/app-server.ts) | The server process body: options, worker script copy, supervisor, and tools |
| [`src/mcp-server.ts`](src/mcp-server.ts) | Console routing, tool registration, result mapping and bounds, failure text, and shutdown |
| [`src/tools.ts`](src/tools.ts) | Tool helpers and the `execute_python` tool |
| [`src/setup-host.ts`](src/setup-host.ts) | The setup host and the executable and version helpers |
| [`src/supervisor.ts`](src/supervisor.ts) | Lazy start, serialized calls, lost-state messages, and close |
| [`src/json-line-worker.ts`](src/json-line-worker.ts) | Spawn, line parsing, timeouts, cancellation, process-group signals, and the log tail |
| [`src/materialize.ts`](src/materialize.ts) | Content-addressed payload copies |
| [`tests/fixtures/fake-worker.mjs`](tests/fixtures/fake-worker.mjs) | Protocol fixture that stands in for a Python worker |
| [`tests/fixtures/source-server.ts`](tests/fixtures/source-server.ts) | TypeScript server entry that runs only through the source launch |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | The whole chain with the real MCP manager, MCP client, and tool runtime |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Game development tools](../README.md) — the package group and how its packages connect.
- [MCP manager](../../mcp/mcp-manager/README.md) — configured and plugin-registered servers.
- [MCP client](../../mcp/mcp-client/README.md) — tool naming, result projection, images, and reconnection.

-----

<a id="model-experience"></a>
## Model Experience

### Registered server tools and instructions

#### What the model sees

This package adds no system-prompt text of its own, and its only tool definition is the `execute_python` tool below. While a consumer's registration is active, the model sees the tools of that server, such as `mcp__wasd_blender__<tool>`, with the descriptions and input schemas of its `AppTool` entries, and the server's `instructions` in the system prompt, as the [MCP client](../../mcp/mcp-client/README.md#model-experience) projects them. The server lists its tools without starting a worker, so they appear whether or not the application can start.

#### Token effect

The consumer's tool descriptions, input schemas, and instructions enter every request while the server is connected; this package adds only the `execute_python` argument descriptions to them.

#### KV Cache effect

The tool definitions and instructions keep the request prefix stable while the server stays connected with an unchanged tool list. Loading or unloading the plugin, or exhausting the five reconnect attempts, adds or removes them and can invalidate reuse from the first changed tool definition or system-message text onward.

### Tool result text and images

#### What the model sees

A successful result is one text block followed by the tool's images in order. Cut text ends with `[output truncated: <n> more characters]`, and each image that cannot be sent becomes a text notice in its position: `[image omitted: as base64 it exceeds the 4 MiB limit for one image; request a smaller image]`, `[image omitted: as base64 the images of this result exceed their 6 MiB total limit; request fewer or smaller images]`, or `[image unavailable: <reason>]`. The MCP client decides whether the images that are sent enter context as images or as its text diagnostics.

#### Token effect

The text block is capped at 1 MiB of JSON-encoded text, and the images at 4 MiB of base64 each and 6 MiB per result; the text and the admitted images stay in context until compaction.

#### KV Cache effect

Append-only: each result follows the existing request prefix and changes no earlier request text.

### The `execute_python` tool

#### What the model sees

The consumer gives the tool its title and description. Its input schema has `code`, a required string of 1 to 200,000 characters described as `Python source to run.`, and `timeout_seconds`, an optional whole number from 1 to `maxTimeoutMs` in whole seconds (at least 1) described as `Seconds before <app> is stopped and restarted (default <requestTimeoutMs in seconds>).`. The result text has up to three parts, separated by blank lines: the traceback when the code raised, or `<type>: <message>` when the traceback is empty; `result: ` and the JSON of `result` when it is not null; and `output:` followed by the printed output when there is any. Without any part the text is `Done. The code assigned no result and printed nothing.`. A raised exception makes the result an error result. Pending setup notes come first, and a reply that does not match fails the call with `The <app> worker sent an unexpected execute_python reply:` and the mismatches.

#### Token effect

The two argument schemas come to about 240 characters of JSON beside the consumer's title and description. The result text holds what the worker returned, whose printed output and `result` the worker bounds, and stays in context until compaction.

#### KV Cache effect

One configuration yields one declaration, so the tool-definition prefix stays stable; a change of `requestTimeoutMs` or `toolCallTimeoutMs` changes the `timeout_seconds` schema. Results are append-only.

### Worker failure results

#### What the model sees

A failed call reaches the model as a failed tool call that carries the error message and, for a worker failure, the end of the worker's traceback, `Recent worker output:` with the end of its stdout and stderr, and `Error code: <code>`, separated by blank lines. When the worker stopped, the message ends with `; its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker`. After the worker exits between calls or a running call is cancelled, the next call fails with such a `WORKER_EXITED` message without running, and the call after it starts a fresh worker.

#### Token effect

The traceback part adds at most 4,000 characters and the worker output part at most 2,000; the whole text is cut at 1 MiB of JSON like result text, and the failed call stays in context until compaction.

#### KV Cache effect

Append-only, like other tool results; a failure changes no earlier request text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply to every server built on the library.

- **One worker per server** — every caller of a server shares its worker and the application state in it, and calls queue behind the running one, so one long call delays the rest.
- **A stop loses the application state** — a timeout, a crash, a protocol violation, or the cancellation of a running call stops the worker. The library saves and restores nothing, so work that the application has not written to disk is lost.
- **Console routing only** — `serveAppMcp` reroutes the global `console` when it starts. Output written before that call, or written to `process.stdout` directly, enters the MCP stream, which must carry only MCP frames.
- **Fixed result bounds** — text is cut at 1 MiB of JSON, and images are limited to PNG and JPEG within 4 MiB of base64 each and 6 MiB per result. The library does not downscale images, so the worker must produce them within these bounds. A reply line over 32 MiB stops the worker.
- **Fixed connection policy** — consumers cannot change the 15 s close budget or the reconnect policy. After five consecutive failed reconnect attempts the MCP client removes the server's tools until the server is restarted through the MCP manager, the plugin reloads, or the Host restarts.
- **Payload copies accumulate** — every content version of a shipped file keeps its own directory under `<dataRoot>/payload/`; the library never deletes earlier versions.
- **Source entries need the checkout's tsx** — a `.ts` server entry resolves `tsx/esm` from the repository's `node_modules` and reads the repository's `tsconfig.base.json`, so only a source checkout of the harness can register one; a built or packaged harness registers `.js` entries.
- **Waiting counts against the tool-call budget** — the 30 s that a worker request leaves of `toolCallTimeoutMs` cover a worker start and the result, but not a call that first waits behind other calls or for a long first-use setup. Such a call can still reach the MCP client's budget, and the client then cancels it.
- **Windows process trees** — Windows has no process groups. Stopping a worker runs `taskkill /T /F` on its process tree, so the SIGTERM step of a shutdown is already a forced kill, and processes that a worker leaves running after it exits on its own are not stopped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
