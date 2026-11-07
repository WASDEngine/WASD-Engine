---
description: "面向部署方与维护者的 LibGodot Godot 游戏运行：配置运行时及其安装、帧推流与超时，或排查 godot_* 工具、“游戏”标签页、godot Remote 和 /api/godot.frames 路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-godot

[English](README.md) | 中文

## 概述

让 agent（智能体）运行 Session 的 Godot 游戏、通过截图查看它、用按键、鼠标和输入动作游玩它、读取日志与错误，并在不运行游戏的情况下检查 GDScript。你可以在右侧栏的“游戏”标签页中观看并游玩同一个游戏。WASD Engine 的 Web 与 Desktop 默认启用本插件。游戏通过 LibGodot 运行（只需在“游戏”标签页中安装一次），或通过已安装的 Godot 编辑器运行；只有 macOS 上的 LibGodot 能在没有窗口的情况下运行游戏。每个 Session 同时只运行一个游戏；游戏音频只在宿主上播放。

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

当 agent 需要通过运行和游玩来测试 Godot 游戏，或用户需要在对话旁观看或游玩该游戏时，选用本插件。插件为 Session 的项目启动自己的 Godot 进程，从不连接用户已打开的 Godot 编辑器。加载插件只会注册其工具、提示词部分、Remote 和帧路由；在游戏或脚本检查开始、或用户安装运行时之前，不会启动任何 Godot 进程，也不会下载任何内容。

### 默认组合

fork 的 patch 文件 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `godot` 行插入每个 Web 与 Desktop profile，并把它的数据目录放在 harness 主目录下：`~/.wasdengine/godot`；设置了 `DSH_HOME` 时为 `$DSH_HOME/godot`。

```yaml
- id: godot
  name: '@deepseek-ai/dsh-godot'
  config:
    dataRoot: !!js dshHomePath('godot')
```

宿主插件需要 `tools`、`systemPrompt`、`workingDirectory`、`subprocess`、`agents` 和 `typert` 服务。它只在存在 `connection` 服务时注册帧路由，截图还需要 `attachments` 与 `llm` 服务，“游戏”标签页中的 **运行** 还需要 `sessionController` 服务，由它恢复没有活动 Agent 的 Session。该行还带有本包的浏览器半侧，即“游戏”标签页和 Godot 工具卡片，它们需要 Web 与 Desktop 的右侧栏。

### 关闭插件或修改设置

profile patch 按 id 覆盖该行。把下面的条目加入 `$DSH_HOME/profiles/<name>/cordis.patch.yml`；未设置 `DSH_HOME` 时 `$DSH_HOME` 为 `~/.wasdengine`，标准 profile 名为 `web` 与 `desktop`。编辑 patch 后重启 Web 或 Desktop。插件页面「游戏工具」标签页上的开关（[`ui-game-tools`](../ui-game-tools/README.zh.md)）通过插件管理器添加或删除这一 `disabled` 条目，插件管理器随即应用更改，或说明更改需要重启后才生效。

```yaml
- id: godot
  disabled: true
```

禁用该行会撤下工具、提示词部分、Remote、帧路由和“游戏”标签页，并停止所有正在运行的游戏。设置 `config` 的 patch 会替换该行的整个配置，因此请在要修改的字段旁重新写出 `dataRoot`：

```yaml
- id: godot
  config:
    dataRoot: !!js dshHomePath('godot')
    streamFps: 15
    agentRunsMuted: false
```

### 配置

[`src/index.ts`](src/index.ts) 声明并校验以下字段。`dataRoot`、`libgodotPath`、`runnerPath` 或 `godotExecutable` 为相对路径，`libgodotPath` 与 `runnerPath` 只设置了其中一个，或 `runtimeManifestUrl` 不是 http 或 https URL 时，加载失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 存放托管运行时和 harness 脚本副本的绝对目录 |
| `runtimeVersion` | `4.7.2-wasd.1` | 托管运行时的版本：即它在 `runtime/` 下的文件夹名，也是其 manifest（元数据清单）必须描述的版本 |
| `runtimeManifestUrl` | `https://github.com/WASDEngine/WASDEngine/releases/download/libgodot-4.7.2-wasd.1/manifest.json` | 安装时下载的发布 manifest |
| `libgodotPath` | `''` | LibGodot 库的绝对路径；须与 `runnerPath` 一起设置 |
| `runnerPath` | `''` | `godot_runner` 可执行文件的绝对路径；须与 `libgodotPath` 一起设置 |
| `godotExecutable` | `''` | Godot 编辑器可执行文件的绝对路径，在没有可用的 LibGodot 运行时时使用；为空时搜索 `PATH`，在 macOS 上还搜索 `/Applications` |
| `embedded` | `true` | 在 macOS 上以无窗口方式渲染 LibGodot 运行 |
| `streamFps` | `30` | 向“游戏”标签页推流的每秒帧数，1 到 60 |
| `streamQuality` | `0.9` | 推流的 JPEG 帧的 JPEG 质量，0.1 到 1 |
| `streamLossless` | `true` | PNG 编码跟得上 `streamFps` 时推流无损 PNG 帧，否则推流 JPEG 帧；`false` 只推流 JPEG 帧 |
| `streamMaxWidth` | `1280` | 推流帧的最大宽度（像素），64 到 4096 |
| `importBeforeRun` | `true` | 每次运行前导入项目资源 |
| `importTimeoutMs` | `180000` | 导入步骤及单次 `godot_check` 的时限 |
| `startTimeoutMs` | `60000` | 从启动到游戏连接的时限 |
| `requestTimeoutMs` | `15000` | 截图、求值、场景树、暂停或继续请求的时限，有请求等待时游戏可保持沉默的最长时间，以及等待、单步或 agent 的输入序列在其按每秒 10 帧所需时间之外最多可用的实际时间 |
| `stopGraceMs` | `3000` | 被停止的游戏在被终止前用于退出的时间，也是每个 Godot 进程的终止宽限时间 |
| `processOutputBytes` | `1048576` | 每个 Godot 进程的每个输出流保留的控制台输出字节数，至少 1024 |
| `maxLogEntries` | `5000` | 每次运行保留的日志条目数 |
| `maxRuns` | `4` | 所有 Session 合计可同时运行的游戏数，每个游戏在其进程结束前一直计入 |
| `agentRunsMuted` | `true` | agent 启动的运行是否默认无音频，除非 `godot_run` 另行指定 |

