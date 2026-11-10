---
description: "WASD Engine MCP 服务器的浏览器部分，面向需要修改「使用其他智能体设置」（桌面引导的最后一步与设置中的「其他智能体」分区）及其智能体标志、设置提示词与连接状态，或修改窗口如何打开已连接 agent 启动游戏所在会话的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-mcp

[English](README.md) | 中文

## 概述

让这台电脑上的 Claude Code、Codex 或其他 agent 使用 WASD Engine 的游戏工具。登录后，「使用其他智能体设置」是桌面引导的最后一步，设置中也保留为「其他智能体」：显示可以连接的 AI 智能体的标志、要粘贴到 agent 中的提示词，以及是否已有 agent 连接。已连接的 agent 启动游戏时，窗口会打开该 agent 的会话，因此游戏会在这里播放。Host 部分 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 向已登录的用户提供这些工具并生成提示词。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

登录 WASD Engine。在桌面应用中，登录后的引导以 **使用其他智能体设置** 结束；之后可以打开 **设置 → 其他智能体**。复制提示词并粘贴到另一个 agent 中，然后按该 agent 的要求操作，例如重启它。

### 默认组合

fork 补丁文件 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 会在每个 Web 与 Desktop profile 的 `game-mcp` 行之后插入这一行：

```yaml
- id: ui-game-mcp
  name: '@deepseek-ai/dsh-client-ui-game-mcp'
```

该行不接受配置，其 Host 部分不做任何事：这一行的存在只是为了让 Host 提供浏览器部分。浏览器部分自行挂载 `@deepseek-ai/dsh-game-mcp` 的 `gameMcp` Remote，填充 [`ui-settings-account`](../../client/ui-settings-account/README.zh.md) 引导的 `settings.account.onboarding.agents` 步骤，在设置中加入 `other-agents` 分区，并通过 `uiWorkspace` 打开会话。profile 补丁中带 `disabled: true` 的 `- id: ui-game-mcp` 条目会移除该步骤、该分区以及窗口打开会话的行为，服务器仍继续运行。

### 设置内容

该步骤与该分区显示相同的设置内容：按网站顺序排列在白色方块上的 ChatGPT、Claude、Gemini、Grok、MiniMax、DeepSeek、Kimi 与 GLM 标志，设置提示词，「复制提示词」按钮，以及服务器状态：正在启动、等待 agent、已连接 agent 的名称、服务器无法运行的原因，或与 Host 的连接已断开。当宿主拒绝写入剪贴板时（嵌入式浏览器就是如此），按钮会选中提示词，方便用户用键盘复制。该步骤使用引导的标题与样式类，其「继续」无论是否已有 agent 连接都会完成引导；引导的「上一步」返回之前的选择页。

只有当 Peer 可以调用 `gameMcp/watch` 时，该步骤与该分区才存在；LiveShare 只把这个调用留给所有者。它们显示期间通过 `gameMcp.watch` 读取服务器视图，流中断后会重新打开：先等待 1 秒，最长等待 30 秒。`src/client/assets/` 中的每个标志文件都注明其商标所有者与来源。

### 已连接 agent 的游戏

已连接的 agent 启动游戏时，Host 会带着该 agent 的会话发出 `game-mcp/reveal`。每个可以读取该会话的窗口都会打开它，会话的「游戏」标签页也会为这次运行打开，与 agent 启动的任何运行一样。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

浏览器插件最先挂载生成的 `gameMcp` Remote 贡献，最后撤下它。在等待 `remote.gameMcp` 的作用域中，它注册自己的词典与 `game-mcp/reveal` 订阅；当 Peer 可以调用 `gameMcp/watch` 时，再通过 `ctx.slots.inject()` 把 `AgentSetupStep` 注册到 `settings.account.onboarding.agents`，把 `AgentSetupSection` 注册到 `settings.section`，并以链接图标 `AgentSetupIcon` 作为其导航图标。引导只在桌面应用中声明其步骤的 slot，因此 Web UI 只有该分区。视图流在第一个订阅者出现时打开，在最后一个订阅者离开时关闭，因此两者都未显示时不会发出任何 Remote 调用。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Loader 行的空 Host `apply` |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：先挂载 Remote，再挂载 UI |
| [`src/client/mount.ts`](src/client/mount.ts) | 词典、reveal 订阅与 slot 注册 |
| [`src/client/source.ts`](src/client/source.ts) | 视图流及其重新打开 |
| [`src/client/AgentSetup.tsx`](src/client/AgentSetup.tsx)、[`src/client/AgentSetup.module.css`](src/client/AgentSetup.module.css) | 智能体标志、提示词框、该步骤与该分区 |
| [`src/client/assets/`](src/client/assets/) | 智能体标志 |
| [`src/client/locales.ts`](src/client/locales.ts) | 八种语言的 `gameMcp` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

这些页面介绍生成提示词的服务器、承载该步骤的引导以及「游戏」标签页。

- [game-mcp](../game-mcp/README.zh.md) — 服务器、其令牌、其工具以及已连接 agent 的会话。
- [ui-settings-account](../../client/ui-settings-account/README.zh.md) — 必需的登录，以及带最后一步的桌面引导。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md#mcp-server-for-other-agents) — 服务器如何连接游戏工具、会话与窗口。
- [Godot 包](../godot/README.zh.md) — 显示已连接 agent 游戏的「游戏」标签页。

-----

<a id="model-experience"></a>
## 模型体验

### 设置内容与窗口

#### 模型可见内容

无。设置内容与 `game-mcp/reveal` 订阅不会添加任何会话事件、提示词文本或工具；用户把提示词粘贴到另一个 agent 中，由该 agent 的 harness 决定其模型看到什么，详见 [game-mcp](../game-mcp/README.zh.md#model-experience)。

#### Token 影响

不直接产生 token。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制决定了设置内容显示什么以及哪些窗口会跟随已连接的 agent；它们是本包当前的约束。

- **每个窗口都会跟随** — 已连接 agent 启动游戏时，每个可以读取其会话的窗口都会打开该会话，包括用户正在另一个会话中工作的窗口。
- **仅限启动以来出现的 agent** — 设置内容只会在 agent 自 Host 启动以来调用过服务器后显示其名称；更早设置好但尚未调用的 agent 显示为等待中。
- **标志不是受支持 agent 的清单** — 这些标志表示其智能体可以通过 MCP 连接的 AI 产品；任何带 MCP 客户端的 agent 都能连接，提示词只给出 Claude Code 与 Codex 的命令。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
