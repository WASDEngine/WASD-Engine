---
description: "面向部署方与维护者的 LibGodot Godot 游戏运行：配置运行时及其安装、帧推流与超时，或排查 godot_* 工具、“游戏”标签页、godot Remote 和 /api/godot.frames 路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-godot

[English](README.md) | 中文

## 概述

让 agent（智能体）带启动选项运行 Session 的 Godot 游戏、通过截图以及从任意相机绘制的视图查看它、游玩它、在其中运行 GDScript、录制视频、读取日志，并在不运行游戏的情况下检查 GDScript。你可以在“游戏”标签页中观看并游玩同一个游戏。WASD Engine 的 Web 与 Desktop 默认启用本插件。游戏只通过 LibGodot 运行（只需在“游戏”标签页中安装一次），从不通过 Godot 编辑器运行；在 macOS 上，游戏在没有窗口的情况下运行。每个 Session 同时只运行一个游戏；游戏音频只在宿主上播放。

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

[`src/index.ts`](src/index.ts) 声明并校验以下字段。`dataRoot`、`libgodotPath`、`runnerPath`、`webTemplatePath`、`windowsTemplatePath`、`macosTemplatePath` 或 `serverTemplatePath` 为相对路径，`libgodotPath` 与 `runnerPath` 只设置了其中一个，或 `runtimeManifestUrl`、`webTemplateArchiveUrl`、`windowsTemplateArchiveUrl`、`macosTemplateArchiveUrl` 或 `serverTemplateArchiveUrl` 不是 http 或 https URL 时，加载失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 存放托管运行时和 harness 脚本副本的绝对目录 |
| `runtimeVersion` | `4.7.2-wasd.3` | 托管运行时的版本：即它在 `runtime/` 下的文件夹名，也是其 manifest（元数据清单）必须描述的版本；系统提示词会写明它开头的 Godot 版本，例如 `4.7` |
| `runtimeManifestUrl` | `https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-4.7.2-wasd.3/manifest.json` | 安装时下载的发布 manifest |
| `libgodotPath` | `''` | LibGodot 库的绝对路径；须与 `runnerPath` 一起设置 |
| `runnerPath` | `''` | `godot_runner` 可执行文件的绝对路径；须与 `libgodotPath` 一起设置 |
| `streamFps` | `30` | 向“游戏”标签页推流的每秒帧数，1 到 60 |
| `streamQuality` | `0.9` | 推流的 JPEG 帧的 JPEG 质量，0.1 到 1 |
| `streamLossless` | `true` | 准备 PNG 帧跟得上 `streamFps` 时推流无损 PNG 帧，否则推流 JPEG 帧；`false` 只推流 JPEG 帧 |
| `streamMaxWidth` | `1280` | 推流帧的最大宽度（像素），64 到 4096 |
| `importBeforeRun` | `true` | 每次运行前导入项目资源 |
| `importTimeoutMs` | `180000` | 单个导入步骤（在运行或检查之前）以及单次 `godot_check` 脚本加载的时限 |
| `startTimeoutMs` | `60000` | 从启动到游戏连接的时限 |
| `requestTimeoutMs` | `15000` | 截图、求值、场景树、暂停或继续请求的时限，有请求等待时游戏可保持沉默的最长时间，以及等待、单步或 agent 的输入序列在其按每秒 10 帧所需时间之外最多可用的实际时间 |
| `stopGraceMs` | `3000` | 被停止的游戏在被终止前用于退出的时间，也是每个 Godot 进程的终止宽限时间 |
| `processOutputBytes` | `1048576` | 每个 Godot 进程的每个输出流保留的控制台输出字节数，至少 1024 |
| `maxLogEntries` | `5000` | 每次运行保留的日志条目数 |
| `maxRuns` | `4` | 在任何电脑上所有 Session 合计可同时运行的游戏数上限，每个游戏在其进程结束前一直计入；电脑的[运行上限](#game-runs)可能更低 |
| `runMemoryBytes` | `8589934592`（8 GiB） | 每个游戏所需的电脑物理内存：运行上限至多为电脑内存除以此值并四舍五入到整数；`0` 表示不考虑内存 |
| `runCores` | `4` | 每个游戏所需的逻辑处理器数：运行上限至多为电脑的逻辑处理器数除以此值并向下取整；`0` 表示不考虑处理器 |
| `maxHeadlessProcesses` | `2` | 同时运行的 `godot_check` 进程、`godot_script` 运行、供其他插件使用的导入、导出以及实例组数上限；之后的按顺序等待，直到有一个结束 |
| `minAvailableMemoryBytes` | `1073741824`（1 GiB） | 启动游戏、`godot_check` 进程、导出或实例组时电脑必须有的可用内存；`0` 关闭此检查 |
| `hiddenFps` | `10` | [无人显示或使用的无窗口游戏](#game-runs)的每秒帧数，取值 0 到 60；`0` 让所有游戏保持自身帧率 |
| `hiddenDelayMs` | `30000` | 游戏连接后、最后一个“游戏”标签页不再显示它后，或其最后一个请求结束后，经过多长时间开始应用 `hiddenFps` |
| `agentRunsMuted` | `true` | agent 启动的运行是否默认无音频，除非 `godot_run` 另行指定 |
| `minWindowHeight` | `720` | 未指定窗口大小的运行，在项目的拉伸模式会缩放其内容时（见[游戏运行](#game-runs)），把高度较小的项目窗口按整数倍放大，使高度接近此像素值；`0` 保留每个项目的窗口大小 |
| `recordQuality` | `0.92` | [`godot_record`](#views-and-recordings) 捕获的帧的 JPEG 质量，0.1 到 1 |
| `recordBufferBytes` | `1073741824`（1 GiB） | 窗口编码录制慢于游戏捕获帧时，宿主为其保留的已捕获帧的字节数；需要更多时，录制停止并失败 |
| `maxVideoBytes` | `4294967296`（4 GiB） | `godot_record` 保存的视频的最大大小 |
| `webTemplateArchiveUrl` | `https://github.com/WASDEngine/WASD-Engine/releases/download/web-template-4.7.2-wasd.1/web-template-4.7.2-wasd.1.tpz` | 包含运行时 Godot 版本 Web 模板的导出模板归档；[Web 导出](#web-export)只从中下载该模板；须为 http 或 https URL。默认值是 WASD Engine 构建的模板 |
| `webTemplateEntry` | `templates/web_nothreads_release.zip` | 单线程 Web 发布模板在该归档中的路径 |
| `webTemplateSha256` | `477a8c0b…48a65d` | 下载的模板必须具有的小写十六进制 SHA-256；与归档一起修改 |
| `webTemplatePath` | `''` | 用来代替下载的绝对路径 Web 发布模板 ZIP |
| `windowsTemplateArchiveUrl` | `https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz` | 运行时 Godot 版本的 Godot 导出模板归档；Windows 的[桌面版导出](#desktop-export)只从中下载其模板；须为 http 或 https URL |
| `windowsTemplateEntry` | `templates/windows_release_x86_64.exe` | 64 位 x86 Windows 发布模板在该归档中的路径 |
| `windowsTemplateSha256` | `d34d36f3…4b0562` | 下载的模板必须具有的小写十六进制 SHA-256；与归档一起修改 |
| `windowsTemplatePath` | `''` | 用来代替下载的绝对路径 Windows 发布模板 `.exe` |
| `macosTemplateArchiveUrl` | `https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz` | 运行时 Godot 版本的 Godot 导出模板归档；macOS 的[桌面版导出](#desktop-export)只从中下载其模板；须为 http 或 https URL |
| `macosTemplateEntry` | `templates/macos.zip` | macOS 模板 ZIP 在该归档中的路径 |
| `macosTemplateSha256` | `88df5e2e…558a4792` | 下载的模板必须具有的小写十六进制 SHA-256；与归档一起修改 |
| `macosTemplatePath` | `''` | 用来代替下载的绝对路径 macOS 模板 ZIP |
| `serverTemplateArchiveUrl` | `https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz` | 运行时 Godot 版本的 Godot 导出模板归档；[专用服务器导出](#server-export)只从中下载其模板；须为 http 或 https URL |
| `serverTemplateEntry` | `templates/linux_release.x86_64` | Linux x86_64 发布模板在该归档中的路径 |
| `serverTemplateSha256` | `d9f79ab8…a7c63` | 下载的模板必须具有的小写十六进制 SHA-256；与归档一起修改 |
| `serverTemplatePath` | `''` | 用来代替下载的绝对路径 Linux x86_64 发布模板 |
| `exportTimeoutMs` | `600000` | 一次导出（包括它启动的资源导入）的截止时间 |
| `maxInstances` | `4` | 在任何电脑上，一个[实例组](#instance-groups)同时启动的无窗口实例数上限；电脑自身的上限可能更低 |
| `instanceMemoryBytes` | `2147483648`（2 GiB） | 为实例组中每个实例预留的电脑物理内存：一个实例组最多包含电脑内存除以该值后四舍五入的实例数；`0` 表示不考虑内存 |
| `instanceCores` | `1` | 为实例组中每个实例预留的逻辑处理器数：一个实例组最多包含电脑逻辑处理器数除以该值后向下取整的实例数；`0` 表示不考虑处理器 |
| `webCheckCommand` | `[]` | 启动 [Web 检查](#web-check) 所用浏览器的命令行（不含其参数）：桌面应用的可执行文件，以及 Electron 默认应用运行它时的应用文件夹。游戏工具覆盖层从 `WASD_WEB_CHECK_COMMAND` 读取它，桌面应用为其 Host 设置该变量；为空时关闭 Web 检查 |
| `webCheckSeconds` | `20` | 游戏开始稳定绘制帧后 Web 检查观察它的秒数，取值 1 到 600 |
| `webCheckStartTimeoutMs` | `180000` | 从打开页面起，Web 检查等待游戏启动并稳定绘制帧的毫秒数 |
| `webCheckTimeoutMs` | `300000` | 一次 Web 检查的截止时间，包括其浏览器的启动和游戏的加载 |

<a id="runtime"></a>
### Godot 运行时

每次运行和每次 `godot_check` 都会重新解析运行时，并采用第一个匹配项：

1. `runnerPath` 与 `libgodotPath`：你自行构建或安装的 LibGodot runner 与库。
2. Desktop 应用在本包 `libgodot/<platform>-<arch>/` 目录中附带的运行时（打包后的应用从 `app.asar.unpacked` 读取），仅当其 `runtime.json` 写明当前版本、平台和架构，且 runner 与库都存在时使用。
3. `<dataRoot>/runtime/<runtimeVersion>/` 中的托管运行时，条件相同。

配置的路径不是可用文件时，调用会失败，消息中写明该字段，搜索不再继续。Desktop 打包时会放入附带的运行时（[Desktop 应用中的 LibGodot](../../../wasdengine/FORK.md#libgodot-in-the-desktop-app)）；源码检出和 npm 安装不附带运行时，使用托管运行时。插件从不启动 Godot 编辑器，无论它位于 `PATH`、`/Applications` 还是其他位置，因为编辑器会在窗口中运行游戏。没有任何运行时可用时，`godot_run` 与 `godot_check` 会失败，并要求从“游戏”标签页安装运行时或在配置中设置。

在 macOS 上，每次运行都会传入 `--embedded`，[打过补丁的 LibGodot](../../../wasdengine/libgodot/BUILD.md#the-patches) 用 Metal 把游戏渲染到一个不显示在任何窗口中的图层：不会打开游戏窗口，“游戏”标签页和截图是查看游戏的唯一途径。在补丁未覆盖的 Linux 与 Windows 上，运行会在宿主的桌面上打开普通的游戏窗口，“游戏”标签页同样会为其推流。

<a id="managed-runtime"></a>
### 安装托管运行时

托管运行时是以 LibGodot 形式构建、带有 WASD Engine 补丁的 Godot 4.7.2；[LibGodot 构建指南](../../../wasdengine/libgodot/BUILD.md)说明了 runner、归档、`runtime.json` 和 manifest。“游戏”标签页中的 **安装 Godot** 在运行时缺失或失败时显示，它调用 `installRuntime` Remote 方法，该方法：

1. 下载 `runtimeManifestUrl`，并要求其 `version` 等于 `runtimeVersion`；
2. 为宿主的 `<platform>-<arch>` 键（例如 `darwin-arm64`）选择产物；
3. 从产物的 `url`（相对于 manifest URL 解析）下载归档，并在接收过程中校验其大小和 SHA-256；
4. 用 `tar` 把归档解压到暂存文件夹：`tar` 在该文件夹中运行，唯一的路径参数是 `../<归档名>`，因为 Windows 的 `tar.exe` 以 ANSI 代码页读取参数，而 ANSI 代码页无法容纳用户配置文件夹路径中的所有字符；确认 runner 与库都在其中；并写入 `runtime.json`；
5. 在文件锁保护下把暂存文件夹重命名为 `<dataRoot>/runtime/<runtimeVersion>/`；如果另一个宿主进程在此期间已安装该运行时，则保留那一份。

安装期间，每个“游戏”标签页都会显示带百分比的“正在下载 Godot”，随后显示“正在校验 Godot”和“正在解压 Godot”。第二个请求会加入正在进行的安装；关闭标签页只会停止它的等待，卸载插件则会取消安装。无论成功还是失败，下载文件和暂存文件都会被删除；失败时会显示原因：manifest 无法访问或其 HTTP 状态、manifest 无效或属于其他版本、没有对应平台的构建、下载出错、大小或 SHA-256 不匹配，或归档中缺少运行时文件。`wasdengine/libgodot/build.sh --install <dataRoot>` 会把本地构建安装到同一位置。

<a id="game-runs"></a>
### 游戏运行

一个 Session 最多运行一个游戏。`godot_run` 和“游戏”标签页中的 **运行** 会先停止 Session 当前的游戏，再启动下一个；宿主在所有 Session（包括已连接 agent 的 Session）中最多同时运行运行上限个游戏；游戏在其进程结束前一直计入，包括其 Session 关闭后仍在停止的游戏。运行上限是 [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.zh.md#build-the-tools) 的 `processLimit` 按 `maxRuns`、`runMemoryBytes` 与 `runCores` 算出的值：按默认设置，8 GiB 内存的电脑运行一个游戏，16 GiB 内存、8 个逻辑处理器的电脑运行两个，32 GiB 内存、16 个逻辑处理器的电脑运行四个。在 Apple M3 Pro 上，一个 Defenders of the Wall 游戏的内存峰值为 0.9 GiB。启动还要求电脑有 `minAvailableMemoryBytes` 的可用内存（以操作系统报告的数值为准，因此其他程序以及 Blender、GIMP、SuperCollider 的工作进程都计入其中）；否则以 `godot/low-memory` 失败，不启动任何进程。Session 的 Agent 结束时（例如 Session 关闭），其游戏会停止；卸载插件会停止所有游戏。

无人显示或使用的无窗口游戏以 `hiddenFps` 的帧率运行：游戏连接后、最后一个[“游戏”标签页](#game-tab)或帧流不再显示它后，或其最后一个请求结束后，经过 `hiddenDelayMs`，宿主就通过 harness 为 `Engine.max_fps` 设置上限；游戏自身的上限更低时保留后者。显示该游戏的“游戏”标签页，以及工具或标签页的每个请求，都会立即解除上限，且在请求到达游戏之前解除，因此 `godot_wait`、`godot_input`、`godot_performance` 及其他工具看到的都是游戏自身的帧率。受限期间，只要项目的物理节拍能放进受限后的帧（默认每帧最多 8 个物理步，即每秒 10 帧时每秒 80 个节拍），游戏时间就保持原有速度；每帧按固定量移动、不考虑帧间隔的逻辑会变慢。Linux 与 Windows 上有窗口的游戏保持自身帧率，因为用户能看到窗口。在 Apple M3 Pro 上，一个无人显示的 Defenders of the Wall 游戏以自身帧率运行时占用 0.33 个核心，限制为每秒 10 帧后占用 0.04 个核心。

无窗口游戏只在有显示器显示它时才呈现（present）其帧：显示该游戏的“游戏”标签页持有一个 `godot.view` 流，它计为一个显示。没有显示时，harness 把根视口从屏幕上分离，但仍让它把每一帧绘制到其纹理中，截图、录制和帧流读取的正是该纹理，帧率最多为屏幕的刷新率，与呈现时的节奏相同。一帧呈现时要等窗口服务器（window server）收回上一帧，而其他进程大量呈现帧时，它会迟迟才收回：在 Apple M3 Pro 上，一个游戏旁边另有一个呈现帧的游戏时，它每秒多次卡顿 100 到 600 毫秒；第二个游戏停止呈现后，尽管它仍绘制每一帧，第一个游戏便稳定地以每秒 120 帧运行。只渲染而不呈现的帧不会拖累第一个游戏，只占用处理器的繁忙游戏也不会。

运行使用 `project` 参数指定的文件夹（相对于工作目录），否则使用最近的 `project.godot`：插件按名称顺序广度优先搜索工作目录及其下三层文件夹，并跳过 `.git`、`node_modules`、`.godot`、`.agents` 和 `.wasdengine`（WASD Engine 在其中保存项目状态，例如已移除扩展的备份）；`godot_check` 检查整个项目时也跳过这些文件夹。`scene` 必须是现有文件的 `res://` 路径或 `uid://` 引用；不指定时，游戏打开项目的主场景。`width` 与 `height` 一起设置窗口大小，取值为 1 到 16384 像素。不指定时，窗口采用项目的大小：`window/size/window_width_override` 与 `window_height_override` 为正时取它们，否则取 `viewport_width` 与 `viewport_height`；当该大小低于 `minWindowHeight` 且 `window/stretch/mode` 为 `canvas_items` 或 `viewport` 时，运行按使高度最接近 `minWindowHeight` 的整数倍放大窗口，因此 640x360 的像素画游戏以 1280x720 运行，像素保持方正，`godot_run` 的结果会写明放大倍数。拉伸模式为 `disabled` 的项目保持原大小，因为更大的窗口会显示更多的世界。

`args` 在 `--` 之后、harness 自己的参数之前传给游戏，游戏用 `OS.get_cmdline_user_args()` 读取它们，因此游戏自带的捕获或测试模式无需等待请求的代码即可启动：最多 64 个参数，每个最多 4,096 个字符，且都不以 `--wasd-` 开头。`engine_args` 从固定列表中传递 Godot 命令行选项，并检查每个值：`--fixed-fps`、`--max-fps`、`--time-scale`、`--disable-vsync`、`--frame-delay`、`--delta-smoothing`、`--debug-collisions`、`--debug-paths`、`--debug-navigation`、`--debug-avoidance`、`--print-fps`、`--verbose` 和 `--language`；其他选项，例如 `--script`、`--path` 或 `--write-movie`，会被拒绝。使用 `--fixed-fps` 时，无论绘制一帧需要多久，每一帧都让游戏时间前进相同的步长，因此游戏以绘制速度而不是实际时间运行，`--max-fps` 也不会让它变慢。运行的 `launch` 带有这两个列表，因此“游戏”标签页的 **Restart** 会再次传入它们。

运行依次经过以下阶段：

1. `preparing`：从运行创建起，到其导入步骤或启动开始为止，后者紧接着发生。插件先解析项目、场景和运行时，再停止 Session 之前的游戏并创建运行，因此其中任何一项有问题时，调用失败，之前的游戏继续运行；运行上限或内存的拒绝发生在之前的游戏停止之后。
2. `importing`：设置了 `importBeforeRun` 时，Godot 的无界面 `--import` 更新项目的导入数据；该步骤先等待宿主对该项目的其他导入步骤、检查和 Web 导出结束。其错误和警告进入运行的日志；导入异常退出时会添加一条警告，运行继续，超过 `importTimeoutMs` 则运行失败。
3. `starting`：从启动到游戏连接宿主。插件在 `127.0.0.1` 的随机回环端口上监听，向游戏传入随机令牌；在 `startTimeoutMs` 内没有游戏出示该令牌时，运行失败。
4. `running` 或 `paused`：游戏保持连接期间。
5. `exited`、`crashed` 或 `failed`：运行结束后。以退出码 0 自行退出的游戏，或被用户或 agent 停止的游戏，结束于 `exited`。其他任何退出都结束于 `crashed`，关闭连接后仍持续运行 `stopGraceMs` 的游戏也是如此。在游戏连接之前失败的运行结束于 `failed`。崩溃与失败消息会引用进程输出的最后 20 行。

停止操作会要求游戏退出，超过 `stopGraceMs` 仍在运行时终止进程；从停止开始的那一刻起，游戏不再接受新的请求，发给它的“游戏”标签页输入会被丢弃。有请求在等待时，若游戏在 `requestTimeoutMs` 内没有发送任何内容，等待中的请求会以 `The game stopped responding` 失败；运行中的游戏至少每秒报告一次状态。宿主放弃一个等待、单步或输入序列时（因为调用方取消了它，或游戏停止了响应），会要求游戏丢弃该请求，被丢弃的输入序列会释放它仍按住的键、按钮和动作。宿主进程退出时 LibGodot runner 随之退出，harness 在与宿主的连接关闭时让游戏退出。

agent 启动的运行使用 Godot 的 `Dummy` 音频驱动，除非 `godot_run` 传入 `muted: false` 或 `agentRunsMuted` 为 `false`。从“游戏”标签页启动的运行会播放音频。

`godot_run` 以 `web: true` 启动的运行会传入 `--rendering-method gl_compatibility`，因此无论项目的 `rendering/renderer/rendering_method` 如何设置，游戏都使用其 [Web 构建](#web-export)的兼容性渲染器渲染，显示已发布游戏的玩家看到的着色、阴影和缺失的效果。其 `launch` 带有 `web: true`，因此“游戏”标签页的 **运行** 会以同样方式重启它，其渲染器显示为 `opengl3 / gl_compatibility`。这种运行使用桌面 OpenGL 驱动而非浏览器，因此只有浏览器才有的限制和卡顿由 [Web 检查](#web-check)报告。

<a id="harness"></a>
### harness

harness 不会被复制到项目中：每次运行都通过 Godot 的 `--script` 选项，传入本包 `runtime/wasd_harness.gd` 在 `<dataRoot>/payload/` 中的副本，`project.godot` 以及项目的场景和脚本保持不变。导入步骤写入的导入数据与 Godot 编辑器相同。harness 是游戏的主循环：它连同项目的自动加载打开主场景或请求的场景，在游戏暂停时继续为宿主服务，通过 Godot `Logger` 记录打印的行以及带脚本回溯的错误，并通过回环连接响应宿主的截图、帧流、帧率、呈现、输入、等待、单步、暂停、继续、取消、求值、场景树、视图、录制、性能、音频和退出请求。在 WASD Engine 自己的 LibGodot 构建（从 `4.7.2-wasd.3` 起）上，它通过运行时的 `WASDEngineRuntime` 单例剖析脚本；在其他运行时上，`godot_performance` 会说明无法剖析。

<a id="tools"></a>
### 工具

每个工具都作用于调用方 Session 的游戏；在 Session 之外调用会失败。

| 工具 | 参数 | 结果 |
|---|---|---|
| `godot_run` | `project`、`scene`、`width`、`height`、`muted`、`web`、`args`、`engine_args` | 启动或重启游戏（`web: true` 时使用其 Web 构建的兼容性渲染器，并使用给出的[启动选项](#game-runs)）并等待其运行，然后报告阶段、项目、场景、窗口大小及其放大倍数、渲染器、Godot 版本、无窗口、静音与 Web 标志、启动选项，以及导入和启动期间记录的最多 20 条错误和警告；游戏启动失败，或开始运行后一秒内结束，则调用失败 |
| `godot_stop` | 无 | 游戏结束后返回 `Stopped the game.`，或返回 `No game was running.` |
| `godot_screenshot` | `max_width`（默认 1280，64 到 4096）、`region`、`coordinate_space` | 一张游戏窗口的 PNG 图像，缩小到 `max_width` 像素宽，或其中 `region` 矩形按窗口自身像素的图像，并附上图像大小、窗口大小、区域、帧号以及游戏是否暂停 |
| `godot_input` | `events`（最多 256 个）、`screenshot`、`coordinate_space` | 依次执行事件，其中的等待和按住按实际时间计算，然后报告事件数、帧数、秒数和当前帧；`screenshot: true` 会附加一张截图。序列在其等待时间、按每秒 10 帧计的每个等待一帧与开始的一帧，再加上 `requestTimeoutMs` 的实际时间过去后提前结束，并报告已执行的事件 |
| `godot_wait` | `seconds` 或 `frames`、`screenshot` | 让游戏经过这么多未暂停的游戏时间或这么多帧（1 到 100000）；游戏暂停时拒绝 `seconds`；等待在其秒数（或按每秒 10 帧计的帧数）加上 `requestTimeoutMs` 的实际时间过去后提前结束，并报告已经过的游戏时间和帧数，例如游戏自行暂停时 |
| `godot_view` | `node` 或 `asset`、`bone`、`yaw`、`pitch`、`distance`、`radius`，或 `camera`；`fov`、`isolate`、`lighting`、`animation`、`time`、`width`、`height`（默认 1280x720，最大 4096） | 一张在游戏内部用独立相机、按独立尺寸绘制的游戏 3D 世界的 PNG 图像，不改变窗口或游戏相机，并附上相机的位置、方向和视野，以及取景的中心和半径；见[视图、代码与录制](#views-and-recordings) |
| `godot_record` | `seconds`（0.5 到 120）、`fps`、`max_width`、`path`、`replace`、`events`、`coordinate_space`、`sheet_frames`（默认 12，最多 24） | 在事件播放期间把游戏录制为 MP4 文件，返回文件路径、大小、编解码器、帧数、跳过的帧数、时长、帧率和帧尺寸，并附上一张取自整段录制的帧的 JPEG 拼图 |
| `godot_control` | `action`（`pause`、`resume` 或 `step`）、`frames` | 暂停或继续游戏，或运行 `frames` 帧（默认 1，最多 100000）后再次暂停；单步期间游戏被暂停、继续或再次单步时（例如在“游戏”标签页中），以及按每秒 10 帧计的帧数加上 `requestTimeoutMs` 的实际时间过去后，单步提前结束，结果会写明原因；报告暂停状态和帧号 |
| `godot_eval` | `expression` 或 `code`、`node`、`timeout_seconds`（code，默认 10，1 到 300） | 在运行中的游戏里对 Godot `Expression` 求值，其中定义了 `scene`、`root`、`tree`、引擎单例和自动加载，以 `node` 处的节点或当前场景为基对象；或把 GDScript `code` 作为函数体运行；返回 JSON 形式的值及其 Godot 类型 |
| `godot_scene_tree` | `node`、`depth`（默认 6，最多 64）、`max_nodes`（默认 400，最多 5000） | 缩进的大纲，列出节点名称、类、脚本、位置、大小、隐藏节点、Label 与 Button 文本，以及被禁用的处理 |
| `godot_performance` | `seconds`（默认 2，0.25 到 20）、`scripts`（默认 true） | 在这段真实时间内采样游戏，报告帧率、帧时间百分位数与尖峰、每帧各阶段的平均与最大毫秒数、渲染器测得的 GPU 与渲染 CPU 时间、绘制的对象、图元与绘制调用数、内存与显存、对象数及其变化、物理物体、管线编译、导航、音频延迟、场景树普查、自定义 `Performance` 监视器，以及帧率限制；随后，除非 `scripts` 为 false，再以同样的秒数剖析脚本，报告每个脚本及其最耗时的函数每帧的毫秒数，以及它们调用的引擎方法 |
| `godot_audio` | `seconds`（默认 3，0.25 到 30）、`events`（最多 256 个）、`coordinate_space`、`path`、`replace` | 在这些事件从开始处播放的同时，采集这么长的游戏混音，报告电平、响度、削波、静音、频谱、含有声音的片段、播放过的音频播放器以及总线，模型能看图像时附上波形与声谱图；`path` 把采集保存为 16 位 `.wav` 文件，除非 `replace` 为 true，否则不覆盖已有文件 |
| `godot_logs` | `since`、`levels`、`limit`（默认 200，最多 1000） | 游标 `since` 之后、或本 Session 上次读取之后的日志条目，以及下一个游标 |
| `godot_check` | `paths`、`project` | 项目自上次导入以来有改动时先导入项目，然后在无界面 Godot 中加载 GDScript 文件而不运行游戏，并按文件列出问题 |
| `godot_script` | `script`、`args`、`timeout_seconds`、`project` | 项目自上次导入以来有改动时先导入项目，然后在无界面 Godot 中针对项目运行继承 `SceneTree` 或 `MainLoop` 的 GDScript 而不运行游戏，并报告其输出的结尾和引擎错误 |

`godot_screenshot`、`godot_input`、`godot_wait`、`godot_view`、`godot_record`、`godot_control`、`godot_eval`、`godot_scene_tree`、`godot_performance` 和 `godot_audio` 需要已连接的游戏。在 Session 第一次运行之前，它们以 `No game is running in this Session; call godot_run first.` 失败；游戏启动或停止期间，以 `The game is starting or stopping; call godot_run to wait for it.` 失败；游戏结束后，它们写明游戏的阶段并引用崩溃或失败消息。

使用 `screenshot: true` 时，`godot_input` 和 `godot_wait` 会在向游戏发送任何内容之前检查模型路由能否查看图像，不能时直接失败，不对游戏执行任何操作。事件或等待之后的截图失败不会让调用失败，因为游戏已经执行了操作：结果文本写明 `The screenshot after the events failed: <reason>` 或 `The screenshot after the wait failed: <reason>`。

`godot_input` 接受以下事件：`key`，带 `W`、`Space`、`Left`、`Enter` 或 `Escape` 等 Godot 键名，或带 `keycode`；`text`，逐字符输入；`mouse_button`，在 `x` 与 `y` 处使用 `left`、`right`、`middle` 或滚轮按钮；`mouse_motion`；`action`，用于 `ui_accept` 等输入映射动作，可带 `strength`；`joy_button` 与 `joy_axis`，用于某个手柄 `device`；以及 `{ "wait": seconds }`，它让序列暂停这么多实际时间。按下的键或按钮会保持按下，直到对应的释放事件，或直到其 `hold` 时间（同样按实际时间计算）结束。游戏按到达顺序一次执行一个输入序列，包括“游戏”标签页的输入。agent 序列的时限从游戏收到它时开始计算，因此排在其他输入之后的序列可能在执行第一个事件之前就结束；“游戏”标签页的输入没有时限，因此排在 agent 序列之后的一批输入仍会送达其中的按键和按钮释放。鼠标坐标是当前运行最新截图的像素，插件会把它换算为窗口像素，因此在本次运行的第一张截图之前发送指针事件会失败；`coordinate_space: "window"` 则直接接受窗口像素。

每个结果末尾都附有该运行自本 Session 上一次 Godot 工具调用以来记录的错误、脚本错误和着色器错误条目，最多 10 条，其余给出数量；失败消息也附带同样的报告。`godot_run` 自行报告导入和启动期间的问题，`godot_logs` 会把截至其下一个游标的所有条目标记为已报告，包括被其 `levels` 过滤掉的条目。

一次运行保留其最新的 `maxLogEntries` 条日志。每个条目带有在宿主所有运行中递增的序号、来源（`game` 表示 harness 日志记录器，`process` 表示 Godot 进程的控制台输出，`import` 表示导入步骤）、级别（`stdout`、`stderr`、`warning`、`error`、`script_error` 或 `shader_error`）、消息（插件在 4,000 个字符处截断），以及 Godot 报告时提供的文件、行号、函数和脚本回溯。游戏进程的控制台输出在游戏关闭连接后进入日志；游戏启动失败时，全部输出都会进入日志。游标之后的条目已被丢弃时，`godot_logs` 会报告这一情况。

`godot_check` 按游戏加载脚本的方式加载脚本。Godot 通过项目的导入数据查找脚本用 `class_name` 声明的类、`uid://` 路径指向的文件，以及纹理等已导入的资源，而这些数据由导入写入；因此，当这些数据可能比项目文件旧时，检查会先运行运行前导入步骤所用的无界面 `--import`：插件加载以来该项目还没有开始过以退出码 0 结束的导入、项目数据文件夹中缺少类缓存 `global_script_class_cache.cfg`，或者在最近一次这样的导入开始之后，导入读取的某个文件发生了变化。文件的修改时间或状态变更时间较晚即视为发生变化，因此移入项目的文件也算在内。查找变化的文件时，跳过导入所跳过的内容：隐藏的文件和文件夹、数据文件夹（`.godot`；`application/config/use_hidden_project_data_directory` 为 `false` 时为 `godot`）、包含 `.gdignore` 文件或另一个项目的 `project.godot` 的文件夹，以及导入在其导入的文件旁边写入的 `.import` 与 `.uid` 文件。与运行前的导入一样，这次导入向项目写入 Godot 编辑器会写入的内容，执行导入的编辑器也会运行项目已启用的编辑器插件和 `@tool` 脚本。导入异常退出或超过 `importTimeoutMs` 时，检查不会失败：结果以一条警告开头，说明有关 `class_name` 类或已导入资源的错误可能是误报，下一次检查会再次导入。宿主对同一项目的导入步骤、检查和 Web 导出逐个执行，因此同时开始的检查和运行导入步骤不会同时导入该项目。最多同时运行 `maxHeadlessProcesses` 个检查与 Web 导出，每个检查连同其前的导入；之后的检查等待空位，得到空位后，若电脑的可用内存少于 `minAvailableMemoryBytes`，则不启动 Godot 并失败。

随后，检查启动一个无界面 Godot，通过 `runtime/wasd_check.gd` 加载每个脚本，绕过资源缓存。在加载某个扩展文件夹的第一个脚本之前，它先加载该文件夹 `plugin.cfg` 指定的脚本，就像编辑器先加载编辑器插件、再加载其扩展的其余部分一样。扩展文件夹是脚本路径上 `res://addons/` 之下第一个含有 `plugin.cfg` 的文件夹，因此嵌套在供应商文件夹中的扩展会像编辑器的插件搜索那样被找到。这次加载的每个错误都归入其所在文件对应的受检脚本，否则归入插件脚本；请求未包含该插件脚本时，报告会把它列在受检脚本之后。受检脚本自身加载时再次遇到的插件错误同样归入插件，因此每个错误只出现一次，干净的脚本保持干净。Dialogue Manager 等扩展依赖这一顺序：视图脚本使用其插件的类，而插件预加载视图的场景；若先加载视图脚本，就会在它仍在加载时经由该场景再次遇到它，Godot 会把它报告为不存在的资源。它不创建自动加载，也不打开场景，因此它运行的项目代码只有加载本身运行的代码：被加载脚本的静态初始化代码，以及项目声明为全局类的自定义资源加载器和保存器。它检查 `paths` 指定的文件和文件夹（`res://` 路径或相对于工作目录的路径），或检查项目的每个 `.gd` 文件，最多 400 个。不指定 `project` 时，它使用本 Session 当前或上一次运行的项目，否则使用最近的项目。它列出脚本加载期间 Godot 在 `res://` 文件中记录的错误和警告，因此预加载脚本中的错误会写明那个脚本；没有此类条目的脚本会得到第一个引擎错误（如果有）。这个 Godot 在报告完每个脚本之前结束或超过 `importTimeoutMs` 时，检查失败。引用单例自动加载的脚本与在游戏中一样进行检查，只是场景自动加载的类型为 `Node`，因此检查不会报告使用场景自动加载成员时的类型错误。

`godot_performance` 向游戏发送一个 `performance` 请求，并在 Host 上汇总其回答。harness 以一次主循环迭代开始到下一次开始的时间作为一帧，并用引擎信号为各阶段计时：物理从本次迭代的第一个 `physics_frame` 到 harness 的 `_process`，harness 自身的工作从那里到 `process_frame`，脚本与节点从 `process_frame` 到 `RenderingServer.frame_pre_draw`，绘制从那里到 `frame_post_draw`；其他是帧的其余部分，例如等待帧率上限。GPU 与渲染 CPU 时间来自根视口的渲染时间测量，采样期间开启，之后关闭；渲染器不报告 GPU 时间时，结果会说明。上游 Godot 的 Metal 驱动不采集 GPU 时间戳，因此在 macOS 上，只有 WASD Engine 从 `4.7.2-wasd.3` 起的 LibGodot 构建会报告 GPU 时间：它们的 Metal 驱动在时间戳之后的每个通道（pass）开始和结束时采样 GPU 时钟，一个时间戳读取它之前各通道中最晚的结束时间，与 Vulkan 的时间戳相同。每个内置 `Performance` 监视器在开始和结束时各读取一次，因此对象数显示其变化，管线编译计入采样期间发生的次数。普查从根节点遍历场景树，不含内部子节点，最多 200,000 个节点；节点可以处理且其处理已开启时计为处理中。一次采样最多记录 20,000 帧，之后的帧只计数。测量期间游戏照常运行：结果计入暂停的帧，harness 时间包含从 GPU 取得 Game 标签页流式传输的帧（随后由工作线程编码），Metal 上的无窗口运行最多以显示器的刷新率显示帧，关闭 VSync 时也是如此。百分位数采用最近秩法，尖峰指长于中位数两倍的帧。游戏在采样的秒数加上 `requestTimeoutMs` 的真实时间后提前结束采样，调用被取消时也会结束采样。

除非 `scripts` 为 false，采样随后再以同样的秒数，用 WASD Engine 的 LibGodot 构建中的脚本剖析器继续进行，它们为每个 GDScript 函数及函数调用的每个引擎方法计时。剖析器会拖慢脚本，因此它们只在测完帧之后运行，帧时间不受其影响。结果为每个脚本给出其每帧的自身时间：在其函数的代码以及这些函数调用的引擎方法中所花的时间，不含它们调用的脚本函数，后者计入各自的脚本，因此各脚本的时间之和就是全部 GDScript 的时间。它列出最耗时的八个脚本，每个脚本中最耗时的三个函数及其每帧调用次数、自身与总时间以及函数体开始的行号，以及每个函数中最耗时的两个引擎方法。harness 自身的函数不计入。没有剖析器时（例如上游的 LibGodot 构建），结果会说明。

`godot_audio` 向游戏发送一个 `audio` 请求。harness 在 Master 总线效果链的末尾加入一个 `AudioEffectCapture`，因此采集的是完整的混音，之后再把它移除；Master 总线在效果之后才应用其音量，因此宿主按 harness 报告的音量与静音（开始时以及每次变化）缩放采样。静音运行的 `Dummy` 音频驱动不向任何设备播放，但照常混音，因此它的音频也能采集。harness 每帧从 4 秒的缓冲区取出采集到的音频；游戏两帧之间卡顿更久时会丢失音频，结果会说明丢了多少。采集期间，harness 跟踪每个 `AudioStreamPlayer`、`AudioStreamPlayer2D` 和 `AudioStreamPlayer3D`（最多 500 个，包括进入场景树的），并报告开始播放的那些及其流、总线、音量、开始次数和时间，以及每条总线的音量、静音、独奏、旁路、发送目标、效果和最大峰值。宿主用 [`@deepseek-ai/dsh-game-audio`](../game-audio/README.zh.md) 的测量和图像测量这些采样，与“音频”标签页测量声音文件的方式相同，并找出高于 -50 dBFS 的片段，短于 150 毫秒的间隔会并入。事件像 `godot_input` 那样从采集开始处播放，采集结束时仍在运行的事件会被取消。采集在其秒数加上 `requestTimeoutMs` 的真实时间后提前结束。`ctx.godot` 和其他插件可以通过 `GodotRun.audio` 采集，其可选的停止信号会提前结束采集，并保留截至当时的音频。

结果文本不超过 6,000 个字符，被截断时以 `… (output shortened)` 结尾；引用的日志消息不超过 500 个字符。`godot_logs` 在达到文本上限之前结束本页，其下一个游标紧跟在最后一个列出的条目之后。

`godot_script` 会等待 `maxHeadlessProcesses` 中的一个空位，并等待该项目的其他导入步骤、检查和导出结束；在设置了 `importBeforeRun` 且项目自上次导入以来有改动时，它会像 `godot_check` 那样先导入项目，使此后新增的类名和资源可用，然后用解析出的运行时执行 `--headless --path <project> --script <res path> -- <args>`，用于 GUT 的 `res://addons/gut/gut_cmdln.gd` 等测试扩展的命令行运行器，以及构建或生成脚本。`script` 是 `res://` 路径或相对于工作目录的路径，必须是项目内的 `.gd` 文件。`args` 放在 `--` 之后传给脚本，脚本用 `OS.get_cmdline_user_args()` 读取。脚本退出或达到 `timeout_seconds`（默认 120，最多 900）时运行结束。LibGodot 不暴露引擎的退出码，因此脚本退出后运行器总是以 0 退出，无论它向 `quit()` 传了什么；结果会说明这一点，测试运行器的通过与失败要从其打印的汇总中判断。其他退出码表示运行器本身失败。结果保留标准输出和标准错误的最后 6,000 个字符以及此前省略的行数，以便保留运行器的汇总，并列出最多 20 个引擎错误，导入的错误在前。未给出 `project` 时，它使用 Session 当前或上一次运行的项目，否则使用最近的项目。与游戏一样，脚本以 Host 用户的全部权限运行。

<a id="views-and-recordings"></a>
### 视图、代码与录制

带 `region` 的 `godot_screenshot` 按窗口自身的像素捕获窗口中的这个矩形，单位是最新截图的像素，`coordinate_space` 为 `window` 时是窗口像素，因此人脸或文字等细小细节保留游戏绘制的每个像素。宽度小于 768 像素（或小于 `max_width`，取较小者）的区域，会按不超过该宽度的最大整数倍放大，最多 8 倍，每个窗口像素都是一个方块。之后，`godot_input` 以截图像素给出的鼠标坐标映射到该区域内。

`godot_view` 在游戏内部的一个 SubViewport 中绘制，它采用根视口的抗锯齿、缩放、细节层次和阴影设置（游戏可能在运行时修改它们），因此视图以任意尺寸（最大 4096 像素，与窗口大小无关）显示游戏自己的着色器、材质、灯光、环境，以及模型此刻由动画、AnimationTree 或代码给出的姿势。视图的相机采用游戏相机的投影、裁剪平面、层、环境、相机属性和合成器，然后：

- 指定 `node` 时，取景该 3D 节点下可见的几何体（不含粒子），从其朝向周围 `yaw` 度（0 表示看向其 +Z 一侧）、上方 `pitch` 度处观看，距离为恰好容纳它的距离乘以 `distance`；`bone` 取景该节点下 Skeleton3D 中这根骨骼周围 `radius` 米（默认 0.25）的范围，例如头部；`isolate` 在捕获之前给该节点的几何体和所有灯光加上渲染层 20，从而只绘制该节点，并由游戏的灯光照亮；
- 指定 `camera` 时，站在 `position` 并看向 `target`，均为世界坐标；
- 两者都不指定时，站在游戏相机所在的位置；
- 指定 `asset`（项目导入的 `res://` 场景、模型或网格）时，在一个独立的世界中单独实例化它，其中场景的脚本像在游戏中一样运行，并像在游戏中一样设置材质；把它的 AnimationPlayer 定格在 `animation` 的第 `time` 秒，并像节点一样通过 35 度镜头取景；默认的 `lighting: "studio"` 用中性的天空以及随相机移动的主光、补光和轮廓光照明，`"game"` 则使用游戏相机或世界的环境以及场景中定向光的副本。

视图在捕获之前绘制 8 帧，让时间性抗锯齿等时间性效果稳定下来，之后释放其 SubViewport；它只绘制 3D，因此 2D 游戏改用截图区域。

带 `code` 的 `godot_eval` 把代码编译为一个继承 `Node` 的独立脚本中某个函数的函数体，该脚本的成员 `tree`、`root`、`scene` 和 `node` 分别保存场景树、根窗口、当前场景以及 `node` 处的对象，因此代码可以声明同名的自有变量：先作为返回其值的单个表达式，再作为语句。代码可以声明变量、循环、调用 lambda、按名称使用引擎单例（例如 `Input`、`OS`、`ResourceLoader` 和 `RenderingServer`）与自动加载，并 `await` 信号，例如 `get_tree().process_frame`，因此设置捕获或测试无需修改游戏代码；代码运行期间，脚本的节点是根节点的内部子节点。编译错误和脚本错误会带着它们在代码中的行号返回；结果最多等待 `timeout_seconds` 让 await 中的代码完成，超时后调用失败，代码在游戏中继续运行。`expression` 也可以按名称使用引擎单例和自动加载。

`godot_record` 通过转发的 `godot/record` 请求，请一个可以读取该 Session 的 WASD Engine 窗口编码录制，没有窗口连接时立即失败。游戏录制期间，窗口从 `GET /api/godot.recording?session=<SessionId>&run=<runId>&recording=<id>` 读取帧：harness 像帧流那样不等待地从 GPU 复制每一帧，工作线程把它缩放到最多 `max_width` 像素（默认 1920）并以 `recordQuality` 编码为 JPEG，按实际时间每秒 `fps` 次（默认 30）。窗口解码这些帧，用 WebCodecs 编码为 H.264（浏览器没有 H.264 编码器时为 VP9），码率约为每像素 0.15 位，每 2 秒一个关键帧，写出采样时间等于各帧捕获时间的 MP4 文件，并在应答之前用 `POST /api/godot.video` 及同样的参数上传，应答附有一张拼图，含从第一帧到最后一帧均匀分布的 `sheet_frames` 帧，每帧标注其时间。宿主把上传的文件移到 `path`：工作目录或项目文件夹内的 `.mp4` 文件，或者项目 `recordings` 文件夹中以项目名称和时间命名的新文件；宿主会在该文件夹中写入 `.gdignore` 文件，使 Godot 不导入这些视频；除非设置了 `replace`，宿主拒绝覆盖已有文件。`events` 从录制开始时按 `godot_input` 的方式播放；录制结束时仍在播放的事件被取消，游戏会松开它们按住的键和按钮。

使用 `--fixed-fps` 的运行改为按游戏帧录制：每 `round(固定帧率 / fps)` 帧捕获一帧，不跳过任何一帧，每帧在视频中占同样多的游戏帧；`seconds` 计的是视频的秒数，录制会等待游戏绘制完这些帧，因此无论游戏绘制得快慢，影片都保持节奏，就像 Godot 的 Movie Maker 模式那样；`events` 仍按实际时间播放。实时录制在有六帧正在复制或编码，或有 48 MiB 消息等待连接时跳过一帧，结果会统计跳过的帧数；按游戏帧的录制则改为等待。录制算作对该运行的一次显示，因此无窗口游戏保持自身帧率。窗口必须在 `requestTimeoutMs` 内开始读取，宿主最多为窗口保留 `recordBufferBytes` 尚未读取的帧；超过时录制停止并失败。录制不含音频。

<a id="connected-agents"></a>
### 供已连接 agent 使用的工具

通过 WASD Engine 的 MCP 服务器 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 连接的本机 agent 从插件位于 [`src/mcp.ts`](src/mcp.ts) 的 provider 获得同样的十四个工具，它们由同一个 `godotToolDefinitions` 构建，区别有三点：

- 每个工具都接受 `project`：包含 `project.godot` 的文件夹、其上方至多三层的文件夹，或 `project.godot` 文件本身的绝对路径；省略时，调用沿用该 agent 上一次的项目，而在 agent 第一次调用之前会以 `Pass project: the absolute path of the folder that holds project.godot.` 失败。调用为该 agent 在这个游戏项目中自己的 Session 执行，MCP 服务器在首次使用时创建该 Session，因此运行、其日志与“游戏”标签页都属于这个 Session。
- `godot_run` 的描述说明游戏在 WASD Engine 窗口中播放；Session 自身的 `godot_check` 接受相对于工作目录的路径，这里改为接受绝对路径；`godot_logs` 读取 agent 上次读取之后的条目。
- 截图、视图和录制拼图以 PNG 或 JPEG 字节形式直接放在结果中返回，而不是为模型路由保存附件，也不检查模型；截图或截图区域请求的宽度，以及视图请求的尺寸，使图像最长边至多 1,568 像素、面积至多 1,150,000 像素，即 agent 无需缩放即可接收的尺寸。

`godot_run` 还会请 WASD Engine 窗口显示该 Session，随后其“游戏”标签页会为这次运行打开。provider 向 `search_game_tools` 报告运行时的就绪状态：`ready`；托管运行时安装期间为 `starting`；否则为带有运行时消息的 `unavailable`。它的指令以 `The godot_* tools run Godot 4.7: write code for it, and in a new project.godot, start config/features with "4.7" and set 3d/physics_engine="Jolt Physics" under [physics].` 结尾，写明与系统提示词部分相同的 Godot 版本；该部分不写明版本时，指令省略这句话。provider 为 `godot_screenshot`、`godot_view`、`godot_logs`、`godot_scene_tree` 与 `godot_performance` 加上 MCP 的只读提示，不为 `godot_check` 加，因为它的导入会写入项目，也不为 `godot_record` 加，因为它会保存视频。

<a id="game-tab"></a>
### “游戏”标签页

浏览器半侧在右侧栏中添加“游戏”标签页。从侧栏[引导页](../../client/ui-sidebar-right/README.zh.md#the-guide)的“游戏”卡片打开它。屏幕上的 Session 中有 agent 启动的运行正在进行时，只要页面未重新加载，标签页会自动打开，每次运行一次；用户之后切换到该 Session 时也会打开。关闭标签页会像 **停止** 一样停止 Session 的游戏，无论游戏由谁启动；折叠侧栏或切换到其他 Session 时，游戏继续运行。标签页跟随 Session 的游戏，无论由谁启动；没有活动 Agent 的 Session（例如宿主重启后）也是如此，在运行开始前它显示没有运行。

- **运行** 运行 Session 上一次运行所用项目的主场景，Session 还没有运行时则运行最近项目的主场景；Session 没有活动 Agent 时，它会像发送消息那样先恢复该 Session。有运行正在进行时，它显示为 **重新运行**，并以该运行启动时的场景和窗口大小再次运行项目。在有可用运行时之前，它处于禁用状态。
- **停止** 停止正在进行的运行。
- **暂停** 与 **继续** 暂停和继续运行中的游戏，**前进一帧** 让暂停的游戏前进一帧。
- **安装 Godot** 在运行时缺失或失败时出现。

状态区显示安装进度、运行的阶段、帧率、场景文件（悬停提示显示其 `res://` 路径）以及渲染器。宿主拒绝的操作会显示一条可关闭的消息，每个控件在其自身的请求进行期间保持禁用。另一个正在运行的 Web 或桌面端应用写入该 Session 时，**运行** 显示“此会话已在另一个正在运行的 Web 或桌面端应用中打开，请退出该应用后重试”。

游戏画面按比例适配标签页并在两侧留出边条，只在跟随流正在送达、标签页可见且游戏处于运行或暂停状态时显示游戏；此期间标签页持有该运行的 `view` 流，使无窗口游戏保持自身帧率并呈现其帧（[游戏运行](#game-runs)）。在 macOS 桌面应用中，画面显示游戏自身的画面：应用把无窗口游戏的图层放在页面之后，页面让游戏所在的矩形保持透明，因此游戏以完整分辨率和显示器的刷新率显示，不捕获、编码或解码任何帧。在 Web 应用、Windows 与 Linux 桌面应用中，以及桌面应用不显示其图层的运行，画面改为绘制最新推流的帧。点击游戏即可让画面获得焦点，这次点击也会送达游戏。获得焦点时，画面把已映射的按键发送给游戏，并阻止页面接收这些按键；未映射的按键、输入法组字，以及按住 Meta 键（Command 或 Windows 键）时的按键仍由页面和应用处理。用 AltGr 输入的字符（Windows 将其报告为 Ctrl+Alt）会带着其文本送达游戏；其他 Ctrl 组合键不带文本。在 Windows Desktop 上，画面获得焦点时 Ctrl+W 等应用快捷键不会执行，因此游戏会收到这些按键；在 macOS Desktop 上，带 Command 的组合键仍由应用处理。Esc 会送达游戏，因此游戏自己的暂停或设置菜单会像在游戏窗口中一样随 Esc 打开。Shift+Esc 从不送达游戏：它把键盘和鼠标交还给页面，画面获得焦点后的几秒内会显示“按 Shift+Esc 释放鼠标和键盘”。画面获得焦点时，图像上的鼠标按键、移动和滚轮步进以游戏窗口像素送达游戏，从图像上开始的拖动在移出图像后继续有效；没有焦点时，指针经过游戏不会让游戏移动。游戏捕获鼠标时，在图像上的下一次按下会把指针锁定在画面上；画面和窗口都有焦点时，捕获本身也会锁定指针，前提是浏览器此时允许锁定：刚点击过或按过 Esc 以外的按键之后，或者上一次锁定由页面结束之后。锁定后的移动以相对位移送达游戏；指针锁定之前，它经过游戏不会让游戏移动。游戏释放鼠标、画面或窗口失去焦点时，锁定结束。指针锁定期间，浏览器自己保留 Esc（无论带哪些修饰键），改为结束锁定；画面随后在 100 毫秒后把 Esc 发送给游戏并保持焦点，除非窗口在此期间失去焦点；按住 Shift 时，它会像按下 Shift+Esc 一样释放自己。失去焦点时，会释放画面按住的所有按键和按钮并结束锁定。

输入按批发送，每批最多 256 个事件，每次重绘一批，连续的鼠标移动会合并；下一批要等宿主接受上一批后才发送。宿主每次向游戏转发一批，排队超过 256 个时丢弃最早的事件。发给已结束运行的输入会被丢弃。一批输入因其他原因失败时，标签页记录一次失败，直到某一批再次成功，并在下一批中、或在画面失去焦点时，再次发送失败那一批中的按键和鼠标按钮释放，使游戏不会一直按住某个键或按钮。

画面下方的 **日志** 抽屉显示运行的错误数和警告数；展开后，最新的条目排在最前，并附有其 `res://` 文件和行号。标签页保留当前运行最新的 500 条，跟随流两次更新之间到达超过 200 条时，只会收到最新的 200 条。运行结束时，画面显示游戏是已退出、已崩溃还是无法启动，并附上退出码或信号以及引用的输出。跟随流在送达快照后结束时，标签页立即重新跟随该 Session，并保留最后的状态。跟随流在送达快照前停止时，标签页在 1 s 后重新跟随，延迟逐次加倍，最长 30 s，用户按 **重试** 时则立即重新跟随；在此期间，它在最后的状态上方显示“与游戏的连接已断开”和 **重试**，游戏画面既不推流也不接收输入。

在对话中，`godot_screenshot`、`godot_input` 和 `godot_wait` 的调用显示为“游戏截图”“游戏输入”和“等待游戏”行。行的摘要显示截图尺寸、结果的第一行、“失败”或“已停止”；展开后显示截图（点击可打开大图预览）和结果文本。其他 Godot 工具使用标准工具行。

<a id="remote-and-frames"></a>
### Remote 方法与帧路由

“游戏”标签页通过 `godot` Remote 命名空间调用宿主。除 `installRuntime` 外，每个方法的第一个参数都是 Session id，且都不需要活动 Agent：`follow`、`stop`、`control` 和 `input` 作用于该 Session 的运行，`run` 则会像提示词那样，先通过 `sessionController` 服务恢复没有活动 Agent 的 Session。

| 方法 | 返回 | 用途 |
|---|---|---|
| `follow(session)` | `GodotFollowItem` 流 | 先是一个 `snapshot`，包含运行、运行时状态、最新 200 条日志和日志游标，随后是 `run`、`logs` 和 `runtime` 项；读取方落后时各项会合并。没有活动 Agent 的 Session 没有运行（`null`），其 Agent 结束后也是如此，之后的 Agent 启动的运行会出现在同一个流中；流在调用被取消或插件卸载时结束 |
| `run(session, request)` | `GodotRunView` | 先恢复没有活动 Agent 的 Session，再用 `project`、`scene`、`width`、`height`、`muted`（默认 `false`）、`web`、`args` 和 `engineArgs` 启动或重启游戏；游戏启动后即返回，进度由跟随流报告；取消调用只会停止对已开始的恢复的等待 |
| `stop(session)` | 无 | 游戏结束后返回，Session 没有运行时以 `godot/not-running` 拒绝；取消调用只会停止等待 |
| `control(session, request)` | `GodotRunView` | `pause`、`resume`，或带 1 到 100000 个 `frames` 的 `step` |
| `input(session, runId, events)` | 无 | 为指定运行排队最多 256 个事件，不等待游戏处理 |
| `view(session, runId)` | `GodotViewItem` 流 | 流保持打开期间把指定运行计为一个显示，使无窗口游戏保持自身帧率并呈现其帧；显示计入后产出 `{ type: 'shown' }`，运行结束时结束，并以 `godot/not-running` 或 `godot/stale-run` 拒绝 |
| `installRuntime()` | `GodotRuntimeView` | 安装托管运行时，或加入正在进行的安装，并在其结束后返回 |

拒绝时使用以下代码：`godot/no-project`（附搜索的 `directory`）、`godot/runtime-unavailable`、`godot/not-running`、`godot/stale-run`（输入或视图所针对的运行已不是当前运行）、`godot/too-many-runs`（附 `limit`）、`godot/low-memory`（附可用内存不足的启动的 `availableBytes` 与 `requiredBytes`）、`godot/request-failed`（游戏拒绝了请求或没有应答），以及用于无效事件、大小或帧数的 `gateway/bad-request`。恢复失败的 `run` 带有 Session 控制器的代码，例如 `session/not-found`，或另一个宿主进程写入该 Session 时的 `session/writer-held`。LiveShare 把每个方法归为仅所有者可用，并把该命名空间排除在共享之外。

游戏画面读取 `GET /api/godot.frames?session=<SessionId>&run=<runId>`，这是一个只有所有者 Peer 能访问的 Connection 精确路由；插件在存在 `connection` 服务时注册它。缺少参数时路由返回 400，Session 中没有该 id 的活动运行时返回 404。否则它以 `application/octet-stream` 和 `Cache-Control: no-store, no-transform` 推流，直到运行结束或请求被中止。响应体是一系列记录：

| 偏移 | 字节数 | 字段 |
|---|---|---|
| 0 | 4 | 图像长度 `N`，无符号小端序 |
| 4 | 2 | 帧宽度（像素），无符号小端序 |
| 6 | 2 | 帧高度（像素），无符号小端序 |
| 8 | 4 | 运行内的帧序号，无符号小端序 |
| 12 | `N` | PNG 或 JPEG 文件的字节 |

`GET /api/godot.recording?session=<SessionId>&run=<runId>&recording=<id>` 与带同样参数的 `POST /api/godot.video` 以同样的条件为编码 [`godot_record` 录制](#views-and-recordings)的窗口服务。`GET` 按顺序流式发送录制的每一帧，不会相互替换，每条记录依次为 4 字节图像长度、4 字节帧序号、4 字节的该帧在视频中的毫秒数、2 字节宽度和 2 字节高度（均为无符号小端序），然后是 JPEG 文件；录制停止且读取方取走每一帧后结束；第二个读取方得到 409。`POST` 是单独的路由，请求体以流的形式到达；它接收视频，最大 `maxVideoBytes`，否则为 413，成功时应答 204。缺少这三个参数时两者都应答 400，录制不在进行中时应答 404。

harness 只在至少有一个帧响应打开时推流，帧率为 `streamFps`，宽度最多缩小到 `streamMaxWidth` 像素，推流的一帧只占用游戏主线程不到一毫秒。有 RenderingDevice 时（Forward+ 与 Mobile 渲染器都有），harness 请 GPU 复制一帧但不等待，复制结果在几帧后送达；兼容性渲染器，以及 8 位 RGBA 以外格式的帧（例如以高动态范围渲染的帧），改为同步读取。工作线程负责转换、缩放、加边条并编码各帧，下一帧的复制与上一帧的编码同时进行。发往 Host 的消息按顺序排队，并以连接能接收的速度发出，因此读取缓慢的一方不会拖住游戏；仍有较早的消息排队时，harness 不捕获新帧。帧是质量为 `streamQuality` 的 JPEG 文件。开启 `streamLossless` 时，只要准备一帧最多用一个帧间隔（1/`streamFps` 秒），帧就是无损 PNG 文件：每次推流先发送 JPEG 帧，对一帧的 PNG 测试跟得上后切换为 PNG，简单的 2D 场景和像素画通常如此；某个 PNG 帧用时更长时回到 JPEG 帧，大多数 3D 场景如此。试编码或 PNG 帧较慢后，下一次试编码在 1 s 后进行，延迟逐次加倍，最长 8 s。Godot 的 JPEG 编码器在任何质量下都以一半分辨率存储颜色，因此 PNG 帧保留文字和像素画清晰的彩色边缘，而 JPEG 帧会把它们模糊。读取方尚未取走上一条记录时到达的帧会相互替换，因此读取较慢的一方总能收到最新的帧。帧响应失败或结束时，“游戏”标签页在 250 ms 后重新打开它；在尝试未送达任何帧期间，延迟逐次加倍，最长 4 s。

<a id="web-export"></a>
### Web 导出

`ctx.godot.exportWeb({ projectDir, outputDir }, signal)` 为其他 Host 插件把项目导出为网页版，例如 [WASD Engine 插件](../wasd-plugins/README.zh.md)，其 `wasd_export_web` 与 `wasd_release_game` 工具会调用它；“游戏”标签页和 `godot_*` 工具不会调用。解析出的运行时启动一个无窗口的 Godot 进程，以预设 `WASD Engine Web` 运行 `--export-release`：使用不支持 GDExtension 的单线程 Web 发布模板，因此构建不需要跨源隔离，可以在任何嵌入它的页面中运行。Godot 只从项目的 `export_presets.cfg` 读取预设，所以导出会把该预设加到项目自身预设之后（项目预设保持原有顺序），并在之后恢复该文件的原始字节；若项目原本没有该文件，则删除它。导出会先清空 `outputDir`，导出到同一文件夹的两次导出依次进行。导出占用与 `godot_check` 共享的 `maxHeadlessProcesses` 个位置之一；电脑的可用内存少于 `minAvailableMemoryBytes` 时，导出不启动 Godot 并失败。结果列出各文件（`index.html`、`index.js`、`index.wasm`、`index.pck`、音频 worklet 与图标）及其大小，并附最多十条说明：桌面渲染器不是兼容性渲染器的项目（`rendering/renderer/rendering_method` 未设置时为 Forward+）在网页上使用兼容性渲染器，那里的着色器以 sRGB 值读取 `source_color` 纹理、场景深度的范围不同，SSAO、SDFGI、体积雾、TAA 和 FSR 等效果缺失，实例 uniform 能容纳的对象更少；数据包超过 100 MiB 时玩家要等待其完整下载；以及 Godot 的导出警告。没有写出页面、引擎或数据包的导出会失败，并附上 Godot 的错误行。

Godot 的网页运行时不绘制启动画面；只有页面的加载界面会在进度条上方显示启动图片，除非项目的 `application/boot_splash/image` 指定了自己的图片，否则该图片是 Godot 的标志。对于没有自己图片的项目，预设的 `html/head_include` 会加入一段隐藏该图片的样式，因此加载界面只在项目的 `application/boot_splash/bg_color` 背景上显示进度条；有自己图片的项目保留其图片。

Web 模板是 WASD Engine 构建的 Godot 单线程 Web 发布模板，修复了 Forward+ 游戏在 Web 上遇到的 Compatibility 渲染器限制：超过约 60 个物体时的实例 uniform、未过滤的 `SOFT_VERY_LOW` 阴影、`emit_particle()`，以及主线程等待着色器编译和帧缓冲检查（[构建说明](../../../wasdengine/web-template/BUILD.md)）。它的导出模板归档只包含该模板。第一次导出会用 HTTP 范围请求读取归档的 ZIP 目录，只下载 `webTemplateEntry`（约 10 MB），检查其大小、CRC-32 和 `webTemplateSha256`，并以 `templates/<sha256>.zip` 发布（约 40 MB，因为模板以不压缩方式存储，其摘要只取决于其中的文件）；同时进行的导出共享同一次下载。不响应范围请求的服务器会使导出失败，并提示设置 `webTemplatePath`。

<a id="web-check"></a>
### Web 检查

`ctx.godot.checkWeb({ outputDir, entry }, signal)` 以玩家遇到它的方式检查一个 Web 导出，供其他 Host 插件使用，例如 [WASD Engine 插件](../wasd-plugins/README.zh.md)，其 `wasd_export_web` 与 `wasd_release_game` 会报告检查结果。插件在 `127.0.0.1` 的随机端口上通过 HTTP 提供 `outputDir`，只响应对其中文件的 GET 和 HEAD 请求，并以 `--wasd-web-check=` 加一个 JSON 请求启动 `webCheckCommand` 指定的浏览器：请求包含 `entry`（默认 `index.html`）的 URL、1280x720 的页面、`webCheckSeconds`、`webCheckStartTimeoutMs`，以及浏览器自己的截止时间：它从浏览器启动时算起，比 `webCheckTimeoutMs` 早 10 s 结束，较短的 `webCheckTimeoutMs` 则取其一半。在桌面应用中，这个浏览器就是处于 Web 检查模式的应用本身（`apps/desktop/src/wasdengine-web-check.ts`）：它不申请单实例锁，不显示窗口、Dock 图标或菜单栏，把浏览器配置保存在一个用后删除的临时文件夹中，并在一个拥有独立 GPU 进程的离屏窗口中打开页面，因此耗尽 GPU 或内存的游戏不会影响应用。页面的任何操作都到不了屏幕上，也离不开它的构建：该模式与页面交互时不带用户手势，不给页面对话框、弹出窗口、全屏、打印、下载和任何权限，也不让它导航到其他源。在页面自身的脚本运行之前，它记录页面 50 ms 及以上的主线程任务；游戏启动后（Godot 的页面移除其 `#status` 加载遮罩时），它还记录每个动画帧的间隔和 WebGL 绘制调用，并保留页面的控制台输出。Godot 在游戏自身的加载之前就会移除遮罩，而游戏的加载可能让页面长时间卡住，因此检查在游戏绘制了 60 帧之后才开始观察：它丢弃此前的帧，在没有输入的情况下观察游戏运行 `webCheckSeconds`；从打开页面起，它最多等待 `webCheckStartTimeoutMs` 让游戏启动并绘制这些帧。随后它在 stdout 打印一行测量结果并退出，最晚在其截止时间退出；启动它的进程结束时，它立即退出。浏览器报告无响应的页面，或在等待时间内没有回应检查最后一次请求的页面，会被报告为无响应；到结束时仍未再回应的页面不附带帧，因为它冻结前绘制的帧已不能说明它的状况。插件校验这一行，并报告 Godot 何时启动游戏、游戏何时开始稳定绘制帧；页面最长的主线程任务以及持续一秒及以上的任务数；帧率（观察到的帧数除以其所用时间）和最慢的一帧；每帧绘制调用的中位数和最大值；页面链接的 WebGL 程序数；构建打印的不同错误和警告中的最多 12 条（Godot 的 `ERROR:` 和 `WARNING:` 消息不含其位置行，以及页面自身的错误），各附次数；以及用平实语言写成的发现：打开页面超过 20 s 后才稳定绘制帧，或在 `webCheckStartTimeoutMs` 内始终没有稳定绘制、单次卡顿 2 s 及以上或多次一秒的卡顿、每帧绘制调用中位数超过 1,500、帧率低于 30、页面进程结束、页面不再响应，以及表示 Web 构建缺少项目所用功能的 Godot 消息：超出 uniform 缓冲区的实例 uniform、`emit_particle()`、FogVolume 着色器、TAA 和 FSR。一次检查占用导出所用的 `maxHeadlessProcesses` 个位置之一并经过同样的内存检查；`webCheckCommand` 为空，或浏览器没有输出结果行就结束时，检查以 `GodotWebCheckError` 失败。WASD Engine 插件把报告转换成其工具结果中的文本。

<a id="desktop-export"></a>
### 桌面版导出

`ctx.godot.exportDesktop({ projectDir, platform, outputDir }, signal)` 为其他 Host 插件把项目导出为 `windows` 或 `macos` 版本，例如 WASD Engine 插件，其 `wasd_export_desktop` 与 `wasd_release_game` 工具会调用它。一个无窗口的 Godot 进程以预设 `WASD Engine Windows` 或 `WASD Engine macOS` 运行 `--export-release`，并在 `outputDir` 中写入一个 ZIP 文件，以去掉文件系统不接受字符的 `application/config/name` 命名，否则为 `Game.zip`：Windows 版是一个嵌入了游戏数据包并带有项目图标的 64 位 x86 `.exe`；macOS 版是游戏的通用应用包，适用于 Intel 与 Apple 芯片，经过临时签名、未经公证，其 bundle identifier 为 `com.wasdengine.game.<name>`，由游戏名称中的小写 ASCII 字母、数字和连字符组成。预设文件、输出文件夹、`maxHeadlessProcesses` 位置、内存检查和错误行都与 Web 导出相同。

桌面版构建只打包项目已导入的 VRAM 压缩纹理格式，而编辑器在 macOS 和 x86 主机上只导入 S3TC/BPTC，除非 `project.godot` 要求更多格式；Windows 构建需要 S3TC/BPTC，通用 Mac 构建同时需要 S3TC/BPTC 与 ETC2/ASTC。因此导出在运行期间把 `project.godot` 中的 `rendering/textures/vram_compression/import_s3tc_bptc`（macOS 还有 `import_etc2_astc`）设为 `true`，让其导入步骤补上缺少的格式，之后恢复这些设置；即使 `project.godot` 在导出期间被修改，也只把这些设置恢复为原来的值。补上的格式的导入文件留在项目的 `.godot` 文件夹中，可以省去下一次导出的工作。

每个平台的第一次导出会像 Web 导出下载自己的模板一样下载其模板：`windowsTemplateEntry` 约 38 MB，以 `templates/<sha256>.exe` 发布；`macosTemplateEntry` 约 123 MB，以 `templates/<sha256>.zip` 发布。

<a id="server-export"></a>
### 专用服务器导出

`ctx.godot.exportServer({ projectDir, outputDir }, signal)` 为其他 Host 插件把项目导出为 Linux x86_64 专用服务器，例如 WASD Engine 插件，它的发布会存储多人联机游戏的服务器构建。它以预设 `WASD Engine Server` 运行 `--export-release`，该预设的添加与移除方式与 Web 预设相同：这是一次专用服务器导出，会去掉每个资源的视觉部分、内嵌数据包，并写出一个可执行文件 `server.x86_64`，游戏服务器主机以 `--headless` 启动它。Linux x86_64 的 GDExtension 库会写在它旁边。导出会把该可执行文件设为可运行，与其他导出共享空位、内存检查和项目导入步骤的顺序，并返回可执行文件的大小、写出的每个文件以及最多十条说明。每个导出预设都包含 `res://wasd_multiplayer.cfg`，即 WASD Multiplayer 插件的配置；它不是资源，否则 Godot 会把它排除在外。

第一次专用服务器导出会像 Web 导出下载自己的模板一样下载其模板：`serverTemplateEntry` 压缩后约 28 MB，以 `templates/<sha256>.x86_64` 发布。

<a id="instance-groups"></a>
### 实例组

`ctx.godot.runInstances({ projectDir, instances, timeoutMs }, signal)` 为其他 Host 插件同时运行项目主场景的多个无窗口实例，例如 WASD Engine 插件的多人联机测试，它会运行游戏的服务器及其客户端。每个实例以 `--headless --path <project>` 运行，在 Host 的环境之上带有自己的环境变量，在各自的 `delayMs` 之后启动，并在实例组的截止时间停止；报告给出每个实例的退出码、是否超时，以及每个输出流的最后 20,000 个字符。当项目的导入数据可能过期时，实例组会先导入项目；它占用 `maxHeadlessProcesses` 中的一个空位以及该项目在导入顺序中的轮次；当它不请求任何实例，或请求的实例数超过电脑的上限（`maxInstances`，在较小的电脑上会按 `instanceMemoryBytes` 和 `instanceCores` 降低）时，它在启动任何实例之前就被拒绝。

### 供其他插件使用的录制

`ctx.godot.record(agent, request, signal)` 为其他 Host 插件录制某个 Agent 所在会话的游戏，例如 [WASD Engine 插件](../wasd-plugins/README.zh.md)的预览；“游戏”标签页和 `godot_*` 工具不会调用它。它在 `seconds` 秒的真实时间内（最多 30 秒）每隔 `frameMs` 毫秒截取一次窗口，每张宽度最多 `maxWidth`；请求给出 `frameQuality` 时为该质量的 JPEG（宽度较大时游戏编码 JPEG 比 PNG 快），否则为 PNG；同时从录制开始播放 `events`，并像 `godot_input` 一样校验这些事件；录制结束时仍在播放的事件会被取消，游戏会松开它们按住的输入。如果一次截取在下一个间隔开始之后才结束，紧接着就截取最新间隔的画面，因此各帧保持真实时间，并带有各自的截取时间。另一张宽度最多 `stillWidth` 的 PNG 截图会作为 `stillAt` 秒处的静态图，除非某一帧已经足够宽。录制会计为该运行的一次查看，因此无窗口的游戏保持自身的帧率，“游戏”标签页的帧流保持不变。当会话没有运行游戏，或运行的是 `project` 之外另一个项目的游戏时，录制会像 `godot_run` 一样先启动该项目的游戏（按 `agentRunsMuted` 决定是否静音），并让它运行 `startSeconds` 秒；设置 `stopStarted` 时，录制结束后会停止该游戏。结果包含各帧和静态图（各自标明图片类型）、窗口尺寸、录制是否启动了游戏，以及游戏是否在每一帧中都处于暂停状态。除非 `coordinateSpace` 为 `window`，指针坐标都是会话对运行中游戏的最近一张截图中的像素，因此需要启动游戏的录制会在启动之前拒绝这类坐标。

### 供其他插件使用的导入

`ctx.godot.importProject(projectDir, signal)` 为其他 Host 插件执行一次导入步骤，例如在安装扩展后导入项目的[游戏扩展](../game-addons/README.zh.md)：在 `maxHeadlessProcesses` 中的一个空位可用、且该项目的其他导入步骤、检查和导出结束之后，在 `importTimeoutMs` 内用解析出的运行时执行一次无界面的 `--import`，这也会加载项目已启用的编辑器插件。可用内存少于 `minAvailableMemoryBytes` 时它拒绝开始。它返回最多 20 个错误和警告，导入步骤未正常结束时附加一条警告；没有安装运行时则返回 undefined。“游戏”标签页和 `godot_*` 工具不会调用它。

### 项目中的 Blender 文件

Godot 的 Blender 场景导入器通过运行编辑器设置所指定的 Blender 可执行文件来转换 `.blend` 文件。在没有该可执行文件的无界面编辑器中，它的导入支持查询会失败，编辑器随即跳过项目中所有待处理的导入，而不只是 `.blend` 文件的导入。因此，在每个导入步骤（运行、检查、`godot_script` 与 `ctx.godot.importProject` 的导入步骤）之前，以及 Web 导出之前，只要编辑器的文件扫描会遇到 `.blend` 文件（即不在隐藏文件夹或含有 `.gdignore` 文件的文件夹中），插件就会在 `project.godot` 中关闭该导入器（`filesystem/import/blender/enabled=false`）。桌面编辑器在找不到 Blender 时也会提供同样的开关。这一更改会附带一条给智能体的说明：运行日志中来自导入步骤的一条警告、检查的导入警告、导入报告的第一条警告，以及 Web 导出的第一条警告。Godot 从不运行 Blender；模型以 [Blender 工具](../blender/README.zh.md)导出的 `.glb` 文件进入项目。

<a id="data-directory"></a>
### 数据目录中的文件

| 路径 | 内容 | 生命周期 |
|---|---|---|
| `payload/<hash>/wasd_harness.gd`、`payload/<hash>/wasd_check.gd` | harness 与检查脚本在 Desktop 应用归档之外的副本；`<hash>` 是脚本 SHA-256 的前 16 位十六进制数字 | 脚本不变时复用；旧版本保留 |
| `runtime/<runtimeVersion>/` | 托管运行时：runner、LibGodot 库和 `runtime.json` | 保留；新的 `runtimeVersion` 会安装在它旁边 |
| `runtime/.download-<id>.tar.gz`、`runtime/.staging-<id>/`、`runtime/<runtimeVersion>.lock` | 进行中安装的归档、解压出的文件和写入锁 | 安装结束时删除 |
| `templates/<sha256>.zip`、`templates/<sha256>.exe`、`templates/<sha256>.x86_64` | 下载的 Web、macOS、Windows 和 Linux 服务器导出模板，各自以其固定的 SHA-256 命名 | 保留；新的 SHA-256 会在旁边另行下载 |
| `templates/.download-<id>.<ext>`、`templates/<sha256>.<ext>.lock` | 进行中的模板下载及其写入锁 | 下载结束时删除 |

插件不会在 `dataRoot` 下写入其他内容；截图进入附件存储，导出写入调用方指定的文件夹。

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面上的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，`package.json` 以 `icon` 字段指向该文件。该文件把 Godot Engine 标志（版权所有 © 2017 Andrea Calabró）原样嵌入 36 × 36 画布，只添加了 `viewBox` 以便缩放：源文件是 [Godot 仓库](https://github.com/godotengine/godot)中 Godot 4.7.2 的 `misc/logo/icon.svg`，也见于 [Godot 媒体资料包](https://godotengine.org/press/)。该标志以[知识共享署名 4.0 国际许可协议（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/)授权，不受本仓库的许可证覆盖。Godot 与 Godot 标志是 Godot Foundation 的商标，此处依其[商标政策](https://godot.foundation/policies-and-procedures/trademark-policy)用于标识 Godot 集成。WASD Engine 与 Godot Foundation 没有关联，也未获其认可。“游戏”标签页、它的引导条目与 Godot 工具卡片仍使用本包自己的游戏手柄图形。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本包有宿主侧与 Client 侧两部分。宿主侧是 `godot` 服务，一个 Typert Remote 服务：其构造函数校验配置，注册工具和提示词部分，并在存在 `connection` 服务时注册帧路由。它拥有一个运行时管理器，负责解析和安装运行时，并把运行时视图发布给每个跟随流；还拥有一个以活动 Agent 为键的每 Session 状态注册表，其中包括当前运行、日志与新错误游标，以及最新截图的帧；该注册表还保存每个 Session id 的跟随流，它们比 Agent 存在得更久。同一个 Session 的启动与停止依次进行。它还拥有项目导入记录：同一项目的导入步骤、检查和 Web 导出由它逐个执行，它还记住每个项目最近一次以退出码 0 结束的导入的开始时间。

一次运行拥有它的导入进程、回环监听器、游戏进程和计时器，并在结束时全部释放。[harness 协议](../../../docs/subsystems/gamedev.zh.md#harness-protocol)定义了运行与 harness 交换的消息：令牌握手、请求及其应答、状态、日志、帧和截图图像。

Client 侧先挂载生成的 `godot` Remote，再挂载 UI；撤下时先撤 UI，再撤 Remote。每个 Session 有一个跟随源，在有读取方期间把跟随流折叠为标签页的状态。游戏画面用 `fetch` 读取帧路由，用 `createImageBitmap` 解码最新的记录：图像以 PNG 文件签名开头时按 PNG 解码，否则按 JPEG 解码，并在下一次重绘时绘制它。

在 macOS 桌面应用中，页面具有 `dshDesktop.gameLayer`；harness 通过 LibGodot 的 macOS 嵌入式显示服务器启动的运行会报告其绘制所用的图层，即 `GodotRunView` 的 `layer`：一个 CAContext id，以及每个图层点对应的游戏窗口像素数。此类运行处于活动状态且标签页可见时，游戏画面不打开帧响应，而是请桌面应用显示该图层，适配到画面中且边缘对齐设备像素；应用显示图层后，画面用遮罩从应用根元素 `#root` 中挖去同一矩形，使页面在那里透明；与裁剪路径不同，遮罩不影响命中测试，因此挖空区域下的画面仍能接收指针。在根元素旁边 portal 到 `document.body` 的浮层，例如菜单、提示、通知和对话框，绘制在游戏之上；画面的焦点环和提示也由 portal 到那里的一个框绘制在画面上方。画面会跟踪自己的边框：画面或窗口尺寸改变、或页面任意位置发生指针拖动时，画面在每次重绘时放置图层与挖空区域，直到边框连续 10 次重绘保持不变；每 500 ms 一次的检查会发现其他移动。桌面应用回复无法显示图层时，画面改为推流该运行的帧。[桌面应用中的游戏图层](../../../wasdengine/FORK.md#game-layer-in-the-desktop-app)介绍桌面侧的实现。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 宿主插件：配置、提示词部分、Remote 方法和帧路由 |
| [`src/runtime.ts`](src/runtime.ts) | 运行时解析、托管安装和运行时视图 |
| [`src/runs.ts`](src/runs.ts) | 每 Session 状态、运行替换、运行数上限和每次启动的准入 |
| [`src/slots.ts`](src/slots.ts) | 同时运行的脚本检查与 Web 导出的位置 |
| [`src/run.ts`](src/run.ts) | 单次运行：导入步骤、启动、握手、请求、日志、帧、音频采集、无人显示的游戏的帧率与呈现，以及关闭 |
| [`src/protocol.ts`](src/protocol.ts) | harness 连接上的消息分帧与校验 |
| [`src/tools.ts`](src/tools.ts) | 工具声明、结果文本和新错误报告 |
| [`src/performance.ts`](src/performance.ts) | 性能采样的回答、带脚本剖析的汇总及其文本 |
| [`src/audio.ts`](src/audio.ts) | 音频采集的回答、Master 音量、含有声音的片段、汇总及其文本，以及 WAV 文件 |
| [`src/check.ts`](src/check.ts) | 静态脚本检查及其之前的导入 |
| [`src/imports.ts`](src/imports.ts) | 运行、检查、脚本与其他插件的导入步骤，同一项目的导入步骤、检查与 Web 导出的执行顺序，以及项目自上次导入以来是否有改动 |
| [`src/command.ts`](src/command.ts) | 运行到结束并收集输出的 Godot 命令：导入步骤、检查、导出以及实例组中的每个实例 |
| [`src/export.ts`](src/export.ts) | Web、桌面版与专用服务器的导出预设和导出 |
| [`src/export-template.ts`](src/export-template.ts) | 从导出模板归档中下载单个模板项，用于 Web、Windows、macOS 与 Linux 服务器模板 |
| [`src/instances.ts`](src/instances.ts) | 带有各自环境的无窗口实例组 |
| [`src/script.ts`](src/script.ts) | `godot_script` 运行与供其他插件使用的导入报告 |
| [`src/record.ts`](src/record.ts) | 供其他插件使用的录制：请求、其取值范围与截取时钟 |
| [`src/project.ts`](src/project.ts) | 项目搜索、`project.godot` 设置和 `res://` 路径 |
| [`src/blender-import.ts`](src/blender-import.ts) | 在含有 `.blend` 文件的项目中关闭 Blender 导入器 |
| [`src/input.ts`](src/input.ts)、[`src/logs.ts`](src/logs.ts) | 输入校验与截图坐标；日志环形缓冲区及其游标 |
| [`src/follow.ts`](src/follow.ts)、[`src/frames.ts`](src/frames.ts) | 跟随流和帧路由 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：Remote、“游戏”标签页、工具卡片和自动打开 |
| [`src/client/GameTab.tsx`](src/client/GameTab.tsx) | “游戏”标签页正文：工具栏、游戏画面和日志抽屉 |
| [`src/client/input.ts`](src/client/input.ts)、[`src/client/frames.ts`](src/client/frames.ts) | 键盘与鼠标捕获；帧的读取与绘制 |
| [`src/client/layer.ts`](src/client/layer.ts) | macOS 桌面应用显示的图层：其适配矩形、应用根元素的挖空区域，以及对画面边框的跟踪 |
| [`runtime/wasd_harness.gd`](runtime/wasd_harness.gd) | 游戏内 harness |
| [`runtime/wasd_check.gd`](runtime/wasd_check.gd) | `godot_check` 的脚本加载器 |

### 用真实运行时验证

在仓库根目录运行端到端测试套件，并把 `WASD_LIBGODOT_DIR` 设为包含 `godot_runner` 与 LibGodot 库的文件夹，库使用 `wasdengine/libgodot/build.sh` 安装时的文件名 `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`，例如已安装的 macOS 或 Linux 运行时。它检查一个从未导入过、脚本相互使用对方 `class_name` 类的项目，导入一个测试项目并运行（在 macOS 上无窗口运行），调用截图、输入、等待、日志、求值、场景树、性能、控制、检查和停止工具，在“游戏”标签页的视图打开与关闭时跟踪游戏的呈现，读取帧路由，运行第二个项目（其拉伸模式会给游戏加上黑边），并用 `godot_audio` 采集第三个项目的音调；在 WASD Engine 自己的运行时上，还会检查 GPU 时间与脚本剖析。未设置该变量时，测试套件会被跳过。

```sh
WASD_LIBGODOT_DIR="$HOME/.wasdengine/godot/runtime/4.7.2-wasd.3" \
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

插件加载时在全局工具层注册 15 个工具，因此无论是否存在 Godot 运行时或项目，只要 Agent 的工具集没有排除它们，Agent 就能看到：`godot_run`、`godot_stop`、`godot_screenshot`、`godot_input`、`godot_wait`、`godot_view`、`godot_record`、`godot_control`、`godot_eval`、`godot_scene_tree`、`godot_performance`、`godot_audio`、`godot_logs`、`godot_check` 和 `godot_script`，其名称、描述和参数 schema 由 [`src/tools.ts`](src/tools.ts) 声明。唯一随配置变化的文本是 `godot_run` 中 `muted` 的描述 `Run without audio. Default: <agentRunsMuted>.`

#### Token 影响

默认配置下，14 个声明合计约 15,200 个字符的 JSON（含名称），进入每个提供这些工具的请求；其中 `godot_view` 与 `godot_input` 最大，各约 2,500 个字符。

#### KV Cache 影响

同一配置总是生成相同的声明，并在第一个请求之前注册，因此工具定义前缀保持稳定。修改 `agentRunsMuted` 会改变 `godot_run` 的声明，禁用该行会移除全部 14 个声明；任一变化都可能从第一个变化的定义开始使缓存复用失效。

### 系统提示词中的 Godot 部分

#### 模型可见内容

插件在 `TOOL_COMPUTER_USE` 位置对应的顺序上注册一个名为 `godot` 的全局系统提示词部分，文本如下；该部分是静态的，因此即使 Agent 的工具集排除了 Godot 工具，它也仍在该 Agent 的提示词中。第一段写明 `runtimeVersion` 开头的 Godot 版本（默认为 `4.7`），自带运行时与托管运行时都必须与之一致。设置了 `libgodotPath` 与 `runnerPath`，或 `runtimeVersion` 不以 `major.minor` 版本开头时，该段不写明版本，改为 `Godot is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. Do not look for one or download one. For a new game, first write project.godot, whose [physics] section sets 3d/physics_engine="Jolt Physics", a main scene, and its scripts.`。两种形式都让新游戏的 `project.godot` 在 `[physics]` 下设置 `3d/physics_engine="Jolt Physics"`：Godot 4.6 及更高版本默认使用 Jolt，只是因为编辑器的项目管理器会把该键写入它创建的项目；没有该键时 Godot 运行 GodotPhysics3D，在它之下 SoftBody3D 会穿过静态碰撞体。

##### Godot 部分文本

```markdown
# Godot games

Godot 4.7 is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. Do not look for one or download one. Write code for Godot 4.7. For a new game, first write project.godot, whose config/features starts with "4.7" and whose [physics] section sets 3d/physics_engine="Jolt Physics", a main scene, and its scripts.

Test a Godot project with the godot_* tools:
1. godot_run starts or restarts the game and reports import and startup errors.
2. godot_screenshot shows the current frame. godot_input sends keys, text, mouse clicks and motion (in screenshot pixels), and input actions; godot_wait lets game time pass. Look again after acting.
3. godot_logs reads printed output and errors; godot_eval and godot_scene_tree inspect the running scene; godot_performance measures frame times, rendering, memory, and the time of each script; godot_audio captures and measures the game's audio mix; godot_control pauses, resumes, or steps frames.
4. Fix the first error, then call godot_run again. godot_check finds GDScript errors without running the game.
5. Captures and tests need no changes to the game: godot_run takes launch options (args, engine_args), godot_eval runs GDScript code, godot_view draws any camera at any size or a scene alone, and godot_record saves video.
The user can watch and play the running game in the Game panel.

Released games play in browsers, where Godot draws with its Compatibility renderer (WebGL 2) whatever renderer the project uses. Start new games on it, with renderer/rendering_method="gl_compatibility" under [rendering] in project.godot, so they look the same everywhere; run a game on another renderer with godot_run web: true to see it as players will. A Web export ends with a Web check of the build in a browser: fix the freezes and errors it reports.
```

#### Token 影响

插件加载期间，该部分为每个系统提示词增加 1863 个字符；不写明 Godot 版本时为 1789 个字符。

#### KV Cache 影响

文本固定不变，并从第一个请求起就存在，因此系统提示词保持稳定；启用或禁用该行会增加或移除该部分，可复用的前缀有多长由[系统提示词的缓存规则](../../core/system-prompt/README.zh.md#model-experience)决定。

### 工具结果、截图与新错误报告

#### 模型可见内容

每个结果包含一个最多 6,000 个字符的文本块；`godot_screenshot`，以及带 `screenshot: true` 的 `godot_input` 或 `godot_wait`，另附一个 PNG 图像块，以附件 `godot-frame-<frame>.png` 保存；`godot_view` 附一张 PNG 图像 `godot-view-<frame>.png`，`godot_record` 附一张 JPEG 拼图 `godot-recording-sheet.jpg`（`sheet_frames` 为 0 时不附），文本写明模型收到的图像尺寸，`godot_input` 的鼠标坐标以它为准；事件或等待之后的截图失败时，文本改为给出原因。每个结果和每条失败消息的末尾都附有本 Session 上一次 Godot 调用以来记录的错误级条目：`New errors since your last Godot call:`，最多 10 行 `[<level>, <source>] <file>:<line> (<function>): <message>` 形式的条目（省略缺失的部分和 `game` 来源），还有更多条目时附上 `… and <n> more; read them with godot_logs.`。失败以 `Error: <message>` 的形式送达模型，说明接下来应调用什么，并在崩溃或启动失败后引用进程输出的最后 20 行；没有运行时时，`godot_run` 与 `godot_check` 以下面的消息失败。导入未正常结束的 `godot_check` 的结果以 `The Godot import step before the check ended abnormally (<exit>), so errors about class_name classes or imported assets may be false.` 开头，或者其中的 `ended abnormally (<exit>)` 换成 `did not finish within <seconds>`。

##### 缺少运行时的消息

```markdown
No Godot runtime is installed. Install the WASD Engine Godot runtime from the Game panel, or set libgodotPath and runnerPath in the Godot plugin configuration.
```

#### Token 影响

参数、结果文本和图像在对话中保留，直到压缩（compaction）。插件限制每个结果的文本为 6,000 个字符、每条引用的日志消息为 500 个字符、新错误报告为 10 条、`godot_logs` 每次调用最多 1,000 条（默认 200 条）、`godot_scene_tree` 最多 5,000 个节点（默认 400 个）；每张截图增加一张图像，宽度最多为 `max_width` 像素（默认 1280），并按模型路由的图像请求目标进一步调整尺寸；每个视图增加一张 `width` 与 `height` 大小的图像（默认 1280x720），每次录制增加一张最宽 1,536 像素的拼图。

#### KV Cache 影响

仅追加：调用及其结果接在现有请求前缀之后，不会使其失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制描述 Godot 运行、“游戏”标签页和运行时当前的不足。

- **游戏以宿主用户的全部权限运行** — 游戏、导入步骤和 `godot_check` 作为宿主的普通子进程运行。Session 权限模式（例如 `read-only` 或 `workspace-write`）的[沙箱](../../sandbox/sandbox-policy/README.zh.md)不约束它们，它们也从不像 `bash` 命令那样请求[批准](../../interaction/user-approval/README.zh.md)。`godot_run` 启动的游戏代码、`godot_check` 加载的脚本，以及 `godot_eval` 运行的表达式和代码（它们可以运行包括 `OS.execute` 在内的任意 GDScript），都能读写宿主用户可访问的所有文件并启动其他程序。`project` 接受绝对路径或工作目录之外的路径，因此 `godot_run` 和 `godot_check` 会运行宿主用户可读取的任何项目。
- **托管运行时需要已发布的版本** — **安装 Godot** 从 `runtimeManifestUrl` 指定的 GitHub 发布版本下载 manifest 和归档，默认是 `WASDEngine/WASD-Engine` 的 `libgodot-4.7.2-wasd.3`。[LibGodot 运行时工作流](../../../wasdengine/libgodot/BUILD.md#release)必须先发布该版本；在此之前，安装会以 manifest 的 HTTP 状态失败，无法访问 GitHub 的宿主需要设置 `runnerPath` 与 `libgodotPath`。
- **只有三个平台** — 发布工作流构建 macOS arm64、Linux x64 和 Windows x64。在其他平台上（例如 Intel Mac），安装会因 manifest 中没有对应构建而失败，游戏只能通过 `runnerPath` 与 `libgodotPath` 指定的本地 LibGodot 构建运行。
- **macOS 以外会打开窗口** — LibGodot 补丁只在 macOS 上实现无窗口渲染。在 Linux 与 Windows 上，每次运行（包括每次 agent 运行）都会在宿主的桌面上打开游戏窗口。
- **“游戏”标签页不支持手柄** — 标签页只转发键盘和鼠标输入，因此连接在浏览器所在计算机上的手柄无法控制游戏；agent 可以用 `godot_input` 发送手柄按钮和摇杆事件。
- **JPEG 帧会模糊彩色边缘** — 当准备一个 PNG 帧用时超过 1/`streamFps` 秒，或 `streamLossless` 关闭时，场景推流 JPEG 帧，“游戏”标签页中彩色文字等细小的饱和色细节会比游戏中更柔和：Godot 的 JPEG 编码器在任何质量下都以一半分辨率存储颜色。
- **帧为游戏窗口的像素尺寸** — “游戏”标签页把窗口的像素（宽度最多 `streamMaxWidth`）适配到标签页中。在高密度显示器上，标签页覆盖的屏幕像素多于窗口的像素时，帧会被放大，看起来比按显示器密度渲染的游戏窗口更柔和。macOS 桌面应用显示的图层同样具有窗口的像素，应用以相同方式缩放它。
- **应用根元素内的页面内容会透出游戏** — 在 macOS 桌面应用中，根元素让游戏所在的矩形保持透明，因此应用在 `#root` 内绘制在游戏画面上方的内容，例如右侧栏的浮动窗格，或拖动标签页时的放置提示，在覆盖该矩形的部分会透出游戏。portal 到 `document.body` 的浮层绘制在游戏之上。
- **图层可能比布局变化晚一次重绘** — 画面通过桌面应用的主进程放置图层，而页面自行移动挖空区域，因此在侧栏或窗口改变尺寸时，游戏可能比页面边缘晚一次重绘，图层后的黑色会在其边缘露出。
- **音频只在宿主上播放** — “游戏”标签页不带声音。游戏音频通过宿主机器的音频输出播放，因此另一台计算机上的浏览器听不到声音，agent 的运行默认静音。
- **LiveShare 查看者看不到游戏** — LiveShare 把每个 `godot` 方法归为仅所有者可用，并把该命名空间排除在共享之外，帧路由对非所有者 Peer 返回 403，因此查看者既不能观看也不能游玩。
- **每个 Session 一个游戏** — “游戏”标签页中的 **运行** 和 `godot_run` 会相互替换对方的运行，宿主在所有 Session 中最多同时运行运行上限个游戏。
- **隐藏的游戏继续运行** — 没有“游戏”标签页显示的游戏会一直运行到停止：最后一次被显示或使用后的 `hiddenDelayMs` 内以自身帧率（最高为屏幕刷新率）运行，之后以 `hiddenFps` 运行，因此仍会占用一些处理器与图形处理时间；运行上限限制了这样的游戏数。Linux 与 Windows 上有窗口的游戏从不受限，并且总是呈现其帧。内存检查只针对启动：游戏启动后若继续增长，不会被停止。
- **“游戏”标签页显示的游戏仍共享 GPU 与窗口服务器** — 没有显示的游戏会停止呈现，但两个“游戏”标签页同时显示的两个游戏都会呈现，繁忙的游戏仍会让另一个卡顿。只渲染不呈现的游戏仍占用 GPU 时间，因此另一个游戏的帧可能变慢，但不会卡顿。
- **脚本剖析与 Metal 的 GPU 时间需要 WASD Engine 的运行时** — 除 WASD Engine 从 `4.7.2-wasd.3` 起的构建之外的 LibGodot 构建（例如 `runnerPath` 与 `libgodotPath` 指定的构建）没有不依赖调试器的脚本剖析器，在 macOS 上也没有 GPU 时间戳；这时 `godot_performance` 只报告帧时间，并说明原因。剖析器只为 GDScript 计时，其自身开销会拉长它报告的时间，因此这些时间用于在脚本之间比较，而不是与帧时间比较。
- **音频采集取 Master 总线的立体声混音** — 采集位于 Master 总线效果链的末尾，因此 Master 总线旁路其效果时得到的是静音，采集期间替换总线布局的游戏会在那里中断采集的音频；结果会说明这两种情况。在环绕声扬声器模式下，Master 总线的每个声道对都会写入采集，采集会把它们交错在一起，因此其音频不是立体声混音。
- **Web 运行不是浏览器** — `web: true` 的 `godot_run` 使用桌面 OpenGL 驱动渲染，其限制大于浏览器中的 WebGL，例如 uniform 缓冲区为 64 KB，而 Apple GPU 上的 Chrome 只允许 16 KB；它还以原生代码在多个线程上运行，因此既不会显示实例 uniform 溢出，也不会显示浏览器单线程造成的卡顿；这些由 [Web 检查](#web-check)报告。
- **Web 检查需要桌面应用，且只看到启动阶段** — 只有桌面应用提供检查所用的浏览器，因此在其他环境中 `wasd_export_web` 和 `wasd_release_game` 会报告检查无法运行。检查在没有输入的情况下只观察游戏开头的 `webCheckSeconds`，因此会漏掉只有在玩家操作之后或后续关卡中才出现的问题；其离屏页面还要把每一帧从 GPU 复制回来，这会多花几毫秒，而浏览器标签页没有这部分开销。
- **导入只在同一宿主内相互等待** — 宿主逐个执行同一项目的导入步骤、检查和 Web 导出，但另一个宿主或 Godot 编辑器在此期间导入同一项目时，会同时写入其导入数据。
- **删除文件不会触发检查前的导入** — 检查在项目文件发生变化或新增后才导入，因此在下一次导入之前，预加载已删除资源（其导入副本仍在）的脚本会通过检查，而使用已删除脚本的 `class_name` 类的脚本虽然检查失败，但错误消息与游戏显示的不同。
- **游戏脚本逐个加载** — 在 `res://addons/` 之外，检查会先于游戏本会先加载的其他内容加载每个脚本，因此若某个脚本经由其使用的类遇到一个预加载的、带有该脚本本身的场景，它会被报告为不存在的资源，即使游戏先加载那个类、从不会遇到这个错误。
- **“游戏”标签页的输入排在 agent 的输入之后** — 游戏一次只执行一个输入序列，因此 agent 的序列（例如 `{ "wait": 30 }`）执行期间，来自“游戏”标签页的按键和点击要等该序列结束才送达游戏，最迟在其实际时间时限结束时。
- **在 Windows Desktop 上，游戏画面中的应用快捷键暂停** — 画面获得焦点期间，任何应用快捷键或菜单加速键都不会执行，直到按 Shift+Esc 或点击其他位置释放焦点。
- **按住 Shift 时按 Esc 会释放游戏画面** — 画面把按住 Shift 时按下的 Esc 视为 Shift+Esc，因此用 Shift 奔跑的游戏在玩家奔跑时收不到 Esc；指针锁定期间，Esc 在按键 100 毫秒后才送达游戏。
- **不支持 C# 脚本** — WASD Engine 的 LibGodot 构建时不含 .NET，因此 C# 脚本无法加载，插件也从不改用 .NET 版 Godot 编辑器。
- **仅支持 Web、Windows、macOS 与 Linux 服务器导出** — [`exportWeb`](#web-export)、[`exportDesktop`](#desktop-export) 与 [`exportServer`](#server-export) 通过 WASD Engine 插件的工具导出网页版、64 位 x86 Windows 版、Mac 版和 Linux x86_64 专用服务器；`godot_*` 工具不导出任何内容，Linux 桌面版、ARM 版 Windows 与移动端导出需要同一版本的 Godot 编辑器及其导出模板，由 Agent 在 shell 中运行，桌面版构建也没有发布者签名。
- **实例组共享 Host 的上限** — 一个实例组算作一个无窗口进程，其中的实例不是游戏运行，因此“游戏”标签页从不显示它们，运行上限也不计入它们；实例组改由 `maxInstances` 以及电脑的内存和处理器限制。
- **不检查配置的运行时的版本** — harness 与检查脚本继承 Godot 的 `Logger` 类并读取 `ScriptBacktrace` 帧；`runnerPath` 与 `libgodotPath` 指定的 LibGodot 构建若缺少这些类，则无法启动运行。
- **harness 会替换自定义主循环** — 运行通过 `--script` 传入 harness，因此 `application/run/main_loop_type` 指定了自有 `SceneTree` 或 `MainLoop` 类的项目会改由 harness 运行。
- **“游戏”标签页可能显示过时的运行时状态** — 标签页在开始跟随某个 Session 时以及安装之后解析运行时，因此标签页打开期间手动添加或删除的运行时目录，要等标签页再次跟随某个 Session 后才会反映出来，例如刷新页面后。
- **录制需要带 WebCodecs 的 WASD Engine 窗口** — `godot_record` 在已连接的 Desktop 或 Web 窗口中编码，因此没有窗口连接时，或在没有 WebCodecs `VideoEncoder` 的浏览器中，它会失败。录制不含音频；游戏慢于其 `fps` 时，实时录制会跳过帧，`--fixed-fps` 可保留每一帧。
- **视图只在运行中的游戏内绘制 3D** — `godot_view` 需要运行中的游戏和 3D 世界；绘制 `asset` 时使用项目对它的导入，因此文件改动后尚未重新导入的项目会绘制旧的导入结果；它还会运行资源场景的脚本，这些脚本可能依赖游戏的其余部分。`isolate` 在视图的若干帧期间给节点的几何体和所有灯光加上渲染层 20，因此使用第 20 层或在此期间读取层的游戏会看到这一变化。
- **游戏运行期间窗口无法变大** — macOS 嵌入式显示服务器拒绝游戏发起的窗口缩放，因此更大的窗口需要用 `godot_run` 并指定 `width` 和 `height`；`godot_view` 无需更大的窗口即可以任意尺寸绘制。
- **截图需要支持图像的路由** — 在不支持图像输入或没有附件存储的模型路由上，`godot_screenshot` 和 `screenshot` 选项会失败，agent 在那里无法看到游戏；`godot_input` 和 `godot_wait` 会在执行操作之前失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
