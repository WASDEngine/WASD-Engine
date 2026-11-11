---
description: "面向部署方与维护者的无界面 SuperCollider MCP 工具：配置数据目录、sclang 与 scsynth 可执行文件以及超时，或排查 mcp__wasd_supercollider__ 工具、运行时搜索、运行 sclang 的桥接进程以及离线渲染。"
kind: "package-reference"
---

# @deepseek-ai/dsh-supercollider

[English](README.md) | 中文

## 概述

让 agent（智能体）用 SuperCollider 代码设计音效和音乐，并把它们离线渲染为游戏项目中的音频文件。工具不会发出任何声音，因此每次渲染和分析都会返回电平、响度、静音和频谱数据，以及一张波形与声谱图图像，供判断声音之用。WASD Engine 的 Web 与 Desktop 默认启用这些工具；Desktop 应用自带不含图形界面的 SuperCollider，在其他环境中工具使用已安装的版本。每个对话都有自己的解释器；崩溃、超时或长时间没有调用会丢失其 SynthDef 和变量。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 需要以文件形式制作游戏音频（音效、界面音、环境音和音乐循环）时，选用这些工具。插件以独立的用户目录启动自己的 sclang（SuperCollider 语言解释器），从不连接用户已打开的 SuperCollider。激活插件只会注册其 MCP 服务器 `wasd_supercollider`，不做其他事：首次工具调用之前不会搜索或启动 SuperCollider，因此在没有 SuperCollider 的机器上插件也能加载。

### 默认组合

fork 的 patch 文件 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `supercollider` 行插入每个 Web 与 Desktop profile，并把它的数据目录放在 harness 主目录下：`~/.wasdengine/supercollider`；设置了 `DSH_HOME` 时为 `$DSH_HOME/supercollider`。

```yaml
- id: supercollider
  name: '@deepseek-ai/dsh-supercollider'
  config:
    dataRoot: !!js dshHomePath('supercollider')
```

插件需要 `mcpManager` 服务，由 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 组合包的 `mcp-manager` 行提供。在其他组合中，请在本行旁挂载 [`dsh-mcp-manager`](../../mcp/mcp-manager/README.zh.md)，并设置绝对路径的 `dataRoot`。

### 关闭工具或修改设置

profile patch 按 id 覆盖该行。把下面的条目加入 `$DSH_HOME/profiles/<name>/cordis.patch.yml`；未设置 `DSH_HOME` 时 `$DSH_HOME` 为 `~/.wasdengine`，标准 profile 名为 `web` 与 `desktop`。编辑 patch 后重启 Web 或 Desktop。插件页面「游戏工具」标签页上的开关（[`ui-game-tools`](../ui-game-tools/README.zh.md)）通过插件管理器添加或删除这一 `disabled` 条目，插件管理器随即应用更改，或说明更改需要重启后才生效。

```yaml
- id: supercollider
  disabled: true
```

禁用该行后，模型不再看到这些工具和服务器指令，正在运行的解释器也会停止。设置 `config` 的 patch 会替换该行的整个配置，因此请在要修改的字段旁重新写出 `dataRoot`：

```yaml
- id: supercollider
  config:
    dataRoot: !!js dshHomePath('supercollider')
    sclangPath: /opt/supercollider-headless/sclang
```

### 配置

