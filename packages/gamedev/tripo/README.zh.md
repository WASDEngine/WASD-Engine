---
description: "面向 agent（智能体）的 3D 模型：每个会话和 WASD Engine 的 MCP 服务器都提供 tripo_* 工具，用 Tripo 的 P2 模型根据提示词、一张图像或物体的多个视图制作带贴图的 3D 模型，为模型重新制作贴图、绑定骨骼并添加动画，并把每个模型以 .glb 文件保存到游戏项目中；任务经由 WASD Engine API 运行，费用计入已登录账号的套餐。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tripo

[English](README.md) | 中文

## 概述

Tripo 插件让 agent（智能体）用 Tripo 制作游戏的 3D 模型：`tripo_generate` 用 Tripo 的 P2 模型根据提示词、一张图像或物体的多个视图制作带 PBR 贴图的模型；`tripo_texture` 为它重新制作贴图，`tripo_rig` 绑定骨骼，`tripo_animate` 添加预设动画，`tripo_task` 再次等待某个任务。每次调用都在游戏项目中保存一个 `.glb` 文件。WASD Engine API 使用自己的 Tripo 密钥运行这些任务，并把费用计入已登录账号的套餐。通过 WASD Engine 的 MCP 服务器连接的 agent 获得同样的工具。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `tripo` 行插入每个 Web 和 Desktop 配置，并带上 WASDEngine API 源，与 [`gateway.cordis.patch.yml`](../../bundle/base/wasdengine/gateway.cordis.patch.yml) 中账号登录的 `inferenceOrigin` 使用同一个表达式：

```yaml
- id: tripo
  name: '@deepseek-ai/dsh-tripo'
  config:
    apiOrigin: !!js >-
      ctx.get('launchEnvironment')?.getFrom('WASDENGINE_ORIGIN', ['process', 'user-env'])?.value || 'https://api.wasdengine.com'
```

设置 › 内置插件和插件页面的“游戏工具”标签页以 Tripo 之名列出这一行，插件页面的开关会在配置补丁中写入 `- id: tripo` 和 `disabled: true` 来关闭它。激活时不发出任何请求。插件需要 `tools` 和 `workingDirectory` 服务；每次调用读取 `deepseekAccount` 服务的账号令牌，并在有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，把工具提供给连接的 agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiOrigin` | `https://api.wasdengine.com` | WASD Engine API 的源；账号登录只把令牌交给它的 `inferenceOrigin`，所以两者必须一致 |
| `taskTimeoutMs` | `600000` | 一次调用的时限，调用在此期间等待 Tripo 的任务并保存其模型；调用在时限前 30 秒停止等待（时限不足两分钟时为时限的四分之一），以留出下载的时间 |

### 工具

每个工具都把模型保存在以 `.glb` 结尾的 `path`，并返回任务的 `task_id`，供下一步使用。`path` 和每张图像都相对于会话的工作目录，或为绝对路径；网络路径在所有平台上都会被拒绝。调用在启动任务之前检查每个参数、目标路径和每张图像，因此被拒绝的调用不产生费用。没有 `replace` 时，调用随后只在该路径还没有文件时创建一个空的目标文件，因此两个同时写同一路径的调用中只有一个会启动任务，且都不会覆盖文件；完成的模型取代这个空文件，失败的调用会把它连同为它创建的文件夹一起删除。

