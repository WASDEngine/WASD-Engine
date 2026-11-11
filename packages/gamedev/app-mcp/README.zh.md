---
description: "构建以无界面方式运行桌面应用程序的 MCP 服务器，供 Blender、GIMP、SuperCollider 等应用程序包使用：共享的插件 Config 字段、向 MCP 管理器注册以及通过 tsx 的源码启动、服务器进程主体、工具辅助函数与 execute_python 工具、JSON 行工作进程协议与重启、工具结果上限，以及把随包文件复制到 app.asar 之外。"
kind: "package-reference"
---

# @deepseek-ai/dsh-app-mcp

[English](README.md) | 中文

## 概述

把 Blender、GIMP、SuperCollider 等桌面应用程序放在 MCP 工具之后，以无窗口方式运行。宿主插件把共享的 `AppMcpConfig` 字段展开到自己的 Config 中并调用 `registerAppMcpPlugin`；其服务器入口以该应用程序的工具调用 `runAppMcpServer`。每个调用工具的 Session 都有自己的长期运行的工作进程，逐个执行该 Session 的调用。超时、崩溃或协议违规会停止工作进程：失败的调用会报告状态已丢失，之后的调用会启动新的工作进程。共用的安装与工具辅助函数、`execute_python`，以及把随包脚本复制到 `app.asar` 之外的 `materializePayload` 构成本包的其余部分。

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

本库是应用程序插件包的依赖：它没有插件入口，也没有 `cordis.yml` 行；它定义的 Config 字段属于纳入这些字段的插件。应用程序包在两个进程中使用它。宿主插件注册一个 MCP 服务器；MCP 客户端启动的服务器进程提供工具，并拥有应用程序工作进程。

### 何时使用

