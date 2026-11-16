---
description: "Graphics review for the agent: graphics_review sends an image of the game's graphics, which the agent captured or made, to a reviewer that critiques it as a game art director and technical artist would and names the WASD Engine tools and add-ons that would make it look better; the reviewer is the WASD Engine account's model route, which the account pays for as for any model call, and a system prompt section asks for exactly three reviews of each piece of graphics work, for every Session and for connected agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-graphics-review

English | [中文](README.zh.md)

## Summary

The graphics review plugin has a reviewer critique the game's graphics. After graphics work, the agent captures the result, for example with `godot_screenshot` and its `path`, and passes the image to `graphics_review` with what it shows and the look the game is going for. The reviewer answers as a game art director would, with notes on how to make the image look better and the WASD Engine tools and add-ons to consider, never a score. The agent reviews each piece of graphics work exactly three times, acting on each review. Connected agents get the same tool.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `graphics-review` into every Web and Desktop profile, with its defaults:

```yaml
- id: graphics-review
  name: '@deepseek-ai/dsh-graphics-review'
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `deepseek-account` | Provider route of the WASD Engine account, whose model reviews each image |
| `model` | Empty | Model of that route; empty picks the first listed model that takes images |
| `maxTokens` | `8192` | Most tokens of one review, reasoning included |
| `timeoutMs` | `240000` | Time limit of one `graphics_review` call |
| `maxImageBytes` | `52428800` | Largest image file read |
| `maxImageEdge` | `1568` | Longest side in pixels of the image sent |
| `maxImagePixels` | `1150000` | Most pixels of the image sent |
| `minImageEdge` | `512` | Longest side in pixels that a smaller image, such as pixel art, is enlarged toward by whole pixels |

The plugin needs the `tools` and `workingDirectory` services, and the `llm` and `attachments` services to review. With the `systemPrompt` service it adds the `graphics-review` section, with the `gameAddons` service of [`@deepseek-ai/dsh-game-addons`](../game-addons/README.md) the reviewer may name every catalog add-on, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers the tool to connected agents. The Plugins page's switch turns the row off.

### The tool

`graphics_review` takes `image`, the path of a PNG, JPEG, or WebP file, relative to the working directory or absolute; `subject`, what the image shows and what it is for; and the optional `goal`, the look the game is going for, and `focus`, what to look at most. `godot_screenshot` and `godot_view` of [`@deepseek-ai/dsh-godot`](../godot/README.md) save their image at a `path` for it; a Blender render, an image from `image_generate`, a texture, or a sprite sheet works too. The tool reads the file within `maxImageBytes`, turns it upright, scales it down to `maxImageEdge` and `maxImagePixels`, and enlarges a smaller image by whole pixels toward `minImageEdge`, so pixel art stays crisp. It saves the image as an attachment and sends one request to the account's route: the reviewer's instructions as the system prompt, and the image with the agent's words as the user message. The reply's text, after any reasoning, is the review. A missing file, a folder, an empty `subject`, and a file that is not a PNG, JPEG, or WebP image fail before any request.

The account pays for each review as for any model call: the WASD Engine gateway prices the tokens and counts them against the account's monthly AI usage. Once that usage is used up, the review fails with the gateway's own message, which names the account page where the user upgrades or turns on auto recharge, and asks the agent to pass it on to the user. Other failures name no model or provider: a missing or rejected sign-in asks the user to sign in, a busy route asks to wait a few seconds, and any other failure asks to try again in a minute.

### Connected agents

Agents connected through WASD Engine's MCP server reach the tool under the provider `graphics`, titled Graphics review, without a Session: `image` must be an absolute path, and the tool is marked read-only. The provider's description in the overview of the server instructions asks the agent to review each piece of graphics work exactly three times, each time with a new image of the result, and to act on each review, and its guide says how.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The model-facing texts call the reviewer a specialized graphics expert reviewer model and never mention its cost; the reviewer is the account's model route with the reviewer's instructions in [`src/prompt.ts`](src/prompt.ts), which list what to look at; WASD Engine's tools in the order the agents prefer them, with a download that suits the game's art style first and generated 2D art before art drawn by hand or in code; the catalog add-ons by id with when each helps; and the form of the reply, notes and the tools and add-ons to consider, with no score, grade, or verdict. The request carries the purpose `graphics-review`, the calling Session's id when the call has one, a temperature of 0.3, and `maxTokens`. A reply that reaches `maxTokens` keeps its text with a note that the review stops there. Sharp loads at the first review.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, tool registration, the system prompt section, and the game MCP provider |
| [`src/tools.ts`](src/tools.ts) | The tool definition, its arguments, and its result |
| [`src/image.ts`](src/image.ts) | Reading, checking, and fitting the image |
| [`src/review.ts`](src/review.ts) | The request to the account's route, the reply, and the failure messages |
| [`src/prompt.ts`](src/prompt.ts) | The system prompt section, the MCP provider's description and guide, and the reviewer's instructions |
| [`src/mcp.ts`](src/mcp.ts) | The tool for connected agents |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the captures the review takes, the tools it suggests, and the MCP server that offers it to other agents.

- [godot](../godot/README.md) — `godot_screenshot` and `godot_view`, which save their image at a `path`.
- [game-addons](../game-addons/README.md) — the catalog the reviewer names add-ons from.
- [art-references](../art-references/README.md) — references gathered before the art that the review judges.
- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

While the Session has `graphics_review`, the `graphics-review` section, under `# Graphics review`, tells the agent that the tool sends an image to a specialized graphics expert reviewer model, which critiques it with notes and names the WASD Engine tools and add-ons to consider, and to review each piece of graphics work exactly three times, no more and no less: capture the result, review it, act on the review, and repeat with a new capture until the work has had three reviews, then act on the third and move on. It says how to capture the image, with `godot_screenshot` or `godot_view` and their `path` while the Session has the Godot tools, what to pass, how to act on a review, and that a failed call does not count, and it ends by stressing that graphics work never ends with fewer than three reviews or gets more than three. As the Web and Desktop profiles compose it, with the Godot tools:

