---
description: "面向 agent（智能体）的音频：每个会话和 WASD Engine 的 MCP 服务器都提供 audio_search 与 audio_review 工具，用于列出游戏项目的音效、对白和音乐，并按音频标签页播放它们的方式进行测量，附带每个声音的波形与频谱图；另有音频标签页与 SuperCollider 工具共用的浏览器安全音频模块。"
kind: "package-reference"
---

# @deepseek-ai/dsh-game-audio

[English](README.md) | 中文

## 概述

音频插件让无法收听的 agent（智能体）也能审阅游戏的音效、对白和音乐。`audio_search` 列出项目中的声音及其类型、格式和时长。`audio_review` 按 WASD Engine 音频标签页播放的方式测量一个声音：峰值与响度、削波、两端的静音、频谱、循环衔接、立体声声道以及 Godot 导入设置，并附带波形与频谱图，还可以在用户的音频标签页中打开该声音。通过 WASD Engine 的 MCP 服务器连接的 agent 获得同样的工具。`./audio` 导出包含音频标签页与 SuperCollider 共用的格式、文件头探测、测量和图像。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 在每个 Web 和 Desktop 配置文件中、音频标签页的 `ui-game-audio` 行之后插入 `game-audio` 行，不带配置：

```yaml
- id: game-audio
  name: '@deepseek-ai/dsh-game-audio'
```

插件需要 `tools` 和 `workingDirectory` 服务。有 `attachments` 和 `llm` 服务时，它把图像交给模型接受图像的会话；有 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务时，它把工具提供给已连接的 agent。游戏工具开关不列出它。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `measureTimeoutMs` | `60000` | 一次 `audio_review` 调用的时限，该调用等待窗口读取、解码并测量声音 |
| `maxReviewSeconds` | `300` | 一次 `audio_review` 调用测量的最长片段，单位为秒 |
| `maxPreviewBytes` | `268435456` | 窗口为测量而读取的最大文件，256 MiB |
| `maxFolders` | `2000` | 一次项目遍历列出的文件夹数，包括项目文件夹本身 |
| `maxSounds` | `5000` | 一次项目遍历收集的声音数 |

### 工具

| 工具 | 作用 |
|---|---|
| `audio_search` | 遍历项目文件夹，查找 WAV、MP3、Ogg Vorbis 与 Opus、FLAC 和 AIFF 文件，跳过隐藏文件夹和 `node_modules`，读取每个文件的文件头，并列出声音及其类型、格式、编码、声道、采样率、时长和大小，以及每个文件夹中各类声音的数量。`query` 先排名称以它开头的声音，再排名称和路径包含它的声音，最后排路径按顺序包含其字母的声音；`kind`（`effect`、`dialogue` 或 `music`）和 `folder` 缩小列表范围；`limit`（1 到 200，默认 50）和 `offset` 用于分页 |
| `audio_review` | 请求一个可以读取该会话的 WASD Engine 窗口，以声音自身的采样率解码并测量它：每个声道的峰值和 RMS 电平、按 ITU-R BS.1770 计算的响度、开头和结尾低于 -60 dBFS 的静音、最强的频谱成分和频谱质心、结尾与开头的衔接，以及两个声道的相关性与平衡。它从声音旁边的 `.import` 文件读取 Godot 的导入方式；除非 `picture` 为 false 或模型只接受文本，否则返回波形与频谱图；`show` 会在用户跟随的会话的音频标签页中打开该声音：subagent（子智能体）或队友的声音在其主导者的会话中打开。`start` 和 `end` 用于测量长音轨的一部分，最长为 `maxReviewSeconds`；比音频标签页解码上限（其 `maxDecodedSeconds`，默认 20 分钟）更长的声音以 `AUDIO_TOO_LARGE` 失败 |

声音的类型取自其文件名、或从最近的文件夹起其上级文件夹中，第一个表示类型的单词：`sfx`、`fx`、`sound`、`foley`、`ui` 或 `ambience` 表示音效，`voice`、`vo`、`dialogue`、`speech`、`narrator` 或 `bark` 表示对白，`music`、`bgm`、`ost`、`soundtrack`、`song` 或 `jingle` 表示音乐。路径中没有这类单词时，30 秒及以上的声音算作音乐，其余算作音效。

