---
description: "Serve WASD Engine's game tools to other agents on the same computer, such as Claude Code or Codex: the loopback Streamable HTTP endpoint and its token, the provider registry that the game tool plugins and WASD Engine Plugins fill, the search and call tools, the tool that creates game projects without a Session, the Sessions that connected agents' games run in, the gameMcp Remote, the game-mcp/reveal, game-mcp/tool-result, and game-mcp/project-created events, the setup prompt that the Desktop introduction and Settings show, and the refusal of tool calls while WASD Engine is signed out."
kind: "package-reference"
---

# @deepseek-ai/dsh-game-mcp

English | [中文](README.zh.md)

## Summary

Let Claude Code, Codex, and other agents on this computer use WASD Engine's game tools through MCP. The Host plugin listens on `http://127.0.0.1:9273/mcp`, requires the token in its data folder and a signed-in WASD Engine, and offers the `godot_*`, `blender_*`, `gimp_*`, `supercollider_*`, `asset_*`, `audio_*`, and other tools that game tool plugins contribute, with `search_game_tools`, `call_game_tool`, and `create_game_project`, which creates a game project that WASD Engine lists with no Session. A connected agent's Godot game runs in a Session of its own, so it plays in the WASD Engine window's Game tab. [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.md) shows the setup prompt after sign-in.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `game-mcp` into every Web and Desktop profile, after the game tool rows:

