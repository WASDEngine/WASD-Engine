---
description: "The new game guidance plugin, which ends the user's first prompt for a new game with the deployment's guidance as its own logged message, for users and maintainers choosing, configuring, or debugging it."
kind: "package-reference"
---

# @deepseek-ai/dsh-new-game-guidance

English | [中文](README.zh.md)

## Summary

This package gives the agent guidance when the user starts a new game. When the user's first prompt in a top-level Session enters a step while the project folder holds only hidden entries and system files, the plugin adds the configured text as its own message right after the prompt. Later prompts, folders that hold files, and subagent Sessions get none. The `gamedev` preset ships four lines asking for great looks, motion, and sound, lifelike people, a believable world, and autonomous, self-tested work; WASD Engine Plugins' browser half leaves the message out of Chat.

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

Mount this plugin in an agent preset. It needs the `sessionProjections` service and an `fs` filesystem that can list the Session's project folder; the shipped Web and Desktop compositions provide both.

### When to choose it

Choose it when the first build of a new game should follow standards that the user would otherwise have to type, such as quality targets or working without questions, and the deployment wants them in the user's own turn rather than in the system prompt, where they would apply to every request. Avoid it for guidance that should hold for the whole Session: the text reaches the model once, after the first prompt.

### Configure it

```yaml
- id: new-game-guidance
  name: '@deepseek-ai/dsh-new-game-guidance'
  config:
    text: |-
      * Put your effort into making what's on screen look, move and sound great
      * Work autonomously without asking me questions
```

| Field | Default | Meaning |
|---|---|---|
| `text` | required | The guidance, exactly as the model reads it after the first prompt |

A missing value fails at load, and so does text that is only whitespace. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-new-game-guidance) documents the accepted field.

### When the guidance is added

The plugin acts when a step's messages include a message from the user, one whose source kind is `user`, in a top-level Session whose log holds no earlier message from the user, inherited history of a forked Session included. It then lists the Session's project folder, the `cwd` its header records. When every entry is hidden, its name starting with `.`, or is one of the system files `Thumbs.db` and `desktop.ini`, the game is new, and the guidance enters right after the last message from the user in the step, ahead of the context that other plugins add to the step, such as workspace instructions and the clock. A folder that cannot be listed, a Session without a folder, and a folder that holds any other file or folder get no guidance.

The guidance is a `user/message` whose source is `{ kind: 'new-game-guidance' }`, with no form, so the Session log keeps it like the prompt and every later request repeats it as history. Only the first prompt gets it: once the log holds a message from the user, later prompts get none, even after the folder is emptied again. A first turn that a notice or another producer starts, with no message from the user, adds none and leaves the guidance for the user's first prompt, and a step that another listener rejects logs neither the prompt nor the guidance.

Conversation views show a message of this source as opaque context unless a client plugin claims it. In WASD Engine, WASD Engine Plugins' browser half claims it on the Chat target and builds no node for it, so Chat shows the prompt as the user wrote it; the Trajectory view, which lists every message the model received, still lists it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the plugin decides to add the guidance and where it puts it; the observable behavior is covered in [Use this package](#use-this-package).

### Design

- **Plugin, not loop change.** The plugin listens on `agent/pre-step`, the waterfall in which listeners accept, rewrite, or reject the messages a step claims. It delegates first, so later listeners may still reject or rewrite the step, and adds the guidance only to an `enter` decision, keeping its other fields.
- **Right after the prompt.** The listener registers with `prepend: true`, so it runs around the listeners that add other context to the step, such as `agent-instructions` and `time-context`, and inserts the guidance right after the last message from the user in their combined decision.
- **State from the log.** A host-only Session projection, `newGameGuidancePrompted`, folds whether the log holds a message from the user. Projections fold restored and inherited events, so a resumed or forked Session reads the same answer.
- **The folder through the filesystem service.** The listener resolves and lists the header's `cwd` through `ctx.fs`, the service through which the workspace file Remote lists folders for the first build tip of WASD Engine Plugins, so both agree on what a new game is. A listing that fails counts as finding something; a cancelled step throws its reason.
- **Logged.** The guidance enters as an ordinary `user/message`, so every model-visible input is reconstructable from the log. The persistence change `2026-11-18-new-game-guidance-source` acknowledges the new source kind.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the projection, the folder check, and the `agent/pre-step` listener |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Agent lifecycle](../../../docs/agent-lifecycle.md) — where `agent/pre-step` runs in a turn.
- [WASD Engine Plugins](../wasd-plugins/README.md) — the first build tip, which reads the same empty folder, and the Chat Definition that leaves the guidance out.
- [Game development group](../README.md) — the other fork-owned packages.

-----

<a id="model-experience"></a>
## Model Experience

### Guidance context message

#### What the model sees

Right after the user's first prompt for a new game, the model receives the configured text as the next user-role message; routes that join consecutive user messages send it in the same user turn as the prompt. The `gamedev` preset ships these lines.

##### Guidance

```markdown
* Put your effort into making what's on screen look, move and sound great
* People and humanoid figures should look and move like real people, with fitting animations
* The environment should be believable, textured, with lighting that sells the mood
* Work autonomously without asking me questions. Run and play the demo yourself and fix anything that looks or plays wrong before you finish
```

#### Token effect

Zero tokens in a Session that does not start a new game. A new game's Session carries the text once as retained history, under 100 tokens for the shipped lines.

#### KV Cache effect

Append-only; the guidance enters with the first prompt and stays in place, so it does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Any first prompt in an empty folder** — the plugin cannot tell a request to make a game from a question, so a first prompt such as "how do I export a game?" in an empty project folder also gets the guidance.
- **Only the folder decides what is new** — a game whose files live outside the Session's folder does not count as new, and an empty folder that the user opens for something other than a game does.
- **Connected agents get it elsewhere** — agents that use WASD Engine's tools over MCP take their prompts in their own application, so the plugin never sees them; the game MCP server ends the result of [`create_game_project`](../game-mcp/README.md#create-game-projects) with the same lines instead, without the request to work without asking questions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