审阅结果的文本会对游戏中播放效果不好的问题给出警告：达到满刻度而削波的采样、直流偏移、开头有 50 毫秒或更长静音因而播放延迟的音效或对白、在 Godot 循环处会有咔哒声的衔接、相位相反的声道，以及两个声道采样完全相同的立体声文件。

通过 WASD Engine 的 MCP 服务器连接的 agent 在提供方 `audio` 下使用这些工具，每个工具都必须提供 `project`，即游戏项目文件夹的绝对路径；两个工具都标记为只读，在已连接 agent 于该项目中的会话里运行；即使会话属于登记在其上层的游戏项目，声音路径也从 `project` 文件夹算起；并在结果文本之后以 PNG 字节发送图像。

### 音频模块

`./audio` 导出是浏览器安全的，且没有依赖：客户端打包纯净性检查只把 `@deepseek-ai/dsh-game-audio/audio` 作为可内联的线路层放行，因此音频标签页内联它，而 Host 工具和 SuperCollider 导入它。

| 导出 | 作用 |
|---|---|
| `audioFormatOf`、`AUDIO_EXTENSIONS` | 按小写扩展名列出的格式，以及媒体类型和该格式是否由浏览器解码 |
| `audioCategoryOf`、`pathWords` | 根据路径和时长判断声音的类型 |
| `probeAudio` | 从几个较小的字节窗口读取文件头信息：WAV 和 AIFF 的块、FLAC 的 STREAMINFO、MP3 的 Xing、Info 或 VBRI 帧数减去 LAME 编码器延迟和填充，或按比特率估算，以及 Ogg 流最后的 granule 位置 |
| `openAiff`、`decodeAiff` | 浏览器不解码的 AIFF 和 AIFC 采样：任一字节序的 8 到 32 位整数 PCM、无符号 8 位，以及 32 位和 64 位浮点；`openAiff` 定位采样并逐个读取而不复制，`decodeAiff` 复制全部采样 |
| `analyzeAudio`、`integratedLoudness`、`loopSeam`、`stereoImage`、`seamClicks` | 对交错浮点采样的测量 |
| `drawAudioImage`、`describeAudioImage` | 原始 RGB 格式的图像，以及说明其面板和网格的句子 |
| `AUDIO_ERROR` | 工具的错误码，窗口无法完成请求时用它作答 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

`audio_review` 在项目文件夹内解析路径，检查其格式以及文件是否存在，在 Host 上读取文件头和 Godot 导入设置，然后以会话的 Agent 为作用域发出带作用域的 waterfall 事件 `game-audio/measure`。请求从会话头部记录的文件夹命名声音，窗口也以该文件夹解析会话的路径，因此工作目录移到项目文件夹之下的 agent（例如执行 `working_directory` 之后，或在子文件夹中启动的 subagent）测量的正是它所指定的文件。远程事件允许列表把请求转发给可以读取该会话的窗口；第一个作答的浏览器插件通过 `workspaceFiles.readBytes` 读取文件、解码、测量所请求的片段并绘制图像；没有窗口作答时，插件的兜底以 `AUDIO_NO_WINDOW` 拒绝。答复的每个字段在进入结果之前都会经过带边界的校验：有限数值、最多 64 个声道，以及最大 16 MiB 的 PNG。窗口自身的失败保留其消息和错误码，例如 `AUDIO_UNREADABLE`，并按 agent 指定的方式命名声音。`show` 为调用者 subagent 树的根（通过可选的 `subagents` 服务找到）发出 `game-audio/reveal`，没有存活的根时则为调用者自己的会话发出；音频标签页据此打开该声音。

`audio_search` 在 Host 上遍历文件夹，并以每次八个的方式探测每个列出的声音；只要文件的大小和修改时间不变，插件就保留其探测结果，最多保留 `maxSounds` 个文件。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、探测缓存、测量请求及其兜底、会话的图像附件、工具注册和游戏 MCP 提供方 |
| [`src/tools.ts`](src/tools.ts) | 工具定义、参数和返回值 |
| [`src/describe.ts`](src/describe.ts) | 结果文本 |
| [`src/scan.ts`](src/scan.ts) | 项目遍历 |
| [`src/files.ts`](src/files.ts) | 通过文件句柄进行的文件头探测，以及 Godot 导入设置的读取 |
| [`src/result.ts`](src/result.ts) | 对窗口答复和已存储结果字段的校验 |
| [`src/mcp.ts`](src/mcp.ts) | 面向已连接 agent 的工具和提供方说明 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的请求、答复和打开类型，以及两个事件 |
| [`src/audio/`](src/audio/index.ts) | `./audio` 模块 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍播放声音的标签页，以及把工具提供给其他 agent 的服务器。

