---
description: "WASD Engine 插件，即 WASD Engine 自带且始终开启的功能：每个会话和 WASD Engine 的 MCP 服务器都提供 wasd_export_web 与 wasd_release_game 工具，用于把 Godot 游戏导出为网页版，并作为带分享链接的编号版本发布到 WASD Engine 网站；wasdPlugins Remote；会话标题栏与新会话页面上的“发布”按钮；侧边栏中的“探索游戏”；以及输入框推理等级选择器旁的首次构建提示。"
kind: "package-reference"
---

# @deepseek-ai/dsh-wasd-plugins

[English](README.md) | 中文

## 概述

WASD Engine 插件包含 WASD Engine 自带的功能，在每个 Web 与桌面配置中始终开启。它把游戏导出为网页版，并作为下一个编号版本发布到应用所登录的 WASD Engine 网站；分享链接页面中任何人都可以游玩、选择更早的版本并评论。会话的智能体与连接的智能体获得同样的工具；“发布”按钮请智能体发布，“探索游戏”打开已发布游戏的页面。对于新游戏，推理等级选择器旁的提示建议使用 Max 推理等级并启用智能体团队协作。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `wasd-plugins` 行插入每个 Web 与桌面配置：

```yaml
- id: wasd-plugins
  name: '@deepseek-ai/dsh-wasd-plugins'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `explorePath` | `/explore` | WASD Engine 网站上“探索”页面的路径；“探索游戏”打开该页面 |

插件管理器把本包列入 `WASD_ENGINE_PLUGINS`，[`@deepseek-ai/dsh-official-bundles`](../../util/official-bundles/README.zh.md) 将其加入 `PROTECTED_PLUGINS`，因此插件页面、插件管理工具和 `pluginManager` Remote 都拒绝关闭这一行。本包需要 [`@deepseek-ai/dsh-godot`](../godot/README.zh.md) 的 `godot` 服务来导出，并需要 `deepseekAccount` 服务提供网站来源与已登录的令牌。

### 工具

| 工具 | 作用 |
|---|---|
| `wasd_export_web` | 通过 `ctx.godot.exportWeb()` 把 Godot 项目导出到其 `.wasdengine/web/` 文件夹：一个单线程构建，包含 `index.html`、引擎和数据包，任何静态网页服务器都能提供服务。第一次导出会下载 Godot 的 Web 模板，约 10 MB |
| `wasd_release_game` | 导出项目，把构建上传到网站的游戏 API，作为该游戏的下一个版本（1、2、3……），并返回分享链接。在一个网站上的第一次发布会创建游戏，标题取自 `project.godot`，除非 `title` 另有指定；`notes` 最多 1,000 个字符，显示在游戏页面上；`cover_image` 是 PNG、JPEG 或 WebP 文件，作为游戏在“探索”页面上的图片 |

在会话中，`project` 和 `cover_image` 相对于工作目录；不传 `project` 时，工具使用最近的 `project.godot`。通过 WASD Engine MCP 服务器连接的智能体在提供者 `wasd` 下使用这些工具，并且必须传入绝对路径。发布需要已登录的 WASD Engine：未登录时，工具失败并提示用户登录；登录过期时，工具失败并提示用户重新登录。

项目在 `.wasdengine/game.json` 中按网站记住它的游戏，因此同一文件夹之后的发布会为同一个游戏添加版本。当网站上已没有该游戏，或该游戏属于另一个账户时，发布会创建新游戏。`title` 会重命名已有的游戏。网站为版本连续编号，且每个更早的版本都仍可游玩。

### “发布”按钮与“探索游戏”

当会话属于某个游戏项目，并且 Peer 可以向该会话发送提示并调用 `wasdPlugins/project` 时，“发布”按钮出现在会话标题栏中。空白会话的标题栏在首次发送提示之前不显示操作，因此会话仍为空白时，按钮改为出现在新会话页面上，位于游戏项目与智能体预设选择器那一行的右端、分支控件之前。它打开一个对话框：显示项目最近一次发布及其页面链接，拒绝没有 `project.godot` 的文件夹，并接受可选的更新说明。点击“发布”会用窗口的语言向会话发送一条提示，请智能体用这些更新说明（或根据改动自行撰写的说明）调用 `wasd_release_game`，并回复分享链接，因此导出和上传会作为用户可以观看的一轮对话运行。

当 Peer 可以调用 `wasdPlugins/links` 时，“探索游戏”位于左侧边栏底部的“设置”上方。它通过 `window.open` 打开网站的“探索”页面：桌面应用把链接交给系统浏览器，Web UI 在新标签页中打开。在窄侧栏中它只显示地球图标，标签作为提示文字出现。

### 首次构建提示

输入框推理等级选择器旁的卡片建议游戏首次构建时使用 Max 推理等级并启用智能体团队协作。卡片在以下条件同时满足时出现：会话的工作目录（游戏项目文件夹或其 worktree）中除隐藏条目外没有任何内容，例如新游戏项目的 `.git` 文件夹，以及 Windows 的 `Thumbs.db` 与 `desktop.ini` 文件；会话处于空闲状态；会话的推理等级低于 Max 或未启用智能体团队协作。它要求会话是游戏项目的根会话、所选模型提供 Max 推理等级、组合中包含智能体团队，并且 Peer 可以调用 `session/selectModel` 和 `agentTeams/setEnabled`。模型菜单打开或输入框锁定时，以及模型选择器未显示或位于 inert 区域（例如打开的侧边栏抽屉之后）时，卡片隐藏。卡片紧贴在输入框下方，右边缘与推理等级选择器对齐，箭头指向该选择器；窗口下方空间不足时移到输入框正上方，不遮挡草稿，箭头随之调整。

“使用 Max + 团队协作”为会话的模型选择 Max 推理等级并启用智能体团队协作，已经开启的一项会跳过；随后卡片确认两项均已开启，约三秒后消失。某项设置被拒绝时，卡片保持打开并显示原因。“暂不”，或卡片获得焦点时按 Escape，会在当前浏览器中隐藏该游戏项目的提示。提示通过 `workspaceFiles` Remote 跟踪文件夹的直接条目，文件夹一有内容就停止跟踪，因此首次构建写入的文件会让提示永久消失。它占用本分支为 [`@deepseek-ai/dsh-client-ui-model-selection`](../../client/ui-model-selection/README.zh.md) 的模型选择器添加的 `conversation.input.model.callout` 插槽。

### `wasdPlugins` Remote

| 方法 | 返回 |
|---|---|
| `project(projectDir)` | 该绝对路径文件夹是否包含 `project.godot`，以及它在应用所登录的网站上发布到的游戏：标题、分享页面和最新版本 |
| `links()` | 网站的“探索”页面 |

LiveShare 把这两个方法都保留给所有者，因为发布是以所有者的账户进行的。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

网站来源来自账户插件：即使未登录，其账户视图中的链接也指明网站；登录后，`getPlatformSession()` 会连同令牌一起给出网站。每次网站调用都在 `x-dsh-auth-token` 中发送令牌、拒绝重定向，并把 401 映射为登录过期的提示；其他拒绝由网站自己的消息说明，5xx 则提示稍后重试。

发布会把导出结果写入系统临时文件夹中的 ZIP 文件：每个文件通过 `node:zlib` 流式写入，已经压缩的格式按原样存储；然后把它作为 `POST /api/v1/games/<id>/releases` 的请求体上传，更新说明放在查询字符串中，上传后删除该文件。上传返回 404 表示游戏在此期间被删除，此时会创建新游戏并再次上传。网站拒绝的封面会成为结果中的一条说明，因为该版本已经发布。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `WasdPlugins`：配置、工具注册、游戏 MCP 提供者和 `wasdPlugins` Remote |
| [`src/tools.ts`](src/tools.ts) | 工具定义及其 MCP 包装 |
| [`src/release.ts`](src/release.ts) | 网站 API 客户端、游戏关联文件和发布流程 |
| [`src/zip.ts`](src/zip.ts) | 上传所用的流式 ZIP 写入器 |
| [`src/client/`](src/client/) | “发布”按钮、“探索游戏”、首次构建提示、它们的文案和 Remote 挂载 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍导出、向其他智能体提供工具的 MCP 服务器，以及托管已发布游戏的网站。

- [Godot 包](../godot/README.zh.md#web-export) — 无窗口的 Web 导出及其模板。
- [game-mcp](../game-mcp/README.zh.md) — 面向本机智能体的 MCP 服务器。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md) — 游戏工具、会话与窗口如何连接。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的智能体看到 `wasd_export_web`（可选参数 `project`）和 `wasd_release_game`（可选参数 `project`、`notes`、`title` 和 `cover_image`）。发布工具的描述要求模型只在用户要求时才发布，因为每次调用都会公开一个版本。连接的智能体看到同样的工具，参数为绝对路径，并在 `## WASD Engine` 下看到提供者的说明。

