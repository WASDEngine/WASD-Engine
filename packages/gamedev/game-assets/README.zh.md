---
description: "面向 agent（智能体）的素材查看：每个会话和 WASD Engine 的 MCP 服务器都提供 asset_search 与 asset_view 工具，用于列出游戏项目中的 2D 美术与 3D 模型，并让 WASD Engine 窗口像素材标签页那样绘制其中一个，同时给出修改它所需的详细信息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-game-assets

[English](README.md) | 中文

## 概述

素材工具让 agent（智能体）像用户在右侧边栏的「素材」标签页中那样看到游戏项目的美术。`asset_search` 按文件夹列出项目中的图片与模型。`asset_view` 让 WASD Engine 窗口用标签页自己的查看器绘制一个素材，并报告测得的内容：模型可从任意方向以白模或线框绘制，带骨架以及动画片段中的多个姿势，并给出几何、材质、骨骼与动画片段；图片给出透明度、颜色数与 2D 动画帧。`show` 会在用户的素材标签页中打开该素材。通过 WASD Engine 的 MCP 服务器连接的 agent 获得同样的工具。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `game-assets` 行插入每个 Web 与桌面配置，位于素材标签页的 `ui-game-assets` 行之后；图片由后者的浏览器端绘制：

```yaml
- id: game-assets
  name: '@deepseek-ai/dsh-game-assets'
```

