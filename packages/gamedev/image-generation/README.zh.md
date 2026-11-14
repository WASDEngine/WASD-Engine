---
description: "面向 agent（智能体）的图像生成：每个会话和 WASD Engine 的 MCP 服务器都提供 image_generate 工具，用 Google 的 Nano Banana 2.1 根据提示词和最多 14 张用于编辑或参照的图像制作游戏美术、界面元素和贴图，并保存到游戏项目中；图像由 WASD Engine API 制作，费用计入已登录账号的套餐。"
kind: "package-reference"
---

# @deepseek-ai/dsh-image-generation

[English](README.md) | 中文

## 概述

图像生成插件让 agent（智能体）用 Google 的 Nano Banana 2.1 制作游戏的 2D 美术、界面元素、概念图和贴图。它根据提示词，以及最多 14 张用于编辑或参照的现有图像，制作一张图像，并把它保存为游戏项目中的 `.png`、`.jpg` 或 `.webp` 文件。WASD Engine API 使用自己的 Gemini API 密钥制作图像，并把费用计入已登录账号的套餐。通过 WASD Engine 的 MCP 服务器连接的 agent 获得同样的工具。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `image-generation` 行插入每个 Web 和 Desktop 配置，并带上 WASDEngine API 源，与 [`gateway.cordis.patch.yml`](../../bundle/base/wasdengine/gateway.cordis.patch.yml) 中账号登录的 `inferenceOrigin` 使用同一个表达式：

```yaml
- id: image-generation
  name: '@deepseek-ai/dsh-image-generation'
  config:
    apiOrigin: !!js >-
      ctx.get('launchEnvironment')?.getFrom('WASDENGINE_ORIGIN', ['process', 'user-env'])?.value || 'https://api.wasdengine.com'
```

设置 › 内置插件和插件页面的“游戏工具”标签页以 Nano Banana 之名列出这一行，插件页面的开关会在配置补丁中写入 `- id: image-generation` 和 `disabled: true` 来关闭它。激活时不发出任何请求。插件需要 `tools` 和 `workingDirectory` 服务；每次调用读取 `deepseekAccount` 服务的账号令牌，并在有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，把工具提供给连接的 agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiOrigin` | `https://api.wasdengine.com` | WASD Engine API 的源；账号登录只把令牌发给它的 `inferenceOrigin`，所以两者必须一致 |
| `generationTimeoutMs` | `330000` | 一次 `image_generate` 调用的时间上限；API 最多等待 Google 300 秒 |

### 工具

`image_generate` 根据 `prompt`（最多 10,000 个字符）制作一张图像并保存到 `path`，由扩展名决定文件类型：`.png`、`.jpg` 或 `.jpeg`、`.webp`。

| 参数 | 含义 |
|---|---|
| `images` | 最多 14 张现有图像，用于编辑，或参照某个角色、物体或美术风格，顺序与提示词引用它们的顺序一致。Nano Banana 2.1 能让最多 4 个角色和 10 个物体保持一致 |
| `aspect_ratio` | `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9`、`1:4`、`4:1`、`1:8` 或 `8:1`；未指定时取最接近第一张图像的形状，没有图像时为 `1:1` |
| `size` | `1K`（约 100 万像素，默认）、`2K`（约 400 万像素）或 `4K`（约 1600 万像素） |
| `replace` | `path` 已存在时覆盖它；未指定时拒绝已有文件 |

`path` 和每张图像都可以相对会话的工作目录，也可以是绝对路径。一次调用在付费请求之前检查所有参数、目标路径和每张图像，所以被拒绝的调用不产生费用。若图像是方向正确、单帧、最长边不超过 2,048 像素且不超过 7 MB 的 PNG、JPEG 或 WebP 文件，就原样发送；sharp 能读取的其他图像，例如 GIF、TIFF、SVG 或更大的照片，会被转正、缩小，并以 PNG、JPEG 或 WebP 发送。一次调用的图像合计不超过 14 MB。Nano Banana 返回 JPEG 文件：路径为 `.jpg` 时原样保存，为 `.png` 或 `.webp` 时先转换；文件先写入目标旁边的临时文件，因此要么完整出现，要么完全不出现。结果会说明文件、像素尺寸和文件大小、模型、尺寸和形状，以及制作时用到的图像。

Nano Banana 不生成透明背景，因此工具说明告诉 agent：请求一种单一的纯色背景，再用 GIMP 把它变为透明，并为 JPEG 的边缘留一点容差；贴图也用 GIMP 处理成无缝。每张图像都带有 Google 不可见的 SynthID 水印。

通过 WASD Engine 的 MCP 服务器连接的 agent 在提供方 `image`（标题为 Nano Banana）下使用该工具，不需要会话：`path` 和每张图像都必须是绝对路径。它们的图像计入 WASD Engine 当前登录的账号，未登录时服务器拒绝所有调用。

### 价格与账号