#### Token 影响

两个声明合计约 1,700 个字符的 JSON；提供者的说明为 MCP 服务器的说明增加约 550 个字符。

#### KV Cache 影响

两个声明都是静态的，因此保留在已缓存的工具前缀中。

### 工具结果

#### 模型可见内容

`wasd_export_web` 给出输出文件夹、其中的文件及其大小，并说明要通过网页服务器打开 `index.html`。`wasd_release_game` 给出标题、版本、分享链接和该版本的链接，并说明分享页面列出更早的版本并接受评论。两者都会列出关于网页版构建的说明，例如 Forward+ 项目使用兼容性渲染器，以及导出的警告。失败会附带原因，例如未登录的提示或 Godot 的导出错误。

#### Token 影响

结果约几百个字符，外加最多十条说明。

#### KV Cache 影响

在对话中仅追加。

### “发布”提示

#### 模型可见内容

“发布”按钮以窗口的语言发送一条用户消息，例如“在 WASD Engine 上发布这个游戏：调用 wasd_release_game，并附上简短的更新说明，概括自上次发布以来的改动，然后把分享链接给我。”，或附上用户更新说明的同一请求。

#### Token 影响

一条简短的用户消息。

#### KV Cache 影响

与任何用户消息一样，仅追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了发布的范围；它们是本包当前的约束。

