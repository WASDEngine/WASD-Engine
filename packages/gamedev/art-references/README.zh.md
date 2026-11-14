---
description: "面向 agent（智能体）的美术参考：reference_search 在网上为 agent 即将制作的美术查找参考图片、动画和视频封面，并在一张联系表上编号；reference_save 把选中的参考连同来源保存到游戏项目的 references 文件夹，Godot 不会把该文件夹纳入游戏；一个系统提示词段落让 agent 在制作任何美术前先收集参考，并在参考方向不一致时询问用户想要哪个方向。"
kind: "package-reference"
---

# @deepseek-ai/dsh-art-references

[English](README.md) | 中文

## 概述

美术参考插件在 agent（智能体）制作游戏美术之前为它提供参考资料。当用户要精灵图、贴图、模型或动画时，agent 会主动在网上搜索参考，在一张编号的联系表上展示它们，并在参考不一致时询问用户想要哪个方向。它把用到的参考连同来源保存到项目的 `references/` 文件夹，并以它们为依据工作：作为 `image_generate` 的图像，作为对照 Blender 和 GIMP 成果的画面，对动画 GIF 则使用帧表。连接的 agent 获得同样的工具。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 在每个 Web 和 Desktop 配置中插入 `art-references` 行，缓存文件夹位于 WASD Engine 主目录中：

```yaml
- id: art-references
  name: '@deepseek-ai/dsh-art-references'
  config:
    dataRoot: !!js dshHomePath('art-references')
```

插件需要 `tools`、`web` 和 `workingDirectory` 服务；有 `systemPrompt` 服务时添加 `art-references` 段落，有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时把工具提供给连接的 agent。激活时不发出请求；它会删除超过 `cacheDays` 的缓存文件。相对路径的 `dataRoot` 会使插件加载失败。Game tools 标签页不列出这一行：与资源和音频工具一样，它属于 agent 的工作方式，而不是它驱动的应用。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 绝对路径的缓存文件夹：下载的图像在 `images/`，联系表在 `sheets/` |
| `userAgent` | `Mozilla/5.0 (compatible; WASDEngine-References/1.0; +https://wasdengine.com)` | 每个页面和图像请求的 `User-Agent` |
| `cacheDays` | `30` | 缓存的下载和联系表保留并复用的天数 |
| `searchTimeoutMs` | `150000` | 一次 `reference_search` 调用的时间上限 |
| `saveTimeoutMs` | `120000` | 一次 `reference_save` 调用的时间上限 |
| `maxQueries` | `4` | 一次搜索最多接受的查询数 |
| `maxPages` | `4` | 一次搜索最多按地址读取的页面数 |
| `resultsPerQuery` | `8` | 每个查询的网页搜索返回的页面数 |
| `maxCandidates` | `16` | 一张联系表最多的图像数 |
| `maxSaved` | `8` | 一次保存最多接受的图像数 |
| `maxModelImages` | `4` | 一次保存最多给调用方模型看的图像数 |
| `modelImageEdge` | `1024` | 调用方模型收到的图像的最长边 |
| `pageTimeoutMs` | `10000` | 读取一个页面的时间上限 |
| `imageTimeoutMs` | `20000` | 下载一张图像的时间上限 |
| `maxPageBytes` | `2097152` | 读取一个页面的字节数；更长的页面只读到这么多 |
| `maxImageBytes` | `16777216` | 下载图像的最大大小 |
| `minImageEdge` | `24` | 值得研究的图像最长边的最小像素数 |
| `sheetCell` | `240` | 联系表上每张图像所占正方形的边长 |
| `sheetColumns` | `4` | 联系表每行最多的图像数 |
| `framesMaxFrames` | `24` | 动画帧表上最多的帧数；更长的动画均匀抽样 |
| `framesMaxEdge` | `1024` | 动画帧表的最长边 |
| `concurrency` | `6` | 同时读取的页面和同时下载的图像数 |

### 工具

