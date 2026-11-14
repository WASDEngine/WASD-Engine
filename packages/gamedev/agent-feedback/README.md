---
description: "What agents tell the WASD Engine team: the feedback_send tool of every Session and of WASD Engine's MCP server, which sends feedback about WASD Engine, and the usage report of how often agents call each game tool and each MCP server the user added, both sent to the WASD Engine site for the signed-in account."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-feedback

English | [中文](README.zh.md)

## Summary

The agent feedback plugin lets agents tell the WASD Engine team what gets in their way. Its `feedback_send` tool sends feedback about WASD Engine: a bug, a missing feature, something confusing, or a suggestion. Sessions and agents connected through WASD Engine's MCP server, such as Claude Code, get the tool. The plugin also counts how often agents call each MCP tool, of WASD Engine's game tools and of MCP servers the user added, and reports the counts every minute. Both go to the WASD Engine site for the signed-in account.

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

The WASDEngine overlay [`telemetry.cordis.patch.yml`](../../bundle/web-app/wasdengine/telemetry.cordis.patch.yml) inserts the row `agent-feedback` into every Web and Desktop profile, with the version the Desktop app sets for its Host:

```yaml
- id: agent-feedback
  name: '@deepseek-ai/dsh-agent-feedback'
  config:
    appVersion: !!js process.env.DSH_CLIENT_VERSION ?? ''
```

The Plugins page lists the row as Agent feedback, and its switch turns it off with `- id: agent-feedback` and `disabled: true` in the profile patch, which stops both the tool and the usage report. The plugin needs the `tools` service. Each request reads the account's site and token from the `deepseekAccount` service's `getPlatformSession()`, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) the plugin offers its tool to connected agents and counts their calls.

| Field | Default | Meaning |
|---|---|---|
| `usageReports` | `true` | Count the agents' MCP tool calls and report them; `false` counts nothing |
| `reportIntervalMs` | `60000` | Time between two usage reports; a report is sent only when calls were counted since the last one |
| `requestTimeoutMs` | `15000` | Time limit of one request to the site |
| `finalReportTimeoutMs` | `3000` | Time limit of the last usage report, sent as the plugin stops, such as when the app quits |
| `appVersion` | empty | The app's version, which feedback names; a version the site would refuse is logged and left out |

### The feedback tool

`feedback_send` takes `kind`, one of `bug`, `missing_feature`, `confusing`, and `suggestion`; `message`, at most 4,000 characters, which keeps its lines; and `about`, the tool or part of WASD Engine it concerns, at most 120 characters. A call posts one JSON object to `POST /api/v1/feedback` on the site's origin with the account token in `x-dsh-auth-token`: the three arguments trimmed, the agent, the model, the app version, and the operating system as Node names it, such as `darwin`. A Session's call names WASD Engine's own agent, `wasd-engine`, and the display name of the model the Session runs on, as the model service describes it, else the model's id.

Agents connected through WASD Engine's MCP server reach the tool under the provider `feedback`, titled Feedback, without a Session. Their listing adds `model`, the name of the AI model the agent is, and leaves out `agent_id` and `agent_title`, which the provider's `prepare` sets from the client the server identified, such as `claude-code` and Claude Code, over whatever the call passed. The server refuses every call while WASD Engine is signed out.

A result is one sentence: what was sent, and that the team reads it but does not reply. A call that sends nothing says why and what to do: an argument out of range, a signed-out app, a sign-in the site no longer takes, the site's own message for a refusal such as too much feedback in a day, or a site that did not answer.

### The usage report

The plugin counts every finished tool call of a Session's agent and every call that WASD Engine's MCP server reports through `game-mcp/tool-result`. A Session's call counts when `gameMcp.toolOwner()` finds a provider that offers the tool, under that provider and the tool's name for connected agents, so a Session's `mcp__wasd_blender__execute_python` counts as Blender's `blender_execute_python`; a tool named `mcp__<server>__<tool>` that no provider offers counts under that server as one the user added. Every other tool, such as reading a file, counts nothing. A connected agent's call counts under its provider and its client.

Each count is one key, who called which tool of which server, with its calls and failed calls. A cancelled call is no failure, and a call cancelled before its tool ran counts nothing. Every `reportIntervalMs` the plugin posts the counts to `POST /api/v1/tool-usage`, and once more as it stops. Counts that the site may take later stay for the next report: while signed out, without a network, or when the site answers 401, 429, or 5xx. Counts the site refuses as they are, such as for an account on the waitlist, are dropped. One report holds at most 500 keys, the most the site takes, and calls of further tools are left uncounted until a report is sent; the plugin logs it once each time.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Requests go to the origin of `getPlatformSession()`, the account sign-in's `platformOrigin`, never follow redirects, and end after `requestTimeoutMs`. A usage report's body is `{ calls: [{ connected, agent, agent_title, custom, server, server_title, tool, calls, errors }] }`. Reports never overlap: each waits for the one before it, so the last report as the plugin stops first ends the report on its way, whose counts come back, and then sends them all. The timer and the last report run in a fiber that injects `deepseekAccount` and reads the sign-in through that injected service: as a dependent of the sign-in, the fiber stops before the sign-in does when the whole Host stops, and the injected service still answers during its teardown, when `ctx.get()` no longer finds it.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the account's site, tool registration, the game MCP provider, and the usage report's listeners and timer |
| [`src/api.ts`](src/api.ts) | The site client and its wording for feedback it did not send |
| [`src/tools.ts`](src/tools.ts) | The tool definitions of the two surfaces, argument checks, and result text |
| [`src/mcp.ts`](src/mcp.ts) | The tool for connected agents, its offered schema, and the provider's instructions |
| [`src/usage.ts`](src/usage.ts) | Which calls count, and the counts between two reports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the MCP server that offers the tool to other agents, and the site that receives the reports.

- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer, and `toolOwner`.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#agent-feedback) — how the row connects to the game tools and the MCP server.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `feedback_send` with `kind`, `message`, and `about`. The description says to send feedback about WASD Engine itself when it gets in the agent's way, with what each kind means, and when the user asks; to say what was tried, what happened, and what was expected, naming the tools; to send each problem once; to leave out the user's personal information, secrets, and game content beyond what the problem needs; that it is not for problems in the user's own game; and that the team does not reply, so the agent carries on with the user's task. A connected agent sees the same tool with `model`, and the provider's instructions under `## Feedback`.

#### Token effect

The declaration comes to about 1,400 characters of JSON, and about 1,500 with `model` for a connected agent; the provider's instructions add about 500 characters to the MCP server's instructions.

#### KV Cache effect

The declaration is static, so it stays in the cached tool prefix. The usage report adds nothing to any model request.

### Tool results

#### What the model sees

A result is one sentence that names the kind and what it is about, says the team reads it but does not reply, and says to carry on. A failure says why nothing was sent and what to do.

#### Token effect

A result is one sentence.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the plugin offers; they are current package constraints.

- **No reply** — the team reads feedback on the WASD Engine site; nothing reaches the agent or the user afterwards.
- **No approval** — a Session's agent sends feedback without asking the user; the call and its arguments show in the conversation, and a connected agent's own harness may ask its user first.
- **Calls lost on a crash** — counts live in memory until a report is sent, so a crash loses the calls since the last report.
- **No per-call detail** — a report holds names and counts per key, not when each call ran, its arguments, or its duration.
- **Generic conversation rows** — the Web UI shows the tool call in the generic tool row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The site validates every name against its own patterns and refuses a whole report with one invalid entry, so the report sends only names the harness itself produces: provider ids, `mcp__` server names, the game MCP server's client ids, and `wasd-engine`.

</details>