[`src/index.ts`](src/index.ts) 声明并校验以下字段。每个时限都是 1 到 2,147,483,647 之间的整数毫秒数。`dataRoot`，或非空的 `sclangPath` 或 `scsynthPath` 为相对路径时，或 `requestTimeoutMs` 没有比 `toolCallTimeoutMs` 至少少 30 s 时，激活失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 存放解释器用户目录、渲染临时文件、类库配置和工作类副本的绝对目录 |
| `sclangPath` | `''` | 无界面 SuperCollider 构建中 sclang 可执行文件的绝对路径；为空时使用 Desktop 应用自带的运行时（见[查找 SuperCollider](#find-supercollider)） |
| `scsynthPath` | `''` | 用于离线渲染的 scsynth 可执行文件的绝对路径；为空时使用 `sclangPath` 旁边的 scsynth，或自带运行时的 scsynth |
| `toolCallTimeoutMs` | `900,000` | 一次工具调用的时限，包括启动解释器；一次请求（包括 `render_audio` 或 `execute_sclang` 的 `timeout_seconds`）最多可用到其中除最后 30 s 以外的全部时间，这 30 s 留给工作进程启动和返回结果 |
| `startupTimeoutMs` | `30,000` | MCP 服务器连接并列出工具的时限；列出工具不会启动 SuperCollider |
| `readyTimeoutMs` | `60,000` | sclang 编译类库并报告就绪的时限 |
| `requestTimeoutMs` | `600,000` | 一次请求的默认时限，至少比 `toolCallTimeoutMs` 少 30 s；超时后解释器停止，其状态丢失 |
| `graceMs` | `3,000` | 工作进程收到 `shutdown` 请求后以及收到 SIGTERM 后各自可用于退出的时间，超时后发送 SIGKILL；桥接进程在 sclang 的输入关闭后也给它这么长的时间退出 |
| `maxLogBytes` | `65,536` | 为错误消息保留的最近解释器输出字节数 |
| `maxWorkers` | `4` | 同时运行的解释器上限，每个调用的 Session 一个，取值 1 到 16 |
| `workerIdleTimeoutMs` | `600,000` | Session 的解释器在没有调用多长时间后停止，其变量与 SynthDef 随之丢失 |

<a id="find-supercollider"></a>
### 查找 SuperCollider

这些工具只以无界面方式运行 SuperCollider。服务器在每次启动工作进程时查找 sclang 与 scsynth，即首次工具调用时，以及停止之后的那次调用时，并按以下顺序采用第一个匹配项：

1. 非空的 `sclangPath`，配合 `scsynthPath` 或同一目录中的 scsynth。
2. Desktop 应用自带的运行时，位于本包的 `runtime/<platform>-<arch>/` 目录中，打包后的应用从 `app.asar.unpacked` 读取；其 `runtime.json` 指明其中的程序与目录。

服务器从不启动已安装的 SuperCollider：macOS 应用程序的 sclang 链接了 Qt，即使没有窗口，macOS 也会把它显示为一个已打开的应用；而且该应用程序只附带 Qt 的 Cocoa 平台，也无法在屏幕外运行。在 macOS 上，位于应用程序包（`*.app/Contents/`）内的 `sclangPath` 会让调用失败，消息会说明原因。每个 sclang 都以 `QT_QPA_PLATFORM=offscreen` 启动：自带运行时会忽略它；配置的 Qt 构建版 sclang 会因此留在屏幕外，若其 Qt 没有 offscreen 平台则无法启动。

非空的 `scsynthPath` 会替换搜索找到的 scsynth。配置的路径不是可执行文件时，调用失败，消息会指出该设置；自带运行时的 `runtime.json` 无法读取、描述的是其他平台或指向缺失的程序时也同样失败；这两种情况下搜索都不会继续。两者都不匹配时，调用在接触 `dataRoot` 之前失败，并返回[模型体验](#model-experience)中引用的缺少运行时消息。每次启动工作进程都会重新搜索，因此安装运行时后无需重启宿主。

面向 Apple 芯片 macOS 与 Windows x64 的 Desktop 应用自带的运行时是从源码构建、不含 Qt、IDE 和 supernova 的 SuperCollider，因此其中包含 sclang、scsynth、UGen 插件、不含 GUI 类的类库以及类的帮助文件；[BUILD.md](../../../wasdengine/supercollider/BUILD.md) 说明它如何构建与发布，[Desktop 应用中的 SuperCollider](../../../wasdengine/FORK.md#supercollider-in-the-desktop-app) 说明打包如何附带它。源码检出可通过 `wasdengine/supercollider/build.sh --out <folder> --install packages/gamedev/supercollider/runtime` 获得它，或把 `supercollider-<version>` 发布版归档解压到该目录；npm 安装不含该运行时，需要设置 `sclangPath`。

<a id="interpreter"></a>
### 每个对话一个解释器

sclang 以 IDE 模式启动，从标准输入读取命令，并使用服务器写入工作进程自己的文件夹 `<dataRoot>/workers/<pid>/<n>/` 中 `sclang_conf.yaml` 的类库配置；该文件夹是 sclang 的工作目录，命令行以相对于它的路径指明该文件，因为 Windows 上的 sclang 以 ANSI 代码页读取参数，无法容纳用户文件夹名中的所有字符。对于自带运行时，该配置用运行时的类库替换默认的类库路径；配置的 sclang 则保留其默认路径，因此会加载它的系统范围扩展。无论哪种情况，在 macOS 与 Linux 上，`XDG_CONFIG_HOME` 与 `XDG_DATA_HOME` 都把 sclang 的用户配置目录和用户数据目录指向该文件夹中的 `home/`，因此用户自己的扩展、quark 与 synthdef 都不会被加载；Windows 上的 sclang 忽略这两个变量，使用用户自己的 `%LOCALAPPDATA%\SuperCollider` 文件夹。在所有平台上，工作类都会跳过用户的启动文件。该配置还加入工作类 `WasdWorker.sc` 所在的目录，工作类也会让 `Server:boot` 抛出错误：由于没有音频设备，启动实时服务器的代码会失败，并收到指向 `render_audio` 的消息。

每个调用工具的 Session 都有自己的解释器（[每个 Session 一个工作进程](../app-mcp/README.zh.md#one-worker-per-session)），其状态在该 Session 的调用之间保持：如 `~kick` 这样的环境变量、解释器变量 `a` 到 `z`、用 `.add` 添加的 SynthDef，以及代码定义的其他任何内容。通过 WASD Engine 的 MCP 服务器连接的 agent 彼此共享一个解释器。解释器在 `workerIdleTimeoutMs` 内没有调用时停止，新的解释器启动时上述状态都不存在。

<a id="tools"></a>
### 工具

模型以 `mcp__wasd_supercollider__<name>` 调用每个工具，所有路径参数都是绝对路径。调用失败时返回错误结果，其文本指出原因。通过 WASD Engine 的 MCP 服务器 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 连接的 agent 以 `supercollider_<name>` 调用同样的工具，并彼此共享一个解释器。

| 工具 | 参数 | 结果 |
|---|---|---|
| `render_audio` | `code`、`path`、`duration`、`channels`、`sample_rate`、`sample_format`、`normalize_db`、`timeout_seconds` | 渲染了什么、文件的格式与大小、分析报告、图像，以及代码与 scsynth 输出的文本 |
| `analyze_audio` | `path`、`start`、`end` | 文件的格式、声道、采样率、时长与大小，窗口的分析报告，以及图像 |
| `execute_sclang` | `code`、`timeout_seconds` | 以错误结果返回错误及其详情，然后以代码形式返回最后一个表达式的值及其类，以及输出的文本 |
| `class_info` | `names` 或 `search` | 对每个指定的类：其父类、该类及其元类定义的公开方法（含参数名与默认值），以及其帮助文本；对搜索：名称包含该文本的类，以及帮助摘要包含该文本的类 |

`render_audio` 求值 `code`，并以非实时模式用 scsynth 渲染其值：

- UGen 图函数会成为从头开始播放的 SynthDef。返回音频速率信号的函数会把这些信号写入文件；`channels` 要求更多声道时，单声道信号会在每个声道中播放。自己用 `Out.ar`、`ReplaceOut.ar`、`OffsetOut.ar` 或 `XOut.ar` 向总线写入音频的函数默认渲染 2 个声道，除非 `channels` 另有指定。`LocalOut` 与 `Out.kr` 不向总线写入音频，因此只用到它们的函数仍会播放其返回值。返回控制速率或标量值且不向总线写入音频的函数会使调用失败，不写入音频的 SynthDef 也是如此。
- SynthDef 以其默认参数播放；没有 `Out` UGen 的 SynthDef 会使调用失败。
- 模式（pattern）通过 `asScore(duration)` 渲染，Score 或乐谱事件列表按原样渲染。两者都按名称播放 SynthDef，因此 `SynthDescLib.global` 中的每个 SynthDef（例如用 `.add` 添加的，以及 `\default`）都会在第一个事件之前发送给 scsynth；`duration` 之后的事件会被丢弃。除非 `channels` 另有指定，它们渲染 2 个声道。

scsynth 把 32 位浮点 WAV 渲染到临时目录；对于自带运行时，以运行时的插件目录作为 `-U`。随后工作类测量其峰值，若给出 `normalize_db`，则缩放声音使峰值达到该电平；它把恰好 `duration` 秒（按整数采样取整）以 `path` 扩展名对应的格式写入 `path`：`.wav`、`.aif` 或 `.aiff`、`.flac`，或 `.ogg`（Ogg Vorbis）。`sample_format`（`int16`、`int24` 或 `float`，默认 `int16`）适用于前三种格式；FLAC 不接受 `float`。`sample_rate` 默认为 44,100 Hz，即 Godot 的默认混音采样率。缺失的目录会被创建，已有文件会被替换。`duration` 之后的声音被截断，超过满刻度的采样在整数格式中会削波。

分析读取渲染结果的浮点副本（按归一化增益缩放），对于 `analyze_audio` 则读取 `start` 与 `end` 之间窗口的浮点副本（默认整个文件，最长 600 s），由工作类用 libsndfile 解码；服务器读取每个副本后将其删除。报告包括：

- 以 dBFS 表示的峰值与 RMS 电平，有多个声道时还会逐声道给出。
- 按 ITU-R BS.1770-4 计算的积分响度（LUFS），每个声道权重均为 1；短于一个 400 ms 块的窗口，或没有高于门限的块的窗口，不予测量。
- 开头与结尾低于 -60 dBFS 的静音。
- 在最多 64 帧、每帧 8,192 个采样上平均得到的频谱中最强分量的频率，以及频谱质心。
- 采样达到满刻度时的警告，以及 DC 偏移达到 0.01 或以上时的警告。

图像是宽 1,024 像素的 PNG：上方是每个声道的波形（超过两个声道时为声道混合的波形），达到满刻度的列显示为红色；下方是声道混合的声谱图，频率轴为从 20 Hz 到奈奎斯特频率的对数轴，在 100 Hz、1 kHz 和 10 kHz 处有虚线，动态范围为 90 dB。竖直虚线按一个时间步长标出，最多画 12 条。结果文本以同样的方式描述图像。

`execute_sclang` 把 `code` 编译为一个函数体，并在 AppClock 上的 Routine 中运行，因此 `.wait` 与 `Condition` 可用，调用在代码结束时结束。无法编译的代码会在输出文本中返回 sclang 的解析错误。抛出的错误会返回其类与消息；对于方法错误，还会返回接收者和参数。

`class_info` 把每个类的帮助文件 `HelpSource/Classes/<name>.schelp` 读作最多 4,000 个字符的纯文本：摘要、相关类、描述、方法及其参数，以及示例。每类方法最多列出 60 个，搜索最多列出 100 个匹配项。

<a id="data-directory"></a>
### 数据目录中的文件

| 路径 | 内容 |
|---|---|
| `payload/<digest>/WasdWorker.sc` | 从包中复制出的工作类，每个内容版本各一份；早期版本保留 |
| `workers/<pid>/<n>/` | 一个解释器的文件夹，位于其服务器进程的文件夹中，解释器停止后删除；服务器启动时删除已退出的服务器进程的文件夹 |
| `workers/<pid>/<n>/sclang_conf.yaml` | 该解释器的类库配置 |
| `workers/<pid>/<n>/home/config/`、`workers/<pid>/<n>/home/data/` | sclang 的用户配置目录与数据目录，例如 `SuperCollider/synthdefs/` |
| `workers/<pid>/<n>/scratch/` | 请求参数文件（工作类读取后删除），以及渲染与分析的乐谱、日志和浮点音频文件（工作类与服务器用后删除） |

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，由 `package.json` 的 `icon` 指定。该文件把 Nathan Ho（2015）绘制的 SuperCollider 立方体标志原样嵌入 36 × 36 的画布：即 [SuperCollider 仓库](https://github.com/supercollider/supercollider)中 SuperCollider 3.14.1 的 `icons/sc_logo.svg`。SuperCollider（包括其美术作品）采用 [GNU 通用公共许可证第 3 版](https://www.gnu.org/licenses/gpl-3.0.html)，不受本仓库的许可证约束，`icon.svg` 也以相同许可证共享。该图标仅指代 SuperCollider 集成。WASD Engine 与 SuperCollider 项目没有关联，也未获其认可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件涉及四个进程。宿主插件在其生命周期内向 MCP 服务器管理器注册一个 stdio MCP 服务器 `wasd_supercollider`；`wasd_` 前缀使它与用户配置的 `supercollider` 服务器区分开。管理器以宿主自身的可执行文件、在 `ELECTRON_RUN_AS_NODE=1` 下运行服务器入口 `lib/worker.js`，因此 Desktop 应用无需单独安装 Node；harness 的源码启动则通过 tsx 运行 `src/worker.ts`。服务器立即响应 MCP 发现请求，在工具调用到来之前不启动工作进程。

sclang 无法读取工作进程协议的 JSON 请求行，其中运行的代码也无法捕获自己输出的文本，因此工作进程是一个桥接进程：即同一个服务器入口，以 `argv[2]` 中的桥接计划和 `argv[3]` 中的 `--sclang-bridge` 再次运行，并带上服务器自身的加载器参数（例如源码启动时 tsx 的参数）。桥接进程实现[工作进程协议](../app-mcp/README.zh.md#run-the-worker)，并把 sclang 作为子进程运行：

```text
<sclang> -i wasd -l sclang_conf.yaml
```

该命令在工作进程的文件夹 `<dataRoot>/workers/<pid>/<n>/` 中运行，`sclang_conf.yaml` 就在其中。

IDE 名称不为 `none` 时，sclang 会关闭 readline 输入，因此它按以 ESC（0x1b）结尾的块解释标准输入。桥接进程先发送 `WasdWorker.boot("<token>", "<file>")`，其 JSON 文件指明 scsynth、插件目录、临时目录和帮助目录；工作类设置 `Score.program` 并输出 `<token> READY {"version": …}`，桥接进程随后写出协议的就绪行。对于每个请求，桥接进程把参数写入一个 JSON 文件（因为 sclang 字符串字面量最多容纳 8,191 字节），并发送 `WasdWorker.dispatch(<id>, "<method>", "<file>")`。工作类读取并删除该文件，在 Routine 中运行同名的处理方法，并在一个换行之后输出 `<token> END <id> <JSON reply>`。桥接进程把 sclang 自上一个回复以来输出的文本（最多 20,000 个字符，保留前后各一半）加入回复的 `output`，失败时加入回溯信息，并丢弃创建 Server 对象时输出的 `<name> : setting clientID to <n>.` 行。token 是每个桥接进程 32 位随机的十六进制数字，因此输出的文本无法冒充回复。

桥接进程是工作进程的进程组组长，并把 sclang 留在该组中，而 sclang 通过同一组中的 shell 运行 scsynth，因此停止工作进程会停止一次渲染的所有进程；Windows 没有进程组，服务器改为停止桥接进程的进程树。sclang 在 macOS 与 Linux 上通过 `sh`、在 Windows 上通过 `cmd.exe` 运行 scsynth，因此工作类按该 shell 的规则为路径加引号，并且只在 Windows 之外用 `exec` 让 scsynth 取代 shell。sclang 退出时，桥接进程以 sclang 的退出码结束；sclang 无法启动或任一方违反协议（回复了另一个请求、回复不是 JSON、在一个请求运行时发来另一个请求，或工作类未加载）时以 1 结束；没有有效计划时以 2 结束。收到 `shutdown` 或输入结束时，它向 sclang 发送 `0.exit`（因为 Windows 上的 sclang 不会在输入结束时退出），结束 sclang 的输入，并在 sclang 于 `graceMs` 之后仍未退出时将其终止。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 宿主插件：配置 schema（展开了共享字段）与服务器注册 |
| [`src/worker.ts`](src/worker.ts) | 服务器进程入口：以 SuperCollider 选项、工作进程启动器、工具和指令运行 `runAppMcpServer`，或在带 `--sclang-bridge` 时运行绑定到本进程的桥接进程 |
| [`src/environment.ts`](src/environment.ts) | sclang 与 scsynth 的搜索、自带运行时的 `runtime.json`、工作进程的目录、类库配置与桥接计划，以及启动备注 |
| [`src/sclang-bridge.ts`](src/sclang-bridge.ts) | 桥接进程：计划、sclang 的环境、请求文件与命令，以及协议回复 |
| [`src/sclang-output.ts`](src/sclang-output.ts) | sclang 输出中的回复行，以及它们之间有上限的输出 |
| [`src/tools.ts`](src/tools.ts) | 工具声明、工作进程请求、回复校验、分析报告与帮助文本 |
| [`src/audio.ts`](src/audio.ts) | 浮点 WAV 读取、电平、BS.1770 响度、静音、FFT 与平均频谱 |
| [`src/image.ts`](src/image.ts)、[`src/png.ts`](src/png.ts) | 波形与声谱图图像、其描述，以及 PNG 编码 |
| [`src/schelp.ts`](src/schelp.ts) | SCDoc 帮助文件的纯文本 |
| [`src/instructions.ts`](src/instructions.ts) | 服务器名称与指令 |
| [`sc/WasdWorker.sc`](sc/WasdWorker.sc) | 工作类：启动、分派、JSON 回复、每个方法一个处理方法，以及对 `Server:boot` 的覆盖 |

共享的 [`dsh-app-mcp`](../app-mcp/README.zh.md) 包负责共享的 Config 字段与服务器注册、服务器进程、工作进程协议客户端、监管器、结果大小上限以及安装宿主（setup host）。

### 用真实 SuperCollider 验证

在仓库根目录运行端到端测试套件。当本包的 `runtime/<platform>-<arch>/` 目录中有自带运行时（`wasdengine/supercollider/build.sh --install` 会将其放在这里）时，它针对该运行时运行，没有时则跳过。

```sh
pnpm run test:e2e packages/gamedev/supercollider/tests/supercollider-worker.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [游戏开发工具](../README.zh.md) — 本包组及其他游戏应用。
- [App MCP 运行时](../app-mcp/README.zh.md) — 服务器进程、工作进程协议、监管与结果上限。
- [SuperCollider 运行时构建](../../../wasdengine/supercollider/BUILD.md) — Desktop 应用自带的运行时如何构建与发布。
- [MCP 服务器管理器](../../mcp/mcp-manager/README.zh.md) — 插件注册的服务器、其状态与重启。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 工具命名、服务器指令与图像准入。
- [SuperCollider 文档](https://doc.sccode.org/) — 工具所运行代码的上游参考。

-----

<a id="model-experience"></a>
## 模型体验

### SuperCollider 工具声明

#### 模型可见内容

模型看到 4 个名为 `mcp__wasd_supercollider__<name>` 的工具，其描述和输入 schema 由 [`src/tools.ts`](src/tools.ts) 声明，并由 [`model-surface.spec.ts.snap`](tests/__snapshots__/model-surface.spec.ts.snap) 固定；生成的工具目录不列出 MCP 服务器工具。在 `render_audio` 与 `execute_sclang` 中，`timeout_seconds` 的描述写明以秒计的 `requestTimeoutMs` 默认值，其最大值为 `toolCallTimeoutMs` 减去 30 s，以整秒计。服务器列出工具时不启动 SuperCollider，因此无论 SuperCollider 是否可用，模型都能看到这些工具。

#### Token 影响

4 个声明合计约 4,400 个字符的 JSON（含名称），在服务器的工具保持注册期间进入每个请求。

#### KV Cache 影响

同一配置总是生成相同的声明，因此重连后工具定义前缀保持稳定。服务器在宿主启动后完成工具发现时注册这些工具；此前组装的请求不含 SuperCollider 工具，注册后的第一个请求可能从第一个变化的定义开始失去缓存复用。修改 `requestTimeoutMs` 或 `toolCallTimeoutMs` 会改变 `render_audio` 与 `execute_sclang` 的声明，禁用该行会移除全部 4 个声明。

### 系统提示词中的服务器指令

#### 模型可见内容

服务器连接后，MCP 客户端把 [`src/instructions.ts`](src/instructions.ts) 中的指令加入系统提示词，标题为 `### MCP server: wasd_supercollider`。

##### SuperCollider 服务器指令

```markdown
SuperCollider runs headless behind these tools: sclang, its language, keeps state between calls, and scsynth renders sound offline into files. There is no audio device, so nothing plays aloud and real-time servers cannot boot: judge a sound by the measurements and the waveform and spectrogram image that render_audio and analyze_audio return. SuperCollider keeps one interpreter for each conversation: environment variables such as ~kick and SynthDefs added with .add persist between calls until SuperCollider restarts after a crash or a timeout, or stops after a long pause in the calls. The first result after a start names the version.

Paths are absolute. Resolve relative names against your working directory. Write game audio inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Make, look, adjust:
- render_audio evaluates code and renders its value for exactly duration seconds: a UGen graph function such as { Pan2.ar(SinOsc.ar(440), 0) * Env.perc(0.01, 0.5).kr(2) }, a SynthDef, a pattern such as Pbind, or a Score. A function's output channels set the file's channels unless channels is given. Patterns play SynthDefs added with .add, or \default. Sound that is still playing at the end is cut off.
- Read its report: peak and RMS levels, loudness in LUFS, clipping, silence at the start and end, and the dominant frequency. Look at the image: the waveform of each channel above, the spectrogram below. Fix clipping, unintended silence, clicks (thin vertical lines in the spectrogram at onsets or at the end), and harsh highs before calling a sound done.
- analyze_audio reports on any audio file the same way, optionally on a time window.
- execute_sclang runs code to define SynthDefs, build patterns and data, and inspect state. Its result is the value of the last expression as code, and posted text (postln) returns as output. The code runs in a Routine, so .wait works.
- class_info shows classes with their methods, argument names, and defaults, and their help text; check UGen arguments there instead of guessing. Its search finds classes by name.

Game audio:
- Short effects: mono .wav at 44100 Hz with int16 samples, a peak near -1 dBFS (normalize_db: -1), no silence before the onset, and an envelope that ends at zero within the duration, such as Env.perc(...).kr(2).
- Music and ambience: stereo .ogg (Vorbis). For a loop, render a duration of whole bars at the tempo and make the end flow into the start: let releases and effect tails wrap or finish before the end. Godot imports .wav and .ogg; loop playback is an import setting.
- Keep related sounds at a consistent loudness: compare LUFS, not peaks.
- Keep the SuperCollider source next to the sound, such as sfx/jump.scd beside sfx/jump.wav, so it can be changed and rendered again.
```

#### Token 影响

该部分在服务器保持连接期间为每个请求增加约 2,800 个字符。

#### KV Cache 影响

文本是固定的，因此重连后渲染出的部分完全相同。该部分在服务器首次连接时出现，在该行被禁用或服务器的重连尝试用尽时消失；每次变化都会改变组装出的系统提示词，前缀能复用多少由[系统提示词的缓存规则](../../core/system-prompt/README.zh.md#model-experience)决定。

### 工具结果与图像

#### 模型可见内容

每个结果有一个文本块，`render_audio` 与 `analyze_audio` 另外附带一张 PNG 图像，宽 1,024 像素、高 418 或 536 像素。每次启动工作进程后，下一个结果以 `SuperCollider <version> started (<source>) with no SynthDefs or variables defined.` 和一个空行开头，其中 source 为 `the runtime that WASD Engine ships` 或 `sclang at <path>`。其余文本报告调用做了什么，音频结果还包括分析报告与图像说明；输出的文本位于末尾的 `output:` 之后。错误结果携带失败原因：缺少运行时时返回下面的消息（消息写明所在计算机的平台与架构，这里是 Intel Mac 的），工作类报告的错误返回其类与消息并附 `Error code: WORKER_REMOTE`，`execute_sclang` 的错误返回其类、消息与详情，工作进程停止时返回其错误码、最近的解释器输出，以及其状态已丢失的说明。[MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)只在声明支持图像输入的模型路由上接收图像，其他路由则收到诊断文本。

##### 缺少运行时消息

```markdown
WASD Engine's headless SuperCollider is not installed for darwin-x64. The WASD Engine desktop app ships it for macOS on Apple silicon and for Windows x64; a source checkout installs it with `wasdengine/supercollider/build.sh --out <folder> --install packages/gamedev/supercollider/runtime`. WASD Engine does not start an installed SuperCollider, whose application opens as an app. The SuperCollider plugin settings sclangPath and scsynthPath can name another headless build.
```

#### Token 影响

参数、结果文本和被接收的图像在压缩之前一直保留在对话中。工具限制了文本：输出最多保留 20,000 个字符，`execute_sclang` 的结果最多 20,000 个字符的代码，帮助文本每个类最多 4,000 个字符，方法列表每类 60 项，搜索 100 个名称；服务器会截断超过 1 MiB JSON 的文本块。每张图像是约 20 到 100 KiB 的 PNG。

#### KV Cache 影响

仅追加：调用及其结果跟在已有请求前缀之后，不会使其失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制描述 SuperCollider 工具当前的不足。

- **不会发出声音** — 工具在没有音频设备的情况下运行，并拒绝启动实时服务器，因此 agent 和用户都无法通过工具听到声音；用户在游戏中或其他地方收听渲染出的文件。
- **连接的 agent 共享一个解释器** — 通过 WASD Engine 的 MCP 服务器连接的 agent 共用其变量与 SynthDef，一次耗时的渲染会推迟其他 agent 的调用。
- **空闲的 Session 会丢失解释器状态** — Session 的解释器在 `workerIdleTimeoutMs` 内没有调用时停止，或在另一个 Session 需要占用 `maxWorkers` 中的位置时停止。
- **重启会丢失解释器状态** — 崩溃、`requestTimeoutMs` 或 `timeout_seconds` 到期、取消正在运行的调用，或调用 `0.exit` 的代码都会停止 sclang；变量与 SynthDef 随之消失，新的解释器启动时一个都没有。
- **SuperCollider 只在 macOS arm64、Windows x64 与 Linux x64 上运行** — 面向 Apple 芯片 macOS 与 Windows x64 的 Desktop 应用自带运行时，Linux 检出可安装发布构建；Intel Mac 没有运行时，而工具不会启动已安装的 SuperCollider，因此除非 `sclangPath` 指向无界面构建，否则工具会在那里报告缺少运行时。
- **Windows 上的 sclang 使用用户自己的 SuperCollider 文件夹** — 它忽略 `XDG_CONFIG_HOME` 与 `XDG_DATA_HOME`，因此会在 `%LOCALAPPDATA%\SuperCollider` 中创建用户文件夹，并读取那里用户自己的扩展，除非类库配置排除它们（自带运行时的配置会排除）；工作类会跳过那里的启动文件。
- **插件仅为核心 UGen** — 自带运行时只包含 SuperCollider 自身的 UGen，不含 sc3-plugins 或其他扩展，其类库也不含 GUI 类。
- **响度对每个声道同等加权** — 不应用 BS.1770 的环绕声道权重，因此超过两个声道的文件读数会比标准测量值更响。
- **图像需要支持图像的路由** — 在不支持图像输入的模型路由上，模型收到诊断文本，而不是波形与声谱图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
