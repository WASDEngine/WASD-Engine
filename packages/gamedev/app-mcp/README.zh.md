---
description: "构建以无界面方式运行桌面应用程序的 MCP 服务器，供 Blender、GIMP 等应用程序包使用：共享的插件 Config 字段、向 MCP 管理器注册以及通过 tsx 的源码启动、服务器进程主体、工具辅助函数与 execute_python 工具、JSON 行工作进程协议与重启、工具结果上限，以及把随包文件复制到 app.asar 之外。"
kind: "package-reference"
---

# @deepseek-ai/dsh-app-mcp

[English](README.md) | 中文

## 概述

把 Blender、GIMP 等桌面应用程序放在 MCP 工具之后，以无窗口方式运行。宿主插件把共享的 `AppMcpConfig` 字段展开到自己的 Config 中并调用 `registerAppMcpPlugin`；其服务器入口以该应用程序的工具调用 `runAppMcpServer`。第一次工具调用会启动一个长期运行的工作进程，调用逐个执行。超时、崩溃或协议违规会停止工作进程：失败的调用会报告状态已丢失，之后的调用会启动新的工作进程。共用的安装与工具辅助函数、`execute_python`，以及把随包脚本复制到 `app.asar` 之外的 `materializePayload` 构成本包的其余部分。

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

Blender 与 GIMP 包依赖本库构建各自的 MCP 服务器；[Blender 的插件](../blender/src/index.ts)与[服务器入口](../blender/src/worker.ts)展示了一个完整的消费方。Godot 包只使用 `materializePayload` 复制其 harness 脚本。当外部应用程序必须在 agent（智能体）调用的工具之后以无界面方式运行，并且应用程序内的脚本能够响应下文所述的 JSON 行请求时，使用本库。

### 配置插件

插件的 `Config` 接口扩展 `AppMcpConfig`，其 schema 把 `AppMcpConfig.dict` 展开到自己的对象 schema 中，因此每个 app MCP 插件都以相同的默认值与取值范围提供下列字段。每个预算都是 1 到 2,147,483,647 之间的整数毫秒数。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `toolCallTimeoutMs` | `900,000` | 一次工具调用的预算，包括工作进程启动及其首次使用时的安装；一次工作进程请求（包括 `execute_python` 的超时）最多可用到其中除最后 30 s 以外的全部时间 |
| `requestTimeoutMs` | `600,000` | 一次工作进程请求的默认预算，至少比 `toolCallTimeoutMs` 少 30 s；到期时工作进程停止，其状态丢失 |
| `graceMs` | `3,000` | 工作进程在收到 `shutdown` 请求后、以及收到 SIGTERM 后各有的退出时间，之后发送 SIGKILL |
| `maxLogBytes` | `65,536` | 为错误消息保留的最近工作进程输出及安装命令输出的字节数；取正整数 |

插件自行声明并说明 `dataRoot`（它拥有的绝对目录）与 `startupTimeoutMs`，因为它们的含义因应用程序而异。

### 注册服务器

`registerAppMcpPlugin(ctx, config, plugin)` 是这类插件的全部 `apply`，该插件的 `inject` 必须包含 `mcpManager`：

- `dataRoot` 以及 `plugin.paths` 所列的 Config 字段必须是绝对路径或为空；否则它抛出以 `<plugin.app> plugin:` 开头并指明字段的错误。
- `requestTimeoutMs` 最多为 `toolCallTimeoutMs` 减去 30 s；否则它抛出以 `<plugin.app> plugin:` 开头并指明两个预算的错误。这 30 s 留给工作进程启动和结果的返回，因此用完时间的请求会以它自己的错误失败，而不会等到 MCP 客户端放弃该调用并以笼统的超时取消它。
- 服务器收到 `dataRoot`、`requestTimeoutMs`、`toolCallTimeoutMs`、`graceMs`、`maxLogBytes`，以及 `plugin.options` 所列的 Config 字段，每个都使用其 Config 名称。
- 当 `plugin.module`（插件的 `import.meta.url`）以 `.ts` 结尾时，服务器入口是它旁边的 `worker.ts`，否则是它旁边的 `worker.js`。
- 注册通过 `registerAppMcpServer` 完成，使用 `plugin.serverName` 以及 Config 中的 `toolCallTimeoutMs` 与 `startupTimeoutMs`。

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

### 运行服务器进程

