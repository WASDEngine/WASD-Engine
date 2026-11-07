---
description: "Browser half of WASD Engine's MCP server, for maintainers changing the sign-in dialog's Set up with another agent panel, its setup prompt and connection state, or how the window opens the Session whose game a connected agent starts."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-mcp

English | [中文](README.zh.md)

## Summary

Set up Claude Code, Codex, or another agent on this computer to use WASD Engine's game tools. The sign-in dialog of the Get started step and of the account menu offers Set up with another agent below Sign in; the offer opens a panel with the prompt to paste into the agent, a Copy prompt button, and whether an agent connected. When a connected agent starts its game, the window opens the agent's Session, so the game plays here. The Host half, [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md), serves the tools and writes the prompt.

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

Open the sign-in dialog, from the Get started step or from the account menu, and select **Set up with another agent**. Copy the prompt, paste it into the other agent, and follow what the agent asks, such as restarting it.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts this row after the `game-mcp` row into every Web and Desktop profile:

```yaml
- id: ui-game-mcp
  name: '@deepseek-ai/dsh-client-ui-game-mcp'
```

The row takes no configuration, and its Host half does nothing: the row exists so that the Host serves the browser half. The browser half mounts the `gameMcp` Remote of `@deepseek-ai/dsh-game-mcp` itself, fills the alternative slots of [`ui-settings-account`](../../client/ui-settings-account/README.md), and opens Sessions through `uiWorkspace`. A profile patch entry `- id: ui-game-mcp` with `disabled: true` removes the offer and the window's opening of Sessions and leaves the server running.

### The setup panel

The offer is one button below Sign in. It opens a panel with the setup prompt, a Copy prompt button, and the server's state: starting, waiting for an agent, the name of the agent that connected, the reason the server does not run, or a lost connection to the Host. Back to sign in returns to the dialog; once an agent connected, Done closes it. When the host refuses the clipboard, as an embedded browser does, the button selects the prompt so the user can copy it with the keyboard.

The offer and the panel exist only while the Peer may call `gameMcp/watch`, which LiveShare keeps for the owner. The panel reads the server's view through `gameMcp.watch` while it shows and reopens the stream after a break, waiting 1 second at first and up to 30 seconds.

### Games of connected agents

When a connected agent starts its game, the Host emits `game-mcp/reveal` with the agent's Session. Every window that may read the Session opens it, and the Session's Game tab opens for the run, as it does for any run an agent starts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin mounts the generated `gameMcp` Remote contribution first and withdraws it last. In a scope that waits for `remote.gameMcp`, it registers its dictionaries and the `game-mcp/reveal` subscription, and, while the Peer may call `gameMcp/watch`, one registration of the panel component into each alternative slot through `ctx.slots.inject()`. The panel's view stream opens on its first subscriber and closes with its last, so no Remote call runs while the dialog is closed.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Empty Host `apply` of the Loader row |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry that mounts the Remote, then the UI |
| [`src/client/mount.ts`](src/client/mount.ts) | Dictionaries, the reveal subscription, and the slot registrations |
| [`src/client/source.ts`](src/client/source.ts) | The view stream and its reopening |
| [`src/client/AgentSetup.tsx`](src/client/AgentSetup.tsx), [`src/client/AgentSetup.module.css`](src/client/AgentSetup.module.css) | The offer and the panel |
| [`src/client/locales.ts`](src/client/locales.ts) | `gameMcp` dictionaries in eight languages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the server that writes the prompt, the dialog that holds the panel, and the Game tab.

- [game-mcp](../game-mcp/README.md) — the server, its token, its tools, and the Sessions of connected agents.
- [ui-settings-account](../../client/ui-settings-account/README.md) — the sign-in dialog and its alternative slots.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#mcp-server-for-other-agents) — how the server connects the game tools, the Sessions, and the window.
- [Godot package](../godot/README.md) — the Game tab that shows a connected agent's game.

-----

<a id="model-experience"></a>
## Model Experience

### The setup panel and the window

#### What the model sees

Nothing. The panel and the `game-mcp/reveal` subscription add no Session event, prompt text, or tool; the user pastes the prompt into another agent, whose harness owns what its model sees, as [game-mcp](../game-mcp/README.md#model-experience) describes.

#### Token effect

Zero direct tokens.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the panel shows and which windows follow a connected agent; they are current package constraints.

- **Every window follows** — each window that may read a connected agent's Session opens it when the agent starts its game, including a window where the user works in another Session.
- **Agents seen since start** — the panel names an agent once it called the server since the Host started; an agent that was set up earlier but has not called yet shows as waiting.
- **Sign-in dialog only** — the panel lives in the sign-in dialog; once an account is signed in, the account menu offers Sign out instead of Sign in, so the panel is out of reach until the user signs out.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