Blender、GIMP 与 SuperCollider 包依赖本库构建各自的 MCP 服务器；[Blender 的插件](../blender/src/index.ts)与[服务器入口](../blender/src/worker.ts)展示了一个完整的消费方。SuperCollider 的语言自身无法响应 JSON 行请求，因此它的[工作进程](../supercollider/README.zh.md#understand-the-implementation)是一个驱动 sclang 的桥接进程。Godot 包只使用 `materializePayload` 复制其 harness 脚本。当外部应用程序必须在 agent（智能体）调用的工具之后以无界面方式运行，并且应用程序内的脚本或其旁边的桥接进程能够响应下文所述的 JSON 行请求时，使用本库。

### 配置插件

插件的 `Config` 接口扩展 `AppMcpConfig`，其 schema 把 `AppMcpConfig.dict` 展开到自己的对象 schema 中，因此每个 app MCP 插件都以相同的默认值与取值范围提供下列字段。每个预算都是 1 到 2,147,483,647 之间的整数毫秒数，内存与处理器字段是从 0 起的整数。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `toolCallTimeoutMs` | `900,000` | 一次工具调用的预算，包括工作进程启动及其首次使用时的安装；一次工作进程请求（包括 `execute_python` 的超时）最多可用到其中除最后 30 s 以外的全部时间 |
| `requestTimeoutMs` | `600,000` | 一次工作进程请求的默认预算，至少比 `toolCallTimeoutMs` 少 30 s；到期时工作进程停止，其状态丢失 |
| `graceMs` | `3,000` | 工作进程在收到 `shutdown` 请求后、以及收到 SIGTERM 后各有的退出时间，之后发送 SIGKILL |
| `maxLogBytes` | `65,536` | 为错误消息保留的最近工作进程输出及安装命令输出的字节数；取正整数 |
| `maxWorkers` | `4` | 在任何电脑上同时运行的工作进程上限，每个调用的 Session 一个，取值 1 到 16；电脑的[工作进程上限](#one-worker-per-session)可能更低 |
| `workerMemoryBytes` | `8,589,934,592`（8 GiB） | 每个工作进程所需的电脑物理内存：工作进程上限至多为电脑内存除以此值并四舍五入到整数；`0` 表示不考虑内存 |
| `workerCores` | `4` | 每个工作进程所需的逻辑处理器数：工作进程上限至多为电脑的逻辑处理器数除以此值并向下取整；`0` 表示不考虑处理器 |
| `minAvailableMemoryBytes` | `1,073,741,824`（1 GiB） | 启动工作进程时电脑必须有的可用内存；不足时，启动会先停止其他 Session 的空闲工作进程，仍不足则以 `LOW_MEMORY` 失败；`0` 关闭此检查 |
| `workerIdleTimeoutMs` | `600,000` | Session 的工作进程在没有调用多长时间后停止，其状态随之丢失 |

插件自行声明并说明 `dataRoot`（它拥有的绝对目录）与 `startupTimeoutMs`，因为它们的含义因应用程序而异。

### 注册服务器

`registerAppMcpPlugin(ctx, config, plugin)` 是这类插件的全部 `apply`，该插件的 `inject` 必须包含 `mcpManager`：

- `dataRoot` 以及 `plugin.paths` 所列的 Config 字段必须是绝对路径或为空；否则它抛出以 `<plugin.app> plugin:` 开头并指明字段的错误。
- `requestTimeoutMs` 最多为 `toolCallTimeoutMs` 减去 30 s；否则它抛出以 `<plugin.app> plugin:` 开头并指明两个预算的错误。这 30 s 留给工作进程启动和结果的返回，因此用完时间的请求会以它自己的错误失败，而不会等到 MCP 客户端放弃该调用并以笼统的超时取消它。
- 服务器收到 `dataRoot`、`requestTimeoutMs`、`toolCallTimeoutMs`、`graceMs`、`maxLogBytes`、`maxWorkers`、`workerMemoryBytes`、`workerCores`、`minAvailableMemoryBytes`、`workerIdleTimeoutMs`，以及 `plugin.options` 所列的 Config 字段，每个都使用其 Config 名称。
- 当 `plugin.module`（插件的 `import.meta.url`）以 `.ts` 结尾时，服务器入口是它旁边的 `worker.ts`，否则是它旁边的 `worker.js`。
- 注册通过 `registerAppMcpServer` 完成，使用 `plugin.serverName` 以及 Config 中的 `toolCallTimeoutMs` 与 `startupTimeoutMs`。
- 提供 `plugin.gameMcp`（由 `id`、`title`、`description` 与 `instructions` 组成的 `AppGameMcpIdentity`）时，只要 WASD Engine 的 MCP 服务器 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 与工具注册表存在，服务器的工具也会提供给通过它连接的 agent（智能体）：MCP 客户端以 `mcp__<serverName>__<name>` 注册的每个工具以 `<id>_<name>` 提供，运行同一个已注册的定义，并返回服务器的文本与图像；其他内容块变为 `[<type> content omitted]`。provider 的指令是服务器的指令，后面附有一条说明：连接的 agent 彼此共享一个应用程序会话，因为它们的调用不指明 Session（[每个 Session 一个工作进程](#one-worker-per-session)）。服务器已连接时 provider 报告 `ready`，连接之前与重连期间报告 `starting`，失败之后或关闭期间报告带有最后一次错误的 `unavailable`。

编译器会对照插件的 Config 检查这些字段名，并且只有字符串字段能放入 `plugin.paths`。

`registerAppMcpServer(ctx, registration)` 直接接收这些字段，供拥有自定义入口的插件使用。它在 `ctx.effect` 内注册服务器，因此 dispose（资源释放）插件会移除服务器及其工具。注册完成后，管理器启动服务器进程；第一次工具调用之前，服务器不会启动工作进程。

| 注册字段 | 含义 |
|---|---|
| `serverName` | 管理器键与工具命名空间：工具名为 `mcp__<serverName>__<tool>`。管理器接受 1 到 32 个 ASCII 字母、数字、`_` 或 `-` |
| `entry` | 包的服务器入口的 `file:` URL：已构建的 JavaScript，或源码检出中的 TypeScript |
| `options` | 入口通过 `decodeServerOptions(process.argv)` 读取的 JSON 对象 |
| `toolCallTimeoutMs` | MCP 客户端等待一次工具调用的毫秒数 |
| `startupTimeoutMs` | MCP 客户端为一次连接尝试（含工具发现）分配的毫秒数 |

它根据这些字段构建如下 MCP 管理器条目：

| 条目字段 | 取值 |
|---|---|
| `transport` | `stdio` |
| `command` | `process.execPath`，即宿主自身的可执行程序 |
| `args` | 入口的文件路径，其后是编码后的选项；对路径以 `.ts` 结尾的入口，前面先加 `--import` 与 `tsx/esm` 加载器的 URL |
| `env` | `ELECTRON_RUN_AS_NODE=1` 以及置空的 `PYTHONPATH`、`PYTHONHOME` 与 `VIRTUAL_ENV`，对 `.ts` 入口还有指向仓库 `tsconfig.base.json` 的 `TSX_TSCONFIG_PATH`，合并在 MCP 客户端过滤后的宿主环境之上 |
| `cwd` | 空值，因此服务器进程在宿主的工作目录中启动 |
| `toolCallTimeoutMs`、`startupTimeoutMs` | 注册中的取值 |
| `closeTimeoutMs` | 15,000 ms，长于服务器 10 s 的关闭预算 |
| `reconnect` | 启用：首次重试在 1 s 后，每次延迟翻倍直至 30 s，最多连续失败 5 次 |

在 Desktop 应用中，宿主的可执行程序是 Electron，`ELECTRON_RUN_AS_NODE=1` 使它以 Node 方式运行，因此 Desktop 应用无需另行安装 Node。置空的 Python 变量使用户 shell 中的 Python 设置不会进入服务器启动的工作进程。

`.ts` 入口来自 harness 的源码启动，例如 `pnpm dsh web`：此时插件模块是 `src/index.ts`，因此其入口是 `src/worker.ts`。服务器与源码启动本身一样通过 tsx 的 ESM 钩子运行，`TSX_TSCONFIG_PATH` 使工作区 import 无论服务器的工作目录在哪里都映射到其源码。只有 `.ts` 入口才会解析该加载器，因此注册已构建 `.js` 入口的打包版 Desktop 应用不需要 tsx。

`encodeServerOptions` 把选项作为一个参数 `argv[2]` 传递，即其 UTF-8 JSON 的无填充 base64url 文本。MCP 管理器把 `command`、`args`、`env` 值与 `cwd` 中的 `${…}` 视为[凭据模板](../../mcp/mcp-client/README.zh.md#runtime-templates-and-credentials)：它拒绝所有不是 `${credential:REF}` 标记的 `${…}`，并解析这些标记。base64url 文本从不包含 `${`，因此选项值原样到达服务器。当该参数缺失、不是规范的无填充 base64url，或解码后不是 UTF-8 JSON 对象时，`decodeServerOptions` 抛出指明 `argv[2]` 的 `TypeError`。

当 `entry` 不是 `file:` URL 时，`registerAppMcpServer` 抛出 `TypeError`。当服务器名称无效或已被占用（包括被同名的已配置服务器占用）时，管理器抛出错误。任一错误都会使插件失败。

<a id="run-the-server-process"></a>
### 运行服务器进程

`runAppMcpServer(definition, process.argv)` 是服务器入口的全部主体。`definition` 给出服务器的 `name`、`version` 与 `instructions`、随包 `workerScript` 的 `file:` URL，以及三个函数：

- `parseOptions(value)` 校验解码后的选项。服务器用 `AppServerOptionFields`（每个服务器都会收到的 `AppServerOptions` 字段）与自身的字段构建其严格 schema，并调用 `parseAppServerOptions(app, schema, value)`。该函数抛出以 `<app> MCP server options are invalid:` 开头、指明每个缺失、无效或未知字段的错误。
- `workers(options, dependencies)` 创建应用程序的 `AppWorkers`。其 `start(signal, scope)` 准备应用程序，并通过 `dependencies.start`（即 `JsonLineWorker.start`）为一个 Session 启动一个工作进程；`scope.directory` 是该工作进程自己的文件夹，用于应用程序配置文件等文件，且各次启动从不重叠，因此所有工作进程共用的安装步骤一次只运行一个。`dependencies.workerScript()` 返回工作进程脚本在 `dataRoot` 下的 `materializePayload` 副本的真实路径。其 `takeNotes()` 交出自上次调用以来收集的安装说明，例如已启动工作进程的版本。
- `tools(dependencies)` 以 `AppToolDependencies` 构建工具。服务器为每次调用按调用方的 Session 构建它们：`call` 在该 Session 的工作进程上执行工作进程方法，其预算是 `requestTimeoutMs` 与 `graceMs`；`takeNotes` 读取该 Session 的工作进程启动时的说明；`dataRoot`、`requestTimeoutMs` 与 `maxTimeoutMs`（即 `toolCallTimeoutMs` 减去 30 s）携带路径与预算。

定义中的 `app`（例如 `Blender`）在[每个 Session 一个工作进程](#one-worker-per-session)的消息中指称该应用程序。服务器把 `processLimit({ max: maxWorkers, memoryBytes: workerMemoryBytes, cores: workerCores }, machine)` 作为工作进程池的工作进程上限，并以 `machine` 报告的可用内存检查 `minAvailableMemoryBytes`；可选的第五个参数 `machine` 默认为 `nodeMachine()`，即本机的 `os.totalmem()`、`os.availableParallelism()` 与 `process.availableMemory()`。服务器开始提供服务后它即返回；服务器关闭时会关闭工作进程池，后者停止每个工作进程。`argv[2]` 不含选项，或 `parseOptions` 拒绝选项时，它在提供任何服务之前即拒绝。

<a id="serve-the-tools"></a>
### 提供工具

`runAppMcpServer` 通过 `serveAppMcp({ name, version, instructions, tools, scopedTools, onClose })` 提供工具，服务器入口也可以直接调用该函数。它首先把全局 `console` 指向 stderr，使 stdout 只承载 MCP 帧，并在关闭时恢复 console。服务器立即响应工具发现，不启动任何其他内容；只有客户端调用某个工具时，该工具才会运行。工具名称重复时，`serveAppMcp` 在开始提供服务之前即拒绝。

提供 `scopedTools` 时，服务器列出实验性能力 `io.github.wasdengine/session-scope`，宿主的 MCP 客户端（[`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.zh.md)）随后会把发起调用的 agent 的 Session id 以 `io.github.wasdengine/session` 键加入每次工具调用的 `_meta`；不经 agent 发起的调用不带该键。每次调用运行 `scopedTools(sessionId)` 中同名的工具；调用未指明 Session，或其值不是不超过 200 个字符的非空字符串时，运行 `scopedTools(undefined)` 中的工具；此时 `tools` 只决定服务器列出的内容。`SESSION_SCOPE_CAPABILITY`、`SESSION_SCOPE_META_KEY` 与 `sessionOf(meta)` 导出这些名称与读取方式。

每个 `AppTool` 都有 `name`、可选的 `title`、`description`，以及 Zod raw shape 形式的 `input`，SDK 据此校验参数。它的 `run(args, signal)` 返回 `AppToolResult`。服务器关闭时，以及客户端取消调用时，该中止信号都会触发；MCP 客户端在其 `toolCallTimeoutMs` 到期时也会取消调用。

服务器把 `AppToolResult` 映射为 MCP 内容：

- `text` 成为第一个文本块。JSON 编码超过 1 MiB 的文本保留前 174,762 个 UTF-16 码元，不拆分代理对，其后附加 `[output truncated: <n> more characters]`。
- `images` 依次排在其后，类型为 `image/png` 或 `image/jpeg`。每张图像取自其 `data` 字节；没有 `data` 时取自 `path` 处的文件，服务器读取该文件并保留原文件。服务器不会缩放图像。
- base64 编码后超过 4 MiB（即 3 MiB 字节）的图像，或会使结果中图像的 base64 总量超过 6 MiB 的图像，会变成要求提供更小图像的 `[image omitted: …]` 文本提示；之后能放下的图像仍会包含在内。无法读取的文件，或既无 `data` 也无 `path` 的图像，会变成 `[image unavailable: <reason>]`。
- `isError: true` 把结果标记为失败。MCP 客户端随后以结果的文本使调用失败，因此其中的图像只会以客户端文本诊断的形式到达模型。

抛出的错误会变成只含一个文本块的错误结果：错误消息，以及对 `WorkerError` 而言，工作进程 traceback 的最后 4,000 个字符、`Recent worker output:` 之后其日志尾部的最后 2,000 个字符，以及 `Error code: <code>`。

以下情况中最先发生的一种会让服务器关闭：stdin 结束或关闭；MCP 传输自行关闭，即 stdout 写入失败（例如客户端离开后出现 EPIPE）或收到的消息超出其读取缓冲区时；或者收到 SIGTERM 或 SIGINT。服务器关闭 MCP 连接（这会中止正在运行的工具调用），然后最多等待 `onClose` 10 s，且只执行一次。它在 stderr 上报告失败或未完成的 `onClose`，并以退出码 0 退出。信号监听器一直保留到进程退出，因此重复的 SIGTERM（MCP 客户端升级关闭时会发送）不能在 `onClose` 完成之前结束进程。对 stderr 的写入尽力而为：写入失败会被忽略。消费方在 `onClose` 中停止其工作进程，例如调用 `supervisor.close()`。

<a id="build-the-tools"></a>
### 构建工具

以下辅助函数承载各应用程序工具集共用的部分：

- `defineAppTool(tool)` 按工具的 `input` shape 为其 `run` 参数确定类型，并返回可放入工具列表的工具。
- `workerParams(args)` 把已校验的参数转为工作进程参数，省略的参数不出现。
- `replyParser(app)` 返回一个按 Zod schema 校验工作进程回复的函数；不匹配时抛出 `WorkerReplyError`，其消息以 `The <app> worker sent an unexpected <method> reply:` 开头并指明每处不匹配。
- `withSetupNotes(dependencies, result)` 把待报告的安装说明放在结果文本之前，每条之后跟一个空行；`takeNotes` 每条说明只交出一次。
- `formatBytes(bytes)` 把文件或内存大小写成 `512 bytes`、`2.0 KiB`、`5.0 MiB` 或 `1.5 GiB`。
- `processLimit(options, machine)` 返回一台电脑上同一类进程同时运行的上限：取 `options.max`、电脑内存除以 `options.memoryBytes` 并四舍五入的整数、逻辑处理器数除以 `options.cores` 并向下取整的整数三者中最小的一个，且至少为 1；`memoryBytes` 或 `cores` 为 0 时不计入该项。内存的商四舍五入，使标称 16 GB、操作系统报告略少的电脑仍按 16 GiB 得到上限。`memoryShortage(requiredBytes, available)` 读取可用内存，不足 `requiredBytes` 时返回 `{ availableBytes, requiredBytes }`；`lowMemoryMessage(what, shortage)` 是拒绝此类启动时面向模型的消息。Godot 插件把它们用于游戏运行。
- `executePythonTool(dependencies, { app, title, description })` 是以 Python 脚本驱动的应用程序的 `execute_python` 工具；[模型体验](#model-experience)展示其声明与结果文本。
- `AGENT_IMAGE_MAX_EDGE`（1,568 像素）与 `AGENT_IMAGE_MAX_BYTES`（3 MiB，其 base64 形式正好占满单张图像可用的 4 MiB）规定工具向工作进程请求的图像大小。

<a id="find-the-application"></a>
### 查找应用程序

服务器通过 `SetupHost`（setup host，安装环境宿主）查找其应用程序：服务器进程的平台、环境与主目录，判断用户可执行的普通文件的 `isExecutable`，把缺失或不可访问的目录列为空的 `listDirectory`，以及 `makeDirectory`。`nodeSetupHost()` 把它绑定到本机；测试传入假的 host。`firstExecutable(candidates, host)` 返回第一个通过 `isExecutable` 的候选路径；`newestFirst` 按名称中的数字从新到旧排序，因此 `Blender 4.10` 排在 `Blender 4.2` 之前，`GIMP 3.0.1` 排在 `GIMP 3.0` 之前。`CommandArgv` 表示一个绝对路径的可执行程序及其参数。

Desktop 应用随附在插件包中的运行时位于包的 `runtime/<platform>-<arch>/` 文件夹，该文件夹由 `shippedRuntimeRoot(packageRoot)` 给出；位于 `app.asar` 内的包从 `app.asar.unpacked` 读取。`readShippedRuntime(root, host, schema, invalid)` 通过 `ShippedRuntimeHost`（带有 `arch` 与 `readTextFile` 的 setup host，`nodeShippedRuntimeHost()` 把它绑定到本机）读取该文件夹中对应宿主平台与架构的 `runtime.json`。文件不存在时它不返回任何内容，否则返回文件夹、记录，以及解析记录中路径的 `resolve` 函数；记录不是 JSON、不符合 schema，或描述的是其他平台或架构时，以 `invalid` 构造的错误失败。运行时的 schema 展开 `ShippedRuntimeFields`（每条记录都有的 `format`、`version`、`platform` 与 `arch`），并把其中的路径声明为 `ShippedRuntimePath`，即不含 `.` 或 `..` 段、以 `/` 分隔的相对路径。应用随附运行时的归档而非其文件时，`readPackedRuntime` 以同样的方式读取该文件夹的 `archive.json`，返回归档的路径、大小与 SHA-256 以及其 `runtime.json` 的字段，供服务器解包。`unpackPackedRuntime(packed, program, dataRoot, host, signal, failures)` 把它解包到 `<dataRoot>/runtime/<version>`（由 `unpackedRuntimeDirectory` 给出；即使用户名很长，运行时最深的文件也能留在 Windows 的路径长度限制之内），除非该文件夹已有一个包含归档全部字段的 `runtime.json`，且记录的 `program` 是可执行文件。它运行 `findTar` 找到的 `tar`（Windows 上是 `%SystemRoot%\System32` 中 Windows 自带的 `tar.exe`，其他系统上先是 `/usr/bin/tar`，再是 `PATH` 上的 `tar`），解包到一个 `.partial-<8 位十六进制数字>` 同级文件夹，检查解包出的 `runtime.json`，再用 `moveIntoPlace` 把该文件夹重命名到位：`moveIntoPlace` 会替换原位置上程序不可执行的文件夹，并接受并发服务器先移到位的可用文件夹；无论成败，同级文件夹都会被删除。归档或 tar 缺失、tar 失败，或归档中是另一个运行时时，以 `failures.invalid` 构造的错误失败；文件夹无法移到位时，以 `failures.moveFailed` 构造的错误失败。解包需要一个 `RuntimeUnpackHost`，即带有 `rename`、`remove` 与 `run` 的 `ShippedRuntimeHost`，`nodeRuntimeUnpackHost(outputLimit)` 把它绑定到本机；它的 `run` 是 `runCommand`，后者不经 shell、不开窗口地运行命令，并保留输出的末尾。`findOnPath(name, host)` 在 `PATH` 的绝对路径条目中查找程序，Windows 上带 `.exe`。Blender 与 GIMP 服务器以这两种方式读取各自的运行时，并以这种方式解包。

<a id="run-the-worker"></a>
### 运行工作进程

`JsonLineWorker.start(spec, signal)` 依据 `spec.argv` spawn 一个工作进程（其第一个元素是可执行程序的绝对路径），工作目录为 `spec.cwd`，完整环境为 `spec.env`；希望工作进程继承 `process.env` 的调用方需自行将其合并进去。工作进程与客户端交换 UTF-8 JSON 行：

```text
stdin  request   {"id": 1, "method": "<method>", "params": {"<name>": <JSON value>}}
fd 3   ready     {"ready": true, "protocol": 1, "app": "<app>", "version": "<app version>", "python": "<Python version>"}
fd 3   success   {"id": 1, "ok": true, "result": <JSON value>}
fd 3   failure   {"id": 1, "ok": false, "error": {"type": "<exception class>", "message": "<text>", "traceback": "<text>"}}
```

- `python` 写明 Python 工作进程的 Python 版本；不运行 Python 的工作进程省略该字段。
- 工作进程在 fd 3 上的第一行必须是就绪行，并且须在 `spec.readyTimeoutMs` 内写出。否则客户端会终止工作进程及其进程组，排空其输出，并以 `WORKER_START_FAILED` 拒绝启动；被取消的启动在同样的清理之后以中止原因拒绝。
- 请求按调用顺序逐个执行，每条回复都携带待处理请求的 id；`traceback` 可选。请求的 `timeoutMs` 从请求写入 stdin 时开始计时。
- 回复使用 fd 3，因此应用程序自身在 stdout 与 stderr 上的输出不会与回复混杂。客户端把这些输出的最后 `spec.logTailBytes` 字节保留为日志尾部，用于诊断。
- 取消排队中的请求只会把它移出队列。取消已派发的请求会停止工作进程，与超时相同，因为此时工作进程的状态未知。
- `close(graceMs)` 发送 `shutdown` 请求并关闭 stdin。若 `graceMs` 后仍未退出，它向工作进程的进程组发送 SIGTERM，再过 `graceMs` 后发送 SIGKILL。工作进程可以在退出前回复 `shutdown` 请求。已被停止（例如因超时）的工作进程在停止时已收到 SIGKILL，因此 `close` 不再向它发送 SIGTERM，只等待它退出。
- 在 POSIX 上，工作进程是其自身进程组的组长。工作进程退出或被停止时，客户端向该进程组中剩余的每个进程发送 SIGKILL。

工作进程的失败是带有 `code` 的 `WorkerError`，只有 `WORKER_REMOTE` 会让工作进程继续运行。已停止的工作进程以其第一次失败拒绝后续请求；由其所有者启动新的工作进程。超出范围的预算（例如为零的 `timeoutMs`）会抛出 `RangeError`。

| `code` | 原因 | 之后的工作进程 |
|---|---|---|
| `WORKER_REMOTE` | 工作进程回复 `ok: false`；错误携带 `remoteType` 与 `traceback` | 继续运行并保留状态 |
| `WORKER_TIMEOUT` | 在请求的 `timeoutMs` 内没有回复 | 被终止；状态丢失 |
| `WORKER_PROTOCOL` | 某行不是有效回复、回复了不在等待中的 id，或某行超过 32 MiB | 被终止；状态丢失 |
| `WORKER_EXITED` | 工作进程已退出、已关闭，或在已派发的请求被取消后被停止 | 已不存在；状态丢失 |
| `WORKER_START_FAILED` | 工作进程无法 spawn，或其在 fd 3 上的第一行不是按时写出的有效就绪行 | 被终止 |
| `WORKERS_BUSY` | 某个 Session 的第一次调用发现工作进程数已达工作进程上限，且每个都在运行调用（[每个 Session 一个工作进程](#one-worker-per-session)） | 未启动工作进程 |
| `LOW_MEMORY` | 启动工作进程时可用内存少于 `minAvailableMemoryBytes`，停止其他 Session 的空闲工作进程后仍然不足（[每个 Session 一个工作进程](#one-worker-per-session)） | 未启动工作进程 |

<a id="one-worker-per-session"></a>
### 每个 Session 一个工作进程

`WorkerPool({ app, root, start, takeNotes, maxWorkers, minAvailableMemoryBytes, idleTimeoutMs, requestTimeoutMs, closeGraceMs })` 为每个作用域保留一个 `WorkerSupervisor`，`call(scope, method, params, options)` 在该作用域的工作进程上执行一个工作进程方法。对于指明其 Session 的调用（[提供工具](#serve-the-tools)），`runAppMcpServer` 把作用域命名为 `session:<id>`，对于未指明的调用命名为 `shared`，把 `<dataRoot>/workers/` 作为池的 `root`，并把按电脑内存与处理器确定的工作进程上限作为 `maxWorkers`（[运行服务器进程](#run-the-server-process)）。按默认设置，8 GiB 内存的电脑每个应用程序运行一个工作进程，16 GiB 内存、8 个逻辑处理器的电脑运行两个，32 GiB 内存、16 个逻辑处理器的电脑运行四个。可选的 `availableMemory()` 读取当前可用内存，默认为 `process.availableMemory()`。

- 同一作用域的调用按顺序执行；不同作用域的调用同时执行。
- 作用域的第一次调用会创建其 supervisor，后者启动时先在池所在进程的文件夹中建立编号文件夹 `<root>/<pid>/<n>`，再调用 `start(signal, { key, directory })`。各作用域的启动一次只运行一个，启动结束后 `takeNotes` 立即交出的说明属于该作用域；`takeNotes(scope)` 把它们交给该作用域的下一个结果。
- 已有 `idleTimeoutMs` 没有运行调用的工作进程会停止，其文件夹在它退出后删除。
- 已有 `maxWorkers` 个作用域拥有工作进程时，新的作用域会停止最久未使用且没有运行调用的工作进程；每个工作进程都在运行调用时，新作用域的调用以 `WORKERS_BUSY` 失败，不启动任何进程。
- 每次启动（作用域的第一次启动，或其工作进程停止后的启动）都先读取可用内存。可用内存少于 `minAvailableMemoryBytes` 时，启动会停止另一个作用域中最久未使用、正在运行且没有运行调用的工作进程，等它退出后再次读取；没有这样的工作进程时，调用以 `LOW_MEMORY` 失败，不启动任何进程。该数值涵盖整台电脑，因此其他应用程序服务器的进程、Godot 的游戏与其他程序都计入其中。`minAvailableMemoryBytes` 为 0 时不读取。
- 工作进程因上述任一原因停止后，该作用域的下一次调用以 `WORKER_EXITED` 失败，消息说明原因并以 `; its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker.` 结尾；之后的调用会启动新的工作进程。池为最近 256 个这样的作用域记住这一点。
- `prepare()` 删除 `root` 中已退出的服务器进程的文件夹，以及以本进程 id 命名、由使用过同一 id 的先前进程留下的文件夹；它保留仍在运行的进程的文件夹（例如仍在关闭的旧服务器），以及不是进程 id 的名称。`close()` 以 `WORKER_EXITED` 拒绝后续调用，关闭每个 supervisor，并删除本进程的文件夹。

### 停止后重启

`WorkerSupervisor(start, { requestTimeoutMs, closeGraceMs })` 拥有一个作用域的工作进程，`call(method, params, { timeoutMs, signal })` 通过它执行一个工作进程方法：

- 调用按调用顺序逐个执行；没有工作进程在运行时，调用通过 `start(signal)` 启动一个工作进程。`timeoutMs` 默认为 `requestTimeoutMs`，并像 MCP 客户端的工具调用预算一样从调用时开始计算：等待过先前调用的调用只得到剩余的时间；等待耗尽全部预算的调用以 `WORKER_TIMEOUT` 拒绝且不执行，工作进程及其状态保持不变。
- `WORKER_REMOTE` 原样传出，工作进程保留其状态。
- 正在运行的调用遇到其他任何 `WorkerError` 时，会等到工作进程完全退出，再以相同的 code 拒绝，其消息以 `; its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker` 结尾。
- 当工作进程在两次调用之间退出，或正在运行的调用被取消时，下一次调用不会执行：它以同样结尾的 `WORKER_EXITED` 消息失败，再下一次调用才启动新的工作进程。
- 启动失败或被取消时不报告状态丢失，下一次调用会再次尝试启动工作进程。在调用到达工作进程之前取消它，工作进程会继续运行。

`close()` 以 `WORKER_EXITED` 拒绝后续调用，取消正在运行的调用，等待所有调用结束，然后以 `closeGraceMs` 关闭工作进程。

### 把随包文件复制到真实路径

打包后的 Desktop 应用把包文件保存在其 `app.asar` 归档中，只有 Electron 的 `fs` 能够读取；Blender、GIMP、Godot 与 SuperCollider 需要普通文件。`materializePayload(source, dataRoot)` 通过 `file:` URL `source` 的路径读取文件（Electron 的 `app.asar` 支持会解析该路径），并返回位于 `<dataRoot>/payload/<first 16 hex digits of the content's SHA-256>/<file name>` 的副本的真实路径。

- 字节完全相同的副本会被直接复用，不再写入；字节不同的副本会被替换。
- 字节先写入同一目录中的临时文件，再重命名到目标位置，因此读取方永远不会看到不完整的文件。副本的权限模式为 `0o644`（应用 umask 之前）。
- 每个内容版本都有各自的目录。
- 不是 `file:` URL 的 `source` 会抛出 `TypeError`；读写失败会以文件系统错误拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

三个进程参与其中：宿主、MCP 客户端依据入口启动的服务器进程，以及服务器在应用程序内启动的工作进程。只有服务器进程使用 MCP 通信。让应用程序不进入 MCP 流，服务器就能在不启动应用程序的情况下响应工具发现，把工作进程崩溃作为工具结果返回而不是丢失连接，并且无需重连 MCP 即可重启工作进程。MCP SDK 的 stdio 客户端可能在正式提供服务的进程之前启动一个短暂存在的服务器副本；由于第一次工具调用之前不会启动工作进程，该副本从不启动应用程序。

| 文件 | 内容 |
|---|---|
| [`src/index.ts`](src/index.ts) | 共享的 `AppMcpConfig` 字段与包的导出；Config schema 放在这里，配置目录才能读取各插件中的展开 |
| [`src/plugin.ts`](src/plugin.ts) | `registerAppMcpPlugin`：路径检查、取自 Config 的服务器选项，以及插件模块旁的入口 |
| [`src/register.ts`](src/register.ts) | 宿主注册、通过 tsx 的源码启动，以及固定的管理器条目字段 |
| [`src/options.ts`](src/options.ts) | `argv[2]` 选项编解码、共享的选项字段及其校验 |
| [`src/app-server.ts`](src/app-server.ts) | 服务器进程主体：选项、工作进程脚本副本、工作进程池，以及每个调用方 Session 的工具 |
| [`src/pool.ts`](src/pool.ts) | 每个 Session 作用域一个 supervisor、工作进程文件夹、串行启动、空闲停止、腾出位置、启动前的内存检查与状态丢失通知 |
| [`src/machine.ts`](src/machine.ts) | 电脑的内存与处理器、它们允许的进程上限、内存检查及其消息 |
| [`src/session-scope.ts`](src/session-scope.ts) | Session 作用域能力与 `_meta` 键，以及从调用中读取发起调用的 Session |
| [`src/mcp-server.ts`](src/mcp-server.ts) | console 重定向、工具注册、结果映射与上限、失败文本以及关闭 |
| [`src/tools.ts`](src/tools.ts) | 工具辅助函数与 `execute_python` 工具 |
| [`src/setup-host.ts`](src/setup-host.ts) | setup host 以及可执行文件与版本的辅助函数 |
| [`src/shipped-runtime.ts`](src/shipped-runtime.ts) | 插件包的运行时文件夹与 `runtime.json` 查找 |
| [`src/supervisor.ts`](src/supervisor.ts) | 延迟启动、串行调用、状态丢失消息以及关闭 |
| [`src/json-line-worker.ts`](src/json-line-worker.ts) | spawn、行解析、超时、取消、进程组信号以及日志尾部 |
| [`src/materialize.ts`](src/materialize.ts) | 按内容寻址的载荷副本 |
| [`tests/fixtures/fake-worker.mjs`](tests/fixtures/fake-worker.mjs) | 代替 Python 工作进程的协议 fixture（测试前置数据） |
| [`tests/fixtures/source-server.ts`](tests/fixtures/source-server.ts) | 只能通过源码启动运行的 TypeScript 服务器入口 |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | 使用真实 MCP 管理器、MCP 客户端与工具运行时的完整链路 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [游戏开发工具](../README.zh.md)：本包组及其各包如何连接。
- [MCP 管理器](../../mcp/mcp-manager/README.zh.md)：已配置的服务器与插件注册的服务器。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md)：工具命名、结果投影、图像与重连。

-----

<a id="model-experience"></a>
## 模型体验

### 已注册服务器的工具与指令

#### 模型看到什么

本包不添加自己的系统提示词文本，它唯一的工具定义是下文的 `execute_python` 工具。在消费方的注册有效期间，模型会看到该服务器的工具（例如 `mcp__wasd_blender__<tool>`）及其 `AppTool` 条目的描述与输入 schema，并在系统提示词中看到服务器的 `instructions`，呈现方式由 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)决定。服务器列出工具时不启动工作进程，因此无论应用程序能否启动，这些工具都会出现。

#### Token 影响

消费方的工具描述、输入 schema 与指令在服务器连接期间进入每个请求；本包只向其中添加 `execute_python` 的参数描述。

#### KV Cache 影响

服务器保持连接且工具列表不变时，工具定义与指令保持请求前缀稳定。加载或卸载插件，或耗尽五次重连尝试，会添加或移除它们，并可能使缓存复用从第一个变化的工具定义或系统消息文本起失效。

### 工具结果文本与图像

#### 模型看到什么

成功的结果是一个文本块，其后依次是工具的图像。被截断的文本以 `[output truncated: <n> more characters]` 结尾；每张无法发送的图像都会在其位置变成一条文本提示：`[image omitted: as base64 it exceeds the 4 MiB limit for one image; request a smaller image]`、`[image omitted: as base64 the images of this result exceed their 6 MiB total limit; request fewer or smaller images]` 或 `[image unavailable: <reason>]`。已发送的图像以图像还是以文本诊断的形式进入上下文，由 MCP 客户端决定。

#### Token 影响

文本块的上限是 1 MiB 的 JSON 编码文本，图像的上限是每张 4 MiB、每个结果 6 MiB 的 base64；文本与已准入的图像保留在上下文中，直到压缩（compaction）。

#### KV Cache 影响

仅追加：每个结果都接在已有请求前缀之后，不改变任何更早的请求文本。

### `execute_python` 工具

#### 模型看到什么

工具的标题与描述由消费方提供。其输入 schema 包含 `code`（必填字符串，1 到 200,000 个字符，描述为 `Python source to run.`）与 `timeout_seconds`（可选整数，取值从 1 到以整秒计的 `maxTimeoutMs`，且至少为 1，描述为 `Seconds before <app> is stopped and restarted (default <requestTimeoutMs in seconds>).`）。结果文本最多有三部分，以空行分隔：代码抛出异常时的 traceback，或 traceback 为空时的 `<type>: <message>`；`result` 不为 null 时的 `result: ` 及其 JSON；有打印输出时的 `output:` 及其后的打印输出。三部分都没有时，文本为 `Done. The code assigned no result and printed nothing.`。抛出的异常使结果成为错误结果。待报告的安装说明排在最前；回复不匹配时，调用以 `The <app> worker sent an unexpected execute_python reply:` 及不匹配之处失败。

#### Token 影响

两个参数的 schema 在消费方的标题与描述之外约占 240 个字符的 JSON。结果文本承载工作进程返回的内容（其打印输出与 `result` 由工作进程限定上限），并保留在上下文中，直到压缩。

#### KV Cache 影响

同一配置只产生一种声明，因此工具定义前缀保持稳定；更改 `requestTimeoutMs` 或 `toolCallTimeoutMs` 会改变 `timeout_seconds` 的 schema。结果仅追加。

### 工作进程失败结果

#### 模型看到什么

失败的调用以失败的工具调用形式到达模型，携带错误消息；若为工作进程失败，还携带工作进程 traceback 的末尾、`Recent worker output:` 及其 stdout 与 stderr 的末尾，以及 `Error code: <code>`，各部分以空行分隔。工作进程已停止时，消息以 `; its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker` 结尾。工作进程在两次调用之间退出，或正在运行的调用被取消之后，下一次调用不会执行，而是以这样的 `WORKER_EXITED` 消息失败，再下一次调用才启动新的工作进程。上限拒绝的启动以 `WORKERS_BUSY` 失败，告诉模型等其他对话的调用结束后再调用；或以 `LOW_MEMORY` 失败：`The computer has <available> of memory available, less than the <required> that starting a <app> worker needs, so it did not start.`，后接建议：停止不需要的游戏、等待其他工作结束，或请用户关闭程序。

#### Token 影响

traceback 部分最多增加 4,000 个字符，工作进程输出部分最多增加 2,000 个字符；整段文本与结果文本一样在 1 MiB JSON 处截断，失败的调用保留在上下文中，直到压缩。

#### KV Cache 影响

仅追加，与其他工具结果相同；失败不会改变任何更早的请求文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下约束适用于基于本库构建的每个服务器。

- **连接的 agent 共享一个工作进程**：通过 WASD Engine 的 MCP 服务器连接的 agent 发起的调用不指明 Session，因此所有连接的 agent 使用 `shared` 工作进程及其应用程序状态，其调用在正在运行的调用之后排队。它们的指令说明了这一点。
- **每个 Session 的工作进程都是一个进程**：最多同时运行工作进程上限个应用程序进程，各自占用内存；多个 Session 中的渲染等 CPU 密集型工作会彼此拖慢。在 Apple M3 Pro 上，以 1280×720 渲染一次 Blender 默认场景的内存峰值为 1.5 GiB（Cycles）到 1.7 GiB（EEVEE），因此默认的 `workerMemoryBytes` 为每个工作进程预留电脑的 8 GiB。
- **每个应用程序各有上限**：Blender、GIMP 与 SuperCollider 各自确定工作进程上限，因此三者合计最多可运行单个上限的三倍，另外还有 Godot 的游戏。它们共享的是读取整台电脑数值的内存检查。
- **内存检查只针对启动**：工作进程启动后若继续增长（例如加载大场景或渲染），不会被停止；检查会拒绝下一次启动。该数值来自操作系统：在 macOS 上为空闲页加上非活跃、推测与可清除页，不含系统通过压缩或交换才能释放的内存。
- **子 agent 有自己的工作进程**：子 agent 的 Session 有自己的 id，因此它看不到启动它的 Session 的场景或图像；两者之间通过已保存的文件传递工作。
- **空闲停止与腾出位置会丢失状态**：因 `workerIdleTimeoutMs` 内没有调用而停止，或为其他 Session 腾出位置而停止的工作进程，会丢失尚未写入磁盘的内容。
- **停止会丢失应用程序状态**：超时、崩溃、协议违规或取消正在运行的调用都会停止工作进程。本库不保存也不恢复任何内容，因此应用程序尚未写入磁盘的工作会丢失。
- **只重定向 console**：`serveAppMcp` 在启动时重定向全局 `console`。在该调用之前写出的输出，或直接写入 `process.stdout` 的输出，会进入只应承载 MCP 帧的 MCP 流。
- **固定的结果上限**：文本在 1 MiB JSON 处截断，图像仅限 PNG 与 JPEG，每张不超过 4 MiB、每个结果不超过 6 MiB 的 base64。本库不会缩小图像，因此工作进程必须在这些上限内生成图像。超过 32 MiB 的回复行会停止工作进程。
- **固定的连接策略**：消费方不能更改 15 s 的关闭预算或重连策略。连续 5 次重连尝试失败后，MCP 客户端会移除该服务器的工具，直到通过 MCP 管理器重启该服务器、插件重新加载或宿主重启。
- **载荷副本不断累积**：随包文件的每个内容版本都在 `<dataRoot>/payload/` 下保留各自的目录；本库从不删除较早的版本。
- **源码入口需要检出中的 tsx**：`.ts` 服务器入口从仓库的 `node_modules` 解析 `tsx/esm`，并读取仓库的 `tsconfig.base.json`，因此只有 harness 的源码检出才能注册这种入口；已构建或打包的 harness 注册 `.js` 入口。
- **等待时间计入工具调用预算**：工作进程请求为 `toolCallTimeoutMs` 留出的 30 s 涵盖工作进程启动和结果，但不涵盖先排在其他调用之后、或先等待耗时较长的首次安装的调用。这样的调用仍可能达到 MCP 客户端的预算，客户端随即取消它。
- **Windows 进程树**：Windows 没有进程组。停止工作进程会对其进程树运行 `taskkill /T /F`，因此关闭流程中的 SIGTERM 步骤已经是强制终止；工作进程自行退出后仍在运行的、由它启动的进程不会被停止。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
