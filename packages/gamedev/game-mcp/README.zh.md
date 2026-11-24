---
description: "把 WASD Engine 的游戏工具提供给同一台电脑上的其他 agent（智能体），例如 Claude Code 或 Codex：回环 Streamable HTTP 端点及其令牌、由游戏工具插件与 WASD Engine 插件填充的 provider 注册表、搜索与按名调用工具、创建不含 Session 的游戏项目的工具、已连接 agent 的游戏所在的 Session、gameMcp Remote、game-mcp/reveal、game-mcp/tool-result 与 game-mcp/project-created 事件、桌面引导与设置显示的设置提示词，以及 WASD Engine 未登录时对工具调用的拒绝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-game-mcp

[English](README.md) | 中文

## 概述

让这台电脑上的 Claude Code、Codex 和其他 agent 通过 MCP 使用 WASD Engine 的游戏工具。Host 插件监听 `http://127.0.0.1:9273/mcp`，要求提供其数据文件夹中的令牌且 WASD Engine 已登录，并提供游戏工具插件贡献的 `godot_*`、`blender_*`、`gimp_*`、`supercollider_*`、`asset_*`、`audio_*` 等工具，外加 `search_game_tools`、`call_game_tool`，以及创建游戏项目的 `create_game_project`，它创建的项目在 WASD Engine 中列出时不含 Session。已连接 agent 的 Godot 游戏在属于它自己的 Session 里运行，因此会在 WASD Engine 窗口的「游戏」标签页中播放。[`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.zh.md) 在登录后显示设置提示词。

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
    newGameGuidance: |-
      These additional instructions are the recommended prompt for building games with WASD Engine. Do your absolute best to follow them:
      * Put your effort into making what's on screen look, move and sound great
      * People and humanoid figures should look and move like real people, with fitting animations
      * The environment should be believable, textured, with lighting that sells the mood
      * Run and play the demo yourself and fix anything that looks or plays wrong before you finish
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 访问令牌（`token`）与已连接 agent 的 Session 绑定（`sessions.json`）所在的绝对路径文件夹；相对路径会使插件加载失败 |
| `port` | `9273` | 端点的回环端口，0 到 65,535 的整数；0 表示选择空闲端口。端口被其他程序占用时，服务器不会启动，其视图会说明这一点，令牌也会更换（[理解实现](#understand-the-implementation)） |
| `progressIntervalMs` | `30000` | 运行中的工具调用向请求了进度的 agent 发送进度通知的间隔（毫秒），至少为 1 的整数 |
| `readyTimeoutMs` | `8000` | 最初的请求等待组合加载完其插件的最长时间（毫秒，见[服务器指令](#server-instructions)），至少为 1 的整数；默认值低于 Codex 给服务器启动留出的 10 秒 |
| `temporaryFolders` | Host 的临时文件夹，以及 Windows 以外系统上的 `/tmp` 与 `/var/tmp` | agent 存放一次性工作的绝对路径文件夹，其中的文件夹不会经由服务器成为游戏项目（[临时文件夹](#temporary-folders)）；相对路径会使插件加载失败，`[]` 关闭这条规则 |
| `newGameGuidance` | `''` | 附在创建了游戏项目的 `create_game_project` 调用之结果末尾、前面空一行的文本（[创建游戏项目](#create-game-projects)）；为空时不添加，只含空白字符的文本会使插件加载失败 |

profile patch 用 `- id: game-mcp` 与 `disabled: true` 关闭服务器。

### 设置其他 agent

「使用其他智能体设置」由 [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.zh.md) 加入，作为桌面引导的最后一步和设置中的「其他智能体」分区，它显示服务器视图中的设置提示词，以及服务器状态和 Host 启动以来见过的 agent。

[`src/prompt.ts`](src/prompt.ts) 写出的提示词给出服务器名称 `wasd-engine`、URL 与请求头 `Authorization: Bearer <token>`，并给出 Claude Code 与 Codex 的设置方法：

```text
claude mcp add-json wasd-engine '{"type":"http","url":"http://127.0.0.1:9273/mcp","headers":{"Authorization":"Bearer <token>"}}' --scope user
```

```toml
[mcp_servers.wasd-engine]
url = "http://127.0.0.1:9273/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
tool_timeout_sec = 1800
```

除非服务器条目设置了 `tool_timeout_sec`，Codex 会在 60 秒后停止一次工具调用；而上传大型构建的发布或较长的渲染需要数分钟，因此 Codex 条目允许 30 分钟。

令牌是 32 个随机字节的 base64url 形式，首次启动时以 0600 权限写入 `<dataRoot>/token`，因此设置过一次的 agent 在重启后仍可使用。删除该文件后，下次启动会生成新令牌，此后每个 agent 都需要新的提示词。启动时发现端口被其他程序占用，也会生成新令牌，因为之前设置的 agent 会把令牌发给监听该端口的任何程序。

### 已连接 agent 获得的内容

| 工具 | 来源 | 作用 |
|---|---|---|
| `search_game_tools` | 本包 | 列出各插件及其就绪状态与工具数量，以及工具：不带查询时列出每个工具的第一句说明，带查询时列出最匹配的工具及其参数；`plugin` 用于限定插件，带 `plugin` 且不带查询时，结果还包含该插件的指南（[服务器指令](#server-instructions)） |
| `call_game_tool` | 本包 | 按 `name` 与 `arguments` 调用工具，供工具列表中缺少该工具的 agent 使用 |
| `create_game_project` | 本包 | 像「创建游戏项目」对话框那样，根据 `name` 与可选的绝对路径 `location` 创建游戏项目，不在其中打开 Session，并接受 `model`，即 agent 自身 AI 模型的完整名称，已发布游戏的页面会把它记入制作信息（[创建游戏项目](#create-game-projects)） |
| `godot_*` | [`@deepseek-ai/dsh-godot`](../godot/README.zh.md) | Session 自身的十四个 Godot 工具，每个都带有绝对路径参数 `project` |
| `blender_*` | [`@deepseek-ai/dsh-blender`](../blender/README.zh.md)，经由 [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.zh.md) | `wasd_blender` 服务器的工具，由 `mcp__wasd_blender__<tool>` 重命名而来 |
| `gimp_*` | [`@deepseek-ai/dsh-gimp`](../gimp/README.zh.md)，经由 [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.zh.md) | `wasd_gimp` 服务器的工具，由 `mcp__wasd_gimp__<tool>` 重命名而来 |
| `supercollider_*` | [`@deepseek-ai/dsh-supercollider`](../supercollider/README.zh.md)，经由 [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.zh.md) | `wasd_supercollider` 服务器的工具，由 `mcp__wasd_supercollider__<tool>` 重命名而来 |
| `wasd_*` | [`@deepseek-ai/dsh-wasd-plugins`](../wasd-plugins/README.zh.md) | 网页导出与发布工具以及多人联机工具，每个都带有绝对路径参数 `project` |

每位用户都要登录 WASD Engine：账号插件 `@deepseek-ai/dsh-deepseek-account` 报告没有已存储的登录，或无法读取登录时，服务器对每次工具调用（包括 `search_game_tools`、`call_game_tool` 与 `create_game_project`）都返回要求用户登录的错误结果，但仍会列出其工具。服务器在每次调用时读取登录状态，因此用户一登录，工具就能再次使用。没有账号插件的 Host 会执行每次调用。

已连接 agent 彼此共用同一个 Blender worker、同一个 GIMP worker 和同一个 SuperCollider worker，与 WASD Engine 自身各 Session 的 worker 分开（[每个 Session 一个工作进程](../app-mcp/README.zh.md#one-worker-per-session)），除非它们对这些工具的调用传入 `session`：此时每个名称在 `project` 指定的游戏项目中，于该 agent 同名 Session 的 worker 中运行，这也是该名称在 Godot 工具中选择的 Session（[连接的 agent 的 Session](../app-mcp/README.zh.md#connected-agents-sessions)）。这些插件的指南也说明了这一点。

<a id="server-instructions"></a>
### 服务器指令

服务器发给每个 agent 的指令以一段概述开头，由 [`src/catalog.ts`](src/catalog.ts) 写成四段：这些工具的作用是让用户游戏的质量超出单靠代码所能达到的水平，因此 agent 默认使用它们，并在跳过某个适合当前工作的工具时告诉用户原因；新游戏从 `create_game_project` 开始，agent 在首次使用某个插件的工具之前先阅读该插件的指南，指南在哪里，有些指南提到本插件的工具时省略了它的前缀，以及每个辅助 agent 只接一个任务、每个新任务交给新的辅助 agent，因为辅助 agent 的整段对话会在它的每一步重新读取；agent 的计划和最终总结要列出它使用的工具和扩展，并说明为什么跳过每个适合当前工作的工具或扩展，或者为什么一个都不用，而只有工具做不到游戏所需的事情，或会让游戏变差，才算理由；最后是每个插件能带来什么，每个 provider 一行，包含其标题、工具前缀和 `description`。每个 provider 的 `instructions`，即它的指南，跟在 `## <title>` 之下。agent 的 harness 可能截断过长的指令：Claude Code 只把前 4,096 个字符交给它的模型，OpenAI 也要求服务器让前 512 个字符对 Codex 自成一体。因此第一段控制在 512 个字符以内，整段概述必须容纳在 4,096 个字符之内，而概述一旦变长，最先被截掉的是插件列表的末尾，`search_game_tools` 会列出完整的插件列表；带 `plugin` 且不带查询的 `search_game_tools` 会返回该插件的指南，并在前面加一行：指南提到本插件自己的某个工具（结果在指南之后列出这些工具）而省略前缀时，请 agent 加上该插件的前缀。某个 provider 的注册使概述超过 4,096 个字符时，服务器会记录一条给出长度的警告，而 [`wasdengine-game-mcp-overview.spec.ts`](../../bundle/web-app/tests/wasdengine-game-mcp-overview.spec.ts) 用每个随产品发布的 provider 构建概述，概述超长时就会失败。

MCP 只发送一次指令，即在对 `initialize` 或 `server/discover` 的回答中，agent 在整个连接期间都保留这份指令；而监听器随插件一起启动，早于提供游戏工具的那些插件加载完成。因此服务器要等 Loader 的树稳定下来才回答请求：这种稳定涵盖每个插件的导入和启动，也就涵盖了随插件启动而注册的 provider；在应用启动时连接的 agent 会等待回答，而不会收到一份缺少最后加载的插件的概述。令牌放行的第一个请求开始这次等待；等待在 `readyTimeoutMs` 之后结束，并记录一条警告，列出到那时已注册的 provider，或在插件停止时结束；之后的请求不再等待，没有 Loader 的 Host 会立即回答。

<a id="create-game-projects"></a>
### 创建游戏项目

`create_game_project` 通过 Workspace 控制器的 [`gameProjectController`](../../../docs/subsystems/workspace.zh.md#ctxgameprojectcontroller--gameprojectcontroller)（即「创建游戏项目」对话框的 Host 部分）为已连接 agent 创建游戏项目：在 `location`（一个绝对路径，缺失时会被创建，并像对话框那样去掉两端的空格）中创建名为 `name` 的文件夹，省略 `location` 或其为 null 或空白时，则创建在对话框建议的文件夹 `<Documents>/WASD Engine` 中；Git 可用时，文件夹中有一个带有一个空提交的 Git 仓库；然后注册该文件夹，标题为文件夹名，窗口把它列在「游戏项目」下。这次调用不打开任何 Session，因此在用户打开该项目，或某个游戏工具调用指定它并在其中启动该 agent 的 Session 之前，项目不含 Session。结果给出该文件夹的绝对路径，供 agent 之后的调用使用，请 agent 在安装扩展之前先写好游戏的 `project.godot`（安装需要它），并说明 Blender、GIMP 和 SuperCollider 的工具只在同时给出 `session` 时才接受 `project`。`model` 指明 agent 自身的 AI 模型，取值时去掉两端的空格，缺失、为 null 或空白时表示未指明；未指明模型的调用，其结果会请 agent 在首次运行游戏时把 `model` 传给 `godot_run`。设置了 `newGameGuidance` 时，创建了项目的调用的结果会在末尾空一行后附上这段文本：服务器指令的概览作用于每项任务，且已没有余量（[服务器指令](#server-instructions)），而这个结果只送达 agent 一次，正是在它开始一款新游戏、尚未写代码之时。WASD Engine 的行把它设为其推荐提示中的指令：即 `gamedev` 预设的[新游戏指引](../new-game-guidance/README.zh.md)在用户第一条提示之后加入的几行，但去掉了不提问、自主工作的要求，因为已连接的 agent 只从其用户那里接受这一要求。名称不是单个可移植的文件夹名、`location` 不是绝对路径或位于[临时文件夹](#temporary-folders)中、`model` 不是字符串、路径已存在、Host 没有游戏项目控制器，或者调用省略 `location` 而 Host 找不到 Documents 文件夹时，调用都会得到说明原因的错误结果，且不会创建任何内容；对于名称，文本由 Host 给出的原因决定：没有可见字符、含有某些计算机拒绝的字符或长度、是 Windows 保留的设备名（如 `CON` 或 `com1.txt`），或是 `.git`。这次调用不发出 `game-mcp/tool-result`，该事件只报告 provider 工具；创建了项目的调用会发出 `game-mcp/project-created`，带有发起调用的 agent、该文件夹以及调用指明的模型，[WASD Engine 插件](../wasd-plugins/README.zh.md) 据此把该模型记入新游戏的制作信息，监听器的失败会被记录到日志，不影响结果。

<a id="games-in-the-wasd-engine-window"></a>
### WASD Engine 窗口中的游戏

Godot 调用以绝对路径指定项目：包含 `project.godot` 的文件夹、其上方至多三层的文件夹，或 `project.godot` 文件本身；省略 `project` 时，调用使用该 agent 上一次的项目。服务器解析在该项目中运行这个 agent 游戏的 Session：包含该文件夹的已注册游戏项目，或为该文件夹新建的注册，为每个 agent 保存一个 Session；位于[临时文件夹](#temporary-folders)中、且没有已注册游戏项目包含的文件夹不会被注册，该 agent 的 Session 在这个文件夹中工作，不属于任何游戏项目。每个 Session 在首次使用时创建，并记录在 `<dataRoot>/sessions.json` 中，因此 agent 在重启后仍保有它的 Session 与游戏。离开了游戏项目、已归档或已不存在的 Session 会被新的 Session 取代。Godot 调用还可以给出 `session`：一个 1 到 40 个字符、不含控制字符的名称；每个名称在该项目中为该 agent 选择另一个 Session，标题为 `<agent>: <name>`，只有大小写不同的名称选择同一个 Session。共用同一连接、因而共用同一身份的 agent（例如同一 Claude Code 会话中同时工作的多个子 agent）各自给出自己的名称，就能各自运行自己的游戏，而不会重启另一个 agent 正在测试的游戏；某个名称的第一次调用省略 `project` 时，使用该 agent 最近的项目。`godot_run` 会携带该 Session 发出 `game-mcp/reveal`，窗口随即通过 [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.zh.md) 打开该 Session，「游戏」标签页也会像对待任何由 agent 启动的运行一样为这次运行打开。

<a id="temporary-folders"></a>
### 临时文件夹

agent 会在一次性文件夹中测试和试验，例如 Claude Code 位于 `/tmp` 下的 scratchpad；如果每个这样的文件夹都成为游戏项目，用户自己的项目就会淹没在「游戏项目」列表中。因此服务器不在 `temporaryFolders` 中注册游戏项目：默认是 Host 的临时文件夹（由 `TMPDIR`、`TMP` 或 `TEMP` 指定），以及 Windows 以外系统上的 `/tmp` 与 `/var/tmp`。路径的规范写法（解析符号链接后的写法，例如 macOS 上 `/tmp` 指向 `/private/tmp`）等于某个临时文件夹或位于其下时，该路径就在临时文件夹中；尚不存在的路径按其最近的已存在文件夹来写。游戏工具调用指定位于临时文件夹中、且没有已注册游戏项目包含的文件夹时，调用在该 agent 于这个文件夹中的 Session 里运行，该 Session 不属于任何游戏项目：Session 列表像对待所有空白 Session 一样，只在它打开时把它显示在「未分组」下，而窗口仍会为 `godot_run` 打开它。位于临时文件夹中的已注册游戏项目（例如用户自己添加的）仍然保存其 agent 的 Session。`create_game_project` 拒绝位于临时文件夹中的 `location`，并告诉 agent 省略 `location`、传入一个长期保留的文件夹，或自己创建一次性文件夹；无论 Documents 文件夹在哪里，它仍会在 `<Documents>/WASD Engine` 中创建项目。

### 提供工具

`ctx.gameMcp.provide(provider)` 在调用方插件的生命周期内提供该插件的工具，并返回一个幂等的 disposer。provider 包含一个小写的 `id`（作为其工具名称的前缀）、`title`、用一两句话说明其工具做什么、为用户游戏带来什么的 `description`（指令概述会列出它）、可选的 `instructions`（即它的指南）、`tools()`，以及 `status(signal)`，后者以带说明的 `ready`、`starting` 或 `unavailable` 报告就绪状态。每个工具指定一个执行调用的 harness `ToolDefinition`，并可覆盖其描述与输入 schema、标记自身为只读、通过 `prepare` 准备一次调用（映射其参数，通过 `call.session(directory, name)` 选择调用所用的 Agent，并在工具的参数接受模型名称时，转交 agent 自称的 AI 模型名称），以及把结果值转换为 MCP `content`；没有 `content` 时，服务器发送 `output.render` 的文本块。准备好的调用可以 `reveal` 一个 Session；工具还可以通过 `confirmation(value)` 指明一个页面，用户在该页面上确认成功的调用所申请的内容。工具会消耗账号 AI 用量的 provider 设置 `spendsUsage`，这样在 Free 账号继续使用 Free 期间，服务器会把它略去（[用完 AI 用量的 Free 账号](#free-accounts-whose-usage-is-used-up)）。只有当工具名称以 provider id 加下划线开头，且之前的工具和服务器自身的工具都没有使用该名称时，服务器才会列出它；准备、参数校验或执行的失败都会变成带有错误消息的错误结果。工具的 `failureContent(error, args)` 会在执行失败的消息之后追加内容，例如阻止一次发布的 Web 检查的截图；它本身失败时，结果只保留消息。声明了 `timeoutMs` 的工具保留该时限：其执行把到期视为取消，与在 Session 中相同，结果会说明调用已超时。服务器在调用到达时立即执行，可同时执行多个调用，包括同一 agent 及其子 agent 的调用。provider 工具的结果生成后，服务器发出 `game-mcp/tool-result`，带有 provider id、工具名称、准备后的参数、发起调用的 agent、调用所在的 Session（如有）、调用指明的模型（如有），以及 agent 是否收到错误结果；监听器的失败会被记录到日志，不影响结果。[WASD Engine 插件](../wasd-plugins/README.zh.md) 根据这个事件，把连接的 agent 在游戏上用过的工具，以及这些 agent 本身（按它们指明的模型）记入该游戏的制作信息。`ctx.gameMcp.toolOwner(name)` 按连接 agent 所用的工具名，或按运行该工具的 harness 定义的名称，查找当前提供该工具的 provider，并返回 provider 的 id 和标题，以及连接 agent 所用的工具名；[agent 反馈](../agent-feedback/README.zh.md) 借此把 Session 自身对 provider 工具的调用计入该 provider。

<a id="helpers-for-game-tool-plugins"></a>
### 游戏工具插件的辅助函数

`@deepseek-ai/dsh-game-mcp/kit` 收录提供游戏工具的插件共用的部分：`accountAccess` 与 `gatewayOrigin` 用于以已登录账号调用网关，`sessionFiles` 给出调用的文件所在的文件夹，`pathWithin`、`windowPath`、`pathFolder` 与 `pathName` 给出路径所在的位置，`statOf`、`namedFileSize`、`replaceableFile` 与 `writeWhole` 用于调用读写的文件，`textBlocks`、`kilobytes`、`folderRows`、`ATTACHED_IMAGE_SCHEMA` 与 `modelSeesImages` 用于工具结果，`checkedInteger` 用于参数，`stateChanges` 用于每次变化时唤醒的流，`projectMcpTool`、`callFolder` 与 `PROJECT_PARAMETER` 用于已连接 agent 以游戏项目文件夹调用的工具；对于从资源库下载的插件（Poly Haven、ambientCG），还有 `AssetLibraryHttp` 用于只发往该资源库主机的请求，`AssetLibraryRequestError` 给出失败请求的 HTTP 状态码，`AssetLibraryClient` 是各资源库自己的客户端所继承的客户端，提供预览图与下载，`saveBody` 用于把响应连同其摘要流式写入文件，`sessionPreviews`、`shownPreview` 与 `connectedLibraryTools` 用于预览图和两类调用方各自的工具，`downloadFolders` 给出下载写入的文件夹，`writeAssetFiles` 用于要么全部写入要么一个也不写入的文件，`WRITTEN_FILES_SCHEMA` 与 `savedCounts` 用于下载结果中的这些文件。该 kit 只导入 Node 内置模块与类型，因此把本包列为开发依赖的插件打包 kit 时不会带上本插件的服务器与 MCP SDK；[`tests/kit.spec.ts`](tests/kit.spec.ts) 检查其导入。本包的主入口不导出 kit。

资源库辅助函数不抛出自己的错误类。插件传入它的 `errors`：`request` 把失败的请求（以 `AssetLibraryRequestError` 给出，带有 HTTP 状态码，没有响应时为 0）变成插件自己的错误，`exists` 生成文件已存在且内容不同、或目标不是文件时的错误，`corrupt` 生成路径会离开下载文件夹或两个路径指向同一文件时的错误，`disk` 生成文件系统失败时的错误，`argument` 生成 kit 拒绝的文件夹的错误，因此工具结果会记录插件的类名和代码。除取消之外，请求的每种失败都交给 `request`，包括重定向到格式错误的地址，以及资源库发送正文途中连接中断，其消息说明什么也没有保存。`writeAssetFiles` 中文件系统的每个错误，无论是创建文件夹或标记文件、读取已在原位的文件、在文件的 `write` 中写入临时文件，还是把文件移到原位，都交给 `disk`，其消息写明文件、错误代码以及哪些文件已在原位；被取消的下载则以其取消原样失败。之后无法删除的临时文件或标记文件会以隐藏文件的形式留下，不改变下载的结果。

`writeAssetFiles` 把插件的下载所创建的文件夹计入插件持有的文件夹，即插件拥有并传给每次下载的一个 `Map`。一次下载持有它创建的每个文件夹，以及在通往自己文件夹的路上、或在它所持有文件夹之上、由插件另一个正在运行的下载持有的每个文件夹；失败或取消之后最后一个放开某个文件夹的下载，在该文件夹为空时删除它。因此在同一进程中，一个插件的失败下载无论以何种顺序结束，都不会留下它们创建的文件夹。另一个进程或另一个插件的下载不共享这个计数：正在运行的下载在其写入的每个文件夹中放一个隐藏的标记文件，使它们在此期间不会删除该文件夹；但当其中一个下载在本插件的下载所创建的文件夹中工作，并且两者都失败时，该文件夹可能作为空文件夹留下。

### 长时间调用

一次工具调用可能持续数分钟，例如上传大型构建的发布。对每个请求的响应都是一个事件流，请求一到达即开始，并每 15 秒发送一条保活注释，因此等待固定时长让响应开始的 agent 会继续等待：Claude Code 对响应在 60 秒后仍未开始的 HTTP MCP 请求会放弃，并报告 `The operation timed out.`。调用运行期间，请求了进度的 agent（Claude Code 即是如此）每隔 `progressIntervalMs` 收到一条进度通知，其消息给出已用时间，因此对长时间没有任何报告的调用会放弃的 agent（Claude Code 在 5 分钟后放弃）也会继续等待。Codex 把每次调用限制在其 `tool_timeout_sec` 以内，设置提示词中的 Codex 条目会设置该值。

<a id="confirmation-pages"></a>
### 确认页面

当工具指明了确认页面（例如用户在 WASD Engine 网站上确认的游戏服务器购买）时，如果 agent 的客户端在 2026-07-28 修订版上声明了 URL 模式征询（`elicitation.url`），调用会以一个需要输入的结果到达该客户端，其中包含该页面和要确认的内容。客户端向用户展示该页面并重试调用；重试返回调用的内容，并附上一行说明用户如何回应，而不会再次运行工具。其他所有客户端只收到内容本身，其中也给出了该页面，因为以无状态方式提供的 2025 修订版不会随调用携带客户端能力。内容放在不透明的 `requestState` 中传递，用服务器进程的密钥封存，绑定到 `tools/call` 和发起调用的 agent，有效期 30 分钟；被改动的状态会被拒绝。

<a id="free-accounts-whose-usage-is-used-up"></a>
### 用完 AI 用量的 Free 账号

有四个 provider 的工具会消耗 WASD Engine 账号的 AI 用量：ElevenLabs、Nano Banana、画面审查，以及账号服务会为其网络搜索计费的美术参考，它们用 `spendsUsage` 标记自己。当其中某个工具的调用失败、且消息说明已达到用量上限时，服务器通过账号插件的余额读取账号的套餐和用量，WASD Engine 账号服务会在其中报告 `plan` 和 `used_up`。对于用量已用完的 Free 账号，服务器会用一个选择代替这次失败交给用户（[`src/free-plan.ts`](src/free-plan.ts)）：在账号服务的 `/upgrade?plan=pro` 页面升级到 Pro（该页面会直接进入 Pro 的结账），或者继续使用 Free：WASD Engine 仍可继续使用，但生成的音频、视频、3D 模型、动画和图形的质量会下降。在 2026-07-28 修订版上声明了 URL 模式征询的客户端，会像展示[确认页面](#confirmation-pages)一样展示该页面和这条提醒：拒绝打开即继续使用 Free，重试只告诉 agent 该工具现在不可用；打开或忽略该页面则保留这些工具。其他所有客户端会收到一段文本，由 agent 连同页面一起转告用户；除非用户升级，否则继续使用 Free。付费套餐用完用量的情况，以及所有其他失败，都保持原样。

用户继续使用 Free 期间，服务器不向连接的 agent 提供这些 provider：它们的工具从 `tools/list`、`search_game_tools` 以及指令的概述和指南中移除，按名称调用也找不到这样的工具，也不会告诉 agent 原因。这一选择持续到账号服务报告的用量刷新时间，并保存在 `<dataRoot>/free-plan.json` 中，因此重启后依然有效。选择有效期间，当上一次读取已满一分钟时，请求会再次读取账号；读到仍有用量（例如升级或获得新额度之后）即结束这一选择，工具随之恢复；用量再次用完时，会再次询问用户。Session 自身的 agent 不受影响。

MCP 没有能更改 agent 连接时所收到指令的消息：指令只在对 `initialize` 或 `server/discover` 的应答中发送一次。因此服务器为每个 agent 记住它上次收到指令或提示时这些 provider 是否已关闭；这些 provider 关闭或重新开启之后，agent 收到的第一个工具结果末尾会附上一次提示：`Note: WASD Engine turned off these game tools for now: <title> (<id>_*), …. Do not call them, even where the server instructions or a guide name them; use WASD Engine's other game tools instead.`，或者说明它们已重新可用，agent 的工具列表缺少它们时可通过 `call_game_tool` 调用。两条提示都不说明原因。服务器未见过其接收指令的 agent（例如 WASD Engine 重启之后）被视为收到的是这些 provider 开启时的指令。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

监听器只绑定 `127.0.0.1`。每个请求都必须指向端点路径，通过 MCP SDK 的 localhost Host 与 Origin 检查（以阻止 DNS 重绑定和来自浏览器页面的跨站请求），并携带令牌，令牌以常数时间比较校验；其他请求仅凭请求头就得到 404、403 或 401，请求体的任何部分都不会被读取。被放行请求的 POST 请求体在 4 MiB 以内读取。配置的端口被其他程序占用时，服务器不会改为监听另一个端口，因为设置提示词中的端口只到下次启动前有效；它会生成新令牌，使从 agent 那里拿到旧令牌的程序在服务器再次运行后无法使用，并在视图中请用户退出该程序、重启 WASD Engine，再重新设置 agent。被放行的请求会立即计入见过的 agent，然后如[服务器指令](#server-instructions)所述等待组合，等待通过用 `ctx.get('loader')` 读到的 Loader 服务的 `await()` 进行。MCP SDK 的 `createMcpHandler` 为每个请求创建一个低层 MCP 服务器，以无状态方式提供 2026-07-28 协议修订版以及 2025 年的各修订版；其工具列表与指令取自当时的目录；工具列表的变化会送达通过 `subscriptions/listen` 订阅的 agent。

无状态服务不保留连接，因此服务器自行识别每个请求的 agent：依据 2026-07-28 请求信封中的客户端信息、同一 User-Agent 较早发出的 `initialize` 请求中的客户端信息、User-Agent 的产品名，否则视为通用 agent。agent 的名称不会成为 Session 列表中的标题；设置面板显示 Host 启动以来见过的 agent。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `GameMcpServer`：Config、provider 注册表、监听器生命周期、请求检查、对组合的等待与 `gameMcp.watch` 流 |
| [`src/http.ts`](src/http.ts) | 回环监听器，以及 Node 请求与 Web 标准请求、响应之间的转换 |
| [`src/server.ts`](src/server.ts) | MCP 处理器、`tools/list` 与 `tools/call` 处理函数，以及确认页面的 URL 征询 |
| [`src/catalog.ts`](src/catalog.ts) | 工具收集、列出、带插件指南的搜索、指令及其概述，以及执行单次调用 |
| [`src/projects.ts`](src/projects.ts) | `create_game_project`：其参数、默认位置，以及通过 `gameProjectController` 的创建 |
| [`src/clients.ts`](src/clients.ts) | agent 身份与已见过的 agent |
| [`src/sessions.ts`](src/sessions.ts) | 已连接 agent 的 Session 与 `sessions.json` |
| [`src/kit.ts`](src/kit.ts)、[`src/plugin-kit.ts`](src/plugin-kit.ts)、[`src/project-tools.ts`](src/project-tools.ts)、[`src/asset-library.ts`](src/asset-library.ts) | 供游戏工具插件使用的 `/kit` 入口：网关访问、调用的文件、结果的组成部分、以游戏项目文件夹为参数的工具，以及资源库插件共用的部分 |
| [`src/temporary-folders.ts`](src/temporary-folders.ts) | 默认的临时文件夹，以及某个路径是否位于其中 |
| [`src/token.ts`](src/token.ts)、[`src/prompt.ts`](src/prompt.ts) | 令牌文件与校验，以及设置提示词 |
| [`src/provider.ts`](src/provider.ts)、[`src/types.ts`](src/types.ts) | provider 契约与 `game-mcp/tool-result`、`game-mcp/project-created` 事件、浏览器安全的视图类型与 `game-mcp/reveal` 事件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍服务器提供的工具、设置内容及承载它的账号功能，以及协议本身。

- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md#mcp-server-for-other-agents)——服务器如何连接游戏工具、Session 与窗口。
- [Godot 包](../godot/README.zh.md)——Godot 工具与「游戏」标签页。
- [app-mcp](../app-mcp/README.zh.md)——服务器转发其工具的 Blender、GIMP 与 SuperCollider 服务器。
- [ui-game-mcp](../ui-game-mcp/README.zh.md)——「使用其他智能体设置」，以及窗口打开已连接 agent 会话的行为。
- [ui-settings-account](../../client/ui-settings-account/README.zh.md)——必需的登录与桌面引导的最后一步。
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

已连接 agent 的模型会看到 `search_game_tools`、`call_game_tool`、`create_game_project`，以及每个 provider 工具，其描述与输入 schema 由 [`src/catalog.ts`](src/catalog.ts) 列出——Godot 工具使用 Session 自身的工具描述，并改用面向绝对项目路径的措辞；Blender、GIMP 与 SuperCollider 工具使用其服务器自身的描述，并加上 `session` 与 `project`；还会看到服务器指令：先是一段概述，说明为什么要使用这些工具、指南在哪里、跳过工具和扩展时要告诉用户什么，以及每个插件能带来什么，然后是每个插件在 `## <title>` 下的指南。agent 自身的 harness 决定如何呈现它们。

#### Token 影响

Web 与 Desktop profile 的全部十四个 provider，即 Godot、Blender、GIMP、SuperCollider、Poly Haven、ElevenLabs、Nano Banana、素材工具、音频工具、美术参考、画面审查、反馈工具、游戏扩展与 WASD Engine 插件都提供工具时，指令约 33,200 个字符（其中约 4,100 个是概述，约 6,000 个是最大的 Blender 指南），92 个工具声明约 133,800 个字符的 JSON，其中约 12,600 个是 40 个 Blender、GIMP 与 SuperCollider 工具的 `session` 与 `project` 参数。Claude Code 把指令的前 4,096 个字符交给它的模型，即概述和第一份指南的开头；agent 的 harness 决定其余部分有多少进入它的请求。

#### KV Cache 影响

只要 provider 及其工具不变，列表与指令就保持一致；工具较晚出现的 provider（例如 MCP 服务器启动后的 Blender）会改变列表，已订阅的 agent 会收到变化通知。

### 已连接 agent 的工具结果

#### 模型可见内容

provider 工具的结果是其渲染出的文本，Godot 截图、Poly Haven 预览图、素材工具绘制的图片、调用请求时音频审阅的波形与频谱图、参考工具的联系表和保存的参考，以及 Blender、GIMP 和 SuperCollider 服务器发送的图像则作为图像附上。失败会变成带有错误消息的错误结果，例如 `Pass project: the absolute path of the folder that holds project.godot.`。`search_game_tools` 以文本返回插件行、不带查询时所搜索插件的指南，以及工具列表。`create_game_project` 返回一句给出新游戏项目及其文件夹的话、一句说明该文件夹是否包含 Git 仓库的话、请 agent 围绕 `search_game_tools` 所列的插件规划游戏并阅读它将使用的每个插件的指南的要求、请 agent 在其中制作游戏并在安装扩展之前先写好 `project.godot` 的要求、如何把该文件夹传给游戏工具的说明（其中 Blender、GIMP 和 SuperCollider 的工具只在同时给出 `session` 时才接受 `project`），以及在调用未指明 `model` 时，请 agent 把自身 AI 模型的名称传给 `godot_run` 的要求；设置了 `newGameGuidance` 时，其后空一行附上该文本，WASD Engine 的行把它设为其推荐的游戏制作提示中的指令；被拒绝的名称会得到与 Host 给出的原因相应的文本，例如 `"con.txt" is not a folder name that every computer accepts: Windows reserves CON, PRN, AUX, NUL, COM0 to COM9, COM¹, COM², COM³, LPT0 to LPT9, LPT¹, LPT², and LPT³ for devices, with or without an extension. Pass another name.`，位于临时文件夹中的 `location` 会得到 `<location> is in a temporary folder, whose files the system may delete, so WASD Engine creates no game project there.` 以及应改做什么的说明。WASD Engine 未登录时，每次调用都返回错误结果 `WASD Engine is signed out, and its game tools need a signed-in user. Ask the user to open WASD Engine and sign in, then call the tool again.`对于用量已用完的 Free 账号，一次消耗该用量的工具调用失败后：用户拒绝升级页面时返回 `This tool is not available now. Go on with the work using WASD Engine's other game tools.`；不展示页面的客户端则收到一段文本，请 agent 连同页面把这一选择转告用户。这些 provider 关闭或重新开启之后，agent 收到的第一个结果末尾会附上列出它们的提示。

#### Token 影响

超过 100,000 个字符的文本会被截断并附上 `[output truncated: <n> more characters]`；Godot 截图是 PNG 图像，除非调用要求更小，其最长边至多 1,568 像素、面积至多 1,150,000 像素。随附的 `newGameGuidance` 为每个创建的项目的结果增加 476 个字符，约 110 个 token。

#### KV Cache 影响

在 agent 的对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了服务器提供什么以及提供给谁；它们是本包当前的约束。

- **仅限本机 agent**——端点绑定回环地址，因此其他电脑上的 agent 无法访问，没有回环网络访问权限的沙箱中的 agent 也无法访问。
- **完全信任**——持有令牌者可以用用户的权限在 Blender 和 GIMP 中运行 Python、在 SuperCollider 中运行 sclang 代码、在游戏中求值表达式并运行游戏，WASD Engine 不会请求批准；agent 按其自身规则请求批准。提示词中包含令牌，因此用户只应把它粘贴到这台电脑上的 agent 中。
- **单一端口**——第二个 Host（例如与 Desktop 应用同时运行的 `dsh web`）会发现端口已被占用并改用一个空闲端口，其 URL 只在该 Host 的设置内容中显示。
- **空白 Session**——已连接 agent 的 Session 没有轮次，因此 Session 列表把它显示为「新会话」，在其游戏项目中点击「新会话」会打开它；在尚未登录任何 provider 时，窗口显示它会弹出「开始使用」对话框。
- **只创建新文件夹**——`create_game_project` 只创建新的文件夹；已有的、不在临时文件夹中的文件夹会在某个游戏工具调用第一次指定它时成为游戏项目，同时创建发起调用的 agent 的 Session。新项目不会成为之后 Godot 调用的默认项目；在某次调用传入 `project` 之前，这些调用仍使用该 agent 上一次的项目。
- **只有新项目带有指引**——新游戏指引经由 `create_game_project` 的结果送达 agent，因此在 agent 或用户以其他方式创建的文件夹中制作游戏的 agent 收不到指引；agent 会把指引当作来自工具的文本，其分量低于其用户自己的指令。
- **按位置判断临时**——服务器按文件夹所在的位置判断一次性工作：agent 存放在其他位置的文件夹仍会成为游戏项目，而用户保留在临时文件夹中的游戏只有在用户添加它之后才会成为游戏项目。不属于任何游戏项目的 Session 在打开其他 Session 后就会离开 Session 列表，其标题栏也不显示「扩展」「导出 / 分享」与「多人联机」按钮，因为这些按钮作用于游戏项目。
- **没有对话记录**——已连接 agent 的工具调用显示在它自己的 harness 中，而不在 Session 里；Session 在「游戏」标签页中显示它的游戏。
- **指令被 harness 截断**——Claude Code 只把指令的前 4,096 个字符交给它的模型，因此概述之后的指南只能通过 `search_game_tools` 到达它，而概述必须容纳在其中：在随附的十四个 provider 下，概述约 4,070 个字符，新 provider 的那一行大约还有 25 个字符可用；某次注册使概述变长超限时，服务器会发出警告。概述超长时，被截掉的是排在最后的插件列表的末尾。
- **启动时的等待**——在 WASD Engine 启动期间连接的 agent 会等待插件加载，最多等待 `readyTimeoutMs`；更晚才加载完的插件不在该 agent 的概述中（MCP 只发送一次概述），它会通过其工具的 `tools/list_changed` 和 `search_game_tools` 到达该 agent。
- **无状态服务**——同一 agent 的两个实例在每个项目中共用它的 Session、项目默认值与游戏，除非它们的 Godot 调用给出不同的 `session` 名称；它们对 Blender、GIMP 与 SuperCollider 工具的调用若未给出 `session`，则各共用一个 worker。
- **2025 客户端的取消**——使用 2025 修订版的客户端以 `notifications/cancelled` 请求取消调用，该请求到达的是另一个独立的服务器，无法到达正在运行的调用，因此调用只会在其请求关闭或其工具的时限到达时结束。
- **Free 选择与指令**——用户选择继续使用 Free 之后，agent 在连接时收到的指令仍保留消耗用量的 provider 的行和指南，只有其下一个工具结果中的提示说明它们已关闭；它们的工具会从其列表中移除，对它们的调用也找不到工具。服务器对每个 agent 身份只提示一次，因此同一 agent 的两个实例（例如两个 Claude Code 会话）中，只有先发起调用的那个会收到提示。其他 provider 的指南和描述仍可能提到这些工具，例如 SuperCollider 的描述提到了 ElevenLabs。
- **确认页面按进程有效**——封存确认状态的密钥存在于服务器进程中，因此 Host 重启后的重试会被拒绝；客户端展示过的页面仍然有效，指明该页面的工具可以列出等待确认的内容，`wasd_server_status` 即是如此。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

Godot provider 使用与 Session 自身工具相同的 `godotToolDefinitions` 构建其工具定义，因此对某个 Godot 工具的修改无需改动这里即可送达已连接 agent。

修改新游戏指引之后，[`game-mcp-live-agents.e2e.ts`](../../../apps/web/tests/game-mcp-live-agents.e2e.ts) 会用这台计算机上安装并已登录的 Claude Code 检查它，消耗其自身的用量：先运行 `pnpm run build`，再运行 `WASD_LIVE_AGENTS=claude pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/game-mcp-live-agents.e2e.ts`，然后加上 `WASD_LIVE_AGENTS_GUIDANCE=off` 再运行一次以比较计划。

</details>