<a id="runtime"></a>
### Godot 运行时

每次运行和每次 `godot_check` 都会重新解析运行时，并采用第一个匹配项：

1. `runnerPath` 与 `libgodotPath`：你自行构建或安装的 LibGodot runner 与库。
2. Desktop 应用在本包 `libgodot/<platform>-<arch>/` 目录中附带的运行时（打包后的应用从 `app.asar.unpacked` 读取），仅当其 `runtime.json` 写明当前版本、平台和架构，且 runner 与库都存在时使用。
3. `<dataRoot>/runtime/<runtimeVersion>/` 中的托管运行时，条件相同。
4. `godotExecutable`：已安装的 Godot 编辑器可执行文件。
5. `PATH` 上的 `godot`，然后是 `godot4`。
6. 在 macOS 上，`/Applications` 中某个 `Godot*.app` 包内的 `Contents/MacOS/Godot`，按包名逆序依次尝试。

配置的路径不是可用文件时，调用会失败，消息中写明该字段，搜索不再继续。由于附带的运行时和托管运行时都排在 `godotExecutable` 之前，二者中任何一个都优先于它。Desktop 打包时会放入附带的运行时（[Desktop 应用中的 LibGodot](../../../wasdengine/FORK.md#libgodot-in-the-desktop-app)）；源码检出和 npm 安装不附带运行时，使用托管运行时。没有任何运行时可用时，`godot_run` 与 `godot_check` 会失败，并要求从“游戏”标签页安装运行时或在配置中设置。

在 macOS 上以 `embedded: true` 运行 LibGodot 时会传入 `--embedded`，[打过补丁的 LibGodot](../../../wasdengine/libgodot/BUILD.md#the-patch) 用 Metal 把游戏渲染到一个不显示在任何窗口中的图层：不会打开游戏窗口，“游戏”标签页和截图是查看游戏的唯一途径。其他所有运行都会在宿主的桌面上打开普通的游戏窗口：Linux 与 Windows 上的 LibGodot、macOS 上 `embedded: false` 的 LibGodot，以及编辑器可执行文件的每次运行。“游戏”标签页同样会为这些运行推流。

<a id="managed-runtime"></a>
### 安装托管运行时

托管运行时是以 LibGodot 形式构建、带有 WASD Engine 补丁的 Godot 4.7.2；[LibGodot 构建指南](../../../wasdengine/libgodot/BUILD.md)说明了 runner、归档、`runtime.json` 和 manifest。“游戏”标签页中的 **安装 Godot** 在运行时缺失或失败时显示，它调用 `installRuntime` Remote 方法，该方法：

1. 下载 `runtimeManifestUrl`，并要求其 `version` 等于 `runtimeVersion`；
2. 为宿主的 `<platform>-<arch>` 键（例如 `darwin-arm64`）选择产物；
3. 从产物的 `url`（相对于 manifest URL 解析）下载归档，并在接收过程中校验其大小和 SHA-256；
4. 用 `tar` 把归档解压到暂存文件夹，确认 runner 与库都在其中，并写入 `runtime.json`；
5. 在文件锁保护下把暂存文件夹重命名为 `<dataRoot>/runtime/<runtimeVersion>/`；如果另一个宿主进程在此期间已安装该运行时，则保留那一份。

安装期间，每个“游戏”标签页都会显示带百分比的“正在下载 Godot”，随后显示“正在校验 Godot”和“正在解压 Godot”。第二个请求会加入正在进行的安装；关闭标签页只会停止它的等待，卸载插件则会取消安装。无论成功还是失败，下载文件和暂存文件都会被删除；失败时会显示原因：manifest 无法访问或其 HTTP 状态、manifest 无效或属于其他版本、没有对应平台的构建、下载出错、大小或 SHA-256 不匹配，或归档中缺少运行时文件。`wasdengine/libgodot/build.sh --install <dataRoot>` 会把本地构建安装到同一位置。

<a id="game-runs"></a>
### 游戏运行

一个 Session 最多运行一个游戏。`godot_run` 和“游戏”标签页中的 **运行** 会先停止 Session 当前的游戏，再启动下一个；宿主在所有 Session 中最多同时运行 `maxRuns` 个游戏；游戏在其进程结束前一直计入，包括其 Session 关闭后仍在停止的游戏。Session 的 Agent 结束时（例如 Session 关闭），其游戏会停止；卸载插件会停止所有游戏。

运行使用 `project` 参数指定的文件夹（相对于工作目录），否则使用最近的 `project.godot`：插件按名称顺序广度优先搜索工作目录及其下三层文件夹，并跳过 `.git`、`node_modules`、`.godot` 和 `.agents`。`scene` 必须是现有文件的 `res://` 路径或 `uid://` 引用；不指定时，游戏打开项目的主场景。`width` 与 `height` 一起设置窗口大小，取值为 1 到 16384 像素。

运行依次经过以下阶段：

1. `preparing`：从运行创建起，到其导入步骤或启动开始为止，后者紧接着发生。插件先解析项目、场景和运行时，再停止 Session 之前的游戏并创建运行，因此其中任何一项有问题时，调用失败，之前的游戏继续运行；`maxRuns` 的拒绝发生在之前的游戏停止之后。
2. `importing`：设置了 `importBeforeRun` 时，Godot 的无界面 `--import` 更新项目的导入数据。其错误和警告进入运行的日志；导入异常退出时会添加一条警告，运行继续，超过 `importTimeoutMs` 则运行失败。
3. `starting`：从启动到游戏连接宿主。插件在 `127.0.0.1` 的随机回环端口上监听，向游戏传入随机令牌；在 `startTimeoutMs` 内没有游戏出示该令牌时，运行失败。
4. `running` 或 `paused`：游戏保持连接期间。
5. `exited`、`crashed` 或 `failed`：运行结束后。以退出码 0 自行退出的游戏，或被用户或 agent 停止的游戏，结束于 `exited`。其他任何退出都结束于 `crashed`，关闭连接后仍持续运行 `stopGraceMs` 的游戏也是如此。在游戏连接之前失败的运行结束于 `failed`。崩溃与失败消息会引用进程输出的最后 20 行。

停止操作会要求游戏退出，超过 `stopGraceMs` 仍在运行时终止进程；从停止开始的那一刻起，游戏不再接受新的请求，发给它的“游戏”标签页输入会被丢弃。有请求在等待时，若游戏在 `requestTimeoutMs` 内没有发送任何内容，等待中的请求会以 `The game stopped responding` 失败；运行中的游戏至少每秒报告一次状态。宿主放弃一个等待、单步或输入序列时（因为调用方取消了它，或游戏停止了响应），会要求游戏丢弃该请求，被丢弃的输入序列会释放它仍按住的键、按钮和动作。宿主进程退出时 LibGodot runner 随之退出，harness 在与宿主的连接关闭时让游戏退出。

agent 启动的运行使用 Godot 的 `Dummy` 音频驱动，除非 `godot_run` 传入 `muted: false` 或 `agentRunsMuted` 为 `false`。从“游戏”标签页启动的运行会播放音频。

<a id="harness"></a>
### harness

harness 不会被复制到项目中：每次运行都通过 Godot 的 `--script` 选项，传入本包 `runtime/wasd_harness.gd` 在 `<dataRoot>/payload/` 中的副本，`project.godot` 以及项目的场景和脚本保持不变。导入步骤写入的导入数据与 Godot 编辑器相同。harness 是游戏的主循环：它连同项目的自动加载打开主场景或请求的场景，在游戏暂停时继续为宿主服务，通过 Godot `Logger` 记录打印的行以及带脚本回溯的错误，并通过回环连接响应宿主的截图、帧流、输入、等待、单步、暂停、继续、取消、求值、场景树和退出请求。

<a id="tools"></a>
### 工具

每个工具都作用于调用方 Session 的游戏；在 Session 之外调用会失败。

| 工具 | 参数 | 结果 |
|---|---|---|
| `godot_run` | `project`、`scene`、`width`、`height`、`muted` | 启动或重启游戏并等待其运行，然后报告阶段、项目、场景、窗口大小、渲染器、Godot 版本、无窗口与静音标志，以及导入和启动期间记录的最多 20 条错误和警告；游戏启动失败，或开始运行后一秒内结束，则调用失败 |
| `godot_stop` | 无 | 游戏结束后返回 `Stopped the game.`，或返回 `No game was running.` |
| `godot_screenshot` | `max_width`（默认 1280，64 到 4096） | 一张游戏窗口的 PNG 图像，缩小到 `max_width` 像素宽，并附上图像大小、窗口大小、帧号以及游戏是否暂停 |
| `godot_input` | `events`（最多 256 个）、`screenshot`、`coordinate_space` | 依次执行事件，其中的等待和按住按实际时间计算，然后报告事件数、帧数、秒数和当前帧；`screenshot: true` 会附加一张截图。序列在其等待时间、按每秒 10 帧计的每个等待一帧与开始的一帧，再加上 `requestTimeoutMs` 的实际时间过去后提前结束，并报告已执行的事件 |
| `godot_wait` | `seconds` 或 `frames`、`screenshot` | 让游戏经过这么多未暂停的游戏时间或这么多帧（1 到 100000）；游戏暂停时拒绝 `seconds`；等待在其秒数（或按每秒 10 帧计的帧数）加上 `requestTimeoutMs` 的实际时间过去后提前结束，并报告已经过的游戏时间和帧数，例如游戏自行暂停时 |
| `godot_control` | `action`（`pause`、`resume` 或 `step`）、`frames` | 暂停或继续游戏，或运行 `frames` 帧（默认 1，最多 100000）后再次暂停；单步期间游戏被暂停、继续或再次单步时（例如在“游戏”标签页中），以及按每秒 10 帧计的帧数加上 `requestTimeoutMs` 的实际时间过去后，单步提前结束，结果会写明原因；报告暂停状态和帧号 |
| `godot_eval` | `expression`、`node` | 在运行中的游戏里对 Godot `Expression` 求值，其中定义了 `scene`、`root` 和 `tree`，以 `node` 处的节点或当前场景为基对象；返回 JSON 形式的值及其 Godot 类型 |
| `godot_scene_tree` | `node`、`depth`（默认 6，最多 64）、`max_nodes`（默认 400，最多 5000） | 缩进的大纲，列出节点名称、类、脚本、位置、大小、隐藏节点、Label 与 Button 文本，以及被禁用的处理 |
| `godot_logs` | `since`、`levels`、`limit`（默认 200，最多 1000） | 游标 `since` 之后、或本 Session 上次读取之后的日志条目，以及下一个游标 |
| `godot_check` | `paths`、`project` | 在无界面 Godot 中加载 GDScript 文件而不运行游戏，并按文件列出问题 |

`godot_screenshot`、`godot_input`、`godot_wait`、`godot_control`、`godot_eval` 和 `godot_scene_tree` 需要已连接的游戏。在 Session 第一次运行之前，它们以 `No game is running in this Session; call godot_run first.` 失败；游戏启动或停止期间，以 `The game is starting or stopping; call godot_run to wait for it.` 失败；游戏结束后，它们写明游戏的阶段并引用崩溃或失败消息。

使用 `screenshot: true` 时，`godot_input` 和 `godot_wait` 会在向游戏发送任何内容之前检查模型路由能否查看图像，不能时直接失败，不对游戏执行任何操作。事件或等待之后的截图失败不会让调用失败，因为游戏已经执行了操作：结果文本写明 `The screenshot after the events failed: <reason>` 或 `The screenshot after the wait failed: <reason>`。

`godot_input` 接受以下事件：`key`，带 `W`、`Space`、`Left`、`Enter` 或 `Escape` 等 Godot 键名，或带 `keycode`；`text`，逐字符输入；`mouse_button`，在 `x` 与 `y` 处使用 `left`、`right`、`middle` 或滚轮按钮；`mouse_motion`；`action`，用于 `ui_accept` 等输入映射动作，可带 `strength`；`joy_button` 与 `joy_axis`，用于某个手柄 `device`；以及 `{ "wait": seconds }`，它让序列暂停这么多实际时间。按下的键或按钮会保持按下，直到对应的释放事件，或直到其 `hold` 时间（同样按实际时间计算）结束。游戏按到达顺序一次执行一个输入序列，包括“游戏”标签页的输入。agent 序列的时限从游戏收到它时开始计算，因此排在其他输入之后的序列可能在执行第一个事件之前就结束；“游戏”标签页的输入没有时限，因此排在 agent 序列之后的一批输入仍会送达其中的按键和按钮释放。鼠标坐标是当前运行最新截图的像素，插件会把它换算为窗口像素，因此在本次运行的第一张截图之前发送指针事件会失败；`coordinate_space: "window"` 则直接接受窗口像素。

每个结果末尾都附有该运行自本 Session 上一次 Godot 工具调用以来记录的错误、脚本错误和着色器错误条目，最多 10 条，其余给出数量；失败消息也附带同样的报告。`godot_run` 自行报告导入和启动期间的问题，`godot_logs` 会把截至其下一个游标的所有条目标记为已报告，包括被其 `levels` 过滤掉的条目。

一次运行保留其最新的 `maxLogEntries` 条日志。每个条目带有在宿主所有运行中递增的序号、来源（`game` 表示 harness 日志记录器，`process` 表示 Godot 进程的控制台输出，`import` 表示导入步骤）、级别（`stdout`、`stderr`、`warning`、`error`、`script_error` 或 `shader_error`）、消息（插件在 4,000 个字符处截断），以及 Godot 报告时提供的文件、行号、函数和脚本回溯。游戏进程的控制台输出在游戏关闭连接后进入日志；游戏启动失败时，全部输出都会进入日志。游标之后的条目已被丢弃时，`godot_logs` 会报告这一情况。

`godot_check` 启动一个无界面 Godot，通过 `runtime/wasd_check.gd` 加载每个脚本，绕过资源缓存。它不创建自动加载，也不打开场景，因此它运行的项目代码只有加载本身运行的代码：被加载脚本的静态初始化代码，以及项目声明为全局类的自定义资源加载器和保存器。它检查 `paths` 指定的文件和文件夹（`res://` 路径或相对于工作目录的路径），或检查项目的每个 `.gd` 文件，最多 400 个。不指定 `project` 时，它使用本 Session 当前或上一次运行的项目，否则使用最近的项目。它列出脚本加载期间 Godot 在 `res://` 文件中记录的错误和警告，因此预加载脚本中的错误会写明那个脚本；没有此类条目的脚本会得到第一个引擎错误（如果有）。Godot 在报告完每个脚本之前结束或超过 `importTimeoutMs` 时，检查失败。引用单例自动加载的脚本与在游戏中一样进行检查，只是场景自动加载的类型为 `Node`，因此检查不会报告使用场景自动加载成员时的类型错误。

结果文本不超过 6,000 个字符，被截断时以 `… (output shortened)` 结尾；引用的日志消息不超过 500 个字符。`godot_logs` 在达到文本上限之前结束本页，其下一个游标紧跟在最后一个列出的条目之后。

<a id="connected-agents"></a>
### 供已连接 agent 使用的工具

通过 WASD Engine 的 MCP 服务器 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 连接的本机 agent 从插件位于 [`src/mcp.ts`](src/mcp.ts) 的 provider 获得同样的十个工具，它们由同一个 `godotToolDefinitions` 构建，区别有三点：

- 每个工具都接受 `project`：包含 `project.godot` 的文件夹、其上方至多三层的文件夹，或 `project.godot` 文件本身的绝对路径；省略时，调用沿用该 agent 上一次的项目，而在 agent 第一次调用之前会以 `Pass project: the absolute path of the folder that holds project.godot.` 失败。调用为该 agent 在这个游戏项目中自己的 Session 执行，MCP 服务器在首次使用时创建该 Session，因此运行、其日志与“游戏”标签页都属于这个 Session。
- `godot_run` 的描述说明游戏在 WASD Engine 窗口中播放；Session 自身的 `godot_check` 接受相对于工作目录的路径，这里改为接受绝对路径；`godot_logs` 读取 agent 上次读取之后的条目。
- 截图以 PNG 字节形式直接放在结果中返回，而不是为模型路由保存附件，也不检查模型；每张截图请求的宽度使其最长边至多 1,568 像素、面积至多 1,150,000 像素，即 agent 无需缩放即可接收的尺寸。

`godot_run` 还会请 WASD Engine 窗口显示该 Session，随后其“游戏”标签页会为这次运行打开。provider 向 `search_game_tools` 报告运行时的就绪状态：`ready`；托管运行时安装期间为 `starting`；否则为带有运行时消息的 `unavailable`。

<a id="game-tab"></a>
### “游戏”标签页

浏览器半侧在右侧栏中添加“游戏”标签页。从侧栏[引导页](../../client/ui-sidebar-right/README.zh.md#the-guide)的“游戏”卡片打开它。屏幕上的 Session 中有 agent 启动的运行正在进行时，只要页面未重新加载，标签页会自动打开，每次运行一次；用户之后切换到该 Session 时也会打开；用户关闭的标签页在该次运行中保持关闭。标签页跟随 Session 的游戏，无论由谁启动；没有活动 Agent 的 Session（例如宿主重启后）也是如此，在运行开始前它显示没有运行。

- **运行** 运行 Session 上一次运行所用项目的主场景，Session 还没有运行时则运行最近项目的主场景；Session 没有活动 Agent 时，它会像发送消息那样先恢复该 Session。有运行正在进行时，它显示为 **重新运行**，并以该运行启动时的场景和窗口大小再次运行项目。在有可用运行时之前，它处于禁用状态。
- **停止** 停止正在进行的运行。
- **暂停** 与 **继续** 暂停和继续运行中的游戏，**前进一帧** 让暂停的游戏前进一帧。
- **安装 Godot** 在运行时缺失或失败时出现。

状态区显示安装进度、运行的阶段、帧率、场景文件（悬停提示显示其 `res://` 路径）以及渲染器。宿主拒绝的操作会显示一条可关闭的消息，每个控件在其自身的请求进行期间保持禁用。另一个正在运行的 Web 或桌面端应用写入该 Session 时，**运行** 显示“此会话已在另一个正在运行的 Web 或桌面端应用中打开，请退出该应用后重试”。

游戏画面绘制最新推流的帧，按比例适配标签页并在两侧留出边条；只有在跟随流正在送达、标签页可见且游戏处于运行或暂停状态时才推流。点击游戏即可让画面获得焦点。获得焦点时，画面把已映射的按键发送给游戏，并阻止页面接收这些按键；未映射的按键、输入法组字，以及按住 Meta 键（Command 或 Windows 键）时的按键仍由页面和应用处理。用 AltGr 输入的字符（Windows 将其报告为 Ctrl+Alt）会带着其文本送达游戏；其他 Ctrl 组合键不带文本。在 Windows Desktop 上，画面获得焦点时 Ctrl+W 等应用快捷键不会执行，因此游戏会收到这些按键；在 macOS Desktop 上，带 Command 的组合键仍由应用处理。Shift+Esc 从不送达游戏：它把键盘交还给页面，画面获得焦点后的几秒内会显示“按 Shift+Esc 释放键盘”。图像上的鼠标按键、移动和滚轮步进以游戏窗口像素送达游戏，从图像上开始的拖动在移出图像后继续有效。游戏捕获鼠标时，下一次按下会把指针锁定在画面上，移动以相对位移送达游戏；游戏释放鼠标或浏览器结束锁定时，锁定结束。失去焦点时，会释放画面按住的所有按键和按钮。

输入按批发送，每批最多 256 个事件，每次重绘一批，连续的鼠标移动会合并；下一批要等宿主接受上一批后才发送。宿主每次向游戏转发一批，排队超过 256 个时丢弃最早的事件。发给已结束运行的输入会被丢弃。一批输入因其他原因失败时，标签页记录一次失败，直到某一批再次成功，并在下一批中、或在画面失去焦点时，再次发送失败那一批中的按键和鼠标按钮释放，使游戏不会一直按住某个键或按钮。

画面下方的 **日志** 抽屉显示运行的错误数和警告数；展开后，最新的条目排在最前，并附有其 `res://` 文件和行号。标签页保留当前运行最新的 500 条，跟随流两次更新之间到达超过 200 条时，只会收到最新的 200 条。运行结束时，画面显示游戏是已退出、已崩溃还是无法启动，并附上退出码或信号以及引用的输出。跟随流在送达快照后结束时，标签页立即重新跟随该 Session，并保留最后的状态。跟随流在送达快照前停止时，标签页在 1 s 后重新跟随，延迟逐次加倍，最长 30 s，用户按 **重试** 时则立即重新跟随；在此期间，它在最后的状态上方显示“与游戏的连接已断开”和 **重试**，游戏画面既不推流也不接收输入。

在对话中，`godot_screenshot`、`godot_input` 和 `godot_wait` 的调用显示为“游戏截图”“游戏输入”和“等待游戏”行。行的摘要显示截图尺寸、结果的第一行、“失败”或“已停止”；展开后显示截图（点击可打开大图预览）和结果文本。其他 Godot 工具使用标准工具行。

<a id="remote-and-frames"></a>
### Remote 方法与帧路由

“游戏”标签页通过 `godot` Remote 命名空间调用宿主。除 `installRuntime` 外，每个方法的第一个参数都是 Session id，且都不需要活动 Agent：`follow`、`stop`、`control` 和 `input` 作用于该 Session 的运行，`run` 则会像提示词那样，先通过 `sessionController` 服务恢复没有活动 Agent 的 Session。

| 方法 | 返回 | 用途 |
|---|---|---|
| `follow(session)` | `GodotFollowItem` 流 | 先是一个 `snapshot`，包含运行、运行时状态、最新 200 条日志和日志游标，随后是 `run`、`logs` 和 `runtime` 项；读取方落后时各项会合并。没有活动 Agent 的 Session 没有运行（`null`），其 Agent 结束后也是如此，之后的 Agent 启动的运行会出现在同一个流中；流在调用被取消或插件卸载时结束 |
| `run(session, request)` | `GodotRunView` | 先恢复没有活动 Agent 的 Session，再用 `project`、`scene`、`width`、`height` 和 `muted`（默认 `false`）启动或重启游戏；游戏启动后即返回，进度由跟随流报告；取消调用只会停止对已开始的恢复的等待 |
| `stop(session)` | 无 | 游戏结束后返回，Session 没有运行时以 `godot/not-running` 拒绝；取消调用只会停止等待 |
| `control(session, request)` | `GodotRunView` | `pause`、`resume`，或带 1 到 100000 个 `frames` 的 `step` |
| `input(session, runId, events)` | 无 | 为指定运行排队最多 256 个事件，不等待游戏处理 |
| `installRuntime()` | `GodotRuntimeView` | 安装托管运行时，或加入正在进行的安装，并在其结束后返回 |

拒绝时使用以下代码：`godot/no-project`（附搜索的 `directory`）、`godot/runtime-unavailable`、`godot/not-running`、`godot/stale-run`（输入所针对的运行已不是当前运行）、`godot/too-many-runs`（附 `limit`）、`godot/request-failed`（游戏拒绝了请求或没有应答），以及用于无效事件、大小或帧数的 `gateway/bad-request`。恢复失败的 `run` 带有 Session 控制器的代码，例如 `session/not-found`，或另一个宿主进程写入该 Session 时的 `session/writer-held`。LiveShare 把每个方法归为仅所有者可用，并把该命名空间排除在共享之外。

游戏画面读取 `GET /api/godot.frames?session=<SessionId>&run=<runId>`，这是一个只有所有者 Peer 能访问的 Connection 精确路由；插件在存在 `connection` 服务时注册它。缺少参数时路由返回 400，Session 中没有该 id 的活动运行时返回 404。否则它以 `application/octet-stream` 和 `Cache-Control: no-store, no-transform` 推流，直到运行结束或请求被中止。响应体是一系列记录：

| 偏移 | 字节数 | 字段 |
|---|---|---|
| 0 | 4 | 图像长度 `N`，无符号小端序 |
| 4 | 2 | 帧宽度（像素），无符号小端序 |
| 6 | 2 | 帧高度（像素），无符号小端序 |
| 8 | 4 | 运行内的帧序号，无符号小端序 |
| 12 | `N` | PNG 或 JPEG 文件的字节 |

harness 只在至少有一个帧响应打开时推流，帧率为 `streamFps`，宽度最多缩小到 `streamMaxWidth` 像素，并在工作线程上编码每一帧，因此编码不会拖慢游戏。帧是质量为 `streamQuality` 的 JPEG 文件。开启 `streamLossless` 时，只要编码一帧最多用一个帧间隔（1/`streamFps` 秒），帧就是无损 PNG 文件：每次推流先发送 JPEG 帧，对一帧的试编码跟得上后切换为 PNG，简单的 2D 场景和像素画通常如此；某个 PNG 帧用时更长时回到 JPEG 帧，大多数 3D 场景如此。试编码或 PNG 帧较慢后，下一次试编码在 1 s 后进行，延迟逐次加倍，最长 8 s。Godot 的 JPEG 编码器在任何质量下都以一半分辨率存储颜色，因此 PNG 帧保留文字和像素画清晰的彩色边缘，而 JPEG 帧会把它们模糊。读取方尚未取走上一条记录时到达的帧会相互替换，因此读取较慢的一方总能收到最新的帧。帧响应失败或结束时，“游戏”标签页在 250 ms 后重新打开它；在尝试未送达任何帧期间，延迟逐次加倍，最长 4 s。

<a id="data-directory"></a>
### 数据目录中的文件

| 路径 | 内容 | 生命周期 |
|---|---|---|
| `payload/<hash>/wasd_harness.gd`、`payload/<hash>/wasd_check.gd` | harness 与检查脚本在 Desktop 应用归档之外的副本；`<hash>` 是脚本 SHA-256 的前 16 位十六进制数字 | 脚本不变时复用；旧版本保留 |
| `runtime/<runtimeVersion>/` | 托管运行时：runner、LibGodot 库和 `runtime.json` | 保留；新的 `runtimeVersion` 会安装在它旁边 |
| `runtime/.download-<id>.tar.gz`、`runtime/.staging-<id>/`、`runtime/<runtimeVersion>.lock` | 进行中安装的归档、解压出的文件和写入锁 | 安装结束时删除 |

插件不会在 `dataRoot` 下写入其他内容；截图进入附件存储。

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面上的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，`package.json` 以 `icon` 字段指向该文件。该文件把 Godot Engine 标志（版权所有 © 2017 Andrea Calabró）原样嵌入 36 × 36 画布，只添加了 `viewBox` 以便缩放：源文件是 [Godot 仓库](https://github.com/godotengine/godot)中 Godot 4.7.2 的 `misc/logo/icon.svg`，也见于 [Godot 媒体资料包](https://godotengine.org/press/)。该标志以[知识共享署名 4.0 国际许可协议（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/)授权，不受本仓库的许可证覆盖。Godot 与 Godot 标志是 Godot Foundation 的商标，此处依其[商标政策](https://godot.foundation/policies-and-procedures/trademark-policy)用于标识 Godot 集成。WASD Engine 与 Godot Foundation 没有关联，也未获其认可。“游戏”标签页、它的引导条目与 Godot 工具卡片仍使用本包自己的游戏手柄图形。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本包有宿主侧与 Client 侧两部分。宿主侧是 `godot` 服务，一个 Typert Remote 服务：其构造函数校验配置，注册工具和提示词部分，并在存在 `connection` 服务时注册帧路由。它拥有一个运行时管理器，负责解析和安装运行时，并把运行时视图发布给每个跟随流；还拥有一个以活动 Agent 为键的每 Session 状态注册表，其中包括当前运行、日志与新错误游标，以及最新截图的帧；该注册表还保存每个 Session id 的跟随流，它们比 Agent 存在得更久。同一个 Session 的启动与停止依次进行。

一次运行拥有它的导入进程、回环监听器、游戏进程和计时器，并在结束时全部释放。[harness 协议](../../../docs/subsystems/gamedev.zh.md#harness-protocol)定义了运行与 harness 交换的消息：令牌握手、请求及其应答、状态、日志、帧和截图图像。

Client 侧先挂载生成的 `godot` Remote，再挂载 UI；撤下时先撤 UI，再撤 Remote。每个 Session 有一个跟随源，在有读取方期间把跟随流折叠为标签页的状态。游戏画面用 `fetch` 读取帧路由，用 `createImageBitmap` 解码最新的记录：图像以 PNG 文件签名开头时按 PNG 解码，否则按 JPEG 解码，并在下一次重绘时绘制它。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 宿主插件：配置、提示词部分、Remote 方法和帧路由 |
| [`src/runtime.ts`](src/runtime.ts) | 运行时解析、托管安装和运行时视图 |
| [`src/runs.ts`](src/runs.ts) | 每 Session 状态、运行替换和运行数上限 |
| [`src/run.ts`](src/run.ts) | 单次运行：导入步骤、启动、握手、请求、日志、帧和关闭 |
| [`src/protocol.ts`](src/protocol.ts) | harness 连接上的消息分帧与校验 |
| [`src/tools.ts`](src/tools.ts) | 工具声明、结果文本和新错误报告 |
| [`src/check.ts`](src/check.ts) | 静态脚本检查 |
| [`src/project.ts`](src/project.ts) | 项目搜索、`project.godot` 设置和 `res://` 路径 |
| [`src/input.ts`](src/input.ts)、[`src/logs.ts`](src/logs.ts) | 输入校验与截图坐标；日志环形缓冲区及其游标 |
| [`src/follow.ts`](src/follow.ts)、[`src/frames.ts`](src/frames.ts) | 跟随流和帧路由 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：Remote、“游戏”标签页、工具卡片和自动打开 |
| [`src/client/GameTab.tsx`](src/client/GameTab.tsx) | “游戏”标签页正文：工具栏、游戏画面和日志抽屉 |
| [`src/client/input.ts`](src/client/input.ts)、[`src/client/frames.ts`](src/client/frames.ts) | 键盘与鼠标捕获；帧的读取与绘制 |
| [`runtime/wasd_harness.gd`](runtime/wasd_harness.gd) | 游戏内 harness |
| [`runtime/wasd_check.gd`](runtime/wasd_check.gd) | `godot_check` 的脚本加载器 |

### 用真实运行时验证

在仓库根目录运行端到端测试套件，并把 `WASD_LIBGODOT_DIR` 设为包含 `godot_runner` 与 LibGodot 库的文件夹，库使用 `wasdengine/libgodot/build.sh` 安装时的文件名 `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`，例如已安装的 macOS 或 Linux 运行时。它导入一个测试项目并运行（在 macOS 上无窗口运行），调用截图、输入、等待、日志、求值、场景树、控制、检查和停止工具，读取帧路由，并运行第二个项目，其拉伸模式会给游戏加上黑边；未设置该变量时，测试套件会被跳过。

```sh
WASD_LIBGODOT_DIR="$HOME/.wasdengine/godot/runtime/4.7.2-wasd.1" \
pnpm run test:e2e packages/gamedev/godot/tests/godot-runner.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [游戏开发工具](../README.zh.md) — 本包组及其他游戏应用。
- [游戏工具子系统](../../../docs/subsystems/gamedev.zh.md) — 运行生命周期、harness 协议、输入事件和“游戏”标签页的通道。
- [LibGodot 运行时](../../../wasdengine/libgodot/BUILD.md) — runner、macOS 补丁，以及运行时的构建、安装与发布方式。
- [右侧栏](../../client/ui-sidebar-right/README.zh.md) — 容纳“游戏”标签页的停靠区。
- [Connection](../../client/connection/README.zh.md) — 精确路由与所有者 Peer。
- [LiveShare](../../experimental/liveshare/README.zh.md) — 共享查看者可以调用哪些方法。
- [Godot 命令行](https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html) — `--script`、`--import` 和 `--headless` 等上游选项。

-----

<a id="model-experience"></a>
## 模型体验

### Godot 工具声明

#### 模型可见内容

插件加载时在全局工具层注册 10 个工具，因此无论是否存在 Godot 运行时或项目，只要 Agent 的工具集没有排除它们，Agent 就能看到：`godot_run`、`godot_stop`、`godot_screenshot`、`godot_input`、`godot_wait`、`godot_control`、`godot_eval`、`godot_scene_tree`、`godot_logs` 和 `godot_check`，其名称、描述和参数 schema 由 [`src/tools.ts`](src/tools.ts) 声明。唯一随配置变化的文本是 `godot_run` 中 `muted` 的描述 `Run without audio. Default: <agentRunsMuted>.`

#### Token 影响

默认配置下，10 个声明合计约 6,700 个字符的 JSON（含名称），进入每个提供这些工具的请求；其中 `godot_input` 最大，约 2,500 个字符。

#### KV Cache 影响

同一配置总是生成相同的声明，并在第一个请求之前注册，因此工具定义前缀保持稳定。修改 `agentRunsMuted` 会改变 `godot_run` 的声明，禁用该行会移除全部 10 个声明；任一变化都可能从第一个变化的定义开始使缓存复用失效。

### 系统提示词中的 Godot 部分

#### 模型可见内容

插件在 `TOOL_COMPUTER_USE` 位置对应的顺序上注册一个名为 `godot` 的全局系统提示词部分，文本固定如下；该部分是静态的，因此即使 Agent 的工具集排除了 Godot 工具，它也仍在该 Agent 的提示词中。

##### Godot 部分文本

```markdown
# Godot games

Godot is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. Do not look for one or download one. For a new game, first write project.godot, a main scene, and its scripts.

Test a Godot project with the godot_* tools:
1. godot_run starts or restarts the game and reports import and startup errors.
2. godot_screenshot shows the current frame. godot_input sends keys, text, mouse clicks and motion (in screenshot pixels), and input actions; godot_wait lets game time pass. Look again after acting.
3. godot_logs reads printed output and errors; godot_eval and godot_scene_tree inspect the running scene; godot_control pauses, resumes, or steps frames.
4. Fix the first error, then call godot_run again. godot_check finds GDScript errors without running the game.
The user can watch and play the running game in the Game panel.
```

#### Token 影响

插件加载期间，该部分为每个系统提示词增加 903 个字符。

#### KV Cache 影响

文本固定不变，并从第一个请求起就存在，因此系统提示词保持稳定；启用或禁用该行会增加或移除该部分，可复用的前缀有多长由[系统提示词的缓存规则](../../core/system-prompt/README.zh.md#model-experience)决定。

### 工具结果、截图与新错误报告

#### 模型可见内容

每个结果包含一个最多 6,000 个字符的文本块；`godot_screenshot`，以及带 `screenshot: true` 的 `godot_input` 或 `godot_wait`，另附一个 PNG 图像块，以附件 `godot-frame-<frame>.png` 保存，文本写明模型收到的图像尺寸，`godot_input` 的鼠标坐标以它为准；事件或等待之后的截图失败时，文本改为给出原因。每个结果和每条失败消息的末尾都附有本 Session 上一次 Godot 调用以来记录的错误级条目：`New errors since your last Godot call:`，最多 10 行 `[<level>, <source>] <file>:<line> (<function>): <message>` 形式的条目（省略缺失的部分和 `game` 来源），还有更多条目时附上 `… and <n> more; read them with godot_logs.`。失败以 `Error: <message>` 的形式送达模型，说明接下来应调用什么，并在崩溃或启动失败后引用进程输出的最后 20 行；没有运行时时，`godot_run` 与 `godot_check` 以下面的消息失败。

##### 缺少运行时的消息

```markdown
No Godot runtime is installed. Install the WASD Engine Godot runtime from the Game panel, or set libgodotPath and runnerPath, or godotExecutable, in the Godot plugin configuration.
```

#### Token 影响

参数、结果文本和图像在对话中保留，直到压缩（compaction）。插件限制每个结果的文本为 6,000 个字符、每条引用的日志消息为 500 个字符、新错误报告为 10 条、`godot_logs` 每次调用最多 1,000 条（默认 200 条）、`godot_scene_tree` 最多 5,000 个节点（默认 400 个）；每张截图增加一张图像，宽度最多为 `max_width` 像素（默认 1280），并按模型路由的图像请求目标进一步调整尺寸。

#### KV Cache 影响

仅追加：调用及其结果接在现有请求前缀之后，不会使其失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制描述 Godot 运行、“游戏”标签页和运行时当前的不足。

- **游戏以宿主用户的全部权限运行** — 游戏、导入步骤和 `godot_check` 作为宿主的普通子进程运行。Session 权限模式（例如 `read-only` 或 `workspace-write`）的[沙箱](../../sandbox/sandbox-policy/README.zh.md)不约束它们，它们也从不像 `bash` 命令那样请求[批准](../../interaction/user-approval/README.zh.md)。`godot_run` 启动的游戏代码、`godot_check` 加载的脚本，以及 `godot_eval` 求值的表达式（它可以运行包括 `OS.execute` 在内的任意 GDScript），都能读写宿主用户可访问的所有文件并启动其他程序。`project` 接受绝对路径或工作目录之外的路径，因此 `godot_run` 和 `godot_check` 会运行宿主用户可读取的任何项目。
- **托管运行时需要已发布的版本** — **安装 Godot** 从 `runtimeManifestUrl` 指定的 GitHub 发布版本下载 manifest 和归档，默认是 `WASDEngine/WASDEngine` 的 `libgodot-4.7.2-wasd.1`。[LibGodot 运行时工作流](../../../wasdengine/libgodot/BUILD.md#release)必须先发布该版本；在此之前，安装会以 manifest 的 HTTP 状态失败，无法访问 GitHub 的宿主需要设置 `runnerPath` 与 `libgodotPath`，或使用已安装的编辑器。
- **只有三个平台** — 发布工作流构建 macOS arm64、Linux x64 和 Windows x64。在其他平台上（例如 Intel Mac），安装会因 manifest 中没有对应构建而失败，游戏只能通过本地 LibGodot 构建或已安装的编辑器运行。
- **macOS 以外会打开窗口** — 只有 macOS 上的 LibGodot 能在没有窗口的情况下运行游戏。在 Linux 与 Windows 上，以及在任何平台上使用编辑器可执行文件时，每次运行（包括每次 agent 运行）都会在宿主的桌面上打开游戏窗口。
- **“游戏”标签页不支持手柄** — 标签页只转发键盘和鼠标输入，因此连接在浏览器所在计算机上的手柄无法控制游戏；agent 可以用 `godot_input` 发送手柄按钮和摇杆事件。
- **JPEG 帧会模糊彩色边缘** — 当编码一个 PNG 帧用时超过 1/`streamFps` 秒，或 `streamLossless` 关闭时，场景推流 JPEG 帧，“游戏”标签页中彩色文字等细小的饱和色细节会比游戏中更柔和：Godot 的 JPEG 编码器在任何质量下都以一半分辨率存储颜色。
- **帧为游戏窗口的像素尺寸** — “游戏”标签页把窗口的像素（宽度最多 `streamMaxWidth`）适配到标签页中。在高密度显示器上，标签页覆盖的屏幕像素多于窗口的像素时，帧会被放大，看起来比按显示器密度渲染的游戏窗口更柔和。
- **音频只在宿主上播放** — “游戏”标签页推流的帧不带声音。游戏音频通过宿主机器的音频输出播放，因此另一台计算机上的浏览器听不到声音，agent 的运行默认静音。
- **LiveShare 查看者看不到游戏** — LiveShare 把每个 `godot` 方法归为仅所有者可用，并把该命名空间排除在共享之外，帧路由对非所有者 Peer 返回 403，因此查看者既不能观看也不能游玩。
- **每个 Session 一个游戏** — “游戏”标签页中的 **运行** 和 `godot_run` 会相互替换对方的运行，宿主在所有 Session 中最多同时运行 `maxRuns` 个游戏。
- **“游戏”标签页的输入排在 agent 的输入之后** — 游戏一次只执行一个输入序列，因此 agent 的序列（例如 `{ "wait": 30 }`）执行期间，来自“游戏”标签页的按键和点击要等该序列结束才送达游戏，最迟在其实际时间时限结束时。
- **在 Windows Desktop 上，游戏画面中的应用快捷键暂停** — 画面获得焦点期间，任何应用快捷键或菜单加速键都不会执行，直到按 Shift+Esc 或点击其他位置释放焦点。
- **托管运行时不支持 C# 脚本** — LibGodot 构建时不含 .NET，因此 C# 脚本无法加载。已安装的托管运行时还优先于 `godotExecutable`，因此在那里设置的 .NET 编辑器只有在未安装托管运行时时才会运行游戏。
- **不支持导出** — 这些工具可以运行和检查游戏，但不会导出游戏。导出需要同一版本的 Godot 编辑器可执行文件及其导出模板，由 Agent 在 shell 中运行。
- **不检查编辑器可执行文件的版本** — harness 与检查脚本继承 Godot 的 `Logger` 类并读取 `ScriptBacktrace` 帧；没有这些类的编辑器无法启动运行。
- **harness 会替换自定义主循环** — 运行通过 `--script` 传入 harness，因此 `application/run/main_loop_type` 指定了自有 `SceneTree` 或 `MainLoop` 类的项目会改由 harness 运行。
- **“游戏”标签页可能显示过时的运行时状态** — 标签页在开始跟随某个 Session 时以及安装之后解析运行时，因此在标签页打开期间安装的 Godot 编辑器，要等标签页再次跟随某个 Session 后才会显示，例如刷新页面后。
- **截图需要支持图像的路由** — 在不支持图像输入或没有附件存储的模型路由上，`godot_screenshot` 和 `screenshot` 选项会失败，agent 在那里无法看到游戏；`godot_input` 和 `godot_wait` 会在执行操作之前失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