- [ui-game-audio](../ui-game-audio/README.zh.md) —— 音频标签页，负责回答测量请求。
- [game-mcp](../game-mcp/README.zh.md) —— 面向本机 agent 的 MCP 服务器。
- [supercollider](../supercollider/README.zh.md) —— 声音设计工具，其渲染使用同样的测量和图像。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md) —— 游戏工具、它们的行，以及 MCP 服务器。

-----

<a id="model-experience"></a>
## 模型体验

### 工具声明

#### 模型可见内容

会话的 agent 看到 `audio_search`，带有可选的 `query`、`kind`、`folder`、`limit` 和 `offset`；以及 `audio_review`，带有 `path` 和可选的 `start`、`end`、`picture` 与 `show`。描述说明了格式、如何判断声音类型、测量内容，以及 agent 无法收听。已连接的 agent 看到同样的工具，每个工具都必须提供 `project`，并在 `## Audio` 下看到提供方说明。

#### Token 影响

两个声明合计约 2,600 个字符的 JSON；提供方说明为 MCP 服务器的说明增加约 700 个字符。

#### KV Cache 影响

声明是静态的，因此保留在已缓存的工具前缀中。

### 工具结果

#### 模型可见内容

搜索结果给出声音的数量以及各类型的数量，每个声音占一行，列出类型、格式、编码、声道、采样率、时长和大小，随后是每个文件夹的数量。审阅结果给出声音的类型和格式、Godot 的导入方式、所测量的片段、电平与响度、两端的静音、频谱、循环衔接、立体声声道、对发现的每个问题的警告，以及一句说明图像面板和网格的话；会话的模型接受图像时，随后附上图像附件。失败时说明原因：路径在项目之外、文件不存在、文件不是声音、参数错误、没有打开的窗口、声音比窗口的解码上限更长，或者窗口无法读取、解码或测量该声音。

#### Token 影响

搜索结果每个声音约 120 个字符，默认 50 个，最多 200 个。审阅结果约 1,000 个字符，外加一张 1024 像素宽、418 到 536 像素高的 PNG 图像。

#### KV Cache 影响

在对话中仅追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了工具测量的内容和位置；它们是当前的包约束。

- **由窗口解码声音** —— 没有打开的 WASD Engine 窗口时 `audio_review` 会失败，因为 MP3、Ogg 和 FLAC 由浏览器解码；`audio_search` 不需要窗口。
- **时长** —— 窗口要解码整个声音才能测量其中一部分，因此比音频标签页解码上限更长的声音无法审阅。
- **没有文字稿** —— 审阅会测量对白，但不会说明说了什么。
- **固定的类型词** —— 类型取自英文路径单词和时长；文件夹以其他方式命名的项目只能按时长得到音效和音乐。
- **没有响度目标** —— 审阅报告响度和峰值，但不会在声音之间或与目标电平进行比较。
- **格式** —— 不列出 M4A、AAC、WebM 和 tracker 模块，并且只读取 WAV sampler 块中的第一个循环。
- **通用的对话行** —— Web UI 在通用工具行中显示这些工具调用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

测量和图像从 SuperCollider 包移到了这里，SuperCollider 为 `render_audio` 和 `analyze_audio` 导入它们，因此两个工具以相同方式报告声音。Godot 4 导入 WAV、Ogg Vorbis 和 MP3；其 WAV 导入以 `edit/loop_mode` 表示循环模式（0 跟随文件的 sampler 块，1 关闭，2 正向，3 往返，4 反向），并以采样帧为单位给出 `edit/loop_begin` 和 `edit/loop_end`；其 Ogg 和 MP3 导入以秒为单位给出 `loop` 和 `loop_offset`。

</details>