WASD Engine API 按 Google 为 Nano Banana 2.1 定的 API 价格，根据 Google 报告的 token 数，把每张图像计入账号套餐的 AI 用量：2K 图像比 1K 图像贵一半，4K 图像是 1K 的三倍多，另外提示词、发送的图像和思考也会产生少量费用。没有返回图像的请求不产生费用，例如被 Google 安全过滤器拦截的请求。套餐的 AI 用量用完后，调用会以 API 的“Usage limit reached”消息失败，并让 agent 请用户升级套餐或开启自动充值。WASD Engine 未登录时，每次调用都会让 agent 请用户登录；API 拒绝的令牌（HTTP 401）会报告给账号服务，若它仍是已保存的令牌，账号服务会注销账号。

<a id="plugin-icon"></a>
### 插件图标

“游戏工具”标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，由 `package.json` 的 `icon` 字段指定：一个带闪光的包内图片图形，使用 WASD Engine 键帽紫色，不是 Google 或 Nano Banana 的标志。WASD Engine 与 Google 没有关联，也不是由 Google 制作或认可的。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每次调用向 `apiOrigin` 上的 `POST /v1/images/generate` 发送一个 JSON 对象：`prompt`、以 `{ mime_type, data }` 表示且文件为 base64 的 `images`、`aspect_ratio` 和 `size`；`x-dsh-auth-token` 中带有 `deepseekAccount.resolveToken` 为该 URL 发放的令牌，且从不跟随重定向。响应是图像文件（`image/png`、`image/jpeg` 或 `image/webp`），像素尺寸在 `x-image-width` 和 `x-image-height` 中；客户端最多读取 64 MiB。错误响应带有 API 的消息，客户端按状态码为 agent 改写措辞。sharp 在第一次需要读取或转换图像的调用时加载。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、账号令牌、工具注册和游戏 MCP 提供方 |
| [`src/api.ts`](src/api.ts) | API 客户端及其错误措辞 |
| [`src/files.ts`](src/files.ts) | 把每张图像调整为 API 接受的形式，并把结果转换为路径要求的文件类型 |
| [`src/tools.ts`](src/tools.ts) | 工具定义、参数检查、编辑时的形状、文件写入和结果文本 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接 agent 的工具和提供方说明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍把工具提供给其他 agent 的 MCP 服务器，以及各游戏工具如何衔接。

- [game-mcp](../game-mcp/README.zh.md)——面向本机 agent 的 MCP 服务器。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md)——游戏工具、它们的行和 MCP 服务器。
- [Gemini 图像生成](https://ai.google.dev/gemini-api/docs/image-generation)——Nano Banana 的提示词、编辑和参考图像。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 看到 `image_generate`，参数为 `prompt`、`path`，以及可选的 `images`、`aspect_ratio`、`size` 和 `replace`。说明写明了模型，列出它能制作的游戏美术、界面美术和贴图，说明可以传入图像来编辑，或让角色、物体或风格保持一致，说明 Nano Banana 不生成透明背景以及如何用 GIMP 得到透明背景，如何请求贴图并用 GIMP 处理成无缝，要用 `asset_view` 查看每个结果，以及每张图像都会消耗用户 WASD Engine 套餐的 AI 用量，2K 和 4K 更多。连接的 agent 看到同样的工具，其中 `path` 和 `images` 被描述为绝对路径，提供方说明位于 `## Nano Banana` 下。

#### Token 影响

声明约为 2,100 个字符的 JSON；提供方说明为 MCP 服务器的说明增加约 900 个字符。

#### KV Cache 影响

声明是静态的，因此保留在缓存的工具前缀中。

### 工具结果

#### 模型可见内容

结果是一两句话：文件、像素尺寸和文件大小、是否替换了文件、模型、尺寸和形状，以及制作时用到的图像。失败时会说明要修改什么：超出范围的参数、已存在的路径、缺失或不是图像的文件、被 Google 安全过滤器拒绝、套餐用量已用完，或应用未登录。

#### Token 影响

结果是一两句话。

#### KV Cache 影响

在会话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了工具提供的能力，是本包当前的约束。

- **没有透明度**——Nano Banana 不生成 alpha 通道；精灵图和界面元素需要在 GIMP 中把背景变为透明。
- **JPEG 输出**——Gemini API 的 `generateContent` 返回 JPEG 且不提供输出类型选项，因此 `.png` 文件会保留 JPEG 压缩痕迹；Gemini 的 Interactions API 可以通过 `response_format` 请求 PNG，从而避免这一点。
- **不保证可平铺**——贴图要经过 GIMP 处理才无缝；API 没有平铺模式。
- **不是真正的像素画**——像素画风格的结果网格不均匀，颜色也多于调色板；请在 GIMP 中用最近邻采样缩小并减少颜色。
- **每次调用一张图像**——一组精灵图或图标需要每张调用一次，并通过传入先前的图像保持一致。
- **结果不展示给模型**——结果只说明文件；agent 用 `asset_view` 查看它，连接的 agent 用自己的图像读取能力查看。
- **通用会话行**——Web UI 在通用工具行中显示工具调用，没有图像预览。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

API 的图像路由固定使用模型 `gemini-nano-banana-2.1` 和仅图像输出，拒绝文件头与类型不符的图像，读取返回图像的尺寸，并按 Google 报告的 token 计费。请求字段就是工具的参数，名称相同；`aspect_ratio` 总会发送，调用未指定时取第一张图像最接近的形状，因此编辑会保持原图的形状。

</details>