插件需要 `tools` 与 `workingDirectory` 服务。有 `attachments` 与 `llm` 服务时，它把绘制的图片交给模型接受图像的会话；有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，它把工具提供给连接的 agent；有 `connection` 与 `fs` 服务时，它提供素材标签页读取所用的[项目文件路由](#reading-a-projects-files)。profile patch 中写入 `- id: game-assets` 与 `disabled: true` 即可移除这些工具与该路由。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `renderTimeoutMs` | `120000` | 一次 `asset_view` 调用的时间上限，其中包括等待窗口读取并绘制素材的时间 |
| `imageEdge` | `1024` | 调用未给出 `size` 时，返回图片最长边的像素数 |
| `maxImageEdge` | `1568` | 调用可请求的最大 `size` |
| `maxImagePixels` | `1150000` | 单张返回图片的最大像素面积，即支持图像的模型所接受的上限 |
| `maxPreviewBytes` | `268435456` | 窗口为绘制而读取、项目文件路由提供的最大文件，256 MiB |
| `maxFolders` | `2000` | 一次项目遍历列出的文件夹数，含项目文件夹本身 |
| `maxAssets` | `5000` | 一次项目遍历收集的素材数 |

### 工具

| 工具 | 作用 |
|---|---|
| `asset_search` | 列出项目中的图片（PNG、JPEG、WebP、GIF、BMP、SVG、AVIF、ICO、TGA、HDR、EXR）与模型（glTF 和 GLB、OBJ、FBX、DAE、STL、PLY、VOX 以及 Blender 文件），附带类型、格式与大小，并列出各文件夹包含的图片与模型数量。`query` 保留名称或路径包含该文本的素材，最佳匹配在前，否则保留路径按顺序包含其字母的素材；`kind`（`2d` 或 `3d`）与 `folder` 缩小范围；`limit`（1 到 200，默认 50）与 `offset` 用于分页。遍历与素材标签页一样跳过隐藏文件夹和 `node_modules`，并且只在链接的真实路径仍位于项目之内时跟随它 |
| `asset_view` | 绘制 `path` 指向的素材（相对于项目文件夹，或位于其中的绝对路径），并报告其详细信息，见下文 |

`asset_view` 按 `views` 中的方向绘制模型，每个方向是同一张图中的一格：`iso` 以透视从右前上方观察，`front`、`back`、`right`、`left`、`top` 与 `bottom` 不带透视地正对某一面（front 看 +Z 面，right 从 +X 看，top 从 +Y 向下看），便于测量比例。`shading` 为 `material`（默认）、`solid` 白模或 `wireframe` 线框；`skeleton` 在模型上叠加骨骼。给出 `animation`（动画片段名称）时，它从第一个方向绘制片段中的 `frames` 个姿势（默认 6 个，最多 16 个）；给出 `time` 时，则绘制该秒处各个方向的视图。Blender 文件会像素材标签页那样绘制由它导出的同名模型，最近的优先；没有导出模型时调用失败，并建议导出 GLB 或使用 Blender 的 `render_preview`。返回的图片为 JPEG。

`asset_view` 在显示透明度的棋盘格上绘制图片：小尺寸像素画按适合 `size` 的最大整数倍放大，大于实际尺寸的图片平滑缩小；`region` 只绘制其中一个矩形，以便近看细节。`grid` 把图片读作 `columns` × `rows`（及 `count`）帧的精灵表：图片上会画出网格并标出每格编号，详细信息把它列为名为 `grid` 的动画。给出 `animation`（图片某个动画的名称）时，它按顺序绘制该动画的各帧，每帧标注序号与时长，最多 16 帧或 `frames` 帧；`fps` 设置网格或编号图片的速度。返回的图片为 PNG，像素保持精确。文件头所述像素超过窗口解码上限（素材标签页的 `maxDecodedPixels`，默认 8192 × 8192）的图片，会在解码之前以 `ASSET_TOO_LARGE` 失败。

模型的详细信息包括格式和文件大小、尺寸与包围盒、三角形、顶点、网格与节点数，每个材质的类型、颜色、金属度、粗糙度、标志以及按槽位列出的纹理，纹理及其尺寸，骨骼树，每个动画片段的时长、轨道数与动画骨骼，每个网格的变形目标，以及模型引用但缺失的文件。图片的详细信息包括格式、文件大小、像素尺寸、透明度（无、镂空或半透明）、最多数到 256 的颜色数，以及它的 2D 动画：自身的帧（动画 GIF、WebP 或 PNG）、旁边的编号图片（`walk_01.png`、`walk_02.png` 等）、使用它的 Godot 场景与资源中的 SpriteFrames 动画和 Sprite2D 帧网格、同名精灵表 JSON 文件（Aseprite 或 TexturePacker）中的帧与标签，以及调用给出的网格，每个都附带帧数、速度与时长。详细信息最多列出 64 个动画片段或 2D 动画、32 个带变形目标的网格，以及每个网格的 64 个目标，并统计全部数量，因此文字会说明还有多少未列出。除非调用传入 `details: true`，模型的文字是一段摘要，因此反复查看骨架很大的模型时文字保持简短：格式、文件大小、尺寸、三角形数与网格数；最多八个材质名称以及动画片段及其时长，每个列表后附还有多少未列出；纹理、骨骼（附根骨骼名称）与变形目标只给出数量。图片的文字列出它的前八个动画。无论哪种情况，结果都以 JSON 保留完整的详细信息。查看器绘制模型自身的材质和其中存储的动画片段，而游戏可能用自己的着色器、材质和动画替换它们；描述会指向 `godot_view`，它在运行中的游戏里绘制模型。

模型不接受图像的会话只得到详细信息，窗口不绘制任何图片。`show` 发出 `game-assets/reveal` 事件，可以读取该会话的窗口会打开该会话（若它不在屏幕上）及其素材标签页，并选中该素材；调用给出 `grid` 时在图片上显示该网格，给出 `animation` 时还会播放它。队友或子 agent 会在其子 agent 树的领导 agent 的会话（即用户正在查看的会话）中显示素材；该领导 agent 已不存在时，则在它自己的会话中显示。

`asset_view` 只读取真实路径位于项目文件夹之内的文件：经由引出项目文件夹的链接的路径会以 `ASSET_OUTSIDE_PROJECT` 失败，项目文件夹之外的路径也是如此；对于模型引用的文件，真实路径走出窗口所读取的文件夹的，窗口一律不加载。

多个 agent 可以同时查看不同的素材：模型的并行调用、agent 团队的队友、子 agent，以及通过 MCP 服务器连接的 agent。每个调用都在调用方 agent 自己的会话中读取并绘制，得到它自己的图片和详细信息；窗口最多同时绘制三个（[`ui-game-assets`](../ui-game-assets/README.zh.md#for-the-agent)），按 Host 计算的开销，较重的模型单独绘制。在项目下层文件夹中启动的队友从自己的工作目录给出素材路径，窗口则从会话头部记录的项目文件夹读取；结果中提到的文件（例如为图片制作动画的 Godot 资源）以及窗口的失败消息都会按该队友自己的文件夹给出。

通过 WASD Engine 的 MCP 服务器连接的 agent 在提供方 `asset` 下使用这些工具。两个工具都需要 `project`，即游戏项目文件夹的绝对路径，并在连接的 agent 自己在包含该文件夹的已注册游戏项目中的会话里运行，服务器在首次使用时创建该会话，同一产品的所有 agent（例如 Claude Code 的子 agent）共用它；素材路径和 `folder` 相对于 `project`。两个工具都标记为只读，`asset_view` 保留其 `renderTimeoutMs`，绘制的图片以图像字节的形式跟在结果文本之后。`search_game_tools` 报告该提供方已就绪；没有打开的 WASD Engine 窗口时，还会说明在用户打开窗口之前 `asset_view` 都会失败。

<a id="reading-a-projects-files"></a>
### 读取项目文件

素材标签页及其为 agent 绘制的图片通过 `GET /api/game-assets.file?root=<folder>&path=<file>` 读取每个文件，这是只有 owner Peer 能访问的精确 Connection 路由；`connection` 与 `fs` 服务存在期间，插件会注册它。`root` 是项目文件夹的绝对路径，`path` 是文件，相对于该文件夹或为绝对路径。路由通过组合文件系统把两者解析为真实路径（跟随所有链接），文件的真实路径位于该文件夹的真实路径之外时，以代码 `outside-project` 答复 403，因此项目内的链接不会把读取引出项目。没有文件时答复 404，文件夹答复 403 `not-a-file`，格式错误的请求答复 400，文件大于 `max`（最大为 `maxPreviewBytes`）时，在读取之前答复带有上限的 413 `too-large`；`length` 只读取文件的前几个字节，`HEAD` 只答复大小。每个拒绝都是带有 `code` 与 `message` 的 JSON。文件以 4 MiB 的窗口流式传输，其版本在 `X-Asset-Version` 中，大小在 `X-Asset-Size` 中，并带有 `Cache-Control: private, no-store` 与起沙箱作用的 Content-Security-Policy；文件在传输期间版本发生变化时，以错误结束响应。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`asset_search` 在 Host 上遍历项目文件夹。`asset_view` 在 Host 上解析路径及其格式，用同样的遍历查找 Blender 文件的导出模型，然后带着调用方 Agent、调用的取消信号和 JSON 请求（工作区路径、类型、选项、是否绘制图片、字节与面积上限，以及答复详细信息中每个列表的最多条目数、最长名称、最长图片说明与最大图片或帧尺寸（像素），即 [`src/result.ts`](src/result.ts) 中的 `ANSWER_LIMITS`，窗口按其裁剪答复）发出作用域化的 waterfall 事件 `game-assets/render`。[`api-remotes`](../../api/remotes/README.zh.md) 把它转发给可以读取该会话的 owner 窗口；第一个答复胜出，无法处理的窗口（例如没有 WebGL 时遇到模型）用 `next()` 交给下一个。素材标签页的浏览器端负责答复（[`ui-game-assets`](../ui-game-assets/README.zh.md)）：它通过项目文件路由读取文件、测量详细信息，并用标签页的 three.js 查看器在屏幕外绘制图片。请求给出窗口在其中读取的文件夹 `root`：会话头部所记录的文件夹（窗口按该文件夹解析会话的路径）包含调用方 agent 的项目文件夹时取该文件夹，否则取项目文件夹；素材以相对于它的路径给出。Host 先对照项目文件夹的真实路径检查素材的真实路径。

请求附带 Host 计算的绘制开销（[`src/model-cost.ts`](src/model-cost.ts)），窗口的队列按此衡量：文件的大小，对于模型，还有随其一起加载的引用文件，以及其加载器按这些文件所述在文件之外分配的内存。文件按窗口的方式查找：glTF 或 GLB 模型的缓冲区与图片，取自窗口的加载器所读取的描述，即 GLB 文件中无论位于何处的最后一个 JSON 块（读取时不读该文件的其他块），以及任意大小的 `.gltf` 文件文本；OBJ 文件的第一个材质库及其纹理，通过每次读取一兆字节查找；Collada 文件的图片；以及 FBX 文件中独立成文件的图片。名称按窗口的方式解析，只有真实路径位于窗口所读取文件夹之内的文件才计入；网址、其他 URL 以及走出该文件夹的名称都不计入。内存包括每个纹理解码后的大小（按其 PNG、JPEG、GIF、WebP、BMP 或 TGA 文件头所述的像素计算，包括 FBX 文件内嵌的图片）；VOX 文件的网格，即每个被摆放的模型的包围盒中每个格子一个字节，每个暴露的面一个四边形；以及 FBX 文件的节点、字符串与数组，按其记录所述计算。读取模型文件开销最大：最近 64 个模型的读取结果按路径、大小与修改时间保留，同时最多读取两个模型文件，读取期间结束的调用会停止等待，但不会停止读取；其引用文件的大小与文件头每次调用都会重新读取，每次 16 个，最多 1,024 个。引用超过 1,024 个文件的 glTF 或 GLB 文件，或其本身与所引用文件合计超过 `maxPreviewBytes` 的 glTF 或 GLB 文件，会在询问任何窗口之前以 `ASSET_TOO_LARGE` 失败。Host 会把窗口详细信息中提到的文件以及窗口失败消息中的路径，重新按调用方 agent 的工作目录给出。没有窗口连接到 Host 时，调用立即以 `ASSET_NO_WINDOW` 失败，因为网关会为之后连接的窗口保留该请求；已连接的窗口都无法处理时，waterfall 到达插件自己的最后一环，以同样的错误失败。窗口自身的失败，例如模型中没有调用给出的片段名称，会连同消息传给 agent。Host 先用 [`src/result.ts`](src/result.ts) 逐字段检查每个答复，再把图片存为附件或通过 MCP 发送；结果以 JSON 保留详细信息。

格式表与 Blender 导出查找位于 [`src/formats.ts`](src/formats.ts)，以 `@deepseek-ai/dsh-game-assets/formats` 导出。插件的浏览器包不能导入其他插件的值，因此素材标签页保留一份副本，并由那里的一个测试保证两者一致。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、工具注册、会话的图片附件、渲染 waterfall、reveal 事件、游戏 MCP 提供方，以及项目文件路由的注册 |
| [`src/files.ts`](src/files.ts) | 项目文件路由 |
| [`src/model-cost.ts`](src/model-cost.ts) | 窗口绘制一个模型的开销，以及所读取模型文件的保留结果 |
| [`src/types.ts`](src/types.ts) | 可在浏览器中使用的请求、详细信息与结果类型及两个事件，以 `./types` 导出 |
| [`src/formats.ts`](src/formats.ts) | 列出的格式与 Blender 导出查找，以 `./formats` 导出 |
| [`src/scan.ts`](src/scan.ts) | Host 对项目文件夹的遍历，只在链接的真实路径仍位于项目之内时跟随它 |
| [`src/tools.ts`](src/tools.ts) | 工具定义、参数检查与结果内容 |
| [`src/describe.ts`](src/describe.ts) | 搜索结果与详细信息的文本 |
| [`src/result.ts`](src/result.ts) | 对窗口答复的校验 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接的 agent 的工具与提供方说明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍绘制图片的查看器、MCP 服务器与事件转发。

- [ui-game-assets](../ui-game-assets/README.zh.md) — 素材标签页，其查看器为 agent 绘制。
- [game-mcp](../game-mcp/README.zh.md) — 面向本机 agent 的 MCP 服务器。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md#assets-tab) — 这些工具与标签页如何与其他游戏工具配合。
- [api-remotes](../../api/remotes/README.zh.md) — 到达窗口的转发事件。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 可以看到 `asset_search`，带可选的 `query`、`kind`、`folder`、`limit` 与 `offset`；以及 `asset_view`，带 `path` 和可选的 `views`、`shading`、`skeleton`、`animation`、`frames`、`time`、`grid`、`fps`、`region`、`size`、`show` 与 `details`。描述列出了支持的格式，说明各个视图的样子，并说明详细信息给出修改素材所需的内容。连接的 agent 看到同样的工具，其中 `project` 为必填，并在 `## Assets` 下看到提供方说明。

#### Token 影响

两个声明合计约 4,800 个字符的 JSON，加上连接的 agent 看到的 `project` 参数约 5,100 个字符；提供方说明为 MCP 服务器的说明增加约 800 个字符。

#### KV Cache 影响

声明是静态的，因此保留在已缓存的工具前缀中。

### 工具结果

#### 模型可见内容

搜索结果给出项目文件夹与素材数量、各文件夹及其数量、每个素材一行（含类型、格式与大小），以及分页方法。查看结果是若干行详细信息文本（除非调用传入 `details: true`，模型只给出摘要；传入时骨骼以缩进树列出），后跟图片显示的内容以及作为图像附件的图片；模型不接受图像时，会被告知没有绘制图片。失败会说明出了什么问题，例如路径在项目之外、查看器不读取该格式、调用给出的名称不存在时列出素材已有的片段或动画，或者没有打开的 WASD Engine 窗口。

#### Token 影响

搜索结果每个素材约 50 个字符，默认 50 个、最多 200 个。查看结果对图片为几百个字符，对骨骼很多的模型最多几千个字符（最多列出 160 根骨骼），另加一张最长边不超过 1,568 像素、总面积不超过 1,150,000 像素的图片。

#### KV Cache 影响

在对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制决定了这些工具的能力；它们是当前包的约束。

- **由窗口绘制** — 图片与详细信息来自打开的 WASD Engine 窗口；没有打开的窗口时 `asset_view` 立即失败，agent 仍可对模型使用 Blender 的 `render_preview`。
- **调用等待窗口** — 调用的 `renderTimeoutMs` 包括其请求在窗口中排在其他 agent 的图片之后等待的时间。
- **不读取 Blender 文件** — 与素材标签页一样，Blender 文件只能通过由它导出的模型显示。
- **一个窗口答复** — 每个可以读取该会话的 owner 窗口都会开始绘制，使用第一个答复。
- **按名称匹配 Godot 动画** — 精灵节点的 `frame` 或 `frame_coords` 轨道按节点名称匹配，超过 1 MiB 或排在前 400 个之后的 Godot 文件不会被读取。
- **估算的开销** — 一次绘制计入的开销不包括 OBJ、Collada、STL 或 PLY 文件随文件增大的解析开销；PNG、JPEG、GIF、WebP、BMP 与 TGA 以外格式的纹理只按其文件计入；glTF 模型自身的描述不在 Host 上计算大小，由窗口在其加载器分配之前检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
