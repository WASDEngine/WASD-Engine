---
description: "面向 agent（智能体）的 ambientCG：每个会话和 WASD Engine 的 MCP 服务器都提供 ambientcg_search、ambientcg_asset 与 ambientcg_download 工具，用于在 ambientCG 资源库中查找 CC0 的 PBR 材质、贴花、图集和 HDRI，查看其大小与预览图，并把纹理贴图保存到游戏项目中。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ambientcg

[English](README.md) | 中文

## 概述

ambientCG 插件让 agent（智能体）在 [ambientCG](https://ambientcg.com) 的资源库中为游戏查找表面：2,000 多个免费的 PBR 材质，以及贴花、由叶片等镂空小块组成的图集和 HDRI 天空，全部采用 CC0 许可，并把它们的纹理贴图保存到游戏项目中。agent 用英文关键词搜索，查看某个素材的预览图和各分辨率的大小，并下载一种分辨率：插件取得该素材的 ZIP 压缩包，校验它，只写入贴图图片。通过 WASD Engine 的 MCP 服务器连接的 agent，例如 Claude Code 或 Codex，获得同样的工具。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `ambientcg` 行插入每个 Web 与桌面配置，不带配置：

```yaml
- id: ambientcg
  name: '@deepseek-ai/dsh-ambientcg'
```

「设置 › 内置插件」与「插件」页面的「游戏工具」标签页以 ambientCG 标志列出这一行；「插件」页面上的开关会在 profile patch 中写入 `- id: ambientcg` 与 `disabled: true` 来关闭它。启用时不发出任何请求；搜索时才读取它要列出的那一页。插件需要 `tools` 与 `workingDirectory` 服务。有 `attachments` 与 `llm` 服务时，它向模型接受图像的会话显示预览图；有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，它把工具提供给连接的 agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiUrl` | `https://ambientcg.com/api/v3` | ambientCG API 的基础 URL |
| `userAgent` | `WASD Engine` | 每个请求的 `User-Agent`，向 ambientCG 写明软件名称 |
| `requestTimeoutMs` | `30000` | 一次 `ambientcg_search` 或 `ambientcg_asset` 调用的时间上限 |
| `downloadTimeoutMs` | `600000` | 一次 `ambientcg_download` 调用的时间上限 |
| `maxDownloadBytes` | `1073741824` | 一次下载的压缩包的最大大小，以及它解出的图片的最大总大小，1 GiB |
| `catalogMaxAgeMs` | `43200000` | 搜索页、素材和分类在内存中保留的时间，12 小时；0 表示每次都重新读取 |

### 工具

| 工具 | 作用 |
|---|---|
| `ambientcg_search` | 列出标签中包含 `query` 每个关键词的素材，按受欢迎程度从高到低，带有 id、种类、真实尺寸、制作方式、最大分辨率、贴图和标签。ambientCG 匹配完整的英文单词，因此当没有素材包含全部关键词时，插件逐个查询每个词，并为包含其中一些词的素材排序：先看包含的词数，再看包含这些词的素材有多少（越少越靠前），最后看受欢迎程度。没有 `query` 时，列出最受欢迎的素材以及可供搜索的分类。`type`（`materials`、`decals`、`atlases` 或 `hdris`）缩小列表范围；`limit`（1 到 50，默认 10）与 `offset` 用于分页 |
| `ambientcg_asset` | 显示素材 `id`：它的标签、真实尺寸、贴图和 ambientcg.com 上的页面；每种图片格式及各分辨率压缩包的大小；除非 `preview` 为 false，还有它的预览图，一张 512 像素的材质渲染图 |
| `ambientcg_download` | 把素材一种 `resolution` 和 `format` 的贴图图片保存到 `directory`，默认是工作目录中的 `assets/ambientcg/<id>` |

| 种类 | 格式 | 下载默认写入的内容 |
|---|---|---|
| 材质、贴花、图集 | `jpg`（默认）或 `png` | 压缩包中除 DirectX 法线贴图 `NormalDX` 外的全部贴图：`Color`、`NormalGL`、`Roughness`，以及素材具有的 `Metalness`、`AmbientOcclusion`、`Displacement`、`Opacity` 等；`maps` 可指定要取的贴图 |
| HDRI | `exr` | 全景图 `HDR`；`maps` 可以指定 `TONEMAPPED`，即它的 JPEG |

`maps` 接受 API 的名称（`color`、`normal`、`roughness`、`ambient-occlusion`）、文件中的名称（`NormalGL`、`NormalDX`）或常见的其他名称（`albedo`、`ao`、`metallic`、`height`、`alpha`）；`normal` 指 OpenGL 法线贴图，Godot 与 Blender 读取的就是它。素材没有列出的贴图会在下载任何内容之前被拒绝。没有 `resolution` 时，下载使用 `1k`；该格式没有 `1k` 时使用最小的分辨率。超过 `maxDownloadBytes` 的压缩包在取得之前失败，并说明其大小。

ambientCG 把每种分辨率作为一个 ZIP 压缩包提供，其中还有供其他程序使用的材质文件和一张预览图。一次下载把压缩包取到临时文件夹，按素材列表校验其大小，按 ambientCG 文件主机给出的值校验其 SHA-1 摘要，读取压缩包的目录，只解出贴图图片，每张图片都按目录中的 CRC-32 校验；之后删除临时文件夹。一次下载要么写入全部图片，要么一张也不写入，失败或取消会让文件夹保持原样。已在原位且内容相同的图片不会再次写入；内容不同的图片，例如用户编辑过的纹理，会在写入任何内容之前中止下载，除非 `replace` 为 true。插件记住它读过的每个压缩包的目录，因此图片全部在原位的重复下载不会取得任何内容。

通过 WASD Engine 的 MCP 服务器连接的 agent 在提供方 `ambientcg` 下使用这些工具，不需要会话：`ambientcg_search` 与 `ambientcg_asset` 标记为只读，预览图以 JPEG 字节的形式跟在结果文本之后，`ambientcg_download` 要求 `directory` 为绝对路径。

在 Godot 游戏中，`wasd-materials` 扩展的 `WasdSurface.from_folder()` 用下载的文件夹生成材质，`WasdSurface.cutout()` 用带 `Opacity` 图片的文件夹生成镂空材质；`wasd-look` 的 `WasdLook3D.panorama` 接受 HDRI 的 `.exr`。

### ambientCG 的条款

ambientCG 的素材采用 CC0 许可，游戏可以使用它们，包括商业用途，且无需署名。每个结果都写明素材在 ambientcg.com 上的页面，便于 agent 记录来源，正如 `gamedev` 预设对每个第三方素材的要求。ambientCG 的 API 不需要密钥。它的文档说明该网站由一个人运营，API 并非为大量使用而建，因此插件把读到的内容保留在内存中，并逐个而不是同时查询各个词。

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，`package.json` 在 `icon` 字段中指向它：ambientCG 标志中的球体，在 36 × 36 画布中宽 32 个单位。ambientCG 只以图片形式发布其标志，而插件图标必须是矢量形状，因此该文件绘制 ambientCG 自己的矢量图标（它的固定标签页图标，以单色绘出该球体）中的形状，并为每个形状填上彩色标志中对应砖块的颜色。该标志属于 ambientCG，不像其素材那样采用 CC0 许可；ambientCG 的[品牌页面](https://docs.ambientcg.com/brand/)允许产品在提及 ambientCG 时使用它，并要求这种使用不暗示任何认可。WASD Engine 与 ambientCG 没有关联，不是由 ambientCG 制作，也未获 ambientCG 认可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件读取 API 的两个端点，并从它们给出的 URL 下载压缩包。`GET /assets?q=<words>&type=<kinds>&limit=<n>&offset=<n>&include=<fields>` 返回包含每个词的素材中的一页，按受欢迎程度从高到低，并给出匹配数量；`GET /assets?id=<id>&type=<kinds>` 返回一个素材；`GET /categories` 返回分类及其素材数量。每一页以其 URL 为键保留在内存中，最多 64 页，每个素材以其 id 为键，最多 2,048 个，保留 `catalogMaxAgeMs`；刷新失败时用上一次读到的内容作答。素材的 `downloads` 给出它的压缩包；插件提供其中以分辨率命名的 ZIP 文件，表面带图片格式（`1K-JPG`），HDRI 不带（`1K`），并略去动画贴花和 Substance 压缩包。其他种类的素材，例如 Substance 材质、3D 模型和地形，不会列出。

下载 URL 会重定向到 ambientCG 的文件主机。游戏工具 kit 中共用的客户端（[`asset-library.ts`](../game-mcp/src/asset-library.ts)）只访问所配置 `apiUrl` 的主机（使用其协议）以及 `ambientcg.com` 和 `struffelproductions.com` 的 HTTPS 主机，并自行跟随最多五次重定向，每次都只到这样的主机，因此素材列表和重定向都不会把请求发往别处。JSON 响应最多读取 64 MiB，预览图最多 8 MiB，HTTP 429 会变成说明何时重试的消息。kit 还包含两类调用方的预览图、连接的 agent 调用的工具，以及要么全部写入要么一个也不写入的文件写入，Poly Haven 插件与本插件共用它们。

压缩包把每张图片命名为 `<id>_<archive>_<Map>.<extension>`，例如 `Bricks097_1K-JPG_Color.jpg`。插件取压缩包根目录下名称以素材 id 开头、以 `_<Map>` 加图片扩展名结尾的文件，因此预览图 `<id>.png` 以及 `.blend`、`.usdc`、`.mtlx` 和 `.tres` 文件永远不会写入。当压缩包的大小与素材列表不符时，例如 ambientCG 更新了该素材之后，下载会中止，忘掉该素材和该压缩包的目录，并要求再调用一次，以读取新的列表。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config、工具注册、会话的预览图附件，以及游戏 MCP 提供方 |
| [`src/api.ts`](src/api.ts) | API 客户端：保留在内存中的搜索页、素材和分类，建立在 kit 的客户端之上，由后者获取预览图和压缩包 |
| [`src/files.ts`](src/files.ts) | 一种分辨率和格式的压缩包、贴图的名称，以及一次下载从压缩包中取的图片 |
| [`src/download.ts`](src/download.ts) | 取得并校验压缩包、读取其目录并解出其图片 |
| [`src/tools.ts`](src/tools.ts) | 工具定义、按部分关键词的搜索，以及结果文本 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接的 agent 的工具，以及提供方的说明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍同类的资源库插件、把工具提供给其他 agent 的 MCP 服务器，以及游戏工具之间的连接方式。

- [polyhaven](../polyhaven/README.zh.md)——Poly Haven 的 HDRI、纹理和 3D 模型，带同样的三个工具。
- [game-mcp](../game-mcp/README.zh.md)——面向本机 agent 的 MCP 服务器，以及两个资源库插件共用的 kit。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md)——游戏工具、它们的行以及 MCP 服务器。
- [ambientCG API](https://docs.ambientcg.com/api/)——本包读取的端点。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 看到 `ambientcg_search`，带可选的 `query`、`type`、`limit` 与 `offset`；`ambientcg_asset`，带 `id` 与可选的 `preview`；以及 `ambientcg_download`，带 `id` 与可选的 `resolution`、`format`、`maps`、`directory` 和 `replace`。描述说明这些素材采用 CC0 许可，搜索接受几个原形的英文关键词，并且游戏最适合使用 1k 或 2k 和 jpg。连接的 agent 看到同样的工具，其中 `directory` 必须是绝对路径，以及 `## ambientCG` 下的提供方说明。

#### Token 影响

三个声明合计约 3,200 个字符的 JSON；提供方说明为 MCP 服务器的说明增加约 1,050 个字符，它在概述中的一行约 120 个字符。

#### KV Cache 影响

这些声明是静态的，因此保留在缓存的工具前缀中。

### 工具结果

#### 模型可见内容

搜索结果写明查询、匹配数量，并为每个素材列出一行：id、名称、种类、真实尺寸、制作方式、最大分辨率、贴图和标签，并说明每个素材都采用 CC0 许可；当没有素材包含全部关键词、列表为包含部分关键词的素材排序时，结果会说明这一点，没有查询的结果还会列出分类及其素材数量。素材结果列出各图片格式及每种分辨率压缩包的大小，当会话的模型接受图像时，后面附上作为附件的预览图。下载结果写明文件夹、图片及其总大小、其中多少张是新下载、替换或已在原位的、来源页面与许可、每张保存的贴图包含什么，以及一次重复覆盖的尺寸。失败结果写明素材提供的内容，例如其分辨率或贴图，或者 ambientCG 拒绝的原因。

#### Token 影响

搜索结果每个素材约 230 个字符，默认 10 个，最多 50 个。素材结果为几百个字符加一张 512 像素的图像。下载结果为几百个字符。

#### KV Cache 影响

在对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了工具提供的内容；它们是本包当前的约束。

- **完整的英文单词**——ambientCG 把关键词与完整的标签匹配，因此 `wooden` 找不到 `wood` 能找到的内容；工具描述要求使用原形名词，而没有素材包含全部关键词的查询，会为最多四个词各多发一次请求。
- **其他种类**——不提供 Substance 材质、3D 模型、地形、笔刷、普通图片和动画贴花。
- **整个压缩包**——即使只取一张贴图，下载也会取得该分辨率的整个压缩包，其中有它不写入的文件。
- **没有磁盘缓存**——搜索页和压缩包目录只保存在内存中，因此每次 Host 启动都会重新读取，启动后的第一次重复下载会再取一次压缩包来比较。
- **没有赞助者文件**——不支持 ambientCG 的 API 令牌，它让赞助者提前取得文件。
- **通用对话行**——Web 界面用通用工具行显示这些工具调用，不显示缩略图。
- **预览需要图像输入**——模型只接受文本的会话得不到预览图。
- **ambientCG 的服务**——该网站由一个人运营，它的 API 或压缩包内的名称可能在没有通知的情况下变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

API 的文档位于 `https://docs.ambientcg.com/api/v3/`。素材 id 由字母和数字组成，例如 `PavingStones036`，ambientCG 匹配它们时不区分大小写。预览图是素材的 `512-JPG-FFFFFF` 缩略图，一张白底渲染图。ambientCG 的文件主机是 Backblaze B2，它在 `x-bz-content-sha1` 中给出文件的 SHA-1 摘要，分块上传的文件则在 `x-bz-info-large_file_sha1` 中给出；两者都没有的响应只按其大小和每张图片的 CRC-32 校验。`dimensions` 的单位是厘米，ambientCG 不知道时为 0。

</details>
