# 游戏工具

[English](gamedev.md) | 中文

fork 自有的 [`packages/gamedev/`](../../packages/gamedev/README.zh.md) 包组让 agent（智能体）用 Blender、GIMP 与 SuperCollider 制作游戏素材，并运行、测试和游玩 Session 的 Godot 游戏。Blender、GIMP 与 SuperCollider 在 MCP 服务器之后无窗口运行；每个服务器把自己的工具提供给每个 Session，并为每个调用这些工具的 Session 运行一个长期运行的应用工作进程。Godot 通过 LibGodot（从不通过已安装的 Godot 编辑器）把每个 Session 的游戏作为独立进程运行，为 agent 提供原生 `godot_*` 工具，并把游戏画面推送到右侧 Sidebar 的 Game 标签页，用户在其中观看和游玩。一个专门的 MCP 服务器把同样的工具提供给这台电脑上的其他 agent（例如 Claude Code 或 Codex），它们的游戏在同一个 Game 标签页中播放。本页说明这些包如何相互连接，以及它们的进程之间交换的格式；配置、工具目录、模型可见文本与限制由各包的 README 说明。

## 组成

WASDEngine 的 patch 文件 [`game-tools.cordis.patch.yml`](../../packages/bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 是 `@deepseek-ai/dsh-web-app` 组合包 `dsh.bundle.patch` 列表的最后一项，因此每个 Web 与 Desktop profile 都会插入其中的各行：下表中的四个工具行、挂载[「游戏工具」标签页](#game-tools-tabs)且不接受配置的 `ui-game-tools`，以及[供其他 agent 使用的 MCP 服务器](#mcp-server-for-other-agents) `game-mcp` 与其浏览器部分 `ui-game-mcp`。每个工具行只设置 `dataRoot`，值为 `dshHomePath('<row>')`：该行在 harness 主目录下的文件夹，即 `~/.wasdengine/<row>`；设置了 `DSH_HOME` 时为 `$DSH_HOME/<row>`。profile patch 用 `- id: <row>` 和 `disabled: true` 关闭某一行，「插件」页面「游戏工具」标签页上的开关写入的也是这一条目。[FORK.md](../../wasdengine/FORK.md#game-tools) 记录这项 fork 改动，以及合并上游后需要检查的内容。

| 行 | 包 | agent 工具 | 应用进程 |
|---|---|---|---|
| `blender` | [`@deepseek-ai/dsh-blender`](../../packages/gamedev/blender/README.zh.md) | MCP 服务器 `wasd_blender` 提供的 `mcp__wasd_blender__<tool>` | 每个调用的 Session 一个 Python 工作进程：托管虚拟环境中的 `bpy` 模块，或以后台模式运行的已安装 Blender |
| `gimp` | [`@deepseek-ai/dsh-gimp`](../../packages/gamedev/gimp/README.zh.md) | MCP 服务器 `wasd_gimp` 提供的 `mcp__wasd_gimp__<tool>` | 每个调用的 Session 一个 GIMP 3 `gimp-console` 进程，以 Python 批处理命令运行工作进程 |
| `godot` | [`@deepseek-ai/dsh-godot`](../../packages/gamedev/godot/README.zh.md) | 原生 `godot_*` 工具与 `godot` 系统提示词分节 | 每个 Session 一个游戏进程：承载 LibGodot 的 `godot_runner` |
| `supercollider` | [`@deepseek-ai/dsh-supercollider`](../../packages/gamedev/supercollider/README.zh.md) | MCP 服务器 `wasd_supercollider` 提供的 `mcp__wasd_supercollider__<tool>` | 每个调用的 Session 一个带有一个 sclang 的桥接进程，sclang 为每次渲染离线运行 scsynth：Desktop 应用自带的运行时，或已安装的 SuperCollider |

激活时不安装、不下载，也不启动任何应用。Blender、GIMP 与 SuperCollider 行只启动各自的 MCP 服务器进程，由它在第一次工具调用时启动应用；Godot 行只在工具或 Game 标签页请求时才启动游戏；需要缺失应用的调用会失败，并给出安装步骤。三个 MCP 服务器都构建在库 [`@deepseek-ai/dsh-app-mcp`](../../packages/gamedev/app-mcp/README.zh.md) 之上。它的 `materializePayload` 把包交给应用的每个脚本复制到 `<dataRoot>/payload/<digest>/<file name>`，其中 `<digest>` 是内容 SHA-256 的前 16 位十六进制数字。之所以需要复制，是因为打包后的 Desktop 应用把包文件放在 `app.asar` 内，只有 Electron 的 `fs` 能够读取；Godot 包用该函数复制自己的两个 GDScript 文件。MCP 服务器名称带有 `wasd_` 前缀，以便与用户自行配置的 `blender`、`gimp` 或 `supercollider` 服务器区分。fork 内置的 `godot-project` skill（技能）会在 `godot_*`、`mcp__wasd_blender__*`、`mcp__wasd_gimp__*` 与 `mcp__wasd_supercollider__*` 工具存在时引导 agent 使用它们。

| 进程 | 启动方 | 结束时机 | 通信对象 |
|---|---|---|---|
| Blender、GIMP 或 SuperCollider 的 MCP 服务器，即在 Host 可执行文件下运行的包内构建产物 `lib/worker.js`，源码启动时则是通过 tsx 运行的 `src/worker.ts` | MCP 客户端，依据插件注册的服务器条目启动 | MCP 客户端关闭连接时，例如插件被 dispose（资源释放）之后 | 通过 stdio 与 MCP 客户端通信；通过 stdin 与文件描述符 3 与其工作进程通信 |
| Blender、GIMP 或 SuperCollider 工作进程 | MCP 服务器，在 Session 第一次发现该 Session 没有运行中工作进程的工具调用时启动 | 自行退出、服务器关闭，或服务器因超时、协议违规、调用被取消、`workerIdleTimeoutMs` 内没有调用而停止它，或为另一个 Session 的工作进程腾出位置而停止它时 | 与其 MCP 服务器通信；SuperCollider 工作进程还与其 sclang 通信 |
| sclang，以及渲染期间的 scsynth | SuperCollider 工作进程在启动时启动 sclang；sclang 为每次渲染通过 shell 运行 scsynth | sclang 在工作进程关闭其输入、代码让它退出，或工作进程的进程组被停止时结束；scsynth 在其渲染结束时结束 | sclang：通过标准输入与输出和工作进程通信；scsynth：无，sclang 读取其输出文件与日志 |
| Godot 游戏 | `ctx.godot` 通过 `ctx.subprocess` 启动，每次运行一个 | 运行被停止或游戏退出时；连接关闭时 harness 脚本也会退出游戏，`godot_runner` 会随 Host 进程一起退出 | 通过一条回环 TCP 连接与 `ctx.godot` 通信 |
| Godot 导入步骤或脚本检查 | `ctx.godot`，在运行之前以及每次 `godot_check` 调用时启动 | Godot 完成时，或 `importTimeoutMs` 到期后 | 无；`ctx.godot` 读取其输出 |

## 应用 MCP 服务器

Blender、GIMP 与 SuperCollider 采用相同的进程模型，由 `@deepseek-ai/dsh-app-mcp` 实现：

1. Host 插件调用 `registerAppMcpPlugin`，它检查插件的路径设置，并在插件生命周期内向 `ctx.mcpManager`（[MCP](mcp.zh.md)）注册一个 stdio 服务器条目。该条目用 Host 自身的可执行文件运行包的服务器入口（在 Desktop 应用中，`ELECTRON_RUN_AS_NODE=1` 使该可执行文件以 Node 运行；源码启动注册 TypeScript 入口时则通过 tsx 运行），并把插件配置作为一个 base64url JSON 参数传入。
2. 服务器入口调用 `runAppMcpServer`。服务器进程响应 MCP 工具发现时不会启动应用，因此无论应用是否已安装，工具都会列出。MCP 客户端以 `mcp__<server>__<tool>` 公开这些工具，并把服务器的说明加入系统提示词。
3. 服务器列出一项实验性能力，使 Host 的 MCP 客户端在每次工具调用中注明发起调用的 Session；子 agent 以自己的 Session 发起调用，未注明 Session 的调用（例如通过[供其他 agent 使用的 MCP 服务器](#mcp-server-for-other-agents)连接的 agent 的调用）共用一个工作进程。Session 的第一次工具调用会准备应用、把工作进程脚本复制出包，并在 `<dataRoot>/workers/` 下该工作进程自己的文件夹中为该 Session 启动一个工作进程；Blender 可能先用 uv 安装 `bpy` 模块，GIMP 使用其所有工作进程共用的 GIMP 配置目录，SuperCollider 则在工作进程的文件夹中使用用户目录与类库配置。`WorkerPool` 为每个 Session 提供一个 `WorkerSupervisor`，它针对该 Session 的工作进程及其应用状态逐个执行该 Session 的调用，不同 Session 的工作进程同时运行。工作进程逐个启动。`workerIdleTimeoutMs` 内没有调用的工作进程会停止；运行中的工作进程达到 `maxWorkers` 个时，新 Session 的第一次调用会停止最久未使用且没有运行调用的工作进程，若每个工作进程都在运行调用，则以 `WORKERS_BUSY` 失败；被停止工作进程的 Session 会在下一次调用时得知状态已丢失。关于启动的信息（例如应用版本或首次使用时的安装）会出现在该 Session 下一个工具结果的文本之前。
4. 每个工具向同名的工作进程方法发送一个请求，并把回复转换为文本和图像。工作进程报告的异常不会影响工作进程及其状态。调用期间发生超时、协议违规或退出时，工作进程会被停止，该调用失败并说明工作进程的状态已丢失；工作进程在两次调用之间退出，或正在运行的调用被取消时，下一次调用不会执行，而是以同样的消息失败。该 Session 之后第一次实际执行的调用会启动新的工作进程。
5. stdin 关闭、MCP 传输因 stdout 写入失败或收到的消息超出读取缓冲区而自行关闭，或者收到 SIGTERM 或 SIGINT 时，服务器停止其所有工作进程并退出；重复的信号不会中断这一关闭过程。

[app-mcp README](../../packages/gamedev/app-mcp/README.zh.md#use-this-package) 负责说明注册字段、结果上限、错误码与重启规则。

### 工作进程协议

服务器与其工作进程使用协议 1：每行一个 UTF-8 JSON 对象，请求写入工作进程的 stdin，回复写入其文件描述符 3。工作进程的 stdout 与 stderr 只承载应用日志，服务器保留其中最新的 `maxLogBytes` 字节，用于失败消息。

```text
stdin  request  {"id": <integer>, "method": "<method>", "params": {<parameters>}}
fd 3   ready    {"ready": true, "protocol": 1, "app": "<blender, gimp, or supercollider>", "version": "<application version>", "python": "<Python version>"}
fd 3   success  {"id": <integer>, "ok": true, "result": <JSON value>}
fd 3   failure  {"id": <integer>, "ok": false, "error": {"type": "<exception class>", "message": "<text>", "traceback": "<text>"}}
```

- 就绪行必须最先出现在 fd 3 上，并在服务器的就绪期限内到达：Blender 为 `startupTimeoutMs`，GIMP 与 SuperCollider 为 `readyTimeoutMs`。`python` 写明 Blender 与 GIMP 工作进程的 Python 版本；SuperCollider 工作进程省略该字段。工作进程若先退出、写出其他内容或保持沉默，服务器会杀死它，调用以 `WORKER_START_FAILED` 失败。
- 服务器一次只写一个请求，从 1 开始编号，并等待携带该 id 的回复；`traceback` 可选。不是有效回复的行、针对其他 id 的回复，或超过 32 MiB 的行，都会使服务器停止工作进程。
- 方法名就是工具名，只是 `analyze_audio` 发送 `decode_audio`。每个工作进程还都响应 `shutdown` 并随后退出，stdin 关闭时也会退出；Blender 工作进程还响应 `ping`。
- 失败回复报告工作进程在处理请求时捕获的异常，工作进程继续运行。`execute_python` 把 agent 代码抛出的异常放在成功回复中报告，再由工具转换为错误结果。
- `execute_python` 运行 agent 的代码时，Blender 与 GIMP 工作进程都会把 `sys.stdin` 替换为空流，使代码无法读走请求，并在回复中返回代码捕获的 Python 输出。
- 在 POSIX 上，工作进程是其进程组的组长。服务器停止工作进程时，先发送 `shutdown` 请求并关闭 stdin，各宽限期过后再依次向进程组发送 SIGTERM 与 SIGKILL；工作进程无论何时退出，服务器都会向该进程组发送 SIGKILL，以结束工作进程遗留的进程。在 Windows 上，服务器用 `taskkill /T /F` 结束工作进程的进程树。

| | Blender 工作进程 | GIMP 工作进程 |
|---|---|---|
| 脚本 | [`wasd_blender_worker.py`](../../packages/gamedev/blender/py/wasd_blender_worker.py) | [`wasd_gimp_worker.py`](../../packages/gamedev/gimp/py/wasd_gimp_worker.py) |
| 命令 | 使用 `bpy` 模块时为 `<environment python> -I -u <script>`，否则为 `<Blender> --background --factory-startup -noaudio --python-exit-code 1 --python <script>` | `<gimp-console> -n -s -c --batch-interpreter=python-fu-eval -b 'import runpy; runpy.run_path("<script>", run_name="__main__")' --quit`，并把 `GIMP3_DIRECTORY` 设为 `<dataRoot>/profile` |
| 请求 | 直接从文件描述符 0 读取，因为 Blender 可能替换 `sys.stdin` | 由 GIMP 的 Python 插件进程读取，该进程继承 stdin 与 fd 3 |
| 退出 | 在 `shutdown` 回复之后执行 `os._exit(0)`，因为某些导出器运行之后，Blender 可能在其退出处理程序中崩溃。stdin 在没有 `shutdown` 请求的情况下结束，或 fd 3 不再有读取方（工作进程中的线程每秒检查一次，请求期间也会检查）时，说明服务器已不存在：工作进程若是进程组的组长，就用 SIGKILL 终止整个进程组，否则直接退出 | 脚本返回，GIMP 通过 `--quit` 退出。在 POSIX 上，插件进程未完成就结束时，一个看门狗进程会杀死 GIMP，因为 GIMP 会继续运行并保持 fd 3 打开 |

<a id="supercollider-bridge"></a>
### SuperCollider 桥接进程

sclang 从终端输入读取命令，也无法捕获其代码输出的文本，因此 SuperCollider 工作进程是位于上述协议与一个 sclang 子进程之间的桥接进程。桥接进程就是服务器入口本身，以 `argv[2]` 中的桥接计划（与服务器选项一样是 base64url JSON 对象）和 `argv[3]` 中的 `--sclang-bridge` 运行。sclang 以 IDE 模式运行，按各自以 ESC（0x1b）结尾的块读取标准输入，其 `XDG_CONFIG_HOME` 与 `XDG_DATA_HOME` 位于 `<dataRoot>/home/` 之下，并使用加入工作类 [`WasdWorker.sc`](../../packages/gamedev/supercollider/sc/WasdWorker.sc) 的类库配置。由于 sclang 字符串字面量最多容纳 8,191 字节，参数通过 `<dataRoot>/scratch/` 中的 JSON 文件传递；回复是 sclang 输出中的行，每行另起一行并以 32 位随机十六进制数字组成的 token 开头：

```text
stdin of sclang   WasdWorker.boot("<token>", "<boot parameters file>")<ESC>
stdout of sclang  <token> READY {"version": "<SuperCollider version>", "helpSource": "<folder>"}
stdin of sclang   WasdWorker.dispatch(<id>, "<method>", "<parameters file>")<ESC>
stdout of sclang  <token> END <id> {"ok": true, "result": {<fields>}}
stdout of sclang  <token> END <id> {"ok": false, "error": {"type": "<error class>", "message": "<text>", "traceback": "<text>"}}
```

- 收到 `READY` 之后，桥接进程写出协议的就绪行，其中 `app` 为 `supercollider`，并带上版本。`READY` 之前的输出留在日志中；在此之前出现的 `ERROR: Command line parse failed` 行表示工作类没有加载，桥接进程随即结束。
- 桥接进程一次发送一个请求。方法名含有小写字母、数字与下划线以外的字符，或字符串含有 NUL 字符时，由桥接进程自己以失败回复。工作类读取每个参数文件后将其删除，在 AppClock 上的 Routine 中运行该方法的处理方法，并在一个换行之后输出回复。
- sclang 在两个回复之间输出的文本属于后一个回复：桥接进程把它作为 `output` 加入结果，或加入失败的 `traceback`，最多保留 20,000 个字符（前后各一半），并去掉一个结尾换行以及每个 `<name> : setting clientID to <n>.` 行。
- 回复了未在等待的请求、回复不是上述形式的 JSON，或在另一个请求等待期间发来请求，都会使桥接进程以退出码 1 结束；sclang 退出时，桥接进程以 sclang 的退出码结束。
- 渲染通过 sclang 的 shell 运行 `exec <scsynth> -N <score> _ <float WAV> <sample rate> WAV float <options> > <log> 2>&1`，对 Desktop 应用自带的运行时还会带上 `-U <plugins>`；工作类输出日志中除 scsynth 启动与数据包提示以外的各行。

## Godot 运行

`ctx.godot` 是 `@deepseek-ai/dsh-godot` 默认导出的 `GodotController` 服务，拥有 Host 的所有游戏运行。它为每个存活的 Agent 保留一个当前运行，因此每个 Session 都有自己的游戏；已有 `maxRuns` 个运行尚未结束时，它会拒绝启动新的运行，已关闭 Session 的运行在其游戏进程结束前一直计入。同一 Session 的启动与停止逐个执行，启动会先停止该 Session 的当前运行，再启动下一个。dispose 某个 Agent 会停止其运行，此后该 Session 没有运行，直到之后的 Agent 启动一个；dispose 插件会停止所有运行，结束所有 follow 流，并取消正在进行的运行时安装。`godot_*` 工具与 Game 标签页的 `godot` Remote 作用于同一组运行。

### 运行时解析

运行会启动第一个能够解析的运行时：

1. 已配置的 `runnerPath` 与 `libgodotPath`。
2. Desktop 应用在该包 `libgodot/<platform>-<arch>/` 目录中附带的运行时（打包后的应用从 `app.asar.unpacked` 读取），前提是其 `runtime.json` 的格式为 1，所写的版本、平台与架构与当前一致，且其中指定的 runner 与库文件都存在。
3. `<dataRoot>/runtime/<runtimeVersion>/` 中的托管运行时，前提相同。

Desktop 打包时会填充 `libgodot` 目录，详见 [Desktop 应用中的 LibGodot](../../wasdengine/FORK.md#libgodot-in-the-desktop-app)；源码检出和 npm 安装中没有该目录。已配置但不是可用文件的路径属于配置错误，绝不会被跳过。插件从不启动 Godot 编辑器，因为编辑器会在窗口中运行游戏。没有任何运行时可以解析时，`godot_run` 与 `godot.run` 会失败，其消息会指出 Game 标签页的安装操作以及上述设置。

每个 Godot 进程都以 `godot_runner --libgodot <library> --parent-pid <Host process id> -- <Godot arguments>` 启动：runner 承载其进程可以持有的唯一一个 Godot 实例，并在 Host 进程退出时退出。在 macOS 上，游戏的参数包含 `--embedded`，使其无窗口渲染；在 Linux 与 Windows 上，游戏会打开窗口。

`godot.installRuntime` 安装托管运行时。它从 `runtimeManifestUrl` 获取发布 manifest（元数据清单），其 `version` 必须等于 `runtimeVersion`；按 Node 的命名取 `<platform>-<arch>` 对应的产物（例如 `darwin-arm64`），下载时校验其大小与 SHA-256，用 `tar` 解压到暂存文件夹，写入 `runtime.json`，再在文件锁下把该文件夹重命名到位。并发调用方会加入同一次安装，运行时视图会报告安装进度。[BUILD.md](../../wasdengine/libgodot/BUILD.md) 说明 runner、LibGodot 补丁，以及运行时如何构建和发布。

<a id="run-lifecycle"></a>
### 运行生命周期

| 阶段 | 含义 |
|---|---|
| `preparing` | 运行已创建，尚未开始导入步骤或启动 |
| `importing` | 导入步骤正在运行 |
| `starting` | 游戏进程正在运行，`ctx.godot` 等待 harness 握手 |
| `running`、`paused` | harness 脚本已连接；由其最新的 `status` 消息，或暂停、恢复、单步请求的回答决定处于哪一种 |
| `exited` | 终态：运行被停止，或游戏以退出码 0 退出 |
| `crashed` | 终态：握手之后进程以其他方式结束，或在关闭连接后仍运行了 `stopGraceMs` |
| `failed` | 终态：启动在握手之前结束 |

通过 `godot_run` 或 `godot.run` 启动时，依次执行以下步骤；`godot.run` 会先恢复没有存活 Agent 的 Session。握手之前的失败会使运行以 `failed` 结束；其 `message` 说明失败原因，并引用游戏进程输出的最后至多 20 行。

1. 查找项目：`project` 参数，即相对于 Session 工作目录的文件夹或 `project.godot` 路径；未给出时，在工作目录下至多三层文件夹内，按名称顺序广度优先查找最浅的 `project.godot`，并跳过 `.git`、`node_modules`、`.godot` 与 `.agents`。`scene` 必须指向已存在的 `res://` 文件，或是 `uid://` 引用。
2. 解析运行时，把 `wasd_harness.gd` 与 `wasd_check.gd` 复制出包，停止该 Session 的当前运行，并检查运行数量上限。
3. 设置了 `importBeforeRun` 时，在 `importTimeoutMs` 内运行 `--headless --path <project> --import`。其中以 `ERROR:`、`SCRIPT ERROR:`、`SHADER ERROR:` 与 `WARNING:` 开头的行会成为 `import` 日志条目；非零退出会追加一条警告，说明导入的资源可能不完整，启动继续进行。
4. 在 `127.0.0.1` 的临时端口上监听，并生成一个由 32 位十六进制数字组成的令牌。
5. 在项目文件夹中用下方的 Godot 参数启动游戏，不带 `ELECTRON_RUN_AS_NODE`，stdout 与 stderr 各至多收集 `processOutputBytes` 字节。
6. 在 `startTimeoutMs` 内，harness 脚本按 [harness 协议](#harness-protocol)所述连接并完成认证，运行随即变为 `running`。

```text
--path <project> [--embedded] --script <wasd_harness.gd> [--audio-driver Dummy] [--resolution <width>x<height>]
  -- --wasd-port=<port> --wasd-token=<token> [--wasd-scene=<scene>]
```

`--audio-driver Dummy` 使运行静音。agent 启动的运行默认静音，除非调用另行指定，或关闭了 `agentRunsMuted`；Game 标签页启动的运行会播放音频，除非其请求设置了 `muted`。

`godot_stop`、`godot.stop`、重启与 dispose 以相同方式停止运行：`ctx.godot` 发送 `quit`，至多等待 `stopGraceMs` 让进程退出，然后中止进程，由子进程服务终止它，并在进程消失后才结束。

<a id="harness-protocol"></a>
### harness 协议

[`runtime/wasd_harness.gd`](../../packages/gamedev/godot/runtime/wasd_harness.gd) 是游戏的主循环，即由 `--script` 加载的 `SceneTree` 脚本。它打开 `--wasd-scene` 或项目的主场景，照常加载 autoload，在游戏暂停时继续处理，通过 `Logger` 捕获每条打印的消息与引擎错误，并为 `ctx.godot` 提供一条回环 TCP 连接。该脚本从其 payload 副本运行，位于项目之外。两个方向的消息都使用以下分帧格式：

```text
message   u32 LE length N (1 to 64 MiB), then N bytes: u8 kind, payload
kind 1    UTF-8 JSON object                                            both directions
kind 2    u32 LE seq, u16 LE width, u16 LE height, PNG or JPEG bytes   harness to Host: a streamed frame
kind 3    u32 LE request id, PNG or JPEG bytes                         harness to Host: a screenshot image
```

- harness 连接 `127.0.0.1` 上由 `--wasd-port` 指定的端口，并首先发送 `hello`。在连接出示本次运行的令牌之前，`ctx.godot` 在该连接上只接受至多 64 KiB 的消息；收到 `token` 经恒定时间比较相符的 `hello` 以外的任何内容，都会销毁该连接；它按读取每条消息时生效的上限衡量该消息，因此同一次读取中 `hello` 之后的消息可以使用 64 MiB 的上限。`protocol` 不同的 `hello` 会使启动失败。
- 握手完成后，`ctx.godot` 关闭监听器与其他所有连接。
- 连接关闭或写入失败时，harness 会退出游戏。

| `type` | 字段 | 发送时机 |
|---|---|---|
| `hello` | `protocol`（1）、`token`、`pid`、`godot`（Godot 版本字符串）、`project`（`application/config/name`）、`mainScene`、`displayServer`、`renderingDriver`、`renderingMethod`、`width`、`height` | 最先发送，仅一次 |
| `status` | `frame`、`fps`、`paused`、`scene`（当前场景的 `res://` 文件，或为空）、`mouseMode`、`width`、`height`、`droppedLogs` | 每秒一次，以及当前场景或鼠标模式发生变化的那一帧 |
| `logs` | `entries`，每项含 `level`、`message`、`time_ms`，以及已知时的 `file`、`line`、`function`、`code`，和由 `function`、`file`、`line` 组成的 `backtrace` 帧 | 每个有新条目的帧；连接建立之前记录的条目在连接打开后发送 |
| `result` | `id`、`ok`、`ok` 为 false 时的 `error`，以及该请求的结果字段 | 回答请求时 |

harness 日志记录器至多保留 4,000 条未发送条目，超出时丢弃最旧的条目，并在 `droppedLogs` 中计数。其级别为：打印的消息使用 `stdout` 与 `stderr`，引擎错误使用 `error`、`warning`、`script_error` 与 `shader_error`。

`ctx.godot` 以 kind 1 对象发送请求，每个请求带有 `type` 与整数 `id`，`id` 在每次运行内从 1 开始编号：

| `type` | 参数 | 结果字段 | `ctx.godot` 中的期限 |
|---|---|---|---|
| `stream` | `fps`（0 表示停止；至多 60）、`quality`（JPEG 质量，0.1 到 1）、`maxWidth`（64 到 4,096）、`lossless`（PNG 编码跟得上 `fps` 时发送 PNG 帧） | `fps`、`quality`、`maxWidth`、`lossless` | `requestTimeoutMs` |
| `screenshot` | `format`（`png` 或 `jpeg`）、`maxWidth`、`quality` | `format`、`width`、`height`、`windowWidth`、`windowHeight`、`frame`、`paused`，以及一张带请求 id 的 kind 3 图像 | `requestTimeoutMs` |
| `input` | `events`，见[输入事件](#input-events)；可选的 `timeoutMs` | `events`、`frames`、`seconds`（实际时间）、`frame`、`timedOut`、`cancelled` | 无；agent 的序列携带 `timeoutMs`，即其等待时间、按每秒 10 帧计的每个等待一帧与开始的一帧，再加上 `requestTimeoutMs`；Game 标签页的输入不携带 |
| `pause`、`resume` | 无 | `paused`、`frame` | `requestTimeoutMs` |
| `step` | `frames`（1 到 100,000）；可选的 `timeoutMs` | `frames`、`seconds`、`frame`、`paused`、`timedOut`、`cancelled` | 无；它携带 `timeoutMs`，即按每秒 10 帧计的帧数加上 `requestTimeoutMs` |
| `wait` | `frames` 或 `seconds`；可选的 `timeoutMs` | `frames`、`seconds`、`frame`、`paused`、`timedOut`、`cancelled` | 无；它携带 `timeoutMs`，即其秒数（或按每秒 10 帧计的帧数）加上 `requestTimeoutMs` |
| `eval` | `expression`、`node` | `value`、`valueType` | `requestTimeoutMs` |
| `tree` | `node`、`depth`（0 到 64，默认 6）、`maxNodes`（1 到 5,000，默认 400） | `tree`、`truncated` | `requestTimeoutMs` |
| `cancel` | `request`，即待处理的 `wait`、`step` 或 `input` 请求的 id | `cancelled` | 不等待 |
| `quit` | `exitCode` | `quitting` | 不等待 |

- 被拒绝的请求以 `ok: false` 回答，并附带 `error` 文本；未知的 `type` 会被拒绝。
- 没有期限的请求，在 `ctx.godot` 等待期间若 harness 连续 `requestTimeoutMs` 没有发送任何内容，仍会失败；帧、状态与日志都算作活动。`ctx.godot` 放弃一个等待、单步或输入请求时（因为其调用方已中止，或 harness 已沉默），除非运行正在停止，否则会发送带该请求 id 的 `cancel`。
- 截图回答在其 JSON 结果与图像都到达后才算完整，两者顺序不限。截图与帧以像素尺寸显示游戏窗口：根视口位于项目的拉伸模式与宽高比放置它的位置，窗口显示黑边的地方为黑色，因此在完整尺寸下，图像像素就是同一位置的窗口像素。harness 随后把图像缩小到宽度至多 `maxWidth` 像素，并以每秒实际时间至多 `fps` 帧推流，游戏暂停或 `Engine.time_scale` 为 0 时也是如此。
- `step` 让游戏恢复运行，运行指定的帧数，然后暂停它；`pause`、`resume` 或更新的 `step` 会以 `cancelled: true` 结束正在进行的单步，游戏在 `pause` 之后保持暂停，在其余情况下保持运行。`wait` 计入其到达之后运行的帧，而其 `seconds` 只计入未暂停的游戏时间，该时间受 `Engine.time_scale` 缩放。带 `timeoutMs` 的 `wait`、`step` 或 `input` 请求在其到达后经过这么多毫秒的实际时间时结束，以 `timedOut: true` 回答已运行的部分；以这种方式结束的单步会暂停游戏。`cancel` 以同样的方式、以 `cancelled: true` 结束 id 为 `request` 的待处理请求，并以 `cancelled` 回答是否有这样的请求在等待。运行到结束的请求把 `timedOut` 与 `cancelled` 都回答为 false。
- `eval` 以输入 `tree`、`root` 与 `scene`（当前场景）解析 Godot `Expression`，并在 `node` 上运行；未给出 `node` 时在当前场景上运行。
- `ctx.godot` 以 `id` 0 发送 `quit`，并且不等待其回答。

<a id="input-events"></a>
### 输入事件

`GodotInputEvent` 是一个以游戏窗口像素为坐标单位的输入事件。`godot_input` 工具、`godot.input` Remote 方法与 harness 共用它。

| 事件 | 字段 | harness 中的效果 |
|---|---|---|
| `key` | `key`，即 Godot 的 `OS.find_keycode_from_string` 接受的名称（例如 `W`、`Space`、`Left` 或 `Enter`），或 `keycode`；`pressed`；可选的 `echo`、`unicode` 与 `hold` | 一个 `InputEventKey`，其 keycode、物理 keycode 与按键标签均为该键 |
| `text` | `text` | 每个字符一次带 `unicode` 的按下与释放 |
| `mouse_button` | `button`（`left`、`right`、`middle`、`wheel_up`、`wheel_down`、`wheel_left` 或 `wheel_right`）、`pressed`、`x`、`y`；可选的 `double`、`factor` 与 `hold` | 该位置上的一个 `InputEventMouseButton`，带更新后的按键掩码 |
| `mouse_motion` | `x`、`y`；可选的 `dx` 与 `dy` | 一个相对运动为 `dx` 与 `dy` 的 `InputEventMouseMotion` |
| `action` | `action`（输入映射中的动作）、`pressed`；可选的 `strength`（0 到 1）与 `hold` | 一个 `InputEventAction` |
| `joy_button` | `button`、`pressed`；可选的 `device` | 一个 `InputEventJoypadButton` |
| `joy_axis` | `axis`、`value`（−1 到 1）；可选的 `device` | 一个 `InputEventJoypadMotion` |
| `focus` | `focused` | 应用获得焦点或失去焦点的通知 |
| `{"wait": <seconds>}` | 无 | 让序列的其余部分等待指定秒数的实际时间 |

键盘与鼠标事件还接受 `shift`、`ctrl`、`alt` 与 `meta`。

- `ctx.godot` 在事件进入的位置校验事件，即 `godot_input` 与 `godot.input`：一次调用携带 1 到 256 个事件，未知字段会被拒绝，`key` 事件需要 `key` 或 `keycode`，数值必须有限。`godot_input` 的 schema 提供除 `focus` 以外的所有类型。
- `godot_input` 把指针坐标视为该 Session 针对当前运行的最新截图中的像素，并按 `windowWidth / width` 与 `windowHeight / height` 缩放；指定 `coordinate_space: "window"` 时原样传递。
- harness 按到达顺序一次运行一个序列。它按顺序应用事件，遇到每个 `wait` 时等待，并在最后一个事件应用后回答；无法应用的事件（例如未知的键名或输入动作）会使请求失败，此前的事件已经生效。`hold` 在按下后经过指定秒数的实际时间安排对应的释放，不会阻塞序列。提前结束或失败的序列会释放它按下且尚未释放的键、鼠标按钮、输入动作与手柄按钮，包括 `hold` 本应稍后释放的那些；提前结束时，`events` 回答已运行的事件数。
- Game 标签页的输入通过 `godot.input` 到达运行，该方法不等待游戏即返回。`ctx.godot` 为每个运行同时只保留一个进行中的 `input` 请求，并把之后的事件排在其后：连续的 `mouse_motion` 事件合并为一个，取最新位置并累加位移；排队事件超过 256 个时丢弃最旧的事件。来自 agent 与来自 Game 标签页的序列共用 harness 的顺序。Game 标签页的请求不携带 `timeoutMs`，因此排在 agent 序列之后的一批输入（包括其中的释放）仍会在该序列结束后运行，该序列最迟在其时限到达时结束。

### 日志

每个运行在一个由 `GodotLogEntry` 值组成的环形缓冲区中保留最新的 `maxLogEntries` 条条目。同一个序列为插件所有运行的条目编号，因此游标可以跨运行排列条目。

| 字段 | 含义 |
|---|---|
| `seq` | Host 范围内的序号 |
| `runId` | 记录该条目的运行 |
| `source` | 来自 harness 日志记录器的 `game`、来自游戏进程输出的 `process`，或来自导入步骤的 `import`；该类型还允许 `check`，但 `godot_check` 在其工具结果中报告，不写入任何条目 |
| `level` | `stdout`、`stderr`、`warning`、`error`、`script_error` 或 `shader_error` |
| `message` | 文本；更长的消息保留前 4,000 个字符 |
| `file`、`line`、`function` | 已知时的位置 |
| `backtrace` | 脚本调用帧，最近的调用在前 |
| `time` | Host 接收时间，单位为自 epoch 起的毫秒数 |

启动失败时，以及连接关闭之后，游戏进程的输出会成为 `process` 条目；harness 连接期间，由其日志记录器报告游戏的输出。`error`、`script_error` 与 `shader_error` 条目计入运行的 `errorCount`，`warning` 条目计入其 `warningCount`。每个 Godot 工具结果至多列出自该 Session 上一次 Godot 工具调用以来记录的 10 条错误级条目，并统计其余条目的数量；工具由[包 README](../../packages/gamedev/godot/README.zh.md) 说明。

### 脚本检查

`godot_check` 不运行游戏，而是在一个无界面进程中加载脚本：`--headless --path <project> --script <wasd_check.gd> -- <res:// paths>`，至多 400 个脚本，期限为 `importTimeoutMs`。[`wasd_check.gd`](../../packages/gamedev/godot/runtime/wasd_check.gd) 绕过资源缓存加载每个脚本，并为每个脚本打印一行；`ctx.godot` 读取以该标记开头的行：

```text
WASD_CHECK {"path": "<res path>", "loaded": <boolean>, "errors": [{"level": "<level>", "message": "<text>", "file": "<res path>", "line": <line>, "function": "<name>"}]}
```

某个脚本因进程崩溃或超时而没有对应的行时，检查失败，并附带进程输出的末尾。

检查是一个不创建任何 autoload 的 `SceneTree` 脚本：在 Godot 创建项目的 autoload 之前，它把每个 autoload 条目指向自身，由于它不是 `Node`，Godot 拒绝实例化它，并在第一次加载之前恢复这些条目。单例 autoload 名称保持注册，因此使用它们的脚本可以编译；分析器根据脚本 autoload 的脚本确定其类型，把场景 autoload 视为 `Node`。不会运行任何 autoload 的 `_init`、`_ready` 或 `_process`；加载会运行被加载脚本的静态初始化代码，Godot 会创建项目声明为全局类的自定义资源加载器与保存器。

## 帧流

`GET /api/godot.frames?session=<SessionId>&run=<runId>` 以流的形式发送一次运行的帧。存在 Connection 服务时，`ctx.godot` 把它注册为精确的 `ctx.connection.fetch` 路由，Connection 对非所有者的 Peer 回答 403。缺少 `session` 或 `run`，或其为空时，该路由回答 400；除非该运行是 Session 的当前运行且尚未结束，否则回答 404；其余情况以 `application/octet-stream` 回答 200。每个回答都带有 `Cache-Control: no-store, no-transform` 与 `X-Content-Type-Options: nosniff`。响应体是一串记录：

```text
record    u32 LE image length, u16 LE width, u16 LE height, u32 LE seq, PNG or JPEG bytes
```

记录头把长度放在最前、序号放在最后，与 harness 的 kind 2 载荷不同。

- 至少有一个帧响应处于打开状态时，运行会请求 harness 以 `streamFps`、`streamQuality`、`streamMaxWidth` 与 `streamLossless` 推送帧；最后一个响应关闭时，运行发送 `fps` 为 0 的 `stream`。
- harness 在工作线程上编码每一帧：`lossless` 开启且编码一帧 PNG 最多用 1/`fps` 秒时编码为 PNG 文件，否则编码为质量为 `quality` 的 JPEG 文件。[包 README](../../packages/gamedev/godot/README.zh.md#remote-and-frames) 说明推流何时在两者之间切换。
- 响应体只在读取方请求时才产生记录：读取方取走上一条记录之前到达的帧会替换它，因此读取较慢的一方总能收到最新的帧。
- 运行结束或请求被中止时，响应体结束。

## Game 标签页

包的 `./client` 导出是一个 Web 平台插件，它先挂载生成的 `godot` Remote，再注册以下内容：

- 右侧 Sidebar 标签页类型 `godot-game`，其 kind 为 `godot`，具有内置优先级，隐藏时保持挂载，并带有一个顺序为 40 的引导条目；其主体与标题填入[右侧 Sidebar](sidebar-right.zh.md) 的 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` slot；
- `godot_screenshot`、`godot_input` 与 `godot_wait` 的 `tool.call.toolview` 卡片，用于显示结果中的截图；
- 其界面文案，位于 `godot` locale 命名空间中。

| 数据 | 通道 | 时机 |
|---|---|---|
| 运行、运行时与日志 | 该 Session 的 `godot.follow` 流 | Game 标签页或下文所述的打开逻辑读取该 Session 的游戏状态时 |
| 帧 | 对 `api/godot.frames?session=<SessionId>&run=<runId>` 的 `fetch`，相对于 `document.baseURI` 解析，并使用 `cache: 'no-store'` | follow 流正在送达、标签页可见且运行处于 `running` 或 `paused` 时 |
| 输入 | 带运行 id 的 `godot.input` | follow 流正在送达、标签页可见且运行处于 `running` 或 `paused` 时 |
| 操作 | `godot.run`、`godot.stop`、`godot.control` 与 `godot.installRuntime` | 用户按下工具栏按钮时 |

- **follow 流。** `godot.follow` 跟随一个 Session id，不需要存活的 Agent。`ctx.godot` 首先发送 `snapshot`：该 Session 当前或最近一次运行的视图（Session 没有存活的 Agent 或没有运行时为 null）、运行时视图、该运行最后 200 条日志条目，以及游标。随后它发送合并后的变化：带最新视图的 `run`，以及 Session 的 Agent 结束时的 `run: null`；带流游标之后至多最新 200 条条目的 `logs`；以及带最新运行时视图的 `runtime`。之后的 Agent 启动的运行会出现在同一个流中，流在其信号中止或插件卸载时结束。浏览器至多保留当前运行的 500 条条目；`run` 项指向新的运行时，丢弃其他运行的条目；已持有的条目会被跳过。连接断开后，Gateway 的逻辑流会重新打开 follow 流，并从新的快照开始。流再次结束或失败后，若它已送达快照，浏览器立即重新跟随，否则在 1 s 后重新跟随，延迟逐次加倍，至多 30 s，用户按下「重试」时则立即重新跟随；在快照到达之前，界面显示重新连接提示。
- **打开标签页。** 对于右侧 Sidebar 已挂载的 Session，由 agent 启动（`startedBy: 'agent'`）且尚未结束的运行，会按运行 id 打开一次 Game 标签页；只要客户端插件保持加载，即使该 Session 的 scope 被释放后又重新保留，也是如此。
- **帧。** 读取方在字节到达时解析记录，并把声明零字节、宽度或高度为零，或超过 32 MiB 的记录视为损坏。响应失败、被拒绝、损坏或结束后，它在 250 ms 后重新打开；尝试一直没有交付记录时，延迟逐次加倍，至多 4 s。同一时间只用 `createImageBitmap` 解码一张图像：以 PNG 文件签名开头时按 PNG 解码，否则按 JPEG 解码；较新的记录会替换正在等待的记录，最新解码的帧在下一个动画帧绘制到保持帧宽高比的 canvas 上。
- **输入。** 游戏视图获得焦点时（点击该视图即可使其获得焦点），标签页发送键盘事件；鼠标位于 canvas 上方时，发送鼠标事件。它按 Godot Web 平台的方式把 `KeyboardEvent.code` 映射为 Godot 键名，Alt 与 Meta 以 keycode 发送，并把与 Meta 组合的按键留给浏览器。Shift+Escape 从不送达游戏：它使视图失去焦点。单字符按键以 `unicode` 携带其文本，除非按住了 Ctrl 而未按住 Alt，因此 AltGr 字符保留其文本。在 Windows Desktop 上，视图获得焦点期间持有快捷键服务的录制状态。指针位置从绘制的帧（不含其周围的黑边）映射到窗口像素；一次滚轮滚动成为一次滚轮按钮的按下与释放；游戏的鼠标模式为捕获（2）时，按下会锁定指针，移动则发送位移。事件每个动画帧发送一次，每批至多 256 个，连续的移动会合并，同一时间只发送一批。失去焦点时，释放所有按住的键与按钮。一批输入因运行已结束以外的原因失败时，其中的按键与鼠标按钮释放会排在下一批的最前面，由新的事件或失去焦点时的释放发送。
- **操作。** 「运行」以最近一次运行的项目调用 `godot.run`；首次运行之前不带项目，由 `ctx.godot` 查找最近的项目。运行进行中时代替「运行」显示的「重新运行」还会传入该运行 `launch` 中的场景与窗口尺寸。「停止」、「暂停」、「继续」、「前进一帧」与「安装 Godot」（运行时缺失或失败时显示）调用对应的方法。被拒绝的操作会显示其 Remote 错误码对应的文案，包括 `session/writer-held`。

<a id="game-tools-tabs"></a>
## 「游戏工具」标签页

`ui-game-tools` 行挂载 [`@deepseek-ai/dsh-client-ui-game-tools`](../../packages/gamedev/ui-game-tools/README.zh.md)：一个 Host 半区为空的浏览器插件，在用户查找插件的地方列出这四个工具。「设置 › 内置插件」打开时先显示它的只读「游戏工具」标签页，排在清单的「插件列表」之前；「插件」页面在「已安装」之后显示一个「游戏工具」标签页。两个标签页都列出 Blender、GIMP、Godot 与 SuperCollider，显示各包元信息中的标志、标题与描述，以及各行的 Loader 状态。两个标签页在首次渲染之前都不调用任何 Remote。

在「插件」页面上，只要 Host 管理着 profile，profile 挂载的每个工具都有一个开关。开关以工具的 Loader 条目 id 调用 `pluginManager.setPluginEnabled`：关闭工具时把 `- id: <row>` 与 `disabled: true` 写入 profile patch，这也是用户可以手写的覆盖项；开启工具时删除不含其他内容的覆盖项。[插件管理器](../../packages/boot/plugin-manager/README.zh.md#use-this-package)随即应用更改，或报告更改需要重启后才生效，或报告更高优先级的 patch 覆盖了它。

每个工具包都在 `package.json` 的 `icon` 字段中指向 `icon.svg`，因此 Host 的包元信息以 `data:image/svg+xml` URL 携带该文件。每个文件把对应产品的官方标志原样嵌入包图标所用的 36 × 36 画布；[Blender](../../packages/gamedev/blender/README.zh.md#plugin-icon)、[GIMP](../../packages/gamedev/gimp/README.zh.md#plugin-icon)、[Godot](../../packages/gamedev/godot/README.zh.md#plugin-icon) 与 [SuperCollider](../../packages/gamedev/supercollider/README.zh.md#plugin-icon) 的 README 为各标志署名，并说明其许可与商标条款。

<a id="mcp-server-for-other-agents"></a>
## 供其他 agent 使用的 MCP 服务器

`game-mcp` 行挂载 [`@deepseek-ai/dsh-game-mcp`](../../packages/gamedev/game-mcp/README.zh.md)，这台电脑上的其他 agent（例如 Claude Code 或 Codex）通过它使用游戏工具。它的 Host 插件在 `127.0.0.1` 的 `/mcp` 上监听，默认端口为 9273，并提供 2026-07-28 MCP 修订版的 Streamable HTTP 传输，同时以无状态方式提供 2025 年各修订版的传输。每个请求都必须通过 MCP SDK 的 localhost Host 与 Origin 检查，并携带 `Authorization: Bearer <token>`，即 `<dataRoot>/token` 中的令牌。

| 工具 | provider | 调用如何执行 |
|---|---|---|
| `search_game_tools`、`call_game_tool` | `game-mcp` | 服务器搜索各 provider 的工具及其就绪状态，或按名调用其中一个 |
| `godot_*` | `godot`，经由 [`src/mcp.ts`](../../packages/gamedev/godot/src/mcp.ts) 中的 `godotMcpProvider` | Session 自身的工具定义，由 `godotToolDefinitions` 构建并改用面向绝对项目路径的措辞，为已连接 agent 的 Session 执行；截图以 PNG 字节返回 |
| `blender_*`、`gimp_*`、`supercollider_*` | `blender`、`gimp`、`supercollider`，经由 [`@deepseek-ai/dsh-app-mcp`](../../packages/gamedev/app-mcp/README.zh.md) 中的 `offerAppTools` | MCP 客户端注册的 `mcp__wasd_blender__*`、`mcp__wasd_gimp__*` 与 `mcp__wasd_supercollider__*` 定义，其结果连同图像一起转交 |

插件在自身生命周期内通过 `ctx.gameMcp.provide()` 贡献工具，服务器只在 provider 的前缀下列出工具。工具定义以服务器自己的执行上下文运行，因此 harness 的工具策略（例如批准提示）不适用；由已连接 agent 的 harness 应用它自己的策略。

**Session。** 每次 Godot 调用都以绝对路径指定项目，或沿用该 agent 上一次的项目。除非已有注册的游戏项目包含该文件夹，服务器会把该文件夹注册为游戏项目，并在该项目中解析该 agent 的 Session，首次使用时创建：每个 agent 与游戏项目对应一个 Session，记录在 `<dataRoot>/sessions.json` 中。游戏在这个 Session 中运行，因此它的运行、日志与 Game 标签页都与普通 Session 相同，用户可以在其中观看、暂停和游玩。

**窗口。** `godot_run` 携带 Session id 发出 Host 事件 `game-mcp/reveal`。Remote 事件白名单把它转发给每个可以读取该 Session 的窗口，`ui-game-mcp` 行的浏览器插件 [`@deepseek-ai/dsh-client-ui-game-mcp`](../../packages/gamedev/ui-game-mcp/README.zh.md) 随即在其中打开该 Session；之后 Game 标签页会像对待任何由 agent 启动的运行一样为这次运行打开。

**设置。** 同一个浏览器插件用「使用其他智能体设置」填充登录对话框的替代方案 slot，即 `settings.account.onboarding.alternative` 与 `settings.account.menu.alternative`。面板显示期间，它跟随 `gameMcp.watch` 流：服务器状态、端点、带令牌的设置提示词，以及 Host 启动以来见过的 agent。[LiveShare](liveshare.zh.md) 把 `gameMcp/watch` 归为仅所有者可用，并且从不把 `gameMcp` 命名空间提供给分享的观看者。

## Remote 类型

`godot` Remote 方法列在生成的 Cordis API 一节中；它们的第一个参数是普通的 `SessionId`，不需要存活的 Agent：`follow`、`stop`、`control` 与 `input` 作用于该 Session 的当前运行，`godot.run` 则像提示词那样，通过 `ctx.sessionController.resolveAgent` 恢复没有存活 Agent 的 Session，并传递其拒绝，例如 `session/not-found` 与 `session/writer-held`；`installRuntime` 不接受 Session。这些方法的类型位于浏览器安全的 [`src/types.ts`](../../packages/gamedev/godot/src/types.ts)。[LiveShare](liveshare.zh.md) 把每个 `godot/*` 端点归类为仅限所有者（`owner-only`），并且从不向共享查看者提供 `godot` 命名空间。

`GodotRunRequest` 启动或重新启动该 Session 的游戏：

| 字段 | 含义 |
|---|---|
| `project` | 包含 `project.godot` 的文件夹，相对于 Session 的工作目录；未给出时，`ctx.godot` 查找最近的项目 |
| `scene` | 代替主场景运行的 `res://` 或 `uid://` 场景 |
| `width`、`height` | 窗口尺寸（像素），须同时给出，均为 1 到 16,384 的整数 |
| `muted` | 使用 Dummy 音频驱动运行；`godot.run` 默认为 false |

`GodotControlRequest` 携带 `action`（`pause`、`resume` 或 `step`）；对于 `step`，还携带帧数 `frames`，即 1 到 100,000 的整数，默认为 1。

`GodotRunView` 描述工具与 Game 标签页看到的一次运行：

| 字段 | 含义 |
|---|---|
| `runId` | 不透明 id，在 Host 进程内唯一 |
| `phase` | [运行生命周期](#run-lifecycle)中的阶段 |
| `startedBy` | `agent` 或 `user` |
| `projectDir`、`projectName` | 项目文件夹，以及设置时的 `application/config/name` |
| `launch` | 启动请求的场景与窗口尺寸：`scene`、`width` 与 `height`，请求未给出时均不存在；「重新运行」会再次传入它们 |
| `scene` | 已知时，正在运行的场景的 `res://` 路径 |
| `width`、`height` | 游戏窗口尺寸，在游戏报告后提供 |
| `fps`、`frame`、`mouseMode` | 最新 `status` 消息中的值；`mouseMode` 是 Godot 的 `Input.MouseMode`：0 可见、1 隐藏、2 捕获、3 限制在窗口内、4 限制在窗口内且隐藏 |
| `renderer` | 渲染驱动与渲染方法，例如 `metal / forward_plus` |
| `muted`、`windowless`、`runtime` | 是否静音、是否无窗口渲染，以及运行时类型 `libgodot` 或 `executable` |
| `exitCode`、`signal` | 进程如何结束 |
| `message` | 失败或崩溃的说明，附带进程输出的末尾 |
| `errorCount`、`warningCount` | 该运行的错误级条目数与警告条目数 |
| `startedAt` | 启动时间，单位为自 epoch 起的毫秒数 |

`GodotRuntimeView` 描述运行时的可用性：

| `state` | 含义与字段 |
|---|---|
| `ready` | 有运行时可以解析：`kind`、`windowless`，托管运行时还带其 Godot `version` |
| `missing` | 没有可以解析的运行时，可以安装托管运行时；`message` 说明如何安装 |
| `installing` | 安装正在进行；报告进度后，`progress` 含其 `phase`（`downloading`、`verifying` 或 `extracting`）、`completedBytes` 与 `totalBytes` |
| `failed` | 上一次安装失败，或某个已配置的路径不可用；`message` 说明原因 |

`GodotFollowItem` 是 follow 流中的一项：

| `type` | 字段 |
|---|---|
| `snapshot` | `run`（或 null）、`runtime`、`logs`（至多 200 条）与 `cursor` |
| `run` | `run`，即最新视图 |
| `logs` | `entries`（至多 200 条，最旧的在前）与 `cursor` |
| `runtime` | `runtime` |

该包新增以下 Remote 错误码：

| 错误码 | 详情 | 触发条件 |
|---|---|---|
| `godot/no-project` | `directory` | 没有与请求匹配的 `project.godot`，或其 `scene` 既不是已存在的 `res://` 文件，也不是 `uid://` 引用 |
| `godot/runtime-unavailable` | `message` | 没有可以解析的运行时，或某个已配置的运行时路径不可用 |
| `godot/not-running` | 无 | Session 没有运行，或其游戏不接受请求 |
| `godot/stale-run` | `runId` | `input` 指向的运行不是该 Session 的当前运行 |
| `godot/too-many-runs` | `limit` | 其他 Session 的游戏（包括仍在停止的已关闭 Session 的游戏）已占满 `maxRuns` |
| `godot/request-failed` | `message` | 游戏拒绝了请求，或没有及时回答 |

无效的输入事件、窗口尺寸与单步帧数会以 `gateway/bad-request` 失败。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgamemcp--gamemcpserver"></a>

### `ctx.gameMcp` — `GameMcpServer`

Owner of the MCP endpoint, its game tool providers, and the connected agents' Sessions.

```ts cordis-catalog
/**
 * Offer a plugin's game tools to connected agents for the calling plugin's lifetime.
 * @param provider - the plugin's identity, readiness, and tools; its tool names start with its id and an underscore.
 * @returns an idempotent disposer that withdraws the tools.
 * @throws when the id is not lowercase letters and digits starting with a letter, or another provider has it.
 */
provide(provider: GameMcpProvider): () => void

/**
 * Follow the server for the window: its state, endpoint, and setup prompt, and the agents seen.
 * @param signal - stream cancellation.
 * @returns the current view, then the view after each change, until cancelled or the plugin is disposed.
 */
@Remote({ mode: 'stream' }) async* watch(signal: AbortSignal): AsyncIterable<GameMcpView>
```

Source: [`packages/gamedev/game-mcp/src/index.ts`](../../packages/gamedev/game-mcp/src/index.ts)

<a id="ctxgodot--godotcontroller"></a>

### `ctx.godot` — `GodotController`

Host owner of Godot runs: tools for the agent, a Remote for the Game tab, and the frame stream.

```ts cordis-catalog
/**
 * Follow the Session's game for the Game tab, without resuming the Session: a Session without a live Agent
 * reports no run until its Agent starts one.
 * @param sessionId - followed Session.
 * @param signal - stream cancellation.
 * @returns a snapshot, then run, log, and runtime changes until cancelled or the plugin is disposed.
 */
@Remote({ mode: 'stream' }) follow(sessionId: SessionId, signal: AbortSignal): AsyncIterable<GodotFollowItem>

/**
 * Start or restart the Session's game from the Game tab; audio plays unless `muted` is set. A Session without a
 * live Agent is resumed first, as a prompt resumes it.
 * @param sessionId - Session whose game starts.
 * @param request - project, scene, window size, and audio.
 * @param signal - cancellation before launch; a resume or a launched run continues for the Session.
 * @returns the new run, launched; the follow stream reports its progress.
 */
@Remote async run(sessionId: SessionId, request: GodotRunRequest, signal: AbortSignal): Promise<GodotRunView>

/**
 * Stop the Session's game.
 * @param sessionId - Session whose run stops.
 * @param signal - cancellation of the wait; stopping continues.
 * @returns after the game ended; `godot/not-running` when the Session has no run.
 */
@Remote async stop(sessionId: SessionId, signal: AbortSignal): Promise<void>

/**
 * Pause, resume, or step the Session's game.
 * @param sessionId - Session whose run changes.
 * @param request - action and step frames.
 * @param signal - cancellation.
 * @returns the run after the change.
 */
@Remote async control(sessionId: SessionId, request: GodotControlRequest, signal: AbortSignal): Promise<GodotRunView>

/**
 * Send user input to the Session's game without waiting for the game to apply it.
 * @param sessionId - Session whose run receives the input.
 * @param runId - run the input was meant for.
 * @param events - at most 256 events in game window pixels.
 * @param signal - cancellation.
 */
@Remote input(sessionId: SessionId, runId: string, events: GodotInputEvent[], signal: AbortSignal): void

/**
 * Install the managed LibGodot runtime, or join the install already running.
 * @param signal - stops this wait; the install continues.
 * @returns the runtime view after the install settled.
 */
@Remote async installRuntime(signal: AbortSignal): Promise<GodotRuntimeView>
```

Types: [SessionId](core.zh.md)

Source: [`packages/gamedev/godot/src/index.ts`](../../packages/gamedev/godot/src/index.ts)

<a id="game-mcp-events"></a>

### `game-mcp/*` events

<a id="game-mcpreveal--emit"></a>

#### `game-mcp/reveal` — emit

A connected agent's call asked the WASD Engine window to show a Session, such as the one whose game it started; the Host forwards it to the windows that may read the Session.

```ts cordis-catalog
/**
 * A connected agent's call asked the WASD Engine window to show a Session, such as the one whose game it
 * started; the Host forwards it to the windows that may read the Session.
 * @mode emit
 * @param sessionId - Session to show.
 */
'game-mcp/reveal'(sessionId: SessionId): void
```

Types: [SessionId](core.zh.md)

Source: [`packages/gamedev/game-mcp/src/types.ts`](../../packages/gamedev/game-mcp/src/types.ts)
<!-- END GENERATED cordis-surface -->
