---
description: "agent（智能体）告诉 WASD Engine 团队的内容：每个会话和 WASD Engine 的 MCP 服务器都提供 feedback_send 工具，用于发送关于 WASD Engine 的反馈；用量报告统计 agent 调用每个游戏工具和用户添加的每个 MCP 服务器的频率；两者都以已登录账号的身份发送到 WASD Engine 网站。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-feedback

[English](README.md) | 中文

## 概述

agent 反馈插件让 agent（智能体）告诉 WASD Engine 团队是什么妨碍了它们。它的 `feedback_send` 工具发送关于 WASD Engine 的反馈：缺陷、缺失的功能、令人困惑之处或建议。会话和通过 WASD Engine 的 MCP 服务器连接的 agent（例如 Claude Code）都能使用该工具。插件还统计 agent 调用每个 MCP 工具的频率，包括 WASD Engine 的游戏工具和用户添加的 MCP 服务器的工具，并每分钟报告一次计数。两者都以已登录账号的身份发送到 WASD Engine 网站。

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

WASDEngine 覆盖层 [`telemetry.cordis.patch.yml`](../../bundle/web-app/wasdengine/telemetry.cordis.patch.yml) 把 `agent-feedback` 行插入每个 Web 和 Desktop 配置，并带上 Desktop 应用为其 Host 设置的版本：

```yaml
- id: agent-feedback
  name: '@deepseek-ai/dsh-agent-feedback'
  config:
    appVersion: !!js process.env.DSH_CLIENT_VERSION ?? ''
```

插件页面以“智能体反馈”之名列出这一行，其开关会在配置补丁中写入 `- id: agent-feedback` 和 `disabled: true` 来关闭它，这会同时停止工具和用量报告。插件需要 `tools` 服务。每次请求从 `deepseekAccount` 服务的 `getPlatformSession()` 读取账号的网站和令牌；在有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，插件把工具提供给连接的 agent，并统计它们的调用。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `usageReports` | `true` | 统计 agent 的 MCP 工具调用并报告；`false` 时不统计任何调用 |
| `reportIntervalMs` | `60000` | 两次用量报告之间的时间；只有自上次报告以来统计到调用时才发送报告 |
| `requestTimeoutMs` | `15000` | 对网站的单次请求的时间限制 |
| `finalReportTimeoutMs` | `3000` | 插件停止时（例如应用退出时）发送的最后一次用量报告的时间限制 |
| `appVersion` | 空 | 反馈中注明的应用版本；网站会拒绝的版本会被记入日志并省略 |

### 反馈工具

`feedback_send` 接受 `kind`，取值为 `bug`、`missing_feature`、`confusing` 和 `suggestion` 之一；`message`，最多 4,000 个字符，保留换行；以及 `about`，即反馈涉及的工具或 WASD Engine 的部分，最多 120 个字符。一次调用向网站源上的 `POST /api/v1/feedback` 发送一个 JSON 对象，`x-dsh-auth-token` 中带有账号令牌：内容为去除首尾空白的三个参数、agent、模型、应用版本，以及 Node 命名的操作系统，例如 `darwin`。会话的调用注明 WASD Engine 自己的 agent `wasd-engine`，以及会话所用模型的显示名称（取自模型服务的描述，否则为模型 id）。

通过 WASD Engine 的 MCP 服务器连接的 agent 在提供方 `feedback`（标题为 Feedback）下获得该工具，无需会话。它们看到的工具列表增加了 `model`，即该 agent 所用 AI 模型的名称，并省略 `agent_id` 和 `agent_title`：提供方的 `prepare` 会用服务器识别出的客户端（例如 `claude-code` 和 Claude Code）设置这两个参数，覆盖调用传入的任何值。WASD Engine 未登录时，服务器拒绝每次调用。

结果是一句话：说明发送了什么，以及团队会阅读但不会回复。未发送任何内容的调用会说明原因和应对办法：超出范围的参数、应用未登录、网站不再接受的登录、网站自己的拒绝消息（例如一天内反馈过多），或网站没有响应。

### 用量报告

插件统计会话 agent 每次完成的工具调用，以及 WASD Engine 的 MCP 服务器通过 `game-mcp/tool-result` 报告的每次调用。当 `gameMcp.toolOwner()` 找到提供该工具的提供方时，会话的调用计入该提供方，并使用连接 agent 所用的工具名，因此会话的 `mcp__wasd_blender__execute_python` 计为 Blender 的 `blender_execute_python`；没有提供方提供、名为 `mcp__<server>__<tool>` 的工具计入该服务器，视为用户添加的服务器。其他工具（例如读取文件）不计数。连接 agent 的调用计入其提供方和客户端。