##### The `graphics-review` section

```markdown
# Graphics review

graphics_review sends an image to a specialized graphics expert reviewer model, which critiques it as a game art director and technical artist would and gives notes on how to make it look better, naming the WASD Engine tools and add-ons to consider. Review each piece of graphics work exactly three times, no more and no less: once you change what the player sees, such as a model, texture, sprite, animation, UI, lighting, effect, or level, capture the result and pass it to graphics_review, act on the review, and repeat with a new capture until that work has had three reviews; then act on the third review and move on without a fourth. Capture a game screenshot with godot_screenshot, or a closer look with godot_view, and give path to save it; or pass a render, an image you generated, a texture, or a sprite sheet. Pass subject, what the image shows and what it is for, and goal, the look the game is going for, such as the user's request or the style of its references. To act on a review, make the changes its notes ask for with the tools and add-ons it names. A call that fails does not count as a review. This is very important: never finish graphics work with fewer than three reviews, and never review it more than three times.
```

#### Token effect

The section comes to about 1,250 characters.

#### KV Cache effect

The section changes only when the Godot tools join or leave the Session's tools, so it stays in the cached system prompt.

### Tool declarations

#### What the model sees

`graphics_review` with `image` and `subject`, and the optional `goal` and `focus`. The description says that a specialized graphics expert reviewer model critiques an image of the game's graphics the way a game art director and technical artist would, what it looks at, that it gives notes on how to make the image look better and names the WASD Engine tools and add-ons to consider, to call it exactly three times for each piece of graphics work, each time with a new image of the result, and what the review holds. A connected agent sees the same tool with `image` as an absolute path, the provider's description in the overview of the server instructions, and its guide under `## Graphics review`.

#### Token effect

The declaration comes to about 1,700 characters of JSON; the provider's description adds about 270 characters to the overview of the MCP server's instructions, and its guide about 1,300 characters after it.

#### KV Cache effect

The declaration is static, so it stays in the cached tool prefix.

### Tool results

#### What the model sees

A result is `Graphics review of <path>:` and the review in Markdown: up to eight notes on how to make the image look better, the most important first, each with what to change, where in the image, and how, and the WASD Engine tools and add-ons to consider with what to do with each; it holds no score, grade, or verdict. A failure says what to change: a missing file, a folder, a file that is not a PNG, JPEG, or WebP image, or an empty `subject`; or it passes on the account's used-up AI usage with the page where the user pays, or asks to sign in, wait, or try again.

#### Token effect

A review is up to about 600 words. The request itself, which never enters the conversation, carries the reviewer's instructions, about 4,000 characters plus about 200 per catalog add-on, and the image.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the review offers; they are current package constraints.

- **One still image** — a review judges one frame, so motion, animation timing, and other angles need images of their own, such as frames from `godot_record` or views from `godot_view`.
- **Three reviews by instruction** — the agents' texts ask for exactly three reviews of each piece of graphics work, but the tool keeps no count, and each review sees only its own image, not the earlier reviews of the same work.
- **The account's route only** — the review runs on the WASD Engine account's model route whatever model the Session uses, and fails while WASD Engine is signed out.
- **Generic conversation row** — the Web UI shows the call in the generic tool row; the review is its text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The reviewer's instructions name WASD Engine's tools in words, not by tool name, except for tools whose names connected agents and the Session share, such as `image_generate` and `game_addons`, because the Session calls Blender and GIMP tools as `mcp__wasd_blender__<tool>` and connected agents as `blender_<tool>`.

</details>