`runAppMcpServer(definition, process.argv)` 是服务器入口的全部主体。`definition` 给出服务器的 `name`、`version` 与 `instructions`、随包 `workerScript` 的 `file:` URL，以及三个函数：

- `parseOptions(value)` 校验解码后的选项。服务器用 `AppServerOptionFields`（每个服务器都会收到的 `AppServerOptions` 字段）与自身的字段构建其严格 schema，并调用 `parseAppServerOptions(app, schema, value)`。该函数抛出以 `<app> MCP server options are invalid:` 开头、指明每个缺失、无效或未知字段的错误。
- `workers(options, dependencies)` 创建应用程序的 `AppWorkers`。其 `start(signal)` 准备应用程序，并通过 `dependencies.start`（即 `JsonLineWorker.start`）启动一个工作进程；`dependencies.workerScript()` 返回工作进程脚本在 `dataRoot` 下的 `materializePayload` 副本的真实路径。其 `takeNotes()` 交出自上次调用以来收集的安装说明，例如已启动工作进程的版本。
- `tools(dependencies)` 以 `AppToolDependencies` 构建工具：`call` 通过一个 `WorkerSupervisor` 执行工作进程方法，其预算是 `requestTimeoutMs` 与 `graceMs`；`takeNotes` 读取应用程序的说明；`dataRoot`、`requestTimeoutMs` 与 `maxTimeoutMs`（即 `toolCallTimeoutMs` 减去 30 s）携带路径与预算。

服务器开始提供服务后它即返回；服务器关闭时会关闭 supervisor（监管器），后者停止工作进程。`argv[2]` 不含选项，或 `parseOptions` 拒绝选项时，它在提供任何服务之前即拒绝。

### 提供工具

`runAppMcpServer` 通过 `serveAppMcp({ name, version, instructions, tools, onClose })` 提供工具，服务器入口也可以直接调用该函数。它首先把全局 `console` 指向 stderr，使 stdout 只承载 MCP 帧，并在关闭时恢复 console。服务器立即响应工具发现，不启动任何其他内容；只有客户端调用某个工具时，该工具才会运行。工具名称重复时，`serveAppMcp` 在开始提供服务之前即拒绝。

每个 `AppTool` 都有 `name`、可选的 `title`、`description`，以及 Zod raw shape 形式的 `input`，SDK 据此校验参数。它的 `run(args, signal)` 返回 `AppToolResult`。服务器关闭时，以及客户端取消调用时，该中止信号都会触发；MCP 客户端在其 `toolCallTimeoutMs` 到期时也会取消调用。

服务器把 `AppToolResult` 映射为 MCP 内容：

- `text` 成为第一个文本块。JSON 编码超过 1 MiB 的文本保留前 174,762 个 UTF-16 码元，不拆分代理对，其后附加 `[output truncated: <n> more characters]`。
- `images` 依次排在其后，类型为 `image/png` 或 `image/jpeg`。每张图像取自其 `data` 字节；没有 `data` 时取自 `path` 处的文件，服务器读取该文件并保留原文件。服务器不会缩放图像。
- base64 编码后超过 4 MiB（即 3 MiB 字节）的图像，或会使结果中图像的 base64 总量超过 6 MiB 的图像，会变成要求提供更小图像的 `[image omitted: …]` 文本提示；之后能放下的图像仍会包含在内。无法读取的文件，或既无 `data` 也无 `path` 的图像，会变成 `[image unavailable: <reason>]`。
- `isError: true` 把结果标记为失败。MCP 客户端随后以结果的文本使调用失败，因此其中的图像只会以客户端文本诊断的形式到达模型。

抛出的错误会变成只含一个文本块的错误结果：错误消息，以及对 `WorkerError` 而言，工作进程 traceback 的最后 4,000 个字符、`Recent worker output:` 之后其日志尾部的最后 2,000 个字符，以及 `Error code: <code>`。

以下情况中最先发生的一种会让服务器关闭：stdin 结束或关闭；MCP 传输自行关闭，即 stdout 写入失败（例如客户端离开后出现 EPIPE）或收到的消息超出其读取缓冲区时；或者收到 SIGTERM 或 SIGINT。服务器关闭 MCP 连接（这会中止正在运行的工具调用），然后最多等待 `onClose` 10 s，且只执行一次。它在 stderr 上报告失败或未完成的 `onClose`，并以退出码 0 退出。信号监听器一直保留到进程退出，因此重复的 SIGTERM（MCP 客户端升级关闭时会发送）不能在 `onClose` 完成之前结束进程。对 stderr 的写入尽力而为：写入失败会被忽略。消费方在 `onClose` 中停止其工作进程，例如调用 `supervisor.close()`。