`reference_search` 接受 `queries`，最多四个简短的网页搜索，例如 `"knight pixel art sprite"`；以及 `pages`，最多四个要从中取图的网页，例如用户给出的链接；一次调用至少给出其中一种。每个查询都通过 `ctx.web.search` 进行，与 `web_search` 使用并计费的搜索相同。搜索到的页面在本机读取：从每个页面取它为链接预览指定的图像（Open Graph、Twitter 卡片、`image_src` 或 schema.org），没有时取它的第一张大图，以及它播放的视频，此时该图像就是视频的封面。本身就是图像文件的搜索结果按原样取用；返回页面的图像地址，例如维基的文件页面，则取该页面的主图。调用直接给出的页面提供它显示的每张图像：图像标签及其最大的 `srcset` 来源和懒加载属性、picture 来源、视频封面，以及指向图像文件的链接。每张图像都会被下载，检查它是最长边至少 `minImageEdge` 像素的 PNG、JPEG、WebP、GIF 或 AVIF 图像，并保存在缓存文件夹中。差异哈希会找出同一幅画面的其他尺寸或其他网站上的副本，只保留一份。其余的最多 `maxCandidates` 张在联系表上编号：每张图像缩放到棋盘格背景上的一个正方形中，小尺寸的像素画按整数倍放大且不做平滑，左上角是编号，左下角是 `GIF 12`、`ANIM 12` 或 `VIDEO`。联系表是缓存文件夹中的 JPEG 文件，会话的模型以图像形式收到它。

结果在 web 工具使用的外部内容提示之后，列出每张图像的编号、标题、网站、像素尺寸、文件类型、帧数和时长、地址、所在页面和视频，并给出在对话中显示联系表的 Markdown 行：`![Reference images](<sheet path>)`。聊天界面通过 Host 的文件路由渲染绝对路径的图像。

`reference_save` 接受 `subject`，即参考的用途，它决定文件夹名；以及 `images`，最多八个来自 `reference_search` 或其他地方的图像地址，例如用户给出的地址。它下载每张图像或在缓存中找到它，并把它写入会话工作目录下的 `references/<subject>/`，编号接在已有文件之后，例如 `references/knight/03-pixel-knight-pack.png`。动画 GIF 或 WebP 还会得到 `<name>.frames.png`，即它的各帧排成的网格，每帧从 1 开始编号并标出显示时长。每个文件的标题、页面、图像地址、视频和日期写入该文件夹的 `SOURCES.md`，其标题说明这些图像归其作者所有。一个空的 `references/.gdignore` 让 Godot 不导入该文件夹，因此参考永远不会成为游戏或其导出的一部分。结果列出保存的文件和失败的图像，并把每张保存的图像给会话的模型看，最多 `maxModelImages` 张：帧表以绘制时的 PNG 发送，静态图像最长边不超过 `modelImageEdge` 像素，小图按整数倍放大。

页面和图像请求只发往公共互联网地址：第一个地址和每次重定向的地址都必须解析为公共 IPv4 或 IPv6 地址，因此页面无法让工具访问本机或其局域网。请求不带 cookie 或凭据，最多跟随五次重定向。

### 连接的 agent

通过 WASD Engine 的 MCP 服务器连接的 agent 在提供方 `reference`（标题为 Art references）下使用这些工具，无需会话。`reference_save` 接受 `project`，即一个已存在的游戏项目文件夹的绝对路径，并保存到其 `references/` 文件夹。每个结果在文字之后以图像字节发送其图像。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一次搜索同时运行所有查询的网页搜索；某个查询的搜索失败时，只要其他查询或给出的页面提供了来源，它就不贡献任何来源；只有所有查询都失败且调用没有给出页面时，调用才以搜索的消息失败。来源先是给出的页面，然后从每个查询的结果中轮流选取，使每个查询最好的结果排在前面。页面先读取，然后下载图像，每次 `concurrency` 个；会尝试 `maxCandidates` 的两倍数量的图像，以便在部分失败或重复时联系表仍能填满。无法读取的页面、没有图像的页面、下载失败、不是参考图像或太小的图像计为不可用；结果会报告数量。表上的标签来自内置像素字体，因此不需要系统字体。Sharp 在第一次读取图像的调用时加载。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、缓存、工具注册、系统提示词段落和游戏 MCP 提供方 |
| [`src/net.ts`](src/net.ts) | 公共地址检查和跟随重定向的有界 GET 请求 |
| [`src/html.ts`](src/html.ts) | 读取页面的预览图像、视频、标题、网站和显示的图像 |
| [`src/finder.ts`](src/finder.ts) | 搜索、下载、重复画面和缓存文件夹 |
| [`src/images.ts`](src/images.ts) | 图像检查、指纹、联系表、帧表和给模型的副本 |
| [`src/save.ts`](src/save.ts) | 主题文件夹、编号文件、`SOURCES.md` 和 `references/.gdignore` |
| [`src/tools.ts`](src/tools.ts) | 工具定义、参数检查和结果文字 |
| [`src/prompt.ts`](src/prompt.ts) | 系统提示词段落和 MCP 提供方的说明 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接的 agent 的工具 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍工具使用的搜索、接受参考的图像工具，以及把工具提供给其他 agent 的 MCP 服务器。

