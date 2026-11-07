---
description: "把 WASD Engine 的游戏工具提供给同一台电脑上的其他 agent（智能体），例如 Claude Code 或 Codex：回环 Streamable HTTP 端点及其令牌、由 Godot、Blender、GIMP 与 SuperCollider 插件填充的 provider 注册表、搜索与按名调用工具、已连接 agent 的游戏所在的 Session、gameMcp Remote 与 game-mcp/reveal 事件，以及登录对话框显示的设置提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-game-mcp

[English](README.md) | 中文

## 概述

让这台电脑上的 Claude Code、Codex 和其他 agent 通过 MCP 使用 WASD Engine 的游戏工具。Host 插件监听 `http://127.0.0.1:9273/mcp`，要求提供其数据文件夹中的令牌，并提供游戏工具插件贡献的 `godot_*`、`blender_*`、`gimp_*` 与 `supercollider_*` 工具，外加 `search_game_tools` 与 `call_game_tool`。已连接 agent 的 Godot 游戏在游戏项目中属于它自己的 Session 里运行，因此会在 WASD Engine 窗口的「游戏」标签页中播放；agent 启动游戏时，这个标签页会打开。[`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.zh.md) 在登录对话框中加入「使用其他智能体设置」，显示设置提示词。

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

WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 在每个 Web 与 Desktop profile 中、游戏工具行之后插入 `game-mcp` 行：

```yaml
- id: game-mcp
  name: '@deepseek-ai/dsh-game-mcp'
  config:
    dataRoot: !!js dshHomePath('game-mcp')
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 访问令牌（`token`）与已连接 agent 的 Session 绑定（`sessions.json`）所在的绝对路径文件夹；相对路径会使插件加载失败 |
| `port` | `9273` | 端点的回环端口，0 到 65,535 的整数；0 表示选择空闲端口。端口被其他程序占用时，服务器在 Host 重启前改用一个空闲端口，并在其视图中说明 |

profile patch 用 `- id: game-mcp` 与 `disabled: true` 关闭服务器。

### 设置其他 agent

登录对话框中的「使用其他智能体设置」面板由 [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.zh.md) 加入，它显示服务器视图中的设置提示词，以及服务器状态和 Host 启动以来见过的 agent。

[`src/prompt.ts`](src/prompt.ts) 写出的提示词给出服务器名称 `wasd-engine`、URL 与请求头 `Authorization: Bearer <token>`，并给出 Claude Code 与 Codex 的设置方法：

```text
claude mcp add-json wasd-engine '{"type":"http","url":"http://127.0.0.1:9273/mcp","headers":{"Authorization":"Bearer <token>"}}' --scope user
```

```toml
[mcp_servers.wasd-engine]
url = "http://127.0.0.1:9273/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
```

令牌是 32 个随机字节的 base64url 形式，首次启动时以 0600 权限写入 `<dataRoot>/token`，因此设置过一次的 agent 在重启后仍可使用。删除该文件后，下次启动会生成新令牌，此后每个 agent 都需要新的提示词。

### 已连接 agent 获得的内容

| 工具 | 来源 | 作用 |
|---|---|---|
| `search_game_tools` | 本包 | 列出各插件及其就绪状态与工具数量，以及工具：不带查询时列出每个工具的第一句说明，带查询时列出最匹配的工具及其参数；`plugin` 用于限定插件 |
| `call_game_tool` | 本包 | 按 `name` 与 `arguments` 调用工具，供工具列表中缺少该工具的 agent 使用 |
| `godot_*` | [`@deepseek-ai/dsh-godot`](../godot/README.zh.md) | Session 自身的十个 Godot 工具，每个都带有绝对路径参数 `project` |
| `blender_*` | [`@deepseek-ai/dsh-blender`](../blender/README.zh.md)，经由 [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.zh.md) | `wasd_blender` 服务器的工具，由 `mcp__wasd_blender__<tool>` 重命名而来 |
| `gimp_*` | [`@deepseek-ai/dsh-gimp`](../gimp/README.zh.md)，经由 [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.zh.md) | `wasd_gimp` 服务器的工具，由 `mcp__wasd_gimp__<tool>` 重命名而来 |
| `supercollider_*` | [`@deepseek-ai/dsh-supercollider`](../supercollider/README.zh.md)，经由 [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.zh.md) | `wasd_supercollider` 服务器的工具，由 `mcp__wasd_supercollider__<tool>` 重命名而来 |

服务器指令先介绍每个插件，再在插件标题下附上插件自己的指令。已连接 agent 与 Session 自身的 agent 共用同一个 Blender worker、同一个 GIMP worker 和同一个 SuperCollider worker，与所有 Session 一样。

### WASD Engine 窗口中的游戏

Godot 调用以绝对路径指定项目：包含 `project.godot` 的文件夹、其上方至多三层的文件夹，或 `project.godot` 文件本身；省略 `project` 时，调用使用该 agent 上一次的项目。服务器解析在该项目中运行这个 agent 游戏的 Session：包含该文件夹的已注册游戏项目，或为该文件夹新建的注册，为每个 agent 保存一个 Session；Session 在首次使用时创建，并记录在 `<dataRoot>/sessions.json` 中，因此 agent 在重启后仍保有它的 Session 与游戏。离开了游戏项目、已归档或已不存在的 Session 会被新的 Session 取代。`godot_run` 会携带该 Session 发出 `game-mcp/reveal`，窗口随即通过 [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.zh.md) 打开该 Session，「游戏」标签页也会像对待任何由 agent 启动的运行一样为这次运行打开。

### 提供工具

`ctx.gameMcp.provide(provider)` 在调用方插件的生命周期内提供该插件的工具，并返回一个幂等的 disposer。provider 包含一个小写的 `id`（作为其工具名称的前缀）、`title`、一句话的 `description`、可选的 `instructions`、`tools()`，以及 `status(signal)`，后者以带说明的 `ready`、`starting` 或 `unavailable` 报告就绪状态。每个工具指定一个执行调用的 harness `ToolDefinition`，并可覆盖其描述与输入 schema、标记自身为只读、通过 `prepare` 准备一次调用（映射其参数，并通过 `call.session(directory)` 选择调用所用的 Agent），以及把结果值转换为 MCP `content`；没有 `content` 时，服务器发送 `output.render` 的文本块。准备好的调用可以 `reveal` 一个 Session。只有当工具名称以 provider id 加下划线开头、且之前没有工具使用该名称时，服务器才会列出它；准备、参数校验或执行的失败都会变成带有错误消息的错误结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

监听器只绑定 `127.0.0.1`。每个请求都必须指向端点路径，通过 MCP SDK 的 localhost Host 与 Origin 检查（以阻止 DNS 重绑定和来自浏览器页面的跨站请求），并携带令牌，令牌以常数时间比较校验；其他请求得到 404、403 或 401。POST 请求体在 4 MiB 以内读取。MCP SDK 的 `createMcpHandler` 为每个请求创建一个低层 MCP 服务器，以无状态方式提供 2026-07-28 协议修订版以及 2025 年的各修订版；其工具列表与指令取自当时的目录；工具列表的变化会送达通过 `subscriptions/listen` 订阅的 agent。

无状态服务不保留连接，因此服务器自行识别每个请求的 agent：依据 2026-07-28 请求信封中的客户端信息、同一 User-Agent 较早发出的 `initialize` 请求中的客户端信息、User-Agent 的产品名，否则视为通用 agent。agent 的名称不会成为 Session 列表中的标题；设置面板显示 Host 启动以来见过的 agent。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `GameMcpServer`：Config、provider 注册表、监听器生命周期、请求检查与 `gameMcp.watch` 流 |
| [`src/http.ts`](src/http.ts) | 回环监听器，以及 Node 请求与 Web 标准请求、响应之间的转换 |
| [`src/server.ts`](src/server.ts) | MCP 处理器与 `tools/list`、`tools/call` 处理函数 |
| [`src/catalog.ts`](src/catalog.ts) | 工具收集、列出、搜索、指令与执行单次调用 |
| [`src/clients.ts`](src/clients.ts) | agent 身份与已见过的 agent |
| [`src/sessions.ts`](src/sessions.ts) | 已连接 agent 的 Session 与 `sessions.json` |
| [`src/token.ts`](src/token.ts)、[`src/prompt.ts`](src/prompt.ts) | 令牌文件与校验，以及设置提示词 |
| [`src/provider.ts`](src/provider.ts)、[`src/types.ts`](src/types.ts) | provider 契约、浏览器安全的视图类型与 `game-mcp/reveal` 事件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍服务器提供的工具、设置面板及承载它的登录对话框，以及协议本身。

- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md#mcp-server-for-other-agents)——服务器如何连接游戏工具、Session 与窗口。
- [Godot 包](../godot/README.zh.md)——Godot 工具与「游戏」标签页。
- [app-mcp](../app-mcp/README.zh.md)——服务器转发其工具的 Blender、GIMP 与 SuperCollider 服务器。
- [ui-game-mcp](../ui-game-mcp/README.zh.md)——设置面板，以及窗口打开已连接 agent 会话的行为。
- [ui-settings-account](../../client/ui-settings-account/README.zh.md)——登录对话框及其替代方案 slot。
- [Model Context Protocol](https://modelcontextprotocol.io)——协议及其 Streamable HTTP 传输。

-----

<a id="model-experience"></a>
## 模型体验

### Session 自身的 agent

#### 模型可见内容

无：本包不在 harness 中注册任何工具或系统提示词文本。

#### Token 影响

不直接产生 token。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

### 已连接 agent 的工具列表与指令

#### 模型可见内容

已连接 agent 的模型会看到 `search_game_tools`、`call_game_tool`，以及每个 provider 工具，其描述与输入 schema 由 [`src/catalog.ts`](src/catalog.ts) 列出——Godot 工具使用 Session 自身的工具描述，并改用面向绝对项目路径的措辞；还会看到服务器指令：先是一段介绍各插件的文字，然后是每个插件在 `## <title>` 下的指令。agent 自身的 harness 决定如何呈现它们。

#### Token 影响

提供四个游戏工具时，指令约 10,500 个字符，51 个工具声明约 43,800 个字符的 JSON；agent 的 harness 决定其中多少进入它的请求。

#### KV Cache 影响

只要 provider 及其工具不变，列表与指令就保持一致；工具较晚出现的 provider（例如 MCP 服务器启动后的 Blender）会改变列表，已订阅的 agent 会收到变化通知。

### 已连接 agent 的工具结果

#### 模型可见内容

provider 工具的结果是其渲染出的文本，Godot 截图以及 Blender、GIMP 和 SuperCollider 服务器发送的图像则作为图像附上。失败会变成带有错误消息的错误结果，例如 `Pass project: the absolute path of the folder that holds project.godot.`。`search_game_tools` 以文本返回插件行与工具列表。

#### Token 影响

超过 100,000 个字符的文本会被截断并附上 `[output truncated: <n> more characters]`；Godot 截图是 PNG 图像，除非调用要求更小，其最长边至多 1,568 像素、面积至多 1,150,000 像素。

#### KV Cache 影响

在 agent 的对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了服务器提供什么以及提供给谁；它们是本包当前的约束。

- **仅限本机 agent**——端点绑定回环地址，因此其他电脑上的 agent 无法访问，没有回环网络访问权限的沙箱中的 agent 也无法访问。
- **完全信任**——持有令牌者可以用用户的权限在 Blender 和 GIMP 中运行 Python、在 SuperCollider 中运行 sclang 代码、在游戏中求值表达式并运行游戏，WASD Engine 不会请求批准；agent 按其自身规则请求批准。提示词中包含令牌，因此用户只应把它粘贴到这台电脑上的 agent 中。
- **单一端口**——第二个 Host（例如与 Desktop 应用同时运行的 `dsh web`）会发现端口已被占用并改用一个空闲端口，其 URL 只在该 Host 的设置面板中显示。
- **空白 Session**——已连接 agent 的 Session 没有轮次，因此 Session 列表把它显示为「新会话」，在其游戏项目中点击「新会话」会打开它；在尚未登录任何 provider 时，窗口显示它会弹出「开始使用」对话框。
- **没有对话记录**——已连接 agent 的工具调用显示在它自己的 harness 中，而不在 Session 里；Session 在「游戏」标签页中显示它的游戏。
- **无状态服务**——同一 agent 的两个实例在每个项目中共用它的 Session、项目默认值与游戏。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

Godot provider 使用与 Session 自身工具相同的 `godotToolDefinitions` 构建其工具定义，因此对某个 Godot 工具的修改无需改动这里即可送达已连接 agent。

</details>