### 构建工具

以下辅助函数承载各应用程序工具集共用的部分：

- `defineAppTool(tool)` 按工具的 `input` shape 为其 `run` 参数确定类型，并返回可放入工具列表的工具。
- `workerParams(args)` 把已校验的参数转为工作进程参数，省略的参数不出现。
- `replyParser(app)` 返回一个按 Zod schema 校验工作进程回复的函数；不匹配时抛出 `WorkerReplyError`，其消息以 `The <app> worker sent an unexpected <method> reply:` 开头并指明每处不匹配。
- `withSetupNotes(dependencies, result)` 把待报告的安装说明放在结果文本之前，每条之后跟一个空行；`takeNotes` 每条说明只交出一次。
- `formatBytes(bytes)` 把文件大小写成 `512 bytes`、`2.0 KiB` 或 `5.0 MiB`。
- `executePythonTool(dependencies, { app, title, description })` 是以 Python 脚本驱动的应用程序的 `execute_python` 工具；[模型体验](#model-experience)展示其声明与结果文本。
- `AGENT_IMAGE_MAX_EDGE`（1,568 像素）与 `AGENT_IMAGE_MAX_BYTES`（3 MiB，其 base64 形式正好占满单张图像可用的 4 MiB）规定工具向工作进程请求的图像大小。

### 查找应用程序

服务器通过 `SetupHost`（setup host，安装环境宿主）查找其应用程序：服务器进程的平台、环境与主目录，判断用户可执行的普通文件的 `isExecutable`，把缺失或不可访问的目录列为空的 `listDirectory`，以及 `makeDirectory`。`nodeSetupHost()` 把它绑定到本机；测试传入假的 host。`firstExecutable(candidates, host)` 返回第一个通过 `isExecutable` 的候选路径；`newestFirst` 按名称中的数字从新到旧排序，因此 `Blender 4.10` 排在 `Blender 4.2` 之前，`GIMP 3.0.1` 排在 `GIMP 3.0` 之前。`CommandArgv` 表示一个绝对路径的可执行程序及其参数。

### 运行工作进程

`JsonLineWorker.start(spec, signal)` 依据 `spec.argv` spawn 一个工作进程（其第一个元素是可执行程序的绝对路径），工作目录为 `spec.cwd`，完整环境为 `spec.env`；希望工作进程继承 `process.env` 的调用方需自行将其合并进去。工作进程与客户端交换 UTF-8 JSON 行：

```text
stdin  request   {"id": 1, "method": "<method>", "params": {"<name>": <JSON value>}}
fd 3   ready     {"ready": true, "protocol": 1, "app": "<app>", "version": "<app version>", "python": "<Python version>"}
fd 3   success   {"id": 1, "ok": true, "result": <JSON value>}
fd 3   failure   {"id": 1, "ok": false, "error": {"type": "<exception class>", "message": "<text>", "traceback": "<text>"}}
```

- 工作进程在 fd 3 上的第一行必须是就绪行，并且须在 `spec.readyTimeoutMs` 内写出。否则客户端会终止工作进程及其进程组，排空其输出，并以 `WORKER_START_FAILED` 拒绝启动；被取消的启动在同样的清理之后以中止原因拒绝。
- 请求按调用顺序逐个执行，每条回复都携带待处理请求的 id；`traceback` 可选。请求的 `timeoutMs` 从请求写入 stdin 时开始计时。
- 回复使用 fd 3，因此应用程序自身在 stdout 与 stderr 上的输出不会与回复混杂。客户端把这些输出的最后 `spec.logTailBytes` 字节保留为日志尾部，用于诊断。
- 取消排队中的请求只会把它移出队列。取消已派发的请求会停止工作进程，与超时相同，因为此时工作进程的状态未知。
- `close(graceMs)` 发送 `shutdown` 请求并关闭 stdin。若 `graceMs` 后仍未退出，它向工作进程的进程组发送 SIGTERM，再过 `graceMs` 后发送 SIGKILL。工作进程可以在退出前回复 `shutdown` 请求。
- 在 POSIX 上，工作进程是其自身进程组的组长。工作进程退出或被停止时，客户端向该进程组中剩余的每个进程发送 SIGKILL。

工作进程的失败是带有 `code` 的 `WorkerError`，只有 `WORKER_REMOTE` 会让工作进程继续运行。已停止的工作进程以其第一次失败拒绝后续请求；由其所有者启动新的工作进程。超出范围的预算（例如为零的 `timeoutMs`）会抛出 `RangeError`。

| `code` | 原因 | 之后的工作进程 |
|---|---|---|
| `WORKER_REMOTE` | 工作进程回复 `ok: false`；错误携带 `remoteType` 与 `traceback` | 继续运行并保留状态 |
| `WORKER_TIMEOUT` | 在请求的 `timeoutMs` 内没有回复 | 被终止；状态丢失 |
| `WORKER_PROTOCOL` | 某行不是有效回复、回复了不在等待中的 id，或某行超过 32 MiB | 被终止；状态丢失 |
| `WORKER_EXITED` | 工作进程已退出、已关闭，或在已派发的请求被取消后被停止 | 已不存在；状态丢失 |
| `WORKER_START_FAILED` | 工作进程无法 spawn，或其在 fd 3 上的第一行不是按时写出的有效就绪行 | 被终止 |

### 停止后重启

`WorkerSupervisor(start, { requestTimeoutMs, closeGraceMs })` 拥有一个服务器进程的工作进程，`call(method, params, { timeoutMs, signal })` 通过它执行一个工作进程方法：

- 调用按调用顺序逐个执行；没有工作进程在运行时，调用通过 `start(signal)` 启动一个工作进程。`timeoutMs` 默认为 `requestTimeoutMs`。
- `WORKER_REMOTE` 原样传出，工作进程保留其状态。
- 正在运行的调用遇到其他任何 `WorkerError` 时，会等到工作进程完全退出，再以相同的 code 拒绝，其消息以 `; its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker` 结尾。
- 当工作进程在两次调用之间退出，或正在运行的调用被取消时，下一次调用不会执行：它以同样结尾的 `WORKER_EXITED` 消息失败，再下一次调用才启动新的工作进程。
- 启动失败或被取消时不报告状态丢失，下一次调用会再次尝试启动工作进程。在调用到达工作进程之前取消它，工作进程会继续运行。

`close()` 以 `WORKER_EXITED` 拒绝后续调用，取消正在运行的调用，等待所有调用结束，然后以 `closeGraceMs` 关闭工作进程。

### 把随包文件复制到真实路径

打包后的 Desktop 应用把包文件保存在其 `app.asar` 归档中，只有 Electron 的 `fs` 能够读取；Blender、GIMP 与 Godot 需要普通文件。`materializePayload(source, dataRoot)` 通过 `file:` URL `source` 的路径读取文件（Electron 的 `app.asar` 支持会解析该路径），并返回位于 `<dataRoot>/payload/<first 16 hex digits of the content's SHA-256>/<file name>` 的副本的真实路径。

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
| [`src/app-server.ts`](src/app-server.ts) | 服务器进程主体：选项、工作进程脚本副本、supervisor 与工具 |
| [`src/mcp-server.ts`](src/mcp-server.ts) | console 重定向、工具注册、结果映射与上限、失败文本以及关闭 |
| [`src/tools.ts`](src/tools.ts) | 工具辅助函数与 `execute_python` 工具 |
| [`src/setup-host.ts`](src/setup-host.ts) | setup host 以及可执行文件与版本的辅助函数 |
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

失败的调用以失败的工具调用形式到达模型，携带错误消息；若为工作进程失败，还携带工作进程 traceback 的末尾、`Recent worker output:` 及其 stdout 与 stderr 的末尾，以及 `Error code: <code>`，各部分以空行分隔。工作进程已停止时，消息以 `; its state (open files, scene, unsaved changes) was lost, and the next call starts a fresh worker` 结尾。工作进程在两次调用之间退出，或正在运行的调用被取消之后，下一次调用不会执行，而是以这样的 `WORKER_EXITED` 消息失败，再下一次调用才启动新的工作进程。

#### Token 影响

traceback 部分最多增加 4,000 个字符，工作进程输出部分最多增加 2,000 个字符；整段文本与结果文本一样在 1 MiB JSON 处截断，失败的调用保留在上下文中，直到压缩。

#### KV Cache 影响

仅追加，与其他工具结果相同；失败不会改变任何更早的请求文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下约束适用于基于本库构建的每个服务器。

- **每个服务器一个工作进程**：服务器的所有调用方共享其工作进程及其中的应用程序状态，调用在正在运行的调用之后排队，因此一次耗时较长的调用会延迟其余调用。
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
