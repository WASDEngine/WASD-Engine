---
description: "新游戏指引插件：在用户为新游戏发出的第一条提示之后，把部署配置的指引作为一条单独记录的消息加入；面向选择、配置或调试该插件的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-new-game-guidance

[English](README.md) | 中文

## 概述

本包在用户开始做一款新游戏时给智能体指引。当顶层 Session 中用户的第一条提示进入一个步骤、而项目文件夹只含隐藏条目和系统文件时，插件会紧接在这条提示之后，把配置的文本作为一条单独的消息加入。之后的提示、已有文件的文件夹和子智能体 Session 都不会收到指引。`gamedev` 预设附带四行指引：要求画面、动作和声音出色，人物栩栩如生，世界可信，并且自主工作、自己试玩检验；WASD Engine 插件的浏览器部分不会在 Chat 中显示这条消息。

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

在智能体预设中挂载本插件。它需要 `sessionProjections` 服务，以及一个能列出 Session 项目文件夹的 `fs` 文件系统；随附的 Web 与 Desktop 组合都提供这两者。

### 何时选用

当新游戏的第一次构建应遵循一些原本要用户自己输入的标准（例如质量目标或不提问地工作），而部署希望把它们放进用户自己的轮次、而不是放进会作用于每个请求的系统提示时，选用本插件。如果指引应在整个 Session 中有效，则不要选用：文本只在第一条提示之后送达模型一次。

### 配置

```yaml
- id: new-game-guidance
  name: '@deepseek-ai/dsh-new-game-guidance'
  config:
    text: |-
      * Put your effort into making what's on screen look, move and sound great
      * Work autonomously without asking me questions
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `text` | 必填 | 指引，模型在第一条提示之后读到的原文 |

缺少该值时加载即失败，只含空白字符的文本也是如此。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-new-game-guidance)记录了该字段接受的取值。

### 何时加入指引

当一个步骤的消息中包含一条来自用户的消息（来源类型为 `user`），且所在的顶层 Session 的日志中此前没有任何来自用户的消息（分叉 Session 继承的历史也算在内）时，插件开始处理。它随后列出 Session 的项目文件夹，即头部记录的 `cwd`。当每个条目都是隐藏条目（名称以 `.` 开头）或系统文件 `Thumbs.db`、`desktop.ini` 之一时，这就是一款新游戏，指引会紧接在该步骤中最后一条来自用户的消息之后加入，排在其他插件为该步骤加入的上下文（例如工作区说明和时钟）之前。无法列出的文件夹、没有文件夹的 Session，以及含有任何其他文件或文件夹的文件夹，都不会收到指引。

指引是一条来源为 `{ kind: 'new-game-guidance' }`、不带 form 的 `user/message`，因此 Session 日志会像保存提示一样保存它，之后的每个请求都会把它作为历史重复发送。只有第一条提示会得到指引：一旦日志中有来自用户的消息，之后的提示都不会再得到指引，即使文件夹又被清空也是如此。由通知或其他生产者开始、没有用户消息的第一个轮次不会加入指引，而是把指引留给用户的第一条提示；被其他监听器拒绝的步骤既不会记录提示，也不会记录指引。

除非有客户端插件认领，对话视图会把这一来源的消息显示为不透明的上下文。在 WASD Engine 中，WASD Engine 插件的浏览器部分会在 Chat 目标上认领它，且不为它构建节点，因此 Chat 显示的是用户写下的原始提示；列出模型收到的每条消息的 Trajectory 视图仍会列出它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明插件如何决定加入指引以及把它放在哪里；可观察的行为见[使用本包](#use-this-package)。

### 设计

- **插件，而非修改循环。**插件监听 `agent/pre-step`，这是一个 waterfall，监听器在其中接受、改写或拒绝步骤认领的消息。它先委托下游，让之后的监听器仍可拒绝或改写该步骤，并且只向 `enter` 决定加入指引，保留其他字段。
- **紧接在提示之后。**监听器以 `prepend: true` 注册，因此它包裹在为该步骤加入其他上下文的监听器（例如 `agent-instructions` 和 `time-context`）之外，并把指引插入到它们合并后的决定中最后一条来自用户的消息之后。
- **状态来自日志。**一个仅在宿主中的 Session 投影 `newGameGuidancePrompted` 折叠日志中是否有来自用户的消息。投影会折叠恢复的事件和继承的事件，因此恢复或分叉的 Session 读到的答案相同。
- **通过文件系统服务读取文件夹。**监听器通过 `ctx.fs` 解析并列出头部的 `cwd`；工作区文件 Remote 也是通过这一服务为 WASD Engine 插件的首次构建提示列出文件夹的，因此两者对"新游戏"的判断一致。列出失败视为找到了内容；被取消的步骤会抛出其原因。
- **会被记录。**指引作为一条普通的 `user/message` 加入，因此每一项模型可见的输入都能从日志重建。持久化更改 `2026-11-18-new-game-guidance-source` 确认了这一新的来源类型。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、投影、文件夹检查与 `agent/pre-step` 监听器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，请阅读以下页面。

- [智能体生命周期](../../../docs/agent-lifecycle.zh.md)——`agent/pre-step` 在轮次中的运行位置。
- [WASD Engine 插件](../wasd-plugins/README.zh.md)——读取同一空文件夹的首次构建提示，以及不在 Chat 中显示指引的 Definition。
- [游戏开发分组](../README.zh.md)——其他由分叉维护的包。

-----

<a id="model-experience"></a>
## 模型体验

### 指引上下文消息

#### 模型看到什么

紧接在用户为新游戏发出的第一条提示之后，模型会在下一条用户角色消息中收到配置的文本；会合并连续用户消息的路由把它与提示放在同一个用户轮次中发送。`gamedev` 预设附带以下几行。

##### 指引

```markdown
* Put your effort into making what's on screen look, move and sound great
* People and humanoid figures should look and move like real people, with fitting animations
* The environment should be believable, textured, with lighting that sells the mood
* Work autonomously without asking me questions. Run and play the demo yourself and fix anything that looks or plays wrong before you finish
```

#### Token 影响

不开始新游戏的 Session 为零 token。新游戏的 Session 把这段文本作为保留的历史携带一次，随附的几行不到 100 个 token。

#### KV Cache 影响

仅追加；指引随第一条提示加入并保持在原位，不会使已有的 KV cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **空文件夹中的任何第一条提示**——插件无法区分做游戏的请求和提问，因此在空项目文件夹中发出的第一条提示（例如"如何导出游戏？"）也会得到指引。
- **只由文件夹判断是否为新游戏**——文件不在 Session 文件夹中的游戏不算新游戏，而用户为游戏以外的用途打开的空文件夹却算。
- **连接的智能体经由别处收到指引**——通过 MCP 使用 WASD Engine 工具的智能体在它们自己的应用中接收提示，因此插件看不到这些提示；游戏 MCP 服务器改为在 [`create_game_project`](../game-mcp/README.zh.md#create-game-projects) 的结果末尾附上同样的几行，但不含不提问、自主工作的要求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