| 工具 | 参数 | 制作内容 |
|---|---|---|
| `tripo_generate` | `prompt`（最多 1,024 个字符）、`image` 或 `views`（必需的 `front`，以及 `left`、`back`、`right` 中的一到三个），三者恰好给出其一；`face_limit`（48 到 50,000，使用 `quad` 时为 25,000）；`quad` | 由 Tripo 的 P2 模型制作、带 PBR 贴图（基础色、金属度、粗糙度和法线贴图）的模型 |
| `tripo_texture` | 一次 `tripo_generate` 调用的 `task_id`；`prompt`、`image` 或两者都给，此时由图像决定风格 | 同一个模型，以相同质量换上新贴图 |
| `tripo_rig` | 一次 `tripo_generate` 或 `tripo_texture` 调用的 `task_id`；`rig_type`（`biped`、`quadruped`、`hexapod`、`octopod`、`avian`、`serpentine`、`aquatic` 或 `others`） | 绑定了骨骼的模型；没有 `rig_type` 时，先由免费的绑定检查选出骨骼，Tripo 找不到合适的骨骼时调用失败 |
| `tripo_animate` | 一次 `tripo_rig` 调用的 `task_id`；`animations`，一到五个，各一次；`in_place`（默认为 true：没有根运动） | 带有这些动画剪辑的已绑定骨骼模型，Godot 会把它们导入其 AnimationPlayer：双足骨骼可用 `idle`、`walk`、`run`、`jump`、`fall`、`climb`、`dive`、`turn`、`slash`、`shoot` 和 `hurt`；四足、六足或八足骨骼可用 `walk`；蛇形或水生骨骼可用 `march`；鸟类和其他骨骼没有动画 |
| `tripo_task` | `task_id`；`path`（可选） | 等待之前某次调用停止等待的任务，而不重新启动它，并把它的模型保存到 `path` |

一张图像若是方向正确、只有一帧、最长边不超过 2,048 像素且不超过 7 MB 的 PNG、JPEG 或 WebP 文件，就按原样发送；sharp 能读取的其他任何图像都会被转正、缩小并转换，与 [图像生成](../image-generation/README.zh.md) 工具使用它以 `@deepseek-ai/dsh-image-generation/files` 导出的代码所做的相同。一个模型的图像总共最多 16 MB。调用每 3 秒询问一次任务的进展，状态请求偶然失败时最多连续重试五次；API 以繁忙（429）回应的启动请求，会在它指明的停顿（最多 10 秒）之后最多重试六次。调用停止等待时，其错误会指明任务，并请 agent 用它调用 `tripo_task`，这样慢的任务会被保存，而不会被制作并付费两次。模型文件会被检查为完整的 glTF 2.0 二进制文件，并按下一段所述修改，然后才通过目标旁边的临时文件写入；结果会说明文件、大小、模型朝向的轴、动画剪辑，以及绑定骨骼时的骨骼和 `tripo_animate` 可用的动画。

Tripo 的模型朝向 +X，因此每个保存的模型都会绕 +Y 转四分之一圈，朝向 glTF 的正面 +Z，Godot 也把它导入为模型的正面。一个名为 `Front` 的节点在场景的每个部分之上保存这次转向，在绑定骨骼的模型中则位于骨骼之上：像 three.js 这样还会应用蒙皮网格自身节点的导入器，若转向位于蒙皮网格之上，就会把模型转两次。即使在原地，Tripo 的剪辑也可能让模型离开它静止时站立的位置；它的原地奔跑让一只狐狸的髋部位于身前约 0.4 个单位处。因此每个剪辑都会沿骨骼根关节的平移在地面上移动：髋部结束时靠近起点的剪辑，以髋部静止时所在的位置为中心；髋部结束时离起点超过骨骼尺寸十分之一的剪辑，从该位置开始并保持其路径。节点不构成树的模型，或其转向会被移动或拉伸的父节点扭曲的模型，保存时不做转向，其结果也不说明朝向。

