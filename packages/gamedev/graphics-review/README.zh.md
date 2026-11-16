---
description: "面向 agent 的画面审查：graphics_review 把 agent 截取或制作的游戏画面图片发给审查者，由它像游戏美术总监和技术美术那样点评，并指出能让画面更好看的 WASD Engine 工具和扩展；审查者是 WASD Engine 账号的模型路由，账号像为任何模型调用付费一样为其付费；一个系统提示词段落要求每项画面工作恰好审查三次，适用于每个 Session 和连接的 agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-graphics-review

[English](README.md) | 中文

## 概述

画面审查插件让审查者点评游戏画面。完成画面工作之后，agent 截取结果，例如用 `godot_screenshot` 及其 `save` 选项，再把图片连同它展示的内容和游戏想要的风格一起传给 `graphics_review`。审查者像游戏美术总监那样给出让图片更好看的改进意见，以及可以考虑使用的 WASD Engine 工具和扩展，从不打分。agent 对每项画面工作恰好审查三次，并按每次审查修改。连接的 agent 也能使用同一个工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 默认组合

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 在每个 Web 和 Desktop profile 中插入 `graphics-review` 行，使用其默认配置：

```yaml
- id: graphics-review
  name: '@deepseek-ai/dsh-graphics-review'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `deepseek-account` | WASD Engine 账号的 provider 路由，由它的模型审查每张图片 |
| `model` | 空 | 该路由的模型；为空时选择列出的第一个接受图片的模型 |
| `maxTokens` | `16384` | 一次审查最多的 token 数，包括推理 |
| `reasoningEffort` | `low` | 模型提供该推理强度时每次审查使用的推理强度；否则使用模型最低的推理强度 |
| `timeoutMs` | `240000` | 一次 `graphics_review` 调用的时限 |
| `maxImageBytes` | `52428800` | 读取的最大图片文件 |
| `maxImageEdge` | `1568` | 发送的图片最长边的像素数 |
| `maxImagePixels` | `1150000` | 发送的图片最多的像素数 |
| `minImagePixels` | `295936` | 发送的图片最少的像素数：较小的图片（例如像素画）按整数倍朝这个像素数放大，因为路由会把更小的图片按非整数倍放大；默认值是账号路由的 544×544 |

插件需要 `tools` 和 `workingDirectory` 服务，审查还需要 `llm` 和 `attachments` 服务。有 `systemPrompt` 服务时它添加 `graphics-review` 段落；有 [`@deepseek-ai/dsh-game-addons`](../game-addons/README.zh.md) 的 `gameAddons` 服务时，审查者可以点名目录中的每个扩展；有 [`@deepseek-ai/dsh-deepseek-account`](../../credentials/deepseek-account/README.zh.md) 的 `deepseekAccount` 服务时，路由在无人登录时列不出模型，审查会请用户登录；有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，它把工具提供给连接的 agent。「插件」页面的开关可以关闭这一行。

### 工具

`graphics_review` 接受 `image`（PNG、JPEG 或 WebP 文件的路径，相对于工作目录或为绝对路径）、`subject`（图片展示的内容及其用途），以及可选的 `goal`（游戏想要的风格）和 `focus`（最需要关注的方面）。[`@deepseek-ai/dsh-godot`](../godot/README.zh.md) 的 `godot_screenshot` 和 `godot_view` 把 `save` 设为 true 时会为它保存图片：在项目隐藏的 `.wasdengine/screenshots/` 文件夹中新建一个 PNG，Godot 会跳过这个文件夹，因此任何导出都不会带上它，而保存在项目内某个 `path` 的截图会随每次导出发布；Blender 渲染图、`image_generate` 生成的图片、贴图或精灵表也都可以。工具在 `maxImageBytes` 之内读取文件，把图片转正，并缩小到 `maxImageEdge` 和 `maxImagePixels` 之内。低于 `minImagePixels` 的图片按能达到该像素数的最小整数倍放大，或按上限允许的最大整数倍放大，这样路由不会再按非整数倍放大它，像素画保持清晰。它把图片保存为附件，并向账号的路由发送一次请求：审查者的说明作为系统提示词，图片和 agent 的描述作为用户消息，推理强度为 `reasoningEffort`，并受 `maxTokens` 限制。回复中推理之后的文本就是审查结果。文件缺失、路径是文件夹、设备或管道、`subject` 为空，或文件不是 PNG、JPEG、WebP 图片时，调用会在发出任何请求之前失败；调用被取消时会停止读取文件。

账号像为任何模型调用付费一样为每次审查付费：WASD Engine 网关为这些 token 计价，并计入账号每月的 AI 用量。用量用完后，审查会以网关自己的消息失败，消息中写明用户升级或开启自动充值的账号页面，并请 agent 把它转告用户。其他失败不提及任何模型或 provider，只在再次调用有用时才请 agent 重试。账号对已登录账号的拒绝（例如邮箱地址尚未确认或账号在候补名单中）会转告其原话。登录缺失或被拒，以及路由在无人登录时列不出模型，都会请用户登录。路由列出的模型都不接受图片（例如其模型列表把审查者留给更新版本的 WASD Engine）、配置的 `model` 不接受图片，或路由无法处理该请求时，会说明审查者不可用、更新 WASD Engine 可能使它恢复可用，并请 agent 在没有审查的情况下继续；路由要等 WASD Engine 更新后才提供的已配置 `model` 会请用户更新。每次重试都以同样方式失败的请求（例如无效请求或不支持的内容）会请 agent 换一张图片，或在没有审查的情况下继续。在写出任何文本之前就达到 `maxTokens` 的回复会请 agent 发送更近的视图或更窄的 `focus`，没有文本就结束的回复会请 agent 再调用一次。路由繁忙时请等待几秒，其余失败请一分钟后重试一次。

### 连接的 agent

通过 WASD Engine 的 MCP 服务器连接的 agent 在 provider `graphics`（标题为 Graphics review）下使用该工具，无需 Session：`image` 必须是绝对路径，工具标记为只读。服务器指令概述中的 provider 描述要求 agent 对每项画面工作恰好审查三次，每次都发送结果的新图片，并按每次审查行事，它的指南说明了具体做法。该 provider 会消耗账号的 AI 用量（`spendsUsage`），因此用量已用完的 Free 账号继续使用 Free 期间，服务器不向连接的 agent 提供它的任何工具（[用完 AI 用量的 Free 账号](../game-mcp/README.zh.md#free-accounts-whose-usage-is-used-up)）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

面向模型的文字把审查者称为专门的画面专家审查模型，从不提及其费用；审查者是账号的模型路由，配合 [`src/prompt.ts`](src/prompt.ts) 中审查者的说明，其中列出要关注的方面、按 agent 的偏好顺序排列的 WASD Engine 工具（先是符合游戏美术风格的可下载素材，再是生成的 2D 美术，最后才是手绘或用代码绘制的美术）、按 id 列出的目录扩展及其适用场景，以及回复的格式：改进意见和可以考虑使用的工具和扩展，不含评分、等级或结论。请求通过 `ctx.llm.prepareCall` 准备，它绑定模型的推理强度：模型提供 `reasoningEffort` 时使用它，否则使用模型最低的推理强度，因为输出上限把推理也计算在内，而路由默认的推理强度可能把 `maxTokens` 全部用在推理上。请求带有 purpose `graphics-review`、调用有 Session 时的 Session id 和 `maxTokens`，不设 temperature，因为模型推理时账号路由会忽略它。达到 `maxTokens` 的回复保留其文本，并注明审查在此结束。Sharp 在第一次审查时加载。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config、工具注册、系统提示词段落和游戏 MCP provider |
| [`src/tools.ts`](src/tools.ts) | 工具定义、参数和结果 |
| [`src/image.ts`](src/image.ts) | 读取、检查和适配图片 |
| [`src/review.ts`](src/review.ts) | 发往账号路由的请求、回复和失败消息 |
| [`src/prompt.ts`](src/prompt.ts) | 系统提示词段落、MCP provider 的描述和指南，以及审查者的说明 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接的 agent 的工具 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍审查所用的截图、它建议的工具，以及把它提供给其他 agent 的 MCP 服务器。

- [godot](../godot/README.zh.md) — `godot_screenshot` 和 `godot_view`，它们可以用 `save` 为审查保存图片。
- [game-addons](../game-addons/README.zh.md) — 审查者点名扩展所依据的目录。
- [art-references](../art-references/README.zh.md) — 在审查所评判的美术之前收集的参考。
- [game-mcp](../game-mcp/README.zh.md) — 面向本机 agent 的 MCP 服务器。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md) — 游戏工具、它们的行和 MCP 服务器。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型可见内容

当 Session 拥有 `graphics_review` 时，`graphics-review` 段落（标题为 `# Graphics review`）告诉 agent：这个工具把图片发给专门的画面专家审查模型，由它给出改进意见并指出可以考虑使用的 WASD Engine 工具和扩展；并要求 agent 对每项画面工作恰好审查三次，不多也不少：截取结果、审查、按审查行事，再用新的截图重复，直到这项工作经过三次审查，然后按第三次审查行事并继续下一步。Session 拥有 Godot 工具时，段落要求用 `godot_screenshot` 或 `godot_view` 及其 `save` 选项截取图片，它让截图不进入任何导出，只有要保存到别处时才给出它们的 `path`。段落还说明要传入什么、如何按审查行事，以及失败的调用不算一次审查，最后强调画面工作的审查不能少于三次，也不能多于三次。Web 和 Desktop profile 在拥有 Godot 工具时组成的段落如下：