每个计数是一个键，即谁调用了哪个服务器的哪个工具，带有调用次数和失败次数。被取消的调用不算失败，在工具运行前就被取消的调用不计数。插件每隔 `reportIntervalMs` 把计数发送到 `POST /api/v1/tool-usage`，停止时再发送一次。网站以后可能接受的计数会留到下一次报告：未登录、没有网络，或网站返回 401、429 或 5xx 时。网站原样拒绝的计数（例如等候名单上的账号的计数）会被丢弃。一次报告最多包含 500 个键，即网站一次接受的上限；在报告发送之前，其他工具的调用不计数，插件每次遇到这种情况时记录一次日志。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

请求发往 `getPlatformSession()` 的源，即账号登录的 `platformOrigin`，从不跟随重定向，并在 `requestTimeoutMs` 后结束。用量报告的请求体为 `{ calls: [{ connected, agent, agent_title, custom, server, server_title, tool, calls, errors }] }`。报告从不重叠：每次报告都等待前一次结束，因此插件停止时的最后一次报告会先结束正在发送的报告（其计数会退回），然后一并发送全部计数。定时器和最后一次报告运行在一个注入 `deepseekAccount` 的 fiber 中，并通过注入的服务读取登录信息：作为登录服务的依赖方，整个 Host 停止时该 fiber 先于登录服务停止，而且在其停止过程中注入的服务仍可应答，此时 `ctx.get()` 已经找不到该服务。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、账号的网站、工具注册、游戏 MCP 提供方，以及用量报告的监听器和定时器 |
| [`src/api.ts`](src/api.ts) | 网站客户端，以及未发送反馈时的措辞 |
| [`src/tools.ts`](src/tools.ts) | 两种调用方的工具定义、参数检查和结果文本 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接 agent 的工具、提供给它们的参数结构和提供方说明 |
| [`src/usage.ts`](src/usage.ts) | 哪些调用计数，以及两次报告之间的计数 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍把工具提供给其他 agent 的 MCP 服务器，以及接收报告的网站。

- [game-mcp](../game-mcp/README.zh.md)——面向本机 agent 的 MCP 服务器，以及 `toolOwner`。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md#agent-feedback)——这一行如何与游戏工具和 MCP 服务器衔接。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 看到 `feedback_send`，参数为 `kind`、`message` 和 `about`。说明要求在 WASD Engine 本身妨碍 agent 时发送反馈，并说明每种类型的含义，用户要求时也发送；要写清尝试了什么、发生了什么、期望什么，并说出涉及的工具；每个问题只发送一次；除问题所需之外，不包含用户的个人信息、机密和游戏内容；它不用于用户自己游戏中的问题；团队不会回复，因此 agent 应继续完成用户的任务。连接的 agent 看到同样的工具并带有 `model`，提供方说明位于 `## Feedback` 下。

#### Token 影响

声明约为 1,400 个字符的 JSON，连接的 agent 的声明带有 `model`，约为 1,500 个字符；提供方说明为 MCP 服务器的说明增加约 500 个字符。

#### KV Cache 影响

声明是静态的，因此保留在缓存的工具前缀中。用量报告不向任何模型请求添加内容。

### 工具结果

#### 模型可见内容

结果是一句话，注明反馈类型和涉及的内容，说明团队会阅读但不会回复，并要求继续工作。失败时说明为什么没有发送任何内容以及应对办法。

#### Token 影响

结果是一句话。

#### KV Cache 影响

在会话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了插件提供的能力，是本包当前的约束。

- **没有回复**——团队在 WASD Engine 网站上阅读反馈；之后不会有任何内容送达 agent 或用户。
- **没有确认**——会话的 agent 发送反馈时不询问用户；调用及其参数会显示在会话中，连接 agent 自己的工具可能会先询问其用户。
- **崩溃时丢失调用**——计数在报告发送之前保存在内存中，因此崩溃会丢失自上次报告以来的调用。
- **没有逐次调用的细节**——报告按键保存名称和计数，不包含每次调用的时间、参数或耗时。
- **通用会话行**——Web UI 在通用工具行中显示工具调用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

网站按自己的规则校验每个名称，只要有一个条目无效就拒绝整份报告，因此报告只发送 harness 自身产生的名称：提供方 id、`mcp__` 服务器名称、游戏 MCP 服务器的客户端 id，以及 `wasd-engine`。

</details>