- **仅限 Godot** — 工具导出 Godot 项目；其他引擎的游戏需要自己的网页版构建并调用网站的 API。
- **兼容性渲染器** — 网页版构建使用 WebGL 2 渲染，因此 Forward+ 与 Mobile 的效果会缺失或看起来不同，且构建不支持线程和 GDExtension。
- **单一模板版本** — Godot 插件固定使用 Godot 4.7.2 的 Web 模板；其他运行时版本需要在该插件的配置中设置其模板归档的 URL 和 SHA-256。
- **公开发布** — 每次发布都会公开出现在网站的“探索”页面上；删除游戏需要调用网站的 API。
- **按登录的网站发布** — 项目发布到应用所登录的网站；登录另一个网站会在那里创建另一个游戏。
- **首次构建提示按浏览器记录** — “暂不”保存在当前浏览器的 localStorage 中，因此在其他浏览器中或清除网站数据后，仍为空的游戏项目会再次显示提示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

WASD Engine 中既不是游戏工具、也不来自上游的每项功能都属于本包，这样它会与其余功能一起保持开启。发布会调用网站的 `GET`、`POST` 和 `PATCH /api/v1/games[/<id>]`、`POST /api/v1/games/<id>/releases` 以及 `PUT /api/v1/games/<id>/cover`。

</details>