```yaml
- id: game-mcp
  name: '@deepseek-ai/dsh-game-mcp'
  config:
    dataRoot: !!js dshHomePath('game-mcp')
    newGameGuidance: |-
      These additional instructions are the recommended prompt for building games with WASD Engine. Do your absolute best to follow them:
      * Put your effort into making what's on screen look, move and sound great
      * People and humanoid figures should look and move like real people, with fitting animations
      * The environment should be believable, textured, with lighting that sells the mood
      * Run and play the demo yourself and fix anything that looks or plays wrong before you finish
```

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | Required | Absolute folder of the access token (`token`) and of the connected agents' Session bindings (`sessions.json`); a relative path fails the plugin load |
| `port` | `9273` | Loopback port of the endpoint, a whole number from 0 to 65,535; 0 picks a free port. While another program holds it, the server does not start, its view says so, and the token changes ([Understand the implementation](#understand-the-implementation)) |
| `progressIntervalMs` | `30000` | Interval in milliseconds of the progress notifications that a running tool call sends to an agent that asked for progress, a whole number of at least 1 |
| `readyTimeoutMs` | `8000` | Longest time in milliseconds that the first requests wait for the composition to finish loading its plugins ([server instructions](#server-instructions)), a whole number of at least 1; the default stays under the 10 seconds that Codex gives a server to start |
| `temporaryFolders` | The Host's temporary folder and, outside Windows, `/tmp` and `/var/tmp` | Absolute folders where agents keep throwaway work, whose folders never become game projects through the server ([temporary folders](#temporary-folders)); a relative path fails the plugin load, and `[]` turns the rule off |
| `newGameGuidance` | `''` | Text that ends the result of a `create_game_project` call that created a game project, after a blank line ([create game projects](#create-game-projects)); empty adds none, and text of only whitespace fails the plugin load |

A profile patch turns the server off with `- id: game-mcp` and `disabled: true`.

### Set up another agent

Set up with another agent, which [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.md) adds as the last step of the Desktop introduction and as the Other agents section of Settings, shows the setup prompt of the server's view with the server's state and the agents seen since the Host started.

The prompt, which [`src/prompt.ts`](src/prompt.ts) writes, names the server `wasd-engine`, the URL, and the header `Authorization: Bearer <token>`, and gives the setup for Claude Code and Codex:

```text
claude mcp add-json wasd-engine '{"type":"http","url":"http://127.0.0.1:9273/mcp","headers":{"Authorization":"Bearer <token>"}}' --scope user
```

```toml
[mcp_servers.wasd-engine]
url = "http://127.0.0.1:9273/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
tool_timeout_sec = 1800
```

Codex stops a tool call after 60 seconds unless the server's entry sets `tool_timeout_sec`, and a release that uploads a large build, or a long render, takes minutes, so the Codex entry allows 30 minutes.

The token is 32 random bytes in base64url, created on first start in `<dataRoot>/token` with mode 0600, so agents set up once keep working across restarts. Deleting the file makes the next start create another token, after which every agent needs the new prompt. A start that finds the port held by another program also creates another token, because agents set up earlier send theirs to whatever listens on the port.

### What connected agents get

| Tool | From | What it does |
|---|---|---|
| `search_game_tools` | This package | Lists the plugins with their readiness and tool counts, and the tools: every tool's first sentence without a query, or the best matches with their parameters for a query; `plugin` limits the search, and with `plugin` and no query the result also holds that plugin's guide ([server instructions](#server-instructions)) |
| `call_game_tool` | This package | Calls a tool by `name` with `arguments`, for an agent whose tool list lacks it |
| `create_game_project` | This package | Creates a game project as the Create game project dialog does, from `name` and an optional absolute `location`, opens no Session in it, and takes `model`, the name of the AI model the agent is, which the released game's page credits ([Create game projects](#create-game-projects)) |
| `godot_*` | [`@deepseek-ai/dsh-godot`](../godot/README.md) | The Session's fourteen Godot tools, each with an absolute `project` parameter |
| `blender_*` | [`@deepseek-ai/dsh-blender`](../blender/README.md) through [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.md) | The `wasd_blender` server's tools, renamed from `mcp__wasd_blender__<tool>` |
| `gimp_*` | [`@deepseek-ai/dsh-gimp`](../gimp/README.md) through [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.md) | The `wasd_gimp` server's tools, renamed from `mcp__wasd_gimp__<tool>` |
| `supercollider_*` | [`@deepseek-ai/dsh-supercollider`](../supercollider/README.md) through [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.md) | The `wasd_supercollider` server's tools, renamed from `mcp__wasd_supercollider__<tool>` |
| `wasd_*` | [`@deepseek-ai/dsh-wasd-plugins`](../wasd-plugins/README.md) | The Web export and release tools and the multiplayer tools, each with an absolute `project` parameter |

Every user signs in to WASD Engine: while the account plugin, `@deepseek-ai/dsh-deepseek-account`, reports no stored sign-in or cannot read it, the server answers every tool call, `search_game_tools`, `call_game_tool`, and `create_game_project` included, with an error result that asks the user to sign in, and still lists its tools. It reads the sign-in at each call, so the tools work again as soon as the user signs in. A Host without the account plugin runs every call.

Connected agents share one Blender, one GIMP, and one SuperCollider worker among themselves, apart from the workers of WASD Engine's own Sessions ([one worker per Session](../app-mcp/README.md#one-worker-per-session)), unless their calls of those tools pass `session`: each name then runs in the worker of the agent's Session of that name, the same Session that the name picks for the Godot tools, in the game project that `project` names ([connected agents' Sessions](../app-mcp/README.md#connected-agents-sessions)). The guides of those plugins say so.

<a id="server-instructions"></a>
### Server instructions

The instructions that the server sends to every agent open with an overview, which [`src/catalog.ts`](src/catalog.ts) writes in four paragraphs: that the tools exist to raise the quality of the user's game beyond what code alone can make, so the agent uses them by default and tells the user why it skips one that fits the work; that a new game starts with `create_game_project`, that the agent reads a plugin's guide before it first uses the plugin's tools, where the guides are, that some guides name their own plugin's tools without its prefix, and that each helper agent gets one task and each new task a new helper, since a helper's whole conversation is read again at each of its steps; that the agent's plan and final summary name the tools and add-ons it uses and say why it skips each one that fits the work, or uses none, where only a tool that cannot do what the game needs, or would make it worse, is a reason; and what each plugin adds, one line per provider with its title, tool prefix, and `description`. Each provider's `instructions`, its guide, follow under `## <title>`. Agents' harnesses may cut long instructions: Claude Code passes its model the first 4,096 characters, and OpenAI asks servers to keep the first 512 characters self-contained for Codex. So the first paragraph stays within 512 characters, the whole overview has to fit in 4,096, and an overview that grows longer loses the end of the plugin list first, which `search_game_tools` lists in full; with `plugin` and no query, `search_game_tools` returns that plugin's guide, under a line that asks the agent to add the plugin's prefix where the guide names one of the plugin's own tools, listed after the guide, without the prefix. When a provider's registration makes the overview longer than 4,096 characters, the server logs a warning that names the length, and [`wasdengine-game-mcp-overview.spec.ts`](../../bundle/web-app/tests/wasdengine-game-mcp-overview.spec.ts) builds the overview from every shipped provider and fails when it is longer.

MCP sends the instructions once, in the answer to `initialize` or `server/discover`, and the agent keeps them for its connection, while the listener starts as soon as the plugin does, before the plugins that provide game tools have loaded. So the server answers requests only once the Loader's tree has settled, which joins every plugin's import and start and with them the providers that register as their plugins start; an agent that connects while the app starts waits for its answer instead of receiving an overview without the plugins that load last. The first request that the token admits starts the wait, which ends after `readyTimeoutMs` with a warning that names the providers registered so far, or when the plugin stops; later requests do not wait again, and a Host without a Loader answers at once.

<a id="create-game-projects"></a>
### Create game projects

`create_game_project` creates a game project for a connected agent through the Workspace controller's [`gameProjectController`](../../../docs/subsystems/workspace.md#ctxgameprojectcontroller--gameprojectcontroller), the Host half of the Create game project dialog: the folder `name` in `location`, an absolute path that it creates when missing and takes without the spaces around it, as the dialog does, or, without `location` or with a null or blank one, in the dialog's suggested folder, `<Documents>/WASD Engine`; a Git repository with one empty commit when Git is available; and the folder's registration, titled with its name, which the window lists under Game Projects. The call opens no Session, so the project shows with none until the user opens it or a game tool call names it, which starts the agent's Session there. The result names the folder's absolute path for the agent's later calls, asks the agent to write the game's `project.godot` before it installs add-ons, which an installation needs, and says that the Blender, GIMP, and SuperCollider tools take `project` only together with `session`. `model` names the AI model the agent is, taken without the spaces around it, and a missing, null, or blank one names none; the result of a call that named none asks the agent to pass `model` to `godot_run` when it first runs the game. A `newGameGuidance` ends the result of a call that created a project, after a blank line: the overview of the server instructions applies to every task and has no room left ([server instructions](#server-instructions)), while this result reaches the agent once, when it starts a new game and before it writes code. WASD Engine's row sets it to the instructions of its recommended prompt: the lines that the `gamedev` preset's [new game guidance](../new-game-guidance/README.md) adds after the user's first prompt, without the request to work without asking questions, which a connected agent takes only from its user. A name that is not one portable folder name, a `location` that is not absolute or is in a [temporary folder](#temporary-folders), a `model` that is not a string, a path that exists, a Host without the game project controller, and a call without `location` on a Host that cannot find the Documents folder each get an error result that says why, and nothing is created; for a name, the Host's reason picks the text: no visible character, a character or length that some computer refuses, a device name that Windows reserves, such as `CON` or `com1.txt`, or `.git`. The call emits no `game-mcp/tool-result`, which reports provider tools only; a call that created a project emits `game-mcp/project-created` with the calling agent, the folder, and the model the call named, from which [WASD Engine Plugins](../wasd-plugins/README.md) credits the new game with that model, and a listener's failure is logged and leaves the result alone.

<a id="games-in-the-wasd-engine-window"></a>
### Games in the WASD Engine window

A Godot call names its project by absolute path: the folder that holds `project.godot`, a folder up to three levels above it, or the `project.godot` file; without `project`, the call uses the agent's previous project. The server resolves the Session that runs the agent's games in that project: the registered game project that contains the folder, or a new registration of the folder itself, holds one Session per agent; a folder in a [temporary folder](#temporary-folders) that no registered game project contains gets no registration, and the agent's Session works in that folder outside every game project. Each Session is created on first use and remembered in `<dataRoot>/sessions.json`, so the agent keeps its Session and its game across restarts. A Session that left its game project, was archived, or no longer exists is replaced by a new one. A Godot call may also give `session`, a name of 1 to 40 characters without control characters: each name picks another Session of the agent in that project, titled `<agent>: <name>`, and names that differ only in case pick the same one. Agents that share one connection and so one identity, such as the subagents of one Claude Code session that work at the same time, each give their own name, so each runs a game of its own instead of restarting the game another one tests; a name's first call without `project` uses the agent's most recent project. `godot_run` emits `game-mcp/reveal` with the Session, the window opens the Session through [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.md), and the Game tab opens for the run, as it does for any run an agent starts.

<a id="temporary-folders"></a>
### Temporary folders

Agents test and try things out in throwaway folders, such as Claude Code's scratchpad under `/tmp`, and a game project for each of them would bury the user's own projects under Game Projects. So the server registers no game project in the `temporaryFolders`: by default the Host's temporary folder, which `TMPDIR`, `TMP`, or `TEMP` names, and outside Windows `/tmp` and `/var/tmp`. A path is in one when its canonical spelling, with symbolic links resolved, as `/tmp` leads to `/private/tmp` on macOS, is the folder or below it; a path that does not exist yet is spelled through its nearest existing folder. A game tool call that names a folder in one, which no registered game project contains, runs in the agent's Session of that folder outside every game project: the Session list shows it under Ungrouped only while it is open, as it shows every blank Session, and the window still opens it for `godot_run`. A registered game project in a temporary folder, such as one the user added, keeps holding its agents' Sessions. `create_game_project` refuses a `location` in a temporary folder and tells the agent to leave `location` out, pass a folder that lasts, or make a throwaway folder itself; it still creates projects in `<Documents>/WASD Engine` wherever the Documents folder is.

### Provide tools

`ctx.gameMcp.provide(provider)` offers a plugin's tools for the calling plugin's lifetime and returns an idempotent disposer. A provider has a lowercase `id`, which prefixes its tool names, a `title`, a `description` of what its tools do and add to the user's game in one or two sentences, which the overview of the instructions lists, optional `instructions`, its guide, `tools()`, and `status(signal)`, which reports `ready`, `starting`, or `unavailable` with a message. Each tool names a harness `ToolDefinition` that runs the calls and may override its description and input schema, mark itself read-only, `prepare` a call (map its arguments, choose the Agent it runs as, through `call.session(directory, name)`, and pass on the name of the AI model the agent says it is, for a tool whose arguments take one), and turn the value into MCP `content`; without `content` the server sends the text blocks of `output.render`. A prepared call may `reveal` a Session, and a tool may name, through `confirmation(value)`, the page where the user confirms what a successful call asked for. A provider whose tools spend the account's AI usage sets `spendsUsage`, so the server leaves it out while a Free account stays on Free ([Free accounts whose usage is used up](#free-accounts-whose-usage-is-used-up)). The server lists a tool only when its name starts with the provider id and an underscore and neither an earlier tool nor one of the server's own tools has it, and it turns a failure of preparation, argument validation, or execution into an error result with the error's message. A tool's `failureContent(error, args)` adds content after the message of a failed execution, such as the screenshot of the Web check that stopped a release; when it fails, the result keeps the message alone. A tool that declares `timeoutMs` keeps it: its execution sees the expiry as cancellation, as it does in a Session, and the result says the call timed out. The server runs calls as they arrive, several at once, including calls of one agent and of its subagents. Once a provider tool's result is made, the server emits `game-mcp/tool-result` with the provider id, the tool name, the prepared arguments, the calling agent, the Session the call ran in, if any, the model the call named, if any, and whether the agent got an error result; a listener's failure is logged and leaves the result alone. [WASD Engine Plugins](../wasd-plugins/README.md) credits a game with the tools that connected agents used on it, and with the agents themselves by the models they named, from this event. `ctx.gameMcp.toolOwner(name)` finds the provider that offers a tool now, by the tool's name for connected agents or by the name of the harness definition that runs it, and returns the provider's id and title with the tool's name for connected agents; [agent feedback](../agent-feedback/README.md) counts a Session's own calls of a provider's tools under that provider with it.

### Helpers for game tool plugins

`@deepseek-ai/dsh-game-mcp/kit` holds what the plugins that offer game tools share: `accountAccess` and `gatewayOrigin` for the signed-in account's gateway calls, `sessionFiles` for the folders a call's files live in, `pathWithin`, `windowPath`, `pathFolder`, and `pathName` for where a path lies, `statOf`, `namedFileSize`, `replaceableFile`, and `writeWhole` for the files a call reads and writes, `textBlocks`, `kilobytes`, `folderRows`, `ATTACHED_IMAGE_SCHEMA`, and `modelSeesImages` for tool results, `checkedInteger` for arguments, `stateChanges` for a stream that wakes on each change, and `projectMcpTool`, `callFolder`, and `PROJECT_PARAMETER` for the tools that a connected agent calls with a game project's folder. The kit imports only Node built-ins and types, so a plugin that keeps this package among its dev dependencies bundles the kit without this plugin's server and the MCP SDK; [`tests/kit.spec.ts`](tests/kit.spec.ts) checks its imports. The package's main entry does not export the kit.

### Long calls

A tool call may run for minutes, as a release that uploads a large build does. The response to every request is an event stream that starts as soon as the request arrives and carries a keep-alive comment every 15 seconds, so an agent that waits a fixed time for a response to begin keeps waiting: Claude Code gives up on an HTTP MCP request whose response has not begun after 60 seconds, with `The operation timed out.`. While a call runs, an agent that asked for progress, as Claude Code does, gets a progress notification every `progressIntervalMs` whose message gives the time so far, so an agent that gives up on a call that reports nothing, as Claude Code does after 5 minutes, keeps waiting too. Codex limits each call to its `tool_timeout_sec`, which the Codex entry of the setup prompt sets.

<a id="confirmation-pages"></a>
### Confirmation pages

A call whose tool names a confirmation page, such as a game server purchase that the user confirms on the WASD Engine site, reaches an agent whose client declared URL-mode elicitation (`elicitation.url`) on the 2026-07-28 revision as an input-required result with the page and what to confirm. The client shows the page to the user and retries the call; the retry returns the call's content with a line that says how the user answered, without running the tool again. Every other client gets the content alone, which names the page, because the 2025 revisions, served statelessly, carry no client capabilities with a call. The content travels in the opaque `requestState`, sealed with a key of the server process, bound to `tools/call` and the calling agent, and valid for 30 minutes; a changed state is refused.

<a id="free-accounts-whose-usage-is-used-up"></a>
### Free accounts whose usage is used up

Four providers' tools spend the AI usage of the WASD Engine account: ElevenLabs, Nano Banana, the graphics review, and the art references, whose web searches the account service prices, mark themselves with `spendsUsage`. When a call of one of them fails with a message that says the usage limit was reached, the server reads the account's plan and usage through the account plugin's balance, which the WASD Engine account service reports with `plan` and `used_up`. For a Free account whose usage is used up, the server puts a choice to the user in place of the failure ([`src/free-plan.ts`](src/free-plan.ts)): upgrade to Pro on the account service's `/upgrade?plan=pro` page, which goes on to Pro's checkout, or stay on Free, where WASD Engine keeps working but the quality of generated audio, video, 3D models, animations, and graphics decreases. A client that declared URL-mode elicitation on the 2026-07-28 revision shows the page with that warning, as it shows a [confirmation page](#confirmation-pages): declining it keeps the user on Free, and the retry tells the agent only that the tool is not available now; opening the page, or dismissing it, keeps the tools. Every other client gets a text that the agent passes on to the user with the page, and the user stays on Free unless they upgrade. A paid plan's used-up usage, and every other failure, stay as they are.

While the user stays on Free, the server offers connected agents none of those providers: their tools leave `tools/list`, `search_game_tools`, and the overview and guides of the instructions, a call by name finds no such tool, and nothing tells the agent why. The choice lasts until the usage refreshes, as the account service reports, and is kept in `<dataRoot>/free-plan.json`, so it outlives a restart. While it holds, a request reads the account again once the last reading is a minute old, and a reading with usage left, as after an upgrade or new credits, ends the choice, so the tools return; once the usage is used up again, the user is asked again. A Session's own agent is not affected.

MCP has no message that changes the instructions an agent received when it connected: it sends them once, in the answer to `initialize` or `server/discover`. So the server remembers, for each agent, whether those providers were off when the agent last received the instructions or a note, and the first tool result an agent gets after they turned off, or on again, ends with a note, once: `Note: WASD Engine turned off these game tools for now: <title> (<id>_*), …. Do not call them, even where the server instructions or a guide name them; use WASD Engine's other game tools instead.`, or that they are available again, through `call_game_tool` when the agent's tool list lacks them. Neither says why. An agent the server has not seen receive the instructions, as after WASD Engine restarted, is taken to have received them with the providers on.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The listener binds `127.0.0.1` only. Each request must name the endpoint path, pass the MCP SDK's localhost Host and Origin checks, which stop DNS rebinding and cross-site requests from browser pages, and carry the token, which a constant-time comparison checks; other requests get 404, 403, or 401 from their headers alone, before any of their body is read. An admitted request's POST body is read within 4 MiB. When another program holds the configured port, the server does not listen on another one, which a setup prompt would name only until the next start; it creates a new token, so a program that received the old one from an agent cannot use it once the server runs again, and its view asks the user to quit that program, restart WASD Engine, and set agents up again. An admitted request is counted among the agents seen at once and then waits for the composition, as [server instructions](#server-instructions) describes, through the Loader service's `await()`, read with `ctx.get('loader')`. The MCP SDK's `createMcpHandler` serves the 2026-07-28 protocol revision and, statelessly, the 2025 revisions, from one low-level MCP server per request, whose tool list and instructions come from the catalog at that moment; tool list changes reach agents that subscribed through `subscriptions/listen`.

Stateless serving keeps no connection, so the server names each request's agent itself: from the client information of a 2026-07-28 request envelope, from the client information of an earlier `initialize` request with the same User-Agent, from the User-Agent's product, or as a generic agent. The agent's name titles nothing in the Session list; the setup panel shows the agents seen since the Host started.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `GameMcpServer`: Config, the provider registry, the listener lifecycle, the request checks, the wait for the composition, and the `gameMcp.watch` stream |
| [`src/http.ts`](src/http.ts) | Loopback listener and the conversion between Node requests and web-standard requests and responses |
| [`src/server.ts`](src/server.ts) | The MCP handler, the `tools/list` and `tools/call` handlers, and the confirmation pages' URL elicitation |
| [`src/catalog.ts`](src/catalog.ts) | Tool collection, listing, search with a plugin's guide, the instructions and their overview, and running one call |
| [`src/projects.ts`](src/projects.ts) | `create_game_project`: its arguments, the default location, and the creation through `gameProjectController` |
| [`src/clients.ts`](src/clients.ts) | Agent identities and the agents seen |
| [`src/sessions.ts`](src/sessions.ts) | The connected agents' Sessions and `sessions.json` |
| [`src/kit.ts`](src/kit.ts), [`src/plugin-kit.ts`](src/plugin-kit.ts), [`src/project-tools.ts`](src/project-tools.ts) | The `/kit` entry for game tool plugins: gateway access, call files, result parts, and the tools that take a game project's folder |
| [`src/temporary-folders.ts`](src/temporary-folders.ts) | The default temporary folders and whether a path is in one |
| [`src/token.ts`](src/token.ts), [`src/prompt.ts`](src/prompt.ts) | The token file and check, and the setup prompt |
| [`src/provider.ts`](src/provider.ts), [`src/types.ts`](src/types.ts) | The provider contract with the `game-mcp/tool-result` and `game-mcp/project-created` events, the browser-safe view types, and the `game-mcp/reveal` event |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the tools the server offers, the setup and the account features that host it, and the protocol.

- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#mcp-server-for-other-agents) — how the server connects the game tools, the Sessions, and the window.
- [Godot package](../godot/README.md) — the Godot tools and the Game tab.
- [app-mcp](../app-mcp/README.md) — the Blender, GIMP, and SuperCollider servers whose tools the server forwards.
- [ui-game-mcp](../ui-game-mcp/README.md) — Set up with another agent and the window's opening of connected agents' Sessions.
- [ui-settings-account](../../client/ui-settings-account/README.md) — the required sign-in and the Desktop introduction's last step.
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol and its Streamable HTTP transport.

-----

<a id="model-experience"></a>
## Model Experience

### The Session's own agent

#### What the model sees

Nothing: the package registers no tool and no system-prompt text in the harness.

#### Token effect

Zero direct tokens.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

### Connected agents' tool list and instructions

#### What the model sees

A connected agent's model sees `search_game_tools`, `call_game_tool`, `create_game_project`, and every provider tool with the description and input schema that [`src/catalog.ts`](src/catalog.ts) lists, which for the Godot tools are the Session's own tool descriptions with the wording for absolute project paths, and for the Blender, GIMP, and SuperCollider tools their servers' own with `session` and `project` added, and the server instructions: an overview of why to use the tools, where the guides are, what to tell the user about skipped tools and add-ons, and what each plugin adds, then each plugin's guide under `## <title>`. The agent's own harness decides how it presents them.

#### Token effect

With all fourteen providers of the Web and Desktop profiles, Godot, Blender, GIMP, SuperCollider, Poly Haven, ElevenLabs, Nano Banana, the asset tools, the audio tools, the art references, the graphics review, the feedback tool, the game add-ons, and WASD Engine Plugins, the instructions come to about 33,200 characters, about 4,100 of them the overview and 6,000 the Blender guide, the largest, and the 92 tool declarations to about 133,800 characters of JSON, about 12,600 of them the `session` and `project` arguments of the 40 Blender, GIMP, and SuperCollider tools. Claude Code passes its model the first 4,096 characters of the instructions, the overview and the start of the first guide; the agent's harness decides how much of the rest enters its requests.

#### KV Cache effect

The list and the instructions are identical while the providers and their tools stay the same; a provider whose tools appear later, such as Blender after its MCP server started, changes the list, and agents that subscribed hear of the change.

### Connected agents' tool results

#### What the model sees

A provider tool's result is its rendered text and, for Godot screenshots, Poly Haven previews, the asset tools' pictures, the audio review's waveform and spectrogram picture when a call asks for it, the reference tools' contact sheets and saved references, and the images that the Blender, GIMP, and SuperCollider servers send, its images. A failure becomes an error result with the error's message, such as `Pass project: the absolute path of the folder that holds project.godot.`. `search_game_tools` returns the plugin lines, the guide of a plugin searched without a query, and the tool list as text. `create_game_project` returns a sentence that names the new game project and its folder, one that says whether the folder holds a Git repository, the request to plan the game around the plugins that `search_game_tools` lists and to read the guide of each one the agent will use, the request to make the game there and to write its `project.godot` before installing add-ons, how to pass the folder to the game tools, whose Blender, GIMP, and SuperCollider tools take `project` only together with `session`, and, after a call that named no `model`, the request to pass the name of the AI model the agent is to `godot_run`, followed, when `newGameGuidance` is set, by that text after a blank line, which WASD Engine's row sets to the instructions of its recommended prompt for building games; a refused name gets the text of the Host's reason, such as `"con.txt" is not a folder name that every computer accepts: Windows reserves CON, PRN, AUX, NUL, COM0 to COM9, COM¹, COM², COM³, LPT0 to LPT9, LPT¹, LPT², and LPT³ for devices, with or without an extension. Pass another name.`, and a `location` in a temporary folder gets `<location> is in a temporary folder, whose files the system may delete, so WASD Engine creates no game project there.` with what to do instead. While WASD Engine is signed out, every call returns the error result `WASD Engine is signed out, and its game tools need a signed-in user. Ask the user to open WASD Engine and sign in, then call the tool again.` For a Free account whose usage is used up, a failed call of a tool that spends that usage returns `This tool is not available now. Go on with the work using WASD Engine's other game tools.` once the user declines the page that upgrades the account, or, from a client that shows no pages, a text that asks the agent to pass the offer on to the user with the page. The first result an agent gets after those providers turned off, or on again, ends with a note that names them.

#### Token effect

Text beyond 100,000 characters is cut with `[output truncated: <n> more characters]`; Godot screenshots are PNG images whose longest edge is at most 1,568 pixels and whose area is at most 1,150,000 pixels unless the call asks for less. The shipped `newGameGuidance` adds 476 characters, about 110 tokens, to the result of each created project.

#### KV Cache effect

Append-only in the agent's conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the server serves and to whom; they are current package constraints.

- **Local agents only** — the endpoint binds loopback, so an agent on another computer cannot reach it, and agents in sandboxes without loopback network access cannot either.
- **Full trust** — a holder of the token can run Python in Blender and GIMP and sclang code in SuperCollider, evaluate expressions in games, and run games, with the user's permissions and without approval in WASD Engine; agents ask for approval under their own rules. The prompt carries the token, so the user should paste it only into agents on this computer.
- **One port** — a second Host, such as `dsh web` beside the Desktop app, finds the port taken and listens on a free one, whose URL only the setup of that Host shows.
- **Blank Sessions** — a connected agent's Session has no turns, so the Session list names it New Session, New Session in its game project opens it, and while no provider is signed in, the Get started dialog opens over it when the window shows it.
- **New folders only** — `create_game_project` creates a new folder; an existing folder outside the temporary folders becomes a game project when a game tool call first names it, together with the calling agent's Session. The new project does not become the default project of later Godot calls, which keep the agent's previous project until a call passes `project`.
- **Guidance with new projects only** — the new game guidance reaches an agent in the result of `create_game_project`, so an agent that makes a game in a folder that it or the user created another way gets none, and the agent weighs the guidance as text from a tool, below its user's own instructions.
- **Temporary by place** — the server tells throwaway work by where it is: a folder that an agent keeps elsewhere still becomes a game project, and a game that the user keeps in a temporary folder becomes one only when the user adds it. A Session outside every game project leaves the Session list once another Session is open, and its header shows none of the Add-ons, Export / Share, and Multiplayer buttons, which act on a game project.
- **No transcript** — the connected agent's tool calls appear in its own harness, not in the Session; the Session shows its game in the Game tab.
- **Instructions cut by harnesses** — Claude Code passes its model only the first 4,096 characters of the instructions, so the guides after the overview reach it only through `search_game_tools`, and the overview has to fit: with the fourteen shipped providers it comes to about 4,070 characters, which leaves about 25 for a new provider's line, and the server warns when a registration makes it longer. A longer overview loses the end of the plugin list, which comes last.
- **Startup wait** — an agent that connects while WASD Engine starts waits for the plugins to load, at most `readyTimeoutMs`; a plugin that loads later is missing from that agent's overview, which MCP sends once, and reaches the agent through its tools' `tools/list_changed` and `search_game_tools`.
- **Stateless serving** — two instances of the same agent share its Session, its project default, and its game per project unless their Godot calls give different `session` names, and their calls of the Blender, GIMP, and SuperCollider tools that give no `session` share one worker of each.
- **Cancellation from 2025 clients** — a client on a 2025 revision cancels with a `notifications/cancelled` request, which reaches a server of its own and no running call, so the call ends only when its request closes or its tool's time limit passes.
- **Free choice and instructions** — after the user chose to stay on Free, the instructions that an agent received when it connected keep the lines and guides of the providers that spend usage, and only a note in its next tool result says they are off; their tools leave its list, and its calls of them find no tool. The server tells each agent identity once, so of two instances of one agent, such as two Claude Code sessions, only the one that calls first gets the note. Other providers' guides and descriptions may still name those tools, as SuperCollider's description names ElevenLabs.
- **Confirmation pages per process** — the key that seals a confirmation's state lives in the server process, so a retry after the Host restarted is refused; the page the client showed still works, and the tool that named it can list what waits for confirmation, as `wasd_server_status` does.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Godot provider builds its tool definitions with the same `godotToolDefinitions` as the Session's own tools, so a change to a Godot tool reaches connected agents without a change here.

After a change to the new game guidance, [`game-mcp-live-agents.e2e.ts`](../../../apps/web/tests/game-mcp-live-agents.e2e.ts) checks it with the Claude Code installed and signed in on the computer, at the cost of its own usage: `WASD_LIVE_AGENTS=claude pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/game-mcp-live-agents.e2e.ts`, after `pnpm run build`, and again with `WASD_LIVE_AGENTS_GUIDANCE=off` to compare the plans.

</details>