通过 WASD Engine 的 MCP 服务器连接的 agent 在没有会话的情况下，以提供方 `tripo`（标题为 Tripo）使用这些工具：`path`、`image` 和每个视图都必须是绝对路径。它们的任务计入 WASD Engine 已登录的账号，服务器在未登录时拒绝每次调用。服务器说明概览中提供方的描述请 agent 优先用它而不是自己制作 3D 模型，它的指南请 agent 优先用它而不是在 Blender 或代码中制作角色、生物和道具。该提供方会消耗账号的 AI 用量（`spendsUsage`），因此当 AI 用量已用完的免费账号仍停留在免费套餐时，服务器不会向连接的 agent 提供它的任何工具（[用量已用完的免费账号](../game-mcp/README.zh.md#free-accounts-whose-usage-is-used-up)）。

### 价格与账号

WASD Engine API 按 Tripo 报告的已用额度，以 Tripo 的 API 价格把每个成功的任务计入账号套餐的 AI 用量：一个带贴图的 P2 模型的费用是一次新贴图的十一倍，绑定骨骼是两倍半，每个动画与一次贴图相同；绑定检查免费，失败的任务不产生费用。套餐的 AI 用量用完后，启动任务会以 API 的 “Usage limit reached” 消息失败，并请 agent 让用户升级或开启自动充值；已在运行的任务仍会完成并保存。WASD Engine 未登录时，每次调用都会请 agent 让用户登录；API 拒绝的令牌（HTTP 401）会报告给账号服务，若它仍是已保存的令牌，账号服务会注销账号。

<a id="plugin-icon"></a>
### 插件图标

“游戏工具”标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，由 `package.json` 的 `icon` 字段指定：一个 WASD Engine 键帽，采用 WASD Engine Plugins 标志的配色，上面有一个代表 3D 模型的立方体，与[游戏扩展](../game-addons/README.zh.md#plugin-icon)图标一样为 WASD Engine 绘制。它不是 Tripo 的标志。Tripo 是其所有者的商标。WASD Engine 与 Tripo 没有关联，不由 Tripo 制作，也未获其认可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每次调用向 `apiOrigin` 上的一个启动路由发送一个 JSON 对象（`/v1/3d/generate` 带 `prompt`，或带以 `{ view, mime_type, data }` 表示、文件为 base64 的 `images`，以及 `face_limit` 和 `quad`；`/v1/3d/texture` 带 `task_id`、`prompt` 和 `image`；`/v1/3d/rig-check` 带 `task_id`；`/v1/3d/rig` 带 `task_id` 和 `rig_type`；`/v1/3d/animate` 带 `task_id`、`animations` 和 `in_place`），然后读取 `GET /v1/3d/tasks/<task_id>`，直到任务的 `status` 为 `success` 或 `failed`，再下载 `GET /v1/3d/tasks/<task_id>/model`，最多读取 256 MiB。每个请求都在 `x-dsh-auth-token` 中携带 `deepseekAccount.resolveToken` 为其 URL 交出的令牌，并且从不跟随重定向。错误回应带有 API 的消息，客户端按状态码为 agent 组织措辞。sharp 在第一次转换图像的调用时加载。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、账号令牌、工具注册和游戏 MCP 提供方 |
| [`src/api.ts`](src/api.ts) | API 客户端：启动、状态请求、等待、下载及其错误措辞 |
| [`src/glb.ts`](src/glb.ts) | GLB 文件：读取和写入其 JSON 块与二进制块，以及文件中的网格、蒙皮和动画剪辑 |
| [`src/prepare.ts`](src/prepare.ts) | 每个模型转向 +Z，以及每个剪辑移到模型静止时站立的位置 |
| [`src/tools.ts`](src/tools.ts) | 工具定义、参数检查、图像、目标文件和结果文本 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接的 agent 的工具和提供方说明 |
| [`src/types.ts`](src/types.ts) | 任务种类、骨骼、视图，以及 API 报告的任务 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍向其他 agent 提供工具的 MCP 服务器、其图像能制作出最佳模型的工具，以及游戏工具如何连接。

- [game-mcp](../game-mcp/README.zh.md) — 面向本机 agent 的 MCP 服务器。
- [image-generation](../image-generation/README.zh.md) — `image_generate`，`tripo_generate` 会把它的概念图变成模型。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md) — 游戏工具、它们的行和 MCP 服务器。
- [Tripo API 文档](https://developers.tripo3d.ai/en/docs) — Tripo 的模型、贴图、骨骼绑定和动画。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 看到 `tripo_generate`、`tripo_texture`、`tripo_rig`、`tripo_animate` 和 `tripo_task`。`tripo_generate` 的描述列出它制作的模型种类，请 agent 优先用它而不是在 Blender 中建模或在代码中用基本体搭建，并用 Blender 调整它的成果和制作精确或模块化的形状；说明最佳效果来自一张在纯色背景上、符合游戏美术风格的完整物体图像，例如 `image_generate` 制作的概念图，角色以 T 姿势或 A 姿势站立；说明每个模型都有 PBR 贴图，调用会等待，通常一分钟，且每个保存的模型都朝向 glTF 的正面 +Z；并请 agent 用 `asset_view` 查看模型，在 Godot 或 Blender 中缩放它，并把它转向游戏的前进方向。其他描述说明每一步建立在什么之上、返回什么，Tripo 为哪些骨骼提供哪些动画，原地剪辑停留在角色静止时站立的位置，以及如何把超过五个的剪辑载入同一个 AnimationLibrary。连接的 agent 看到同样的工具，每个文件都被描述为绝对路径，并在 `## Tripo` 下看到提供方的说明。模型看到的任何文本都不提及模型的费用，因此 agent 会制作游戏所需的内容；只有账号的 AI 用量用完时的失败才会请它把升级转告用户。

#### Token 影响

五个声明约为 6,500 个字符的 JSON；提供方的说明为 MCP 服务器的说明增加约 1,500 个字符。

#### KV Cache 影响

声明是静态的，因此留在已缓存的工具前缀中。

### 工具结果

#### 模型可见内容

结果为一到两句话：文件、大小、是否替换了文件、模型朝向的轴、任务的 `task_id` 及下一步使用它的工具、带动画模型的动画剪辑，以及绑定骨骼时的骨骼和动画。失败会说明要改什么：超出范围的参数、已存在的路径、缺失或不是图像的图像、Tripo 给出的任务失败原因、仍在运行的任务及再次等待它的 `tripo_task` 调用、已用完的套餐（WASD Engine API 的消息会指明用户升级或开启自动充值的账号页面，并请 agent 转告用户），或未登录的应用。

#### Token 影响

结果为一到两句话。

#### KV Cache 影响

在对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了工具提供的范围；它们是本包当前的约束。

- **只限 Tripo 自己的模型** — 贴图、骨骼和动画都建立在账号用这些工具制作的任务之上；在别处制作的模型，例如在 Blender 中制作或下载的模型，无法在这里由 Tripo 重新贴图、绑定骨骼或添加动画。
- **每个文件五个动画** — Tripo 在一个任务中最多添加五个预设动画；更多动画来自更多文件，游戏把它们的剪辑载入同一个 AnimationLibrary。
- **只有预设动画** — 鸟类和其他骨骼没有动画，任何骨骼都没有 Tripo 预设之外的动画；请在 Blender 或 Godot 中为它们制作动画。
- **大小由 Tripo 决定** — 模型以 Tripo 的大小生成，由 agent 在 Godot 或 Blender 中使其适合游戏；对于前进方向是其他轴的游戏，agent 也会转动朝向 +Z 的模型。
- **按髋部移动剪辑** — 剪辑的路径从其髋部读取，父节点取剪辑开始时的位置，因此根关节在播放中转动的剪辑，只在这一转动的范围内居中；移动距离小于骨骼尺寸十分之一的剪辑被视为停留在原地。
- **结果不会展示给模型** — 结果只说明文件；agent 用 `asset_view` 查看它，连接的 agent 用自己的模型查看器查看。
- **通用对话行** — Web 界面在通用工具行中显示工具调用，不显示模型预览。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

API 的 3D 路由固定模型（P2）、贴图质量（标准，带 PBR 贴图）、骨骼模型和 GLB 输出，自己把图像上传到 Tripo，不把 Tripo 的任务 id 和下载链接交给客户端，只为启动任务的账号提供该任务，并在第一次看到任务成功时按 Tripo 报告的额度收费一次。这里的预设动画名称重复了 API 的列表；API 不接受某种骨骼的某个名称时，会以它的 400 消息返回。

</details>