##### `graphics-review` 段落

```markdown
# Graphics review

graphics_review sends an image to a specialized graphics expert reviewer model, which critiques it as a game art director and technical artist would and gives notes on how to make it look better, naming the WASD Engine tools and add-ons to consider. Review each piece of graphics work exactly three times, no more and no less: once you change what the player sees, such as a model, texture, sprite, animation, UI, lighting, effect, or level, capture the result and pass it to graphics_review, act on the review, and repeat with a new capture until that work has had three reviews; then act on the third review and move on without a fourth. Capture a game screenshot with godot_screenshot, or a closer look with godot_view, with save set to true, which keeps the capture out of the game and its exports, and pass the file its result names; give path instead only to save the image somewhere else. Or pass a render, an image you generated, a texture, or a sprite sheet. Pass subject, what the image shows and what it is for, and goal, the look the game is going for, such as the user's request or the style of its references. To act on a review, make the changes its notes ask for with the tools and add-ons it names. A call that fails does not count as a review. This is very important: never finish graphics work with fewer than three reviews, and never review it more than three times.
```

#### Token 影响

该段落约 1,400 个字符。

#### KV Cache 影响

该段落只在 Godot 工具加入或离开 Session 的工具时变化，因此会留在缓存的系统提示词中。

### 工具声明

