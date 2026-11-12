---
description: "右侧栏的音频标签页：游戏项目的音效、对白和音乐，可搜索、按类型筛选，并按文件夹分组且显示每个声音的时长；播放时显示波形，可无缝循环播放，并显示格式、响度和峰值等详细信息；它还为 agent（智能体）的 audio_review 解码并测量声音，并打开 agent 要展示的声音。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-audio

[English](README.md) | 中文

## 概述

音频标签页让用户无需离开 WASD Engine 就能试听会话游戏项目中的声音。它按文件夹列出项目的音效、对白和音乐及其时长，提供搜索和类型筛选。点击一个声音即可播放并显示其波形，点击或拖动波形可以跳转；正在播放时，方向键会移到下一个声音。循环控件无间隙地循环声音，详细信息显示格式、时长、响度和峰值，并对问题给出提示。该标签页还为 agent（智能体）的 `audio_review` 解码并测量声音。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 在每个 Web 和 Desktop 配置文件中、素材标签页的行之后插入 `ui-game-audio` 行，不带配置：

```yaml
- id: ui-game-audio
  name: '@deepseek-ai/dsh-client-ui-game-audio'
```

该行的 Host 部分为空；Loader 行的存在是为了让 Host 提供 `./client` 包。浏览器插件注册右侧栏的 `audio` 页面类型，其引导条目的顺序为 46，位于素材标签页之后。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxFolders` | `2000` | 一次遍历列出的文件夹数（包括项目文件夹本身），达到后停止并说明列表不完整 |
| `maxSounds` | `5000` | 一次遍历收集的声音数，达到后停止并说明列表不完整 |
| `maxPreviewBytes` | `268435456` | 标签页读取的最大文件，256 MiB；更大的声音显示提示 |
| `maxDecodedSeconds` | `1200` | 标签页解码的最长声音，20 分钟；更长的声音显示提示 |
| `maxMeasuredSeconds` | `300` | 详细信息从声音开头起测量的最长片段 |

### 标签页列出的内容

标签页遍历会话的工作区，查找 WAV、MP3、Ogg Vorbis 与 Opus、FLAC 和 AIFF 文件，跳过隐藏文件夹和 `node_modules`，并每次读取少量声音的文件头以获得时长。列表把声音归入可以折叠的文件夹标题之下；在搜索框中输入时，声音按名称或路径的匹配程度排序。全部、音效、对白和音乐筛选使用 `@deepseek-ai/dsh-game-audio` 给出的声音类型：路径中的单词，例如 `sfx`、`voice` 或 `music`，否则按时长判断。标签页显示时，如果上次遍历早于 2 秒或其耗时的十倍，就会重新遍历；按下刷新控件时也会重新遍历。

### 试听

点击一个声音会选中、解码并播放它；点击正在播放的声音会暂停它。方向键移动选择，正在播放时会播放下一个声音。播放器显示波形（点击或拖动可移动播放头）、当前位置与时长、播放控件、按采样精确循环声音的循环控件，以及音量。整个窗口共用一个播放器，因此跨会话同一时间只播放一个声音；选择另一个声音、声音的文件发生变化或标签页关闭时，声音会停止。所选声音的文件变化时会重新读取，因此 agent 重新生成的声音会以最新内容播放。

### 详细信息

播放器下方显示声音的类型、格式及其编码、采样率和声道、时长、大小、以 LUFS 表示的响度，以及以 dBFS 表示的峰值；这些数值由 agent 的 `audio_review` 使用的同一组函数测量。提示会指出削波的采样、音效或对白开头 50 毫秒或更长的静音、循环控件开启时声音循环处的咔哒声、两个声道内容相同、直流偏移，以及超过详细信息测量长度的声音。

### 对 agent 的答复

对于窗口可以读取的会话发出的 `game-audio/measure` 请求，插件读取声音，以其自身的采样率解码，测量所请求的片段，并在请求需要时在 canvas 上把波形与频谱图绘制为 PNG，每次处理一个请求。按文件头（文件头未给出时按解码结果）长于 `maxDecodedSeconds` 的声音以 `AUDIO_TOO_LARGE` 失败，与标签页拒绝它的方式一致。在等待期间调用已结束的请求轮到时会被丢弃，正在处理的请求在下一步停止，AIFF 解码在下一个分片停止；浏览器的解码无法中止，会运行到结束。由于 AIFF 文件可能给出带小数的采样率，测量结果以整数赫兹表示采样率。其他作用域的请求交给下一个窗口。对于 `game-audio/reveal`，插件会在该会话的音频标签页中打开声音；如果屏幕上是另一个会话，会先显示该会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

该标签页不添加 Host 服务：它用 `workspaceFiles.list` 列出工作区，用 `workspaceFiles.readBytes` 读取文件头和文件，并用 `file` 资源跟随所选文件。浏览器通过以文件头所给采样率创建的 `OfflineAudioContext` 解码 WAV、MP3、Ogg 和 FLAC，因此采样保持文件自身的采样率；AIFF 文件用 `@deepseek-ai/dsh-game-audio/audio` 中的 `openAiff` 解码，客户端包会内联该模块：先确认 AudioBuffer 能容纳文件的声道数和采样率、且声音不超过 `maxDecodedSeconds`，再把采样分片直接写入缓冲区，分片之间页面可以处理其事件。播放器是整个窗口共用的一个 `AudioContext`，在第一次播放时创建，用一个 gain 节点控制音量，每次开始播放都新建一个 `AudioBufferSourceNode`。

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 配置、每个会话的状态、标签页类型与插槽、播放器，以及对测量和打开事件的答复 |
| [`src/client/AudioTab.tsx`](src/client/AudioTab.tsx) | 标签页主体：搜索、筛选、播放器、列表，以及空状态和失败状态 |
| [`src/client/SoundList.tsx`](src/client/SoundList.tsx) | 带文件夹标题和键盘移动的列表 |
| [`src/client/SoundPlayer.tsx`](src/client/SoundPlayer.tsx) | 读取并解码所选声音、波形、控件和详细信息 |
| [`src/client/source.ts`](src/client/source.ts) | 一个会话的遍历、文件头探测和选择 |
| [`src/client/scan.ts`](src/client/scan.ts) | 工作区遍历 |
| [`src/client/rows.ts`](src/client/rows.ts) | 列表行：类型、筛选、搜索、文件夹和方向键移动 |
| [`src/client/read.ts`](src/client/read.ts) | 完整读取和分窗口读取 |
| [`src/client/decode.ts`](src/client/decode.ts) | 解码、测量和图像 |
| [`src/client/agent.ts`](src/client/agent.ts) | 对测量请求的答复 |
| [`src/client/playback.ts`](src/client/playback.ts) | 窗口的播放器 |
| [`src/client/peaks.ts`](src/client/peaks.ts) | 波形的形状 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面介绍 agent 的音频工具，以及本标签页旁边的标签页。

- [game-audio](../game-audio/README.zh.md) —— agent 的音频工具和共享音频模块。
- [ui-game-assets](../ui-game-assets/README.zh.md) —— 展示项目 2D 和 3D 美术素材的素材标签页。
- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md) —— 游戏工具、它们的行，以及 MCP 服务器。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-game-audio` 间接产生影响；其 `audio_review` 把本包产生的测量和图像渲染为有界的工具结果。

#### KV Cache 影响

不会直接使缓存失效；具名消费方负责请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了标签页播放和显示的内容；它们是当前的包约束。

- **列表不实时更新** —— 列表只在标签页显示或使用刷新控件时跟随项目；所选声音本身会随变化重新加载。
- **整个文件解码** —— 声音在播放前会被完整解码，因此长音乐音轨需要片刻，占用的内存与其时长成正比。
- **浏览器支持的格式** —— 浏览器无法解码的编码的 WAV 文件（例如 ADPCM）会显示提示而不是播放。
- **固定的跳过规则** —— 遍历总是跳过隐藏文件夹和 `node_modules`；放在隐藏文件夹中的声音不会显示。
- **不保存音量** —— WASD Engine 重新启动后，音量和循环控件会恢复默认。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

`decodeAudioData` 会重采样到其上下文的采样率，因此解码用的上下文采用文件头给出的采样率；文件头未给出采样率的文件以 48 kHz 解码。Chromium 在用户操作之前会让 `AudioContext` 处于暂停状态，因此播放器在第一次播放时创建上下文，而第一次播放由点击或按键触发。

</details>