- [tool-web](../../web/tool-web/README.zh.md) — 基于同一网页搜索的 `web_search` 工具。
- [image-generation](../image-generation/README.zh.md) — `image_generate`，接受保存的参考作为要匹配的图像。
- [game-mcp](../game-mcp/README.zh.md) — 面向本机 agent 的 MCP 服务器。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md) — 游戏工具、它们的行和 MCP 服务器。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型可见内容

当会话有 `reference_search` 时，`art-references` 段落以 `# Art references` 为标题，告诉 agent：有好参考的美术效果好得多；在制作任何美术资源之前，无需等待要求，就用 `reference_search` 收集参考，除非用户已经给出参考、要求不要搜索，或该资源重复游戏中已有的美术。它说明如何为主体、外观和动作写两到四个查询；无论是否提问，都在下一条消息中用结果给出的 Markdown 图像行向用户展示联系表；保持游戏已有的风格，只从参考中取主体；比较参考的外观而不只是内容，即美术风格、像素尺寸或细节、比例、配色与氛围和视角；当它们在这些方面不同而请求没有说明时，询问用户想要哪个方向，会话有 `ask_user_question` 时用它，每个方向一个选项，即使在较长请求的中途也要问，因为美术方向由用户决定，而游戏的第一份美术决定整个游戏的外观；参考一致时则不询问继续工作；用 `reference_save` 保存用到的参考，它不会添加资源，也无需批准，自己制作的美术不要放进该文件夹；以参考为依据工作：会话有 `image_generate` 时把最接近所选方向的一到三张参考传给它并在提示词中说明从每张取什么，把 Blender 和 GIMP 的成果与参考对照，并按照动画的帧表制作。最后规定：描述自己的设计，绝不复制参考，不复制他人的角色、标志或作品，也绝不把参考图像放进游戏。 以下是 Web 和 Desktop 配置组合出的形式，含 `ask_user_question` 和 `image_generate`；没有 `ask_user_question` 时，问题在回复中提出，每行一个方向，并结束回合等待回答；没有 `image_generate` 时省略它那一步。

##### `art-references` 段落

```markdown
# Art references

Art made from good references comes out much better. Before you make any art asset, such as a sprite, character, creature, item, icon, tile, texture, background, UI piece, 3D model, animation, or effect, gather references for it with reference_search without waiting to be asked. Skip this only when the user already gave references for it, asks you not to search, or the asset repeats art the game already has, such as another color of an existing item.

- Search for the subject and its look in two to four short queries, such as "armored knight pixel art sprite", "knight sprite sheet walk cycle", and "medieval plate armor". For an animation, search for the motion too, such as "sword slash animation gif" or "walk cycle reference". Pass pages to take the images of a page the user linked or a gallery a search found.
- Always show the user the contact sheet, whether or not you ask them anything: put the Markdown image line the result gives you in your next message, so they see what the art will be based on.
- When the game already has art, keep its style, and take only the subject from the references: its shape, details, colors, and motion.
- Otherwise compare how the references look, not only what they show: art style (pixel art, painted, flat, 3D), pixel size or detail (a 16-pixel sprite against a 64-pixel one), proportions (cute against heroic or realistic), palette and mood, and view (side, top-down, isometric). When they differ in any of these and the request does not say which, ask with ask_user_question which direction they want: one option per direction, labeled with its look and the numbers of the references that show it. Art direction is the user's choice, and a game's first art sets the look of the whole game, so ask even in the middle of a longer request. When the references agree, pick the ones that fit and go on without asking.
- Save the references you use with reference_save. It keeps them in references/, out of the game, so it adds no asset and needs no approval; keep the art you make out of that folder.
- Work from the saved references: pass the one to three references closest to the chosen direction to image_generate in images, and say in the prompt what to take from each, such as the proportions and palette of the first image; compare what you make in Blender or GIMP with them; for an animation, follow the frame count and timing of the frames sheet reference_save makes for a GIF.

References guide shape, proportions, colors, mood, and motion. Describe your own design and never copy a reference: do not reproduce someone else's character, logo, or artwork, and never put a reference image into the game.
```