#### 模型可见内容

`graphics_review`，带 `image` 和 `subject`，以及可选的 `goal` 和 `focus`。描述说明：专门的画面专家审查模型会像游戏美术总监和技术美术那样点评游戏画面的图片，说明它关注的方面，说明它会给出让图片更好看的改进意见并指出可以考虑使用的 WASD Engine 工具和扩展，要求对每项画面工作恰好调用三次、每次都使用结果的新图片，并说明审查包含的内容。连接的 agent 看到同一个工具，其中 `image` 为绝对路径，还会在服务器指令概述中看到 provider 的描述，并在 `## Graphics review` 下看到它的指南。

#### Token 影响

该声明约 1,700 个字符的 JSON；provider 的描述为 MCP 服务器指令的概述增加约 270 个字符，它的指南在概述之后增加约 1,500 个字符。

#### KV Cache 影响

该声明是静态的，因此会留在缓存的工具前缀中。

### 工具结果

#### 模型可见内容

结果是 `Graphics review of <path>:` 以及 Markdown 格式的审查：最多八条让图片更好看的改进意见（最重要的在前，每条说明要改什么、在图片中的位置以及怎么改），以及可以考虑使用的 WASD Engine 工具和扩展及各自的用法；其中没有评分、等级或结论。失败时说明要改什么：文件缺失、路径是文件夹、设备或管道、文件不是 PNG、JPEG 或 WebP 图片，或 `subject` 为空；或者转告账号的 AI 用量已用完并给出用户付费的页面，或转告账号自己的拒绝；或者请用户登录、更新 WASD Engine，请 agent 换一张图片、发送更近的视图或更窄的关注点、等待或重试一次，并说明何时应在没有审查的情况下继续。

#### Token 影响

一次审查最多约 600 个英文单词。请求本身从不进入对话，它携带审查者的说明（约 4,000 个字符，每个目录扩展再加约 200 个字符）和图片。

#### KV Cache 影响

在对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了审查能提供什么；它们是本包当前的约束。

- **只看一张静止图片**——一次审查只评判一帧，因此动作、动画节奏和其他角度需要单独的图片，例如 `godot_record` 的帧或 `godot_view` 的视图。
- **按说明审查三次**——agent 的文字要求对每项画面工作恰好审查三次，但工具不计数，而且每次审查只看到自己的图片，看不到同一项工作之前的审查。
- **只用账号的路由**——无论 Session 使用哪个模型，审查都在 WASD Engine 账号的模型路由上运行，WASD Engine 未登录时审查会失败。
- **通用的对话行**——Web UI 用通用的工具行显示这次调用；审查结果就是它的文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

审查者的说明用文字称呼 WASD Engine 的工具，而不用工具名，只有 Session 和连接的 agent 共用名称的工具除外，例如 `image_generate` 和 `game_addons`，因为 Session 以 `mcp__wasd_blender__<tool>` 调用 Blender 和 GIMP 工具，而连接的 agent 以 `blender_<tool>` 调用。

</details>
