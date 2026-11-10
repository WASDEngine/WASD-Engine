---
description: "Browser half of WASD Engine's MCP server, for maintainers changing Set up with another agent, the Desktop introduction's last step and the Other agents section of Settings, with its agents' logos, setup prompt, and connection state, or how the window opens the Session whose game a connected agent starts."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-mcp

English | [中文](README.zh.md)

## Summary

Set up Claude Code, Codex, or another agent on this computer to use WASD Engine's game tools. After sign-in, Set up with another agent is the last step of the Desktop introduction, and Settings keeps it as Other agents: the logos of the AI agents that connect, the prompt to paste into the agent, and whether an agent connected. When a connected agent starts its game, the window opens the agent's Session, so the game plays here. The Host half, [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md), serves the tools to signed-in users and writes the prompt.

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

Sign in to WASD Engine. In the Desktop app, the introduction that follows sign-in ends with **Set up with another agent**; later, open **Settings → Other agents**. Copy the prompt, paste it into the other agent, and follow what the agent asks, such as restarting it.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts this row after the `game-mcp` row into every Web and Desktop profile:

```yaml
- id: ui-game-mcp
  name: '@deepseek-ai/dsh-client-ui-game-mcp'
```

The row takes no configuration, and its Host half does nothing: the row exists so that the Host serves the browser half. The browser half mounts the `gameMcp` Remote of `@deepseek-ai/dsh-game-mcp` itself, fills the introduction's `settings.account.onboarding.agents` step of [`ui-settings-account`](../../client/ui-settings-account/README.md), adds the `other-agents` section to Settings, and opens Sessions through `uiWorkspace`. A profile patch entry `- id: ui-game-mcp` with `disabled: true` removes the step, the section, and the window's opening of Sessions, and leaves the server running.

### The setup

The step and the section show the same setup: the logos of ChatGPT, Claude, Gemini, Grok, MiniMax, DeepSeek, Kimi, and GLM on white tiles, in the website's order, the setup prompt, a Copy prompt button, and the server's state: starting, waiting for an agent, the name of the agent that connected, the reason the server does not run, or a lost connection to the Host. When the host refuses the clipboard, as an embedded browser does, the button selects the prompt so the user can copy it with the keyboard. The step takes the introduction's heading and classes, and its Continue finishes the introduction whether or not an agent connected; the introduction's Back returns to the choice before it.

The step and the section exist only while the Peer may call `gameMcp/watch`, which LiveShare keeps for the owner. They read the server's view through `gameMcp.watch` while they show and reopen the stream after a break, waiting 1 second at first and up to 30 seconds. Each logo file in `src/client/assets/` names its trademark owner and source.

### Games of connected agents

When a connected agent starts its game, the Host emits `game-mcp/reveal` with the agent's Session. Every window that may read the Session opens it, and the Session's Game tab opens for the run, as it does for any run an agent starts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin mounts the generated `gameMcp` Remote contribution first and withdraws it last. In a scope that waits for `remote.gameMcp`, it registers its dictionaries and the `game-mcp/reveal` subscription, and, while the Peer may call `gameMcp/watch`, `AgentSetupStep` into `settings.account.onboarding.agents`, and `AgentSetupSection` into `settings.section` with `AgentSetupIcon`, a link, as its navigation icon, through `ctx.slots.inject()`. The introduction declares its step's slot only in the Desktop app, so the Web UI has the section alone. The view stream opens on its first subscriber and closes with its last, so no Remote call runs while neither shows.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Empty Host `apply` of the Loader row |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry that mounts the Remote, then the UI |
| [`src/client/mount.ts`](src/client/mount.ts) | Dictionaries, the reveal subscription, and the slot registrations |
| [`src/client/source.ts`](src/client/source.ts) | The view stream and its reopening |
| [`src/client/AgentSetup.tsx`](src/client/AgentSetup.tsx), [`src/client/AgentSetup.module.css`](src/client/AgentSetup.module.css) | The agents' logos, the prompt box, the step, and the section |
| [`src/client/assets/`](src/client/assets/) | The agents' logos |
| [`src/client/locales.ts`](src/client/locales.ts) | `gameMcp` dictionaries in eight languages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the server that writes the prompt, the introduction that holds the step, and the Game tab.

- [game-mcp](../game-mcp/README.md) — the server, its token, its tools, and the Sessions of connected agents.
- [ui-settings-account](../../client/ui-settings-account/README.md) — the required sign-in and the Desktop introduction with its last step.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#mcp-server-for-other-agents) — how the server connects the game tools, the Sessions, and the window.
- [Godot package](../godot/README.md) — the Game tab that shows a connected agent's game.

-----

<a id="model-experience"></a>
## Model Experience

### The setup and the window

#### What the model sees

Nothing. The setup and the `game-mcp/reveal` subscription add no Session event, prompt text, or tool; the user pastes the prompt into another agent, whose harness owns what its model sees, as [game-mcp](../game-mcp/README.md#model-experience) describes.

#### Token effect

Zero direct tokens.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the setup shows and which windows follow a connected agent; they are current package constraints.

- **Every window follows** — each window that may read a connected agent's Session opens it when the agent starts its game, including a window where the user works in another Session.
- **Agents seen since start** — the setup names an agent once it called the server since the Host started; an agent that was set up earlier but has not called yet shows as waiting.
- **Logos, not a list of supported agents** — the logos name AI products whose agents can connect over MCP; any agent with an MCP client connects, and the prompt gives commands for Claude Code and Codex only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
