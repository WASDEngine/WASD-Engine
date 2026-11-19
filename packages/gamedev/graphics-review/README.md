---
description: "Graphics review for the agent: graphics_review sends an image of the game's graphics, which the agent captured or made, to a reviewer that critiques it as a game art director and technical artist would and names the WASD Engine tools and add-ons that would make it look better; the reviewer is the WASD Engine account's model route, which the account pays for as for any model call, and a system prompt section asks for one to three reviews of each piece of graphics the agent makes itself and none of downloaded assets, for every Session and for connected agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-graphics-review

English | [中文](README.zh.md)

## Summary

The graphics review plugin has a reviewer critique the game's graphics. After graphics work, the agent captures the result, for example with `godot_screenshot` and its `save` option, and passes the image to `graphics_review` with what it shows and the look the game is going for. The reviewer answers as a game art director would, with notes on how to make the image look better and the WASD Engine tools and add-ons to consider, never a score. Graphics the agent makes get one to three reviews, fewer when one has nothing useful; downloads get none. Connected agents get the same tool.

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
| `maxTokens` | `16384` | Most tokens of one review, reasoning included |
| `reasoningEffort` | `low` | Reasoning effort of each review when the model offers it; otherwise the model's least effort |
| `timeoutMs` | `240000` | Time limit of one `graphics_review` call |
| `maxImageBytes` | `52428800` | Largest image file read |
| `maxImageEdge` | `1568` | Longest side in pixels of the image sent |
| `maxImagePixels` | `1150000` | Most pixels of the image sent |
| `minImagePixels` | `295936` | Fewest pixels of the image sent: a smaller image, such as pixel art, is enlarged by whole pixels toward them, since the route scales a smaller image up by a fraction; the default is the account route's 544×544 |

The plugin needs the `tools` and `workingDirectory` services, and the `llm` and `attachments` services to review. With the `systemPrompt` service it adds the `graphics-review` section, with the `gameAddons` service of [`@deepseek-ai/dsh-game-addons`](../game-addons/README.md) the reviewer may name every catalog add-on, with the `deepseekAccount` service of [`@deepseek-ai/dsh-deepseek-account`](../../credentials/deepseek-account/README.md) a route that lists no model while no one is signed in asks for a sign-in, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers the tool to connected agents. The Plugins page's switch turns the row off.

### The tool

`graphics_review` takes `image`, the path of a PNG, JPEG, or WebP file, relative to the working directory or absolute; `subject`, what the image shows and what it is for; and the optional `goal`, the look the game is going for, `focus`, what to look at most, and `previous`, for a second or third review of the same work: what the agent changed since the last one, and which of its notes it left and why. `godot_screenshot` and `godot_view` of [`@deepseek-ai/dsh-godot`](../godot/README.md) save their image for it with `save` set to true, as a new PNG in the project's hidden `.wasdengine/screenshots/` folder, which Godot skips, so no export carries it, while a capture saved at a `path` inside the project would ship in every export; a Blender render, an image from `image_generate`, a texture, or a sprite sheet works too. The tool reads the file within `maxImageBytes`, turns it upright, and scales it down to `maxImageEdge` and `maxImagePixels`. It enlarges an image below `minImagePixels` by the smallest whole factor that reaches them, or the largest one the upper limits allow, so the route does not scale it up by a fraction and pixel art stays crisp. It saves the image as an attachment and sends one request to the account's route: the reviewer's instructions as the system prompt, and the image with the agent's words as the user message, at `reasoningEffort` within `maxTokens`. The reply's text, after any reasoning, is the review. A missing file, a folder, a device or pipe, an empty `subject`, and a file that is not a PNG, JPEG, or WebP image fail before any request, and a cancelled call stops reading the file.

The account pays for each review as for any model call: the WASD Engine gateway prices the tokens and counts them against the account's monthly AI usage. Once that usage is used up, the review fails with the gateway's own message, which names the account page where the user upgrades or turns on auto recharge, and asks the agent to pass it on to the user. Other failures name no model or provider and ask for another call only when one can help. The account's own refusal of a signed-in account, such as an unconfirmed email address or the waitlist, passes on its words. A missing or rejected sign-in, and a route that lists no model while no one is signed in, ask the user to sign in. A route that lists no model that takes images, as when its listing holds the reviewer back for a newer WASD Engine, a configured `model` that takes none, or a route that cannot serve the request says the reviewer is not available, that updating WASD Engine may bring it back, and to go on without a review; a configured `model` that the route refuses until WASD Engine updates asks the user to update. A request that fails the same way on every try, such as an invalid request or unsupported content, asks for another image or to go on without a review. A reply that reaches `maxTokens` before any text asks for a closer view or a narrower `focus`, and one that ends without text for one more call. A busy route asks to wait a few seconds, and any other failure asks to try again in a minute, once.

