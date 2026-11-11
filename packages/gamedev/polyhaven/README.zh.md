---
description: "面向 agent（智能体）的 Poly Haven：每个会话和 WASD Engine 的 MCP 服务器都提供 polyhaven_search、polyhaven_asset 与 polyhaven_download 工具，用于在 Poly Haven 资源库中查找 CC0 的 HDRI、纹理和 3D 模型，查看其文件与预览图，并保存到游戏项目中。"
kind: "package-reference"
---

# @deepseek-ai/dsh-polyhaven

[English](README.md) | 中文

## 概述

Poly Haven 插件让 agent（智能体）在 [Poly Haven](https://polyhaven.com) 的资源库中为游戏查找素材：免费的 HDRI 天空、可平铺的 PBR 纹理和 3D 模型，全部采用 CC0 许可，并把它们保存到游戏项目中。agent 可以用任何语言按描述搜索，按分类浏览下载最多的素材，查看某个素材的格式、大小和预览图，并下载一种格式和分辨率，例如带纹理的 glTF 模型，每个文件的摘要都会经过校验。通过 WASD Engine 的 MCP 服务器连接的 agent，例如 Claude Code 或 Codex，获得同样的工具。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `polyhaven` 行插入每个 Web 与桌面配置，不带配置：

```yaml
- id: polyhaven
  name: '@deepseek-ai/dsh-polyhaven'
```

「设置 › 内置插件」与「插件」页面的「游戏工具」标签页以 Poly Haven 标志列出这一行；「插件」页面上的开关会在 profile patch 中写入 `- id: polyhaven` 与 `disabled: true` 来关闭它。启用时不发出任何请求；第一次搜索才读取 Poly Haven 的素材列表。插件需要 `tools` 与 `workingDirectory` 服务。有 `attachments` 与 `llm` 服务时，它向模型接受图像的会话显示预览图；有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，它把工具提供给连接的 agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiUrl` | `https://api.polyhaven.com` | Poly Haven API 的基础 URL |
| `userAgent` | `WASD Engine` | 每个请求的 `User-Agent`；Poly Haven 的 API 条款要求它写明软件名称 |
| `requestTimeoutMs` | `30000` | 一次 `polyhaven_search` 或 `polyhaven_asset` 调用的时间上限 |
| `downloadTimeoutMs` | `600000` | 一次 `polyhaven_download` 调用的时间上限 |
| `maxDownloadBytes` | `1073741824` | 一次下载全部文件的最大总大小，1 GiB |
| `catalogMaxAgeMs` | `43200000` | 素材列表在内存中保留的时间，12 小时，即 API 允许缓存保留它的时长；0 表示每次搜索都重新读取 |

### 工具

| 工具 | 作用 |
|---|---|
| `polyhaven_search` | 用 Poly Haven 的搜索为 `query` 排序素材，该搜索能在任何语言中匹配同义词，并按相关度从高到低列出素材的 id、种类、分类、最大分辨率、真实尺寸、多边形数和描述。没有 `query` 时，列出下载最多的素材，以及 `category` 下一级的分类。`type`（`hdris`、`textures` 或 `models`）与 `category`（如 `Furniture/Seating` 这样的路径，逐段匹配且不区分大小写）缩小列表范围；`limit`（1 到 50，默认 10）与 `offset` 用于分页。当搜索返回 HTTP 503 时，插件自行按查询词在名称、标签、分类和描述中的出现情况排序 |
| `polyhaven_asset` | 显示素材 `id`：它的描述、作者、标签、真实尺寸、多边形数和 polyhaven.com 上的页面；每种下载格式及各分辨率的大小；纹理的贴图以及下载默认包含的贴图；除非 `preview` 为 false，还有它的预览图，一张 512 像素的 JPEG |
| `polyhaven_download` | 把素材的一种 `format` 和 `resolution`，连同该格式引用的每个文件，保存到 `directory`，默认是工作目录中的 `assets/polyhaven/<id>`，并说明打开素材的文件 |

| 种类 | 格式 | 默认值 |
|---|---|---|
| HDRI | `hdr` 或 `exr` 全景图 | `hdr` |
| 纹理 | `jpg`、`png` 或 `exr` 贴图；带贴图的 `gltf`、`blend` 或 `mtlx` 材质 | `jpg` 贴图：除名称以 `nor_dx` 结尾的 DirectX 法线贴图外的全部贴图；`maps` 可指定其他贴图 |
| 模型 | 带缓冲区和纹理的 `gltf`、`fbx`、`blend` 或 `usd` | `gltf` |

没有 `resolution` 时，下载使用 `1k`；该格式没有 `1k` 时使用最小的分辨率。超过 `maxDownloadBytes` 的下载在写入任何内容之前失败，并说明其大小。

一次下载要么写入全部文件，要么一个也不写入。每个文件先流式写入目标旁边的临时文件，其大小和 MD5 摘要必须与 Poly Haven 文件列表一致，只有在所有文件都完好到达后，这些文件才替换各自的目标；失败或取消会让文件夹保持原样。已在原位且摘要相同的文件不会再次下载。内容不同的文件，例如用户编辑过的纹理，会在写入任何内容之前中止下载，除非 `replace` 为 true。文件列表中会离开下载文件夹的路径同样会中止下载。

通过 WASD Engine 的 MCP 服务器连接的 agent 在提供方 `polyhaven` 下使用这些工具，不需要会话：`polyhaven_search` 与 `polyhaven_asset` 标记为只读，预览图以 JPEG 字节的形式跟在结果文本之后，`polyhaven_download` 要求 `directory` 为绝对路径。

### Poly Haven 的条款

Poly Haven 的素材采用 CC0 许可，游戏可以使用它们，包括商业用途，且无需署名。每个结果都写明素材在 polyhaven.com 上的页面，便于 agent 记录来源，正如 `gamedev` 预设对每个第三方素材的要求。Poly Haven 的 [API 条款](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md) 允许商业使用；它要求请求写明软件名称，`userAgent` 做到了这一点，还要求产品清楚说明内容的来源，工具名称、结果和「游戏工具」卡片都做到了这一点。

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，`package.json` 在 `icon` 字段中指向它。该文件把 [Poly Haven 标志套件](https://polyhaven.com/logo) 中的彩色 Poly Haven 标志图标原样嵌入 36 × 36 画布。该标志属于 Poly Haven，不像其素材那样采用 CC0 许可；Poly Haven 的标志条款允许基于 Poly Haven API 构建的产品把它用作署名，这正是该图标的作用。WASD Engine 与 Poly Haven 没有关联，不是由 Poly Haven 制作，也未获 Poly Haven 认可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件读取 API 的三个端点，并从它们给出的 URL 下载文件。`GET /assets?type=all` 返回全部素材，2,400 个素材约 2.5 MB；列表在内存中保留 `catalogMaxAgeMs`，刷新失败时用上一次读取的列表作答。`GET /search?q=<query>&t=<type>` 按排序返回全部匹配的 id；插件把这些 id 与列表对应起来，丢弃列表中没有的 id，然后按分类过滤并分页。`GET /files/<id>` 按组（一种贴图、一种格式或 `hdri`）、分辨率和格式返回素材的文件，每个文件都带有 URL、大小、MD5 摘要和它引用的文件；不在第三层的条目，例如 HDRI 的单张色调映射图像，会被略去，引用无法全部读取的文件也会被略去。JSON 响应最多读取 64 MiB，预览图最多 8 MiB，只获取 HTTP 和 HTTPS URL。HTTP 429 会变成说明何时重试的消息。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config、工具注册、会话的预览图附件，以及游戏 MCP 提供方 |
| [`src/api.ts`](src/api.ts) | API 客户端：缓存的素材列表、搜索、文件树、预览图和文件请求 |
| [`src/files.ts`](src/files.ts) | 素材提供的格式和分辨率，以及一次下载的文件及其路径检查 |
| [`src/download.ts`](src/download.ts) | 写入一次下载的文件：临时文件、摘要和冲突 |
| [`src/tools.ts`](src/tools.ts) | 工具定义及其结果文本 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接的 agent 的工具，以及提供方的说明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍把工具提供给其他 agent 的 MCP 服务器，以及游戏工具之间的连接方式。

- [game-mcp](../game-mcp/README.zh.md)——面向本机 agent 的 MCP 服务器。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md)——游戏工具、它们的行以及 MCP 服务器。
- [Poly Haven API](https://api.polyhaven.com/api-docs/swagger.json)——本包读取的端点。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 看到 `polyhaven_search`，带可选的 `query`、`type`、`category`、`limit` 与 `offset`；`polyhaven_asset`，带 `id` 与可选的 `preview`；以及 `polyhaven_download`，带 `id` 与可选的 `format`、`resolution`、`maps`、`directory` 和 `replace`。描述说明这些素材采用 CC0 许可，搜索能理解任何语言的描述，并且游戏最适合使用 1k 或 2k、gltf 模型和 jpg 贴图。连接的 agent 看到同样的工具，其中 `directory` 必须是绝对路径，以及 `## Poly Haven` 下的提供方说明。

#### Token 影响

三个声明合计约 3,100 个字符的 JSON；提供方说明为 MCP 服务器的说明增加约 750 个字符。

#### KV Cache 影响

这些声明是静态的，因此保留在缓存的工具前缀中。

### 工具结果

#### 模型可见内容

搜索结果写明查询、匹配数量，并为每个素材列出一行：id、名称、种类、分类、最大分辨率、真实尺寸、多边形数和 Poly Haven 的描述，并说明每个素材都采用 CC0 许可；没有查询的结果还会列出分类及其素材数量。素材结果列出各格式及每种分辨率的大小以及纹理的贴图，当会话的模型接受图像时，后面附上作为附件的预览图。下载结果写明文件夹、文件及其总大小、其中多少个是新下载、替换或已在原位的、打开素材的文件、来源页面、作者与许可，以及 Godot 和 Blender 如何打开该格式。失败结果写明素材提供的内容，例如其格式或分辨率，或者 Poly Haven 拒绝的原因。

#### Token 影响

搜索结果每个素材约 300 个字符，默认 10 个，最多 50 个。素材结果为几百个字符加一张 512 像素的图像。下载结果为几百个字符。

#### KV Cache 影响

在对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了工具提供的内容；它们是本包当前的约束。

- **没有 HDRI 附加文件**——不提供 HDRI 的背景照片、色调映射 JPEG 和色卡。
- **模型贴图**——模型的纹理贴图只能作为其某种格式的一部分下载，不能单独下载。
- **没有磁盘缓存**——素材列表只保存在内存中，因此每次 Host 启动都会重新读取，每个项目也会重新下载自己的文件。
- **通用对话行**——Web 界面用通用工具行显示这些工具调用，不显示缩略图。
- **预览需要图像输入**——模型只接受文本的会话得不到预览图。
- **Poly Haven 的服务**——API 可能在没有通知的情况下变更或停止，而且它的搜索按语义排序，因此即使资源库中没有相应内容，也会列出相近的素材。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

API 在 `https://api.polyhaven.com/api-docs/swagger.json` 发布 OpenAPI 描述，在 Poly-Haven/Public-API 仓库的 `ToS.md` 发布条款。素材 id 由字母、数字、`_` 与 `-` 组成，素材列表以 id 为每个素材的键。预览图 URL 是列表中的 `thumbnail_url` 加上 `width`、`height` 与 `format=jpeg`，图像 CDN 会返回缩放后的图像。

</details>
