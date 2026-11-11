---
description: "面向 agent（智能体）的 ElevenLabs：每个会话和 WASD Engine 的 MCP 服务器都提供 elevenlabs_voices、elevenlabs_speech、elevenlabs_sound_effect、elevenlabs_music、elevenlabs_clone_voice 与 elevenlabs_delete_voice 工具，用于为角色查找或克隆声音，并把语音、音效和音乐保存到游戏项目中；音频由 WASD Engine API 制作，费用计入已登录账号的套餐。"
kind: "package-reference"
---

# @deepseek-ai/dsh-elevenlabs

[English](README.md) | 中文

## 概述

ElevenLabs 插件让 agent（智能体）用 [ElevenLabs](https://elevenlabs.io) 为游戏角色配音，并制作游戏的音效和音乐。它在 ElevenLabs 的声音库（Voice Library）或其默认声音中查找声音，或根据用户的录音克隆声音，用 Eleven v4 Turbo 说出台词，用 SFX v3 制作音效，用 Music v2.5 作曲，并把每段音频保存为游戏项目中的 `.mp3` 或 `.wav` 文件。WASD Engine API 使用自己的 ElevenLabs 密钥制作音频，并把费用计入已登录账号的套餐。通过 WASD Engine 的 MCP 服务器连接的 agent 获得同样的工具。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `elevenlabs` 行插入每个 Web 与桌面配置，并设置 WASDEngine API 源，其表达式与 [`gateway.cordis.patch.yml`](../../bundle/base/wasdengine/gateway.cordis.patch.yml) 中账号登录的 `inferenceOrigin` 相同：

```yaml
- id: elevenlabs
  name: '@deepseek-ai/dsh-elevenlabs'
  config:
    apiOrigin: !!js >-
      ctx.get('launchEnvironment')?.getFrom('WASDENGINE_ORIGIN', ['process', 'user-env'])?.value || 'https://api.wasdengine.com'
```

「设置 › 内置插件」与「插件」页面的「游戏工具」标签页列出这一行；「插件」页面上的开关会在 profile patch 中写入 `- id: elevenlabs` 与 `disabled: true` 来关闭它。启用时不发出任何请求。插件需要 `tools` 与 `workingDirectory` 服务；每次调用都读取 `deepseekAccount` 服务的账号令牌；有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，它把工具提供给连接的 agent。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiOrigin` | `https://api.wasdengine.com` | WASD Engine API 的源；账号登录只把令牌交给它的 `inferenceOrigin`，因此两者必须一致 |
| `searchTimeoutMs` | `30000` | 一次 `elevenlabs_voices` 调用的时限 |
| `generationTimeoutMs` | `210000` | 一次 `elevenlabs_speech` 或 `elevenlabs_sound_effect` 调用的时限 |
| `musicTimeoutMs` | `660000` | 一次 `elevenlabs_music` 调用的时限 |

### 工具

| 工具 | 作用 |
|---|---|
| `elevenlabs_voices` | 按 `query`（例如 “old British wizard” 这样的描述）在 ElevenLabs 的声音库中列出声音，在 `source` 为 `default` 时列出其默认声音，或在 `source` 为 `mine` 时列出账号克隆的声音，并给出每个声音的 ID、名称、性别、年龄、口音、语言、用途和描述。`gender`、`age`、`accent`、`language` 与 `use_case` 用于筛选；`page` 与 `limit`（1 到 30，默认 10）用于分页。免费 |
| `elevenlabs_speech` | 用 Eleven v4 Turbo 以声音 `voice_id` 说出 `text`（最多 5,000 个字符），并保存到 `path`。方括号中的音频标签（例如 `[whispers]`）指导演绎方式；`language`、`speed`（0.7 到 1.2）、`stability`、`similarity`、`style`（0 到 1）、`seed`、`previous_text` 与 `next_text` 用于调整它 |
| `elevenlabs_sound_effect` | 用 SFX v3 根据 `prompt` 制作音效，并保存到 `path`；`duration_seconds`（0.5 到 30）固定其时长，`loop` 让它无缝循环，`prompt_influence`（0 到 1）设置它贴合提示的程度 |
| `elevenlabs_music` | 用 Music v2.5 根据 `prompt` 作曲，并保存到 `path`；`duration_seconds`（3 到 300）固定其时长，`instrumental` 去掉人声 |
| `elevenlabs_clone_voice` | 在用户确认同意后，用 `samples`（同一说话人的 1 到 5 段 `.wav` 或 `.mp3` 录音）克隆名为 `name` 的声音；`description` 与 `remove_background_noise` 可选。新声音只为该账号说话 |
| `elevenlabs_delete_voice` | 删除账号的克隆声音 `voice_id`，从而腾出名额 |

`path` 相对于会话的工作目录，或为绝对路径；其扩展名决定文件类型：语音和音效为 `.mp3` 或 `.wav`，音乐为 `.mp3`。调用在付费请求之前检查路径和每个参数：路径指向文件夹，或指向已存在的文件而 `replace` 不为 true 时，不产生任何费用。文件先写入旁边的临时文件，因此要么完整出现，要么完全不出现。结果给出文件、大小、音频时长；对循环音效和音乐，还给出让它在 Godot 中循环的导入选项。

通过 WASD Engine 的 MCP 服务器连接的 agent 在 provider `elevenlabs` 下使用这些工具，不需要会话：`elevenlabs_voices` 标记为只读，语音、音效和音乐工具要求 `path` 为绝对路径，`elevenlabs_clone_voice` 要求 `samples` 为绝对路径并传入 `consent: true`。它们的音频费用计入 WASD Engine 已登录的账号；未登录时，服务器拒绝每次调用。

### 价格与账号

WASD Engine API 按 ElevenLabs 的 API 价格，把每次生成的费用计入账号套餐的 AI 用量：语音按其文本的字符数计费，音效和音乐按返回音频的时长计费。查找声音和失败的生成不产生费用。套餐的 AI 用量用完后，调用失败并附上 API 的 “Usage limit reached” 消息，并请 agent 让用户升级套餐或开启自动充值。WASD Engine 未登录时，每次调用都请 agent 让用户登录；API 拒绝的令牌（HTTP 401）会报告给账号服务，若它仍是已保存的令牌，账号服务会退出登录。

### 克隆声音

`elevenlabs_clone_voice` 用 ElevenLabs 的即时声音克隆（Instant Voice Cloning）为已登录账号单独克隆声音：WASD Engine API 对其他每个账号都把它当作未知声音拒绝，`elevenlabs_voices` 也只在 `source` 为 `mine` 时列出它。克隆需要 Pro 或 Max 套餐；克隆本身不收费，每个账号最多保留三个克隆声音，`elevenlabs_delete_voice` 可以腾出一个名额。录音必须来自同一说话人，总长 10 秒到 5 分钟，最好是 1 到 2 分钟清晰的语音，每段最多 10 MB；录音发送到 API 并转交 ElevenLabs，插件不保留副本。

ElevenLabs 要求其账号持有者在每次克隆时确认拥有克隆该声音的权利和许可。在发送任何内容之前，用户要确认以下声明，版本 `2026-11-11`（[`src/consent.ts`](src/consent.ts)）：“These recordings are of my own voice, or of a person who gave me express permission to clone their voice for this purpose, and I will not use the cloned voice to impersonate, deceive, or harm anyone.”（这些录音是我自己的声音，或是明确允许我为此克隆其声音的人的声音，并且我不会用克隆的声音冒充、欺骗或伤害任何人。）在会话中，工具通过 WASD Engine 的批准提示（`ctx.approval`）以用户的语言询问，未获批准的克隆不会发送任何内容；会话的审计日志会记录问题和回答。通过 MCP 服务器连接的 agent 必须向其用户展示这段声明并传入 `consent: true`，因为 WASD Engine 的提示无法到达它。API 会随每个克隆记录声明的版本、确认的位置（`app` 或 `mcp`）以及发出请求的令牌。

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包 `package.json` 的 `icon` 字段所指向的 [`icon.svg`](icon.svg)：一个包内自有的声波图形，采用 WASD Engine 键帽紫色，而不是 ElevenLabs 的标志。WASD Engine 与 ElevenLabs 无关联，并非由 ElevenLabs 制作或认可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每次调用都向 API 发送一个 JSON 对象：`apiOrigin` 上的 `POST /v1/audio/voices`、`/v1/audio/speech`、`/v1/audio/sound-effects` 或 `/v1/audio/music`；克隆以 multipart 表单数据发送到 `POST /v1/audio/voices/clone`，删除调用 `DELETE /v1/audio/voices/<voice id>`；每个请求都把 `deepseekAccount.resolveToken` 为该 URL 交出的令牌放在 `x-dsh-auth-token` 中，从不跟随重定向。生成的应答是音频文件，其时长（毫秒）位于 `x-audio-duration-ms`；客户端最多读取 64 MiB 的音频和 4 MiB 的 JSON。错误应答带有 API 的消息，客户端按状态码为 agent 组织措辞。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、账号令牌、工具注册与游戏 MCP provider |
| [`src/api.ts`](src/api.ts) | API 客户端：查找声音、生成音频与错误措辞 |
| [`src/tools.ts`](src/tools.ts) | 工具定义、参数检查、文件写入与结果文本 |
| [`src/consent.ts`](src/consent.ts) | 同意声明、其版本以及八种语言的批准提示 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接 agent 的工具、它们的 `consent` 参数与 provider 的说明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍把工具提供给其他 agent 的 MCP 服务器，以及各游戏工具如何连接。

- [game-mcp](../game-mcp/README.zh.md)——面向这台电脑上 agent 的 MCP 服务器。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md)——游戏工具、它们的行与 MCP 服务器。
- [ElevenLabs 模型](https://elevenlabs.io/docs/overview/models)——Eleven v4 Turbo、SFX v3 与 Music v2.5。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 看到 `elevenlabs_voices`，带可选的 `query`、`source`、`gender`、`age`、`accent`、`language`、`use_case`、`page` 与 `limit`；`elevenlabs_speech`，带 `text`、`voice_id`、`path` 与可选的 `language`、`speed`、`stability`、`similarity`、`style`、`seed`、`previous_text`、`next_text` 和 `replace`；`elevenlabs_sound_effect`，带 `prompt`、`path` 与可选的 `duration_seconds`、`loop`、`prompt_influence` 和 `replace`；`elevenlabs_music`，带 `prompt`、`path` 与可选的 `duration_seconds`、`instrumental` 和 `replace`；`elevenlabs_clone_voice`，带 `name`、`samples` 与可选的 `description` 和 `remove_background_noise`；以及 `elevenlabs_delete_voice`，带 `voice_id`。描述给出模型名称和描述示例，提到音频标签，说明每次生成都会消耗用户 WASD Engine 套餐的 AI 用量，其中音乐最多，并说明克隆需要说话人的许可，由用户在 WASD Engine 中确认。连接的 agent 看到同样的工具，只是 `path` 和 `samples` 被描述为绝对路径，克隆工具多一个必填的 `consent`，并在 `## ElevenLabs` 下看到引用了同意声明的 provider 说明。

#### Token 影响

六个声明合计约 7,500 个字符的 JSON；provider 的说明为 MCP 服务器的说明增加约 1,300 个字符。

#### KV Cache 影响

这些声明是静态的，因此留在已缓存的工具前缀中。

### 工具结果

#### 模型可见内容

查找声音的结果先给出搜索和筛选条件，然后每个声音一行，列出其 ID、名称、标签以及截断到 160 个字符的描述，再说明是否还有下一页，以及 ID 应传给 `elevenlabs_speech`。生成的结果给出文件、大小、是否替换了已有文件、音频时长、模型，语音还给出声音和字符数；循环音效和音乐还附上让它们在 Godot 中循环的导入选项。失败时说明要改什么：超出范围的参数、已存在的路径、API 拒绝的声音、用完的套餐，或未登录的应用。克隆的结果给出声音、其 ID、录音以及账号保留了几个克隆声音；删除的结果给出声音和剩余的克隆声音数。

#### Token 影响

查找声音的结果每个声音约 250 个字符，默认 10 个，最多 30 个。生成的结果为一到两句话。

#### KV Cache 影响

在对话中只追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了工具提供的能力；它们是本包当前的约束。

- **无法试听**——agent 听不到音频；它根据时长判断结果，由用户试听文件。
- **通用会话行**——Web UI 在通用工具行中显示这些工具调用，没有播放器。
- **不设计声音**——工具使用现有声音和根据录音克隆的声音；它们不根据描述设计声音。
- **每次调用一个文件**——多个角色的对话需要每句台词调用一次，音乐没有作曲计划或分段。
- **音乐只有 MP3**——API 只以 MP3 提供音乐，在 Godot 中循环时会带有 MP3 编码器填充造成的间隙。
- **声音库的声音可能被撤下**——声音的所有者把它从声音库中移除后，它会在所有者设置的通知期（30 天到 2 年）内继续可用，之后停止工作；已经制作的文件仍可播放，新的台词需要换用其他声音。
- **同意以用户的确认为准**——工具无法判断录音是谁的声音；它们记录用户的确认，取得说话人的许可是用户的责任。
- **克隆共用服务的声音名额**——每个克隆声音都会占用服务唯一的 ElevenLabs 工作区中的一个自定义声音名额，因此当服务保留的克隆声音达到上限时，新的克隆会失败，直到删除一些克隆声音。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

API 的音频路由固定 ElevenLabs 的模型和输出格式，拒绝其所有者设置了自定义价格的声音，并测量所计费的音频。语音和音效以 44.1 kHz 128 kbps 的 MP3 或 48 kHz 16 位的 WAV 返回，音乐以 48 kHz 192 kbps 的 MP3 返回。请求字段就是工具参数（名称相同），另加根据文件扩展名得出的 `format`（`mp3` 或 `wav`）；查找声音时把 `limit` 作为 `page_size` 发送。克隆发送 `name`、`description`、`remove_background_noise`、`consent`（`true`）、`consent_statement`（版本）、`consent_channel`（`app` 或 `mcp`），并把每段录音作为 `files` 发送；API 拒绝它不认识的声明版本。

</details>