#### Token 影响

该段落约 2,700 个字符。

#### KV Cache 影响

只有当 `ask_user_question` 或 `image_generate` 加入或离开会话的工具时段落才会变化，因此它留在缓存的系统提示词中。

### 工具声明

#### 模型可见内容

`reference_search` 带可选的 `queries` 和 `pages`，`reference_save` 带 `subject` 和 `images`。描述说明参考适用于哪些美术；每个查询取每个搜索到的页面的主图，包括 GIF 动画和视频封面；结果中的联系表以 Markdown 图像向用户展示；`reference_save` 把图像及其来源保存在 Godot 不纳入游戏的 `references/<subject>/` 中，并为动画制作帧表。连接的 agent 看到同样的工具、带 `project` 的 `reference_save`，以及 `## Art references` 下的提供方说明。

#### Token 影响

两个声明约 2,100 个字符的 JSON；提供方说明为 MCP 服务器的说明增加约 1,200 个字符。

#### KV Cache 影响

声明是静态的，因此留在缓存的工具前缀中。

### 工具结果

#### 模型可见内容

搜索结果是一行找到了什么、联系表的路径和显示它的 Markdown 行、外部内容提示，以及每张图像两到三行：编号、标题、网站、尺寸、类型、帧数和时长以及地址；模型接受图像时附带联系表图像。保存结果列出每个保存的文件、它的帧表以及每张失败的图像和原因，最后说明要以它们为依据工作：把文件传给 `image_generate` 的 `images` 并说明从每张取什么，把 Blender 和 GIMP 的成果与它们对照，并按照帧表的时长制作；每张保存的图像或帧表以图像形式附带。失败会说明要改什么：缺少或过长的参数、不在公共网络上的地址，或网页搜索自己的消息，例如账号未登录。

#### Token 影响

搜索结果每张图像约 100 个字符，最多 16 张，另加一张约 1,000 × 1,000 像素的联系表图像。保存结果每个文件一行，另加最多四张图像。

#### KV Cache 影响

在对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了工具提供的能力；它们是本包当前的约束。

- **没有视频帧** — 视频留在网上：联系表显示它的封面，结果给出它的地址。帧只来自动画 GIF 和 WebP 文件。
- **不运行脚本的页面** — 页面按服务器发送的样子读取，不运行脚本，因此在浏览器中构建页面的网站，或像 Reddit 那样以机器人检查作答的网站，不提供图像。
- **每个搜索结果一张图像** — 搜索取每个页面的主图；图库的其他图像需要把它的地址放进 `pages`。
- **通用预览图** — 列表页或标签页常常把网站横幅指定为链接预览，它会占用联系表上的一个位置。
- **请求前解析** — 公共地址检查在请求前解析主机，因此在检查与连接之间更改记录的主机仍可访问它更改后的地址。
- **通用对话行** — Web UI 用通用工具行显示调用；agent 在消息中展示联系表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

插件使用用户账号已经付费的网页搜索，并像浏览器一样从本机读取页面和图像，因此不需要自己的密钥。Bing 的图像 API 已停用，Google 的 Custom Search 已停止接受新客户，因此图像搜索 API 意味着要在 WASD Engine API 后面接入新的付费提供方；普通搜索结果的预览图已能覆盖大多数美术参考。

</details>