### Connected agents

Agents connected through WASD Engine's MCP server reach the tool under the provider `graphics`, titled Graphics review, without a Session: `image` must be an absolute path, and the tool is marked read-only. The provider's description in the overview of the server instructions asks the agent to review each piece of graphics it makes one to three times, each time with a new image of the result, acting on each review and stopping early when one has nothing useful, and never to review downloads such as Poly Haven's; its guide says how. The provider spends the account's AI usage (`spendsUsage`), so while a Free account whose usage is used up stays on Free, the server offers connected agents none of its tools ([Free accounts whose usage is used up](../game-mcp/README.md#free-accounts-whose-usage-is-used-up)).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The model-facing texts call the reviewer a specialized graphics expert reviewer model and never mention its cost; the reviewer is the account's model route with the reviewer's instructions in [`src/prompt.ts`](src/prompt.ts), which list what to look at; WASD Engine's tools in the order the agents prefer them, with a download that suits the game's art style first and generated 2D art before art drawn by hand or in code; the catalog add-ons by id with when each helps; how to read what the agent says changed since an earlier review, so the reviewer judges those changes and repeats no note the agent says it cannot act on, such as a stock character's face; and the form of the reply, only the notes that would make a clear, visible difference, at most eight and fewer when the work is close, and the tools and add-ons to consider, with no score, grade, or verdict. The request adds the agent's `previous` to the text beside the image as `Since the last review of this work:`. The request is prepared with `ctx.llm.prepareCall`, which binds the model's reasoning efforts: it asks for `reasoningEffort` when the model offers it and otherwise for the model's least effort, because the output limit counts the reasoning and the route's default effort can spend all of `maxTokens` on it. It carries the purpose `graphics-review`, the calling Session's id when the call has one, and `maxTokens`, and no temperature, which the account route ignores while the model reasons. A reply that reaches `maxTokens` keeps its text with a note that the review stops there. Sharp loads at the first review.

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

- [godot](../godot/README.md) — `godot_screenshot` and `godot_view`, which save their image for the review with `save`.
- [game-addons](../game-addons/README.md) — the catalog the reviewer names add-ons from.
- [art-references](../art-references/README.md) — references gathered before the art that the review judges.
- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

While the Session has `graphics_review`, the `graphics-review` section, under `# Graphics review`, tells the agent that the tool sends an image to a specialized graphics expert reviewer model, which critiques it with notes and names the WASD Engine tools and add-ons to consider; to use it only for graphics the agent makes itself, such as models, sprites, UI, lighting, or levels it builds, draws, or generates, never for assets it downloads, such as from Poly Haven or the web, or for work that only adds them to the game; and to review each piece of that work at least once and at most three times: capture the result, review it, act on the review, and repeat with a new capture until the work has had three reviews, passing `previous` with what it changed and which notes it left and why, stopping after the first or second when a review has nothing useful for the work, such as notes that repeat the last review's or ask for what the agent cannot change, and acting on the third before moving on. While the Session has the Godot tools, it says to capture the image with `godot_screenshot` or `godot_view` and their `save` option, which keeps the capture out of every export, and to give their `path` only to save it elsewhere. It says what to pass, how to act on a review, and that a failed call does not count, and it ends by stressing that graphics the agent made never goes without a review or gets more than three, and that downloaded assets get none. As the Web and Desktop profiles compose it, with the Godot tools:

##### The `graphics-review` section

```markdown
# Graphics review

graphics_review sends an image to a specialized graphics expert reviewer model, which critiques it as a game art director and technical artist would and gives notes on how to make it look better, naming the WASD Engine tools and add-ons to consider. Use it only for graphics you make yourself, such as a model, texture, sprite, animation, UI, lighting, effect, or level that you build, draw, or generate, and never for assets you download, such as from Poly Haven or the web, or for work that only adds them to the game. Review each piece of graphics work at least once and at most three times: capture the result, pass it to graphics_review, act on the review, and repeat with a new capture until that work has had three reviews, passing previous with what you changed and which notes you left and why. When a review has nothing useful for that work, such as notes that repeat the last review's or ask for what you cannot change, you may stop there, after the first or second. Act on the third review and move on without a fourth. Capture a game screenshot with godot_screenshot, or a closer look with godot_view, with save set to true, which keeps the capture out of the game and its exports, and pass the file its result names; give path instead only to save the image somewhere else. Or pass a render, an image you generated, a texture, or a sprite sheet. Pass subject, what the image shows and what it is for, and goal, the look the game is going for, such as the user's request or the style of its references. To act on a review, make the changes its notes ask for with the tools and add-ons it names. A call that fails does not count as a review. This is very important: never finish graphics you made without a review, never review a piece of it more than three times, and never review downloaded assets.
```

#### Token effect

The section comes to about 1,800 characters.

#### KV Cache effect

The section changes only when the Godot tools join or leave the Session's tools, so it stays in the cached system prompt.

### Tool declarations

#### What the model sees

`graphics_review` with `image` and `subject`, and the optional `goal`, `focus`, and `previous`. The description says that a specialized graphics expert reviewer model critiques an image of the game's graphics the way a game art director and technical artist would, what it looks at, that it gives notes on how to make the image look better and names the WASD Engine tools and add-ons to consider, to call it only for graphics the agent builds, draws, or generates, never for downloaded assets, at least once and at most three times for each piece of that work, each time with a new image of the result and on a later review with `previous`, stopping after the first or second when a review has nothing useful, such as notes that repeat the last review's, and what the review holds. A connected agent sees the same tool with `image` as an absolute path, the provider's description in the overview of the server instructions, and its guide under `## Graphics review`.

#### Token effect

The declaration comes to about 2,350 characters of JSON; the provider's description adds about 280 characters to the overview of the MCP server's instructions, and its guide about 1,900 characters after it.

#### KV Cache effect

The declaration is static, so it stays in the cached tool prefix.

### Tool results

#### What the model sees

A result is `Graphics review of <path>:` and the review in Markdown: only the notes on how to make the image look better that would make a clear, visible difference, at most eight and fewer when the work is close, the most important first, each with what to change, where in the image, and how, and the WASD Engine tools and add-ons to consider with what to do with each; it holds no score, grade, or verdict. A failure says what to change: a missing file, a folder, a device or pipe, a file that is not a PNG, JPEG, or WebP image, or an empty `subject`; or it passes on the account's used-up AI usage with the page where the user pays, or the account's own refusal; or it asks to sign in, to update WASD Engine, to send another image, a closer view, or a narrower focus, to wait, or to try again once, and says when to go on without a review instead.

#### Token effect

A review is up to about 600 words. The request itself, which never enters the conversation, carries the reviewer's instructions, about 4,400 characters plus about 200 per catalog add-on, and the image.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the review offers; they are current package constraints.

- **One still image** — a review judges one frame, so motion, animation timing, and other angles need images of their own, such as frames from `godot_record` or views from `godot_view`.
- **Reviews by instruction** — the agents' texts ask for one to three reviews of each piece of graphics the agent makes and none of downloaded assets. The tool refuses a fourth review of one piece of work before the review is asked for, so a loop of reviews spends no more of the account's usage, but it tells a piece of work only by the Session and the `subject` its calls name, ignoring letter case and runs of spaces, so a reworded subject counts as new work; the app's agents and the connected agents each have their own counts, of their 1,000 latest pieces of work, which last while WASD Engine runs. It cannot tell a downloaded asset from one the agent made, and leaves to the agent whether a review has anything useful. Each review sees only its own image and what the agent writes in `previous`, not the earlier images or reviews of the same work.
- **The account's route only** — the review runs on the WASD Engine account's model route whatever model the Session uses, and fails while WASD Engine is signed out.
- **Generic conversation row** — the Web UI shows the call in the generic tool row; the review is its text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The reviewer's instructions name WASD Engine's tools in words, not by tool name, except for tools whose names connected agents and the Session share, such as `image_generate` and `game_addons`, because the Session calls Blender and GIMP tools as `mcp__wasd_blender__<tool>` and connected agents as `blender_<tool>`.

</details>
