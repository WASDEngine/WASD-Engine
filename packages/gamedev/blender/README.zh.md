---
description: "面向部署方与维护者的无界面 Blender MCP 工具：选择 bpy 模块后端或已安装 Blender 后端、配置数据目录与超时，或排查 mcp__wasd_blender__ 工具及其首次使用时的安装。"
kind: "package-reference"
---

# @deepseek-ai/dsh-blender

[English](README.md) | 中文

## 概述

让 agent（智能体）在没有窗口的 Blender 中检查、建模、渲染并导出 3D 资产：agent 通过渲染预览查看自己的成果，并为游戏导出 glTF 文件。WASD Engine 的 Web 与 Desktop 默认启用这些工具。首次工具调用会启动 Blender：Desktop 应用随附或 uv 安装的 `bpy` 模块，或以后台模式运行的已安装 Blender。每个对话都有自己的 Blender 会话和打开的场景，崩溃、超时或长时间没有调用都会使其丢失；`run_script` 在独立的 Blender 进程中运行批量脚本。

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

当 agent 需要以文件形式创建、检查或转换 3D 资产时，选用这些工具。插件启动自己的 Blender，从不连接用户已打开的 Blender 窗口。激活插件只会注册其 MCP 服务器 `wasd_blender`，不做其他事：首次工具调用之前不会下载、安装或启动 Blender，因此在没有 uv 或 Blender 的机器上插件也能加载。

### 默认组合

fork 的 patch 文件 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `blender` 行插入每个 Web 与 Desktop profile，并把它的数据目录放在 harness 主目录下：`~/.wasdengine/blender`；设置了 `DSH_HOME` 时为 `$DSH_HOME/blender`。

```yaml
- id: blender
  name: '@deepseek-ai/dsh-blender'
  config:
    dataRoot: !!js dshHomePath('blender')
```

插件需要 `mcpManager` 服务，由 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 组合包的 `mcp-manager` 行提供。在其他组合中，请在本行旁挂载 [`dsh-mcp-manager`](../../mcp/mcp-manager/README.zh.md)，并设置绝对路径的 `dataRoot`。

### 关闭工具或修改设置

profile patch 按 id 覆盖该行。把下面的条目加入 `$DSH_HOME/profiles/<name>/cordis.patch.yml`；未设置 `DSH_HOME` 时 `$DSH_HOME` 为 `~/.wasdengine`，标准 profile 名为 `web` 与 `desktop`。编辑 patch 后重启 Web 或 Desktop。插件页面「游戏工具」标签页上的开关（[`ui-game-tools`](../ui-game-tools/README.zh.md)）通过插件管理器添加或删除这一 `disabled` 条目，插件管理器随即应用更改，或说明更改需要重启后才生效。

```yaml
- id: blender
  disabled: true
```

禁用该行后，模型不再看到这些工具和服务器指令，正在运行的 Blender 也会停止。设置 `config` 的 patch 会替换该行的整个配置，因此请在要修改的字段旁重新写出 `dataRoot`：

```yaml
- id: blender
  config:
    dataRoot: !!js dshHomePath('blender')
    backend: app
    blenderPath: /Applications/Blender.app/Contents/MacOS/Blender
```

### 配置

[`src/index.ts`](src/index.ts) 声明并校验以下字段。`dataRoot`、`uvPath`、`blenderPath` 或 `addonStore` 为相对路径时，或 `requestTimeoutMs` 没有比 `toolCallTimeoutMs` 至少少 30 s 时，激活失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 存放托管的 bpy 环境及其 Python、Windows 版 Desktop 应用解包的运行时、预览、默认渲染结果、`run_script` 的结果和工作脚本副本的绝对目录 |
| `backend` | `auto` | 由哪种 Blender 运行工具：`auto`、`bpy` 或 `app`（见[后端](#backends)） |
| `bpyVersion` | `5.2.3` | `bpy` 包的版本，格式为 `major.minor.patch`：[随附的运行时](#shipped-bpy)只在其版本与此相同时运行，uv 也把这个版本安装到托管环境中 |
| `pythonVersion` | `3.13` | 托管环境的 Python 次版本号，格式为 `3.<minor>`；所用 bpy 版本必须支持它。随附的运行时自带 Python |
| `uvPath` | `''` | uv 可执行文件的绝对路径；为空时先搜索 `PATH`，再依次查找 `~/.local/bin/uv`、`/opt/homebrew/bin/uv` 与 `/usr/local/bin/uv`（Windows 上为 `%USERPROFILE%\.local\bin\uv.exe`） |
| `blenderPath` | `''` | Blender 可执行文件的绝对路径；为空时先使用 `BLENDER_PATH` 环境变量，再查找标准安装位置 |
| `toolCallTimeoutMs` | `900,000` | 单次工具调用的时限，包括首次使用时的 bpy 安装；一个 Blender 请求（包括 `execute_python` 的超时）最多可用到其中除最后 30 s 以外的全部时间，这 30 s 留给工作进程启动和结果 |
| `startupTimeoutMs` | `30,000` | MCP 服务器连接并列出工具的时限，也是每个 Blender 工作进程报告就绪的时限 |
| `requestTimeoutMs` | `600,000` | 单个 Blender 请求的默认时限，至少比 `toolCallTimeoutMs` 少 30 s；到期时工作进程停止，未保存的更改丢失 |
| `graceMs` | `3,000` | 工作进程在收到 `shutdown` 请求后、再在收到 SIGTERM 后各有这么长时间退出，之后收到 SIGKILL |
| `maxLogBytes` | `65,536` | 为错误消息保留的最近工作进程与 uv 输出的字节数 |
| `maxWorkers` | `4` | 同时运行的 Blender 工作进程上限，每个调用的 Session 一个，取值 1 到 16 |
| `workerIdleTimeoutMs` | `600,000` | Session 的 Blender 工作进程在没有调用多长时间后停止，其未保存的场景随之丢失 |
| `addonStore` | `''` | [游戏扩展](../game-addons/README.zh.md)存储目录的绝对路径，每个工作进程以 `WASD_ADDON_STORE` 接收它；为空时 `wasd_addons` 没有可用的扩展。WASDEngine 覆盖层把它设为 `game-addons` 行的 `blenderStore` |
| `maxScripts` | `4` | 任何电脑上同时运行的 [`run_script`](#script-runs) 运行数上限（无论来自哪些调用），取值 1 到 64；某台电脑的上限可能更低 |
| `scriptMemoryBytes` | `2,147,483,648`（2 GiB） | 每个 `run_script` 运行所需的电脑物理内存：同时运行的数量至多为电脑内存除以此值并四舍五入到整数；`0` 表示不考虑内存 |
| `scriptCores` | `2` | 每个 `run_script` 运行所需的逻辑处理器数：同时运行的数量至多为电脑的逻辑处理器数除以此值并向下取整；`0` 表示不考虑处理器 |
| `keptScriptResults` | `20` | `dataRoot` 下 `script-runs/` 中保留的 `run_script` 调用文件夹数，取值 1 到 1,000；新调用会删除超出此数量的最旧文件夹，仍在运行的调用的文件夹除外 |
| `scriptLogBytes` | `16,777,216`（16 MiB） | `run_script` 的每次运行在其 `output.log` 中保留的最多输出字节数，此后日志会说明其余输出已被省略 |

<a id="backends"></a>
### 后端

插件在每次启动工作进程时选择后端：首次工具调用时，以及工作进程停止后的那次调用时。因安装错误而安装 uv 或 Blender 后，再次调用工具即可，无需重启宿主。

- **`bpy`** 运行 Blender Python 模块：其 bpy 版本为 `bpyVersion` 时运行 [Desktop 应用随附的运行时](#shipped-bpy)，否则从 uv 在 `dataRoot` 下管理的虚拟环境中运行。首次启动时，uv 把 Python `pythonVersion` 安装到 `uv-python/`，并用 `bpy==<bpyVersion>` 构建 `venv-py<pythonVersion>-bpy<bpyVersion>/`，默认即 `venv-py3.13-bpy5.2.3/`。在 macOS arm64 上使用默认版本时，该环境约占 740 MB，Python 约占 70 MB，uv 还会在自己的缓存中保存下载的包。首次工具调用会等待安装完成，并在结果中报告；之后的启动复用该环境。环境路径上的目录若其 Python 不可执行（例如它在 `uv-python/` 下的解释器已被删除），会被一次全新的安装替换。bpy 模块无法启动时，调用失败并建议删除环境所在的文件夹，以便下一次启动重新安装。没有 uv 时，此后端失败并给出安装步骤。
- **`app`** 以后台模式和出厂设置运行已安装的 Blender，因此不会加载用户的启动文件和偏好设置。搜索顺序为 `blenderPath`、`BLENDER_PATH`、macOS 上的 `/Applications/Blender.app` 与 `~/Applications/Blender.app`、`PATH` 上的 `blender`，以及 Windows 上 `%ProgramFiles%\Blender Foundation` 下最新的 `Blender*` 文件夹。
- **`auto`** 在 Desktop 应用随附 bpy 或插件找到 uv 时使用 `bpy`，否则使用 `app`。uv 无法安装 bpy，或随附的、已安装的 bpy 模块无法启动时，`auto` 回退到已安装的 Blender，并在下一个工具结果中说明并引用失败信息；两者都不可用时，结果会说明如何安装 uv 或 Blender，或如何修复随附的运行时。

`uvPath`、`blenderPath` 或 `BLENDER_PATH` 的值不是可执行文件时，调用失败；插件不会继续搜索。

<a id="shipped-bpy"></a>
### Desktop 应用中的 bpy

Apple 芯片 macOS 版 Desktop 应用把 Blender 随附在本包的 `runtime/darwin-arm64/` 文件夹中，位于 `app.asar` 之外：CPython 3.13 加上 `bpy` 模块及其依赖的包，因此工具无需 uv、下载或已安装的 Blender。[`wasdengine/blender/BUILD.md`](../../../wasdengine/blender/BUILD.md) 说明如何用 python-build-standalone 的 CPython 和按 SHA-256 固定的 PyPI bpy wheel 构建该运行时。该文件夹的 `runtime.json` 写明 Python 程序及其 `bpy` 的版本；该版本为 `bpyVersion` 时，`auto` 与 `bpy` 后端先运行它，再考虑 uv 的环境；`bpyVersion` 不同时则选用 uv 的环境。服务器以 `-B` 启动工作进程，因此其 Python 不会在已签名的应用中写入字节码缓存，而是在每次启动时编译工作进程导入的模块，耗时不到一秒。`runtime.json` 不是 JSON、描述的是其他平台，或写明的 Python 不是可执行文件时，调用以 `BLENDER_RUNTIME_INVALID` 失败，消息提示重新安装 WASD Engine 或把 `backend` 设为 `app`。EEVEE 渲染（例如以 `material` 着色的 `render_preview`）通过窗口服务器访问 GPU，因此 macOS 把工作进程列为仅后台进程，它没有程序坞图标、菜单栏，也不出现在应用切换器中。运行时中的 `COPYING` 与 `SOURCE.txt` 载有 Blender 的许可证并写明对应的源代码。源码检出用 `wasdengine/blender/build.sh --out <dir> --install "$PWD/packages/gamedev/blender/runtime"` 把运行时安装到 git 忽略的文件夹中，此后工具像 Desktop 应用一样使用它。

Windows x64 版 Desktop 应用改为随附运行时的归档文件，放在 `runtime/win32-x64/` 中，并附带写明该归档及其 `runtime.json` 字段的 `archive.json`，因为运行时最深的文件在应用安装目录下会超过 Windows 260 个字符的路径长度限制。工作进程首次启动时，服务器用 Windows 自带的 `tar.exe` 把归档解包到 `dataRoot` 下的 `runtime/<version>/`，下一个工具结果以 `Unpacked the bpy runtime that WASD Engine ships into <folder> (first use).` 开头；之后的启动复用该文件夹。归档先解包到 `.partial-<8 个十六进制数字>` 同级文件夹，再重命名到位，因此中断的解包不会留下解包到一半的运行时；该位置上 Python 不可执行的文件夹会被替换。这个运行时不带 `-B` 运行，因此其字节码缓存留在 `dataRoot` 下。归档缺失、tar 无法解包，或其 `runtime.json` 描述的是另一个运行时时，调用以 `BLENDER_RUNTIME_INVALID` 失败；在 `auto` 下随后改由已安装的 Blender 运行工具，结果中会说明这一点。

<a id="tools"></a>
### 工具

模型以 `mcp__wasd_blender__<name>` 调用每个工具，所有路径参数都是绝对路径。结果是文本，`render_preview`、`render` 以及带 `preview` 的 `execute_python` 调用另附一张图像；调用失败时返回错误结果，其文本说明原因。通过 WASD Engine 的 MCP 服务器 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 连接的 agent 以 `blender_<name>` 调用同样的工具，这些工具还接受 `session` 与 `project`（[每个对话一个 Blender 会话](#one-blender-session)）。该服务器指令的概述用 [`src/instructions.ts`](src/instructions.ts) 中的 `BLENDER_GAME_MCP_DESCRIPTION` 向它们介绍本插件：Blender 能做出代码构建的基本体无法企及的真实形状、倒角和烘焙纹理，因此玩家看到的每个模型（agent 下载的除外），以及游戏在运行时构建的网格的各个部件，都应来自 Blender；而 Godot 中的 `.glb` 仍会使用游戏的着色器、动画和逐实例变化。

| 工具 | 参数 | 结果 |
|---|---|---|
| `scene_info` | 无 | JSON：文件及其未保存更改标志，自场景被打开、创建或保存以来有工具更改过场景时该标志为 true，每次 `execute_python` 调用都算作一次更改；场景、帧范围、渲染设置与相机、单位、集合树、最多 300 个对象（含变换、尺寸、材质、修改器、可见性和求值后的三角面数），以及数据块计数 |
| `object_info` | `name` | JSON：局部与世界变换、世界包围盒、可见性、网格统计、相机、灯光、骨架或空物体设置、修改器、带节点与纹理的材质、约束、自定义属性和动画；名称不存在时调用失败，并给出最多五个相近名称 |
| `execute_python` | `code`、`timeout_seconds`、`preview` | 代码抛出异常时先给出 traceback（作为错误结果），然后是 `result` 的 JSON 值和打印输出；带 `preview` 且代码未抛出异常时，再附上 `render_preview` 按其 `views`、`objects` 与 `shading` 渲染的预览 |
| `new_scene` | `empty` | 新场景中的对象，以及它清除的、`execute_python` 此前定义的名称；`empty` 默认为 `true`，为 `false` 时以 Blender 默认的立方体、相机和灯光开始 |
| `open_blend` | `path` | 文件、其中的场景、对象数量和名称，以及它清除的、`execute_python` 此前定义的名称；文件中存储的脚本不会运行，加载失败的文件会保留当前打开的场景和这些名称 |
| `save_blend` | `path` | 保存的路径和大小；省略 `path` 时保存当前文件，场景从未保存过则调用失败 |
| `import_file` | `path` | 新对象的名称；扩展名决定使用 glTF、FBX、OBJ、STL、PLY、USD、Alembic、SVG 还是 `.blend` 导入器 |
| `export_gltf` | `path`、`selection`、`apply_modifiers`、`animations`、`format` | 导出的对象数量（不含 glTF 导出所忽略的相机和灯光）、路径、格式和大小；`.gltf` 还会给出旁边的 `.bin` 文件；以及因应用修改器而失去形态键的网格 |
| `export_file` | `path`、`format`、`selection` | FBX、OBJ、STL 或 USD 文件的格式、路径和大小 |
| `render_preview` | `width`、`height`、`view`、`views`、`objects`、`shading` | 一张预览图像，以及它的尺寸、视角、对象数量和世界范围，另有一条说明列出预览无法显示的已列出对象；`views` 把多个方向拼在这一张图像上 |
| `render` | `path`、`width`、`height`、`engine`、`samples`、`camera`、`timeout_seconds` | 一张渲染图像，以及它的尺寸、引擎、相机、渲染耗时和保存的 PNG 路径 |
| `python_api` | `identifier` | 从正在运行的 Blender 读取的某个 Blender Python API 名称的文档，最多 12,000 个字符 |
| `run_script` | `script`、`args`、`runs`、`blend`、`timeout_seconds` | 每次运行的结束方式，以及它的退出码、最后一行输出、文件和文件夹；单次运行时还有其输出的结尾（[脚本运行](#script-runs)） |
| `checkpoint` | 无 | 新检查点的编号 |
| `undo` | 无 | 场景恢复到的检查点；已在保留的最早检查点时，错误会写明该检查点 |

`execute_python` 在同一个命名空间中运行代码；该命名空间在调用之间保留已定义的名称，直到 `new_scene` 或 `open_blend` 清除它们，并已导入 `bpy`、`bmesh`、`mathutils`、`math` 与 `json`。工具把打印输出截断为 20,000 个字符（保留开头和结尾），代码运行期间工作进程只保存输出的开头和结尾，少于 60,000 个字符，无论代码打印多少。JSON 超过 50,000 个字符的 `result` 会变成截断预览，其中超出 ±(2^53 − 1) 的整数以其十进制数字字符串返回，超出 Python 转换上限时返回 `<integer of about N digits>`，异常消息截断为 20,000 个字符。`timeout_seconds` 默认为 `requestTimeoutMs`，最大为 `toolCallTimeoutMs` 减去 30 s，两者均以秒计。带 `preview` 时，代码运行且未抛出异常后，工具按给出的 `views`、`objects` 与 `shading`，以每个视角 768 像素渲染 `render_preview` 那样的预览，并把它的文本和图像加入结果；预览失败时代码的结果照常保留，并说明原因，因此 agent 无需第二次调用就能看到改动。

`export_gltf` 写出当前场景的 +Y 朝上的 glTF 2.0，从不使用 Godot 无法导入的 Draco 压缩。未提供 `apply_modifiers` 时，只有导出对象带有骨架（Armature）以外的修改器才会应用修改器：蒙皮已经包含骨架修改器的形变，而应用网格的修改器会丢弃它的形态键，结果会列出这些网格。`selection` 包含每个指定对象的子对象，隐藏的和不可选的子对象也包括在内，例如在视口中隐藏的 `-col` 碰撞子对象：导出时会显示并选中它们，之后恢复它们的可见性和原来的选择。某个指定对象因所在集合禁用了选择或视口显示而无法选中时，调用失败并说明这一原因。`export_gltf` 与 `export_file` 会先删除 `path` 处已有的文件，Blender 没有写出文件时调用失败（例如只导出相机的 OBJ），因此调用成功后 `path` 处的文件总是这次导出的结果。

`render` 默认从场景相机渲染，`camera` 可以指定另一个相机对象。`width`、`height`、`engine` 与 `samples` 只作用于本次渲染；未提供 `path` 的调用会在 `dataRoot` 的 `renders/` 下写入一个新文件。`timeout_seconds` 的范围与 `execute_python` 相同：超时后 Blender 会被停止并重启，未保存的更改随之丢失，因此 CYCLES 渲染会提前结束采样以按时完成，除非场景自己设置了更严格的时间限制。

<a id="one-blender-session"></a>
### 每个对话一个 Blender 会话

宿主只运行一个 Blender MCP 服务器，该服务器为每个调用它的 Session 运行一个 Blender 工作进程（[每个 Session 一个工作进程](../app-mcp/README.zh.md#one-worker-per-session)）。每个 Session 的工作进程拥有自己的打开场景、`execute_python` 命名空间和一组检查点；同一个 Session 的调用按到达顺序逐个执行，其他 Session 的调用同时执行。通过 WASD Engine 的 MCP 服务器连接的 agent 彼此共享一个工作进程（与 WASD Engine 各 Session 的工作进程分开），除非调用传入名称 `session`：此时调用在 `project` 指定的游戏项目中该 agent 同名 Session 的工作进程中运行，因此同时工作的 agent（例如同一个 Claude Code 会话的多个子 agent）各自保留自己的场景（[连接的 agent 的 Session](../app-mcp/README.zh.md#connected-agents-sessions)）。这些状态在调用之间保留，直到 `new_scene` 或 `open_blend` 替换场景，或工作进程在 `workerIdleTimeoutMs` 内没有调用而停止。替换场景时也会清除 `execute_python` 的名称，因为保存旧场景某一部分的名称（例如 `scene.render` 或 `mesh.vertices`）会指向已释放的内存：读取它会得到垃圾数据，通过它写入会使 Blender 崩溃。

Session 的工作进程在其首次工具调用时启动，带有 Blender 的默认场景。崩溃、请求时限到期或正在运行的调用被取消，都会使工作进程停止并丢失未保存的更改。工作进程在调用期间停止时，该调用失败并说明状态已丢失，下一次调用启动新的工作进程。工作进程在空闲时停止，或因正在运行的调用被取消而停止时，下一次调用不执行，直接以该通知失败，再下一次调用才启动新的工作进程。MCP 服务器本身终止时，Blender 会在大约一秒内结束，即使正处于某次调用之中也是如此，执行的代码所启动的进程也随之结束。请在关键节点保存 `.blend` 文件。

<a id="game-add-ons"></a>
### 游戏扩展

每个工作进程的 `execute_python` 命名空间中都有 `wasd_addons` 模块，执行的代码也可以导入它。`wasd_addons.enable("<id>")` 会从 `addonStore` 指定的存储目录启用目录中的 Blender 扩展：对于扩展，通过模块名为 `wasd`、文件夹为该存储目录的扩展仓库启用，因此它以 `bl_ext.wasd.<module>` 导入；对于 Blender 自带的扩展，例如 Rigify，则直接启用。它接受目录 id 或模块名，返回 Python 模块名；对于存储目录的 `catalog.json` 未列出或尚未下载的扩展，它会抛出 `wasd_addons.AddonError` 并说明该怎么做。当扩展的索引条目指定了设置脚本时，`enable` 随后会以扩展的模块和其资源包所在的文件夹调用脚本中的 `setup(module, assets)`，该文件夹也可由 `wasd_addons.assets("<id>")` 获得。`wasd_addons.enabled()` 列出它启用过的 id。出厂设置由 `new_scene` 加载，执行的代码也可能通过 `bpy.ops.wm.read_factory_settings` 加载；它会移除该仓库、停用所有扩展并重置扩展偏好设置，因此一个持久的 `load_factory_preferences_post` 处理程序会再次启用工作进程之前启用过的扩展并再次运行它们的设置脚本，此时启用失败的扩展不再保留。在状态丢失后启动的工作进程不启用任何扩展。

<a id="headless-operation"></a>
### 无界面运行

Blender 在没有窗口的情况下运行，因此这些工具不提供视口、界面，也不提供窗口或区域截图。部分操作符需要窗口，在后台 Blender 中会失败，因此服务器指令要求 agent 优先直接编辑 `bpy.data`，而不是使用 `bpy.ops` 操作符。

服务器指令还要求 agent 为它制作的每个模型绘制图像纹理（除非用户要求纯色），因为 glTF 导出保留图像纹理，却会丢弃程序化着色器节点。agent 用 `bpy.ops.uv.smart_project` 展开 UV，有符合游戏美术风格的 Poly Haven 纹理时就使用它；否则用程序化节点构建外观，用 CPU 上的 Cycles 把颜色烘焙到图像中（材质在粗糙度和起伏上有变化时，也烘焙粗糙度和法线），用 numpy 在像素上绘制更多细节，并在导出前把这些图像连接到 Principled BSDF。物体处于活动并被选中的状态时，这些操作符和烘焙可以在后台 Blender 中运行。

agent 用 `render_preview` 查看场景。它从一台临时正交相机渲染，相机对准所有可渲染对象，或对准列出的对象及其子对象并隐藏其他几何体，视角为 `iso`、`front`、`back`、`left`、`right` 或 `top`。取景依据渲染所显示的内容：包括仅在视口中隐藏的对象和集合，不包括从视图层中排除或在渲染中隐藏的集合；对于此类集合中的已列出对象，结果会写明预览无法显示它们。默认的 `solid` 是快速的 Workbench 着色，带轮廓并使用材质基础色；`material` 用 EEVEE 以 16 个采样渲染节点材质和纹理，光照来自场景灯光，场景没有灯光时使用一个临时太阳光。用 `views` 代替 `view` 时，它以 `width` × `height` 渲染每个方向，并按给出的顺序从左到右、从上到下拼在一张图像上：两个视角排成一行，最多四个时排成两列，五个或六个时排成三列，相邻视角之间隔四个深色像素，因此四个 768 像素的视角能完整放进 agent 看到的 1,568 像素图像。图像写好或预览失败后，工作进程删除每个视角的文件。

渲染后，`render_preview` 会恢复场景的相机、世界环境、渲染设置、色彩管理的视图变换与外观（look）以及可见性；无法恢复某个值时，调用失败。`render` 生成最终图像，需要相机。

<a id="checkpoints"></a>
### 检查点

`checkpoint` 记录场景状态，`undo` 把场景恢复到最近的检查点并丢弃之后的更改。紧接着再次调用 `undo` 会再后退一个检查点，最早可回到场景被打开或创建时的状态。`new_scene` 与 `open_blend` 会清除检查点。检查点保存在 Blender 的撤销历史中，因此 `undo_steps` 偏好设置（出厂设置为 32）限制了 `undo` 能回退多远；已在保留的最早检查点时，`undo` 失败并写明该检查点。`undo` 之后，`execute_python` 变量中保存的 Python 引用可能失效，`undo` 的结果会提示 agent 按名称重新查找对象。

<a id="script-runs"></a>
### 脚本运行

`run_script` 在独立的 Blender 进程中运行一个 Python 文件，运行方式与 `blender --background --factory-startup --python <file> -- <args>` 相同：适用于批量工作（例如处理大量模型或动画），以及否则会长时间占用 Session 工作进程的长任务。每次运行从 Blender 的默认场景开始，或从 `blend` 指定的 `.blend` 文件开始（打开该文件时不运行其中存储的脚本），并随脚本结束而结束；它从不读取或更改 Session 的场景。脚本以 `__main__` 身份在自己所在的文件夹中运行，该文件夹也排在 `sys.path` 的最前面，`sys.argv` 被设为 `[<script>, '--', <args>...]`，并且可以像 `execute_python` 的代码一样导入 `wasd_addons`。运行的退出码即脚本的退出码：脚本运行结束时为 0；脚本调用 `sys.exit` 时为传入的值；该值超出 0 到 255 的范围或发生未捕获的异常时为 1，异常的 traceback 从脚本的第一帧开始。

`args` 给出单次运行的参数；`runs` 是由包含 `args` 与 `name` 的 1 到 64 个条目组成的列表，改为按每个条目各运行一次脚本。所有调用的运行共享服务器的运行位置，数量为 `maxScripts`、`scriptMemoryBytes` 与 `scriptCores` 经 `processLimit` 得出的上限，按到达顺序分配：按默认设置，8 GiB 内存、8 个逻辑处理器的电脑同时运行四个，只有 4 个逻辑处理器的电脑运行两个。只有电脑可用内存不少于 `minAvailableMemoryBytes` 时运行才会启动；否则它不启动，其结果说明原因。`timeout_seconds` 限制每次运行，默认为 `requestTimeoutMs`；一次调用的所有运行都在 `toolCallTimeoutMs` 减去 30 s 之内结束：届时尚未开始的运行不再开始（包括仍在等待其他调用的运行所占位置的运行，结果会立即将其报告为 `not-started`），仍在运行的运行被停止。被取消的调用会停止其运行。

每次调用把结果保存在 `dataRoot` 下的 `script-runs/<time>-<6 位十六进制数字>/` 中：`summary.json` 是该调用的报告；每次运行各有一个文件夹 `<n>` 或 `<n>-<name>`，其中 `output.log` 合并保存该运行的标准输出与标准错误（最多 `scriptLogBytes`），`files/` 用于存放运行写出的文件，运行从环境变量 `WASD_OUTPUT_DIR` 得到它的路径。每次运行还有一个 `blender-user` 文件夹作为其 `BLENDER_USER_RESOURCES`，运行结束时删除。结果说明每次运行的结束方式（`finished`、`failed`、`timed-out` 或 `not-started`），以及它的退出码或信号、最后一行输出和最多 5 个文件；单次运行时列出最多 50 个文件，并引用其输出的最后 6,000 个字符。没有任何运行完成时，结果为错误结果。

<a id="data-directory"></a>
### 数据目录中的文件

首次工具调用会创建 `dataRoot`。每个工作进程在服务器进程的文件夹 `workers/<pid>/` 中自己的编号文件夹里运行。

| 路径 | 内容 | 生命周期 |
|---|---|---|
| `payload/<hash>/wasd_blender_worker.py` | 工作脚本的副本，是 Desktop 应用归档之外的普通文件；`<hash>` 是其 SHA-256 的前 16 位十六进制数字 | 脚本不变时复用；早期版本保留 |
| `runtime/<version>/` | Windows 版 Desktop 应用以归档随附、首次使用时解包的 bpy 运行时；先解包到 `.partial-<8 个十六进制数字>` 同级文件夹，再重命名到位 | 应用随附该版本期间保留；另一个版本就位后，启动时会删除它 |
| `uv-python/` | uv 为 `bpy` 后端安装的 Python | 保留 |
| `venv-py<pythonVersion>-bpy<bpyVersion>/` | `bpy` 环境，先在同级的 `.partial-<uuid>` 目录中构建，再重命名到位；该位置上 Python 不可执行的目录会先被移到同级的 `.stale-<uuid>` 目录 | 保留；插件只删除被移开的目录 |
| `workers/<pid>/<n>/` | 工作进程的工作目录 | 工作进程停止后删除；服务器启动时删除已退出的服务器进程的文件夹 |
| `previews/` | `render_preview` 图像（包括 `execute_python` 的 `preview`）、拼合预览中每个视角的文件，以及 `render` 图像的缩小副本 | 调用返回时删除 |
| `renders/<time>-<id>.png` | 未提供 `path` 的 `render` 调用的输出 | 保留 |
| `script-runs/<time>-<id>/` | `run_script` 的结果：`summary.json`，以及每次运行一个包含 `output.log` 与 `files/` 的文件夹 | 保留最新的 `keptScriptResults` 个调用文件夹；新调用删除没有正在运行的调用使用的更早文件夹 |

其他文件写到 agent 给出的绝对路径；`save_blend`、`export_gltf`、`export_file` 与 `render` 会创建缺失的父文件夹。uv 把下载的包保存在它自己的缓存目录中。

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面上的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，`package.json` 以 `icon` 字段指向该文件。该文件把 Blender 标志图形原样嵌入 36 × 36 画布：它是 Blender 的应用图标，即 [Blender 源码仓库](https://projects.blender.org/blender/blender)中的 `release/freedesktop/icons/scalable/apps/blender.svg`，取自文件注释写明的提交。Blender 与 Blender 标志是 Blender Foundation 的商标，标志归该基金会所有；它不受任何开放许可证覆盖，也不受本仓库的许可证覆盖。该图标仅用于标识 Blender 集成，并遵循 Blender 的[标志使用指南](https://www.blender.org/about/logo/)与[商标政策](https://www.blender.org/about/trademark-policy/)。WASD Engine 与 Blender Foundation 没有关联，也未获其赞助或认可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件涉及三个进程。宿主插件在自身生命周期内向 MCP 服务器管理器注册一个 stdio MCP 服务器 `wasd_blender`；`wasd_` 前缀使它有别于用户自行配置的 `blender` 服务器。管理器用宿主自身的可执行文件、在 `ELECTRON_RUN_AS_NODE=1` 下运行服务器入口 `lib/worker.js`，因此 Desktop 应用无需另装 Node；harness 的源码启动则通过 tsx 运行 `src/worker.ts`。插件把配置编码为 base64url JSON，通过命令行传给服务器。服务器立即响应 MCP 工具发现，在工具调用到来之前不启动工作进程。

首次调用时，服务器确定后端，按需准备 bpy 环境，把工作脚本复制到包外，并启动一个 Python 工作进程。服务器与工作进程使用共享的 JSON 行协议：请求写入工作进程的标准输入，回复写到文件描述符 3，日志写到标准输出和标准错误。每个工具校验参数，向同名的工作进程方法发送一个请求，校验回复，并把它转换为简洁的文本和图像。监管器逐个执行调用，并在工作进程停止后启动新的工作进程。

同一个工作脚本既在 bpy 模块下运行（应用内的运行时为 `<python> -I -X utf8 -B -u <script>`，Windows 应用解包的运行时与 uv 的环境为 `<python> -I -X utf8 -u <script>`），也在 Blender 内运行（`blender --background --factory-startup -noaudio --python-exit-code 1 --python <script>`）。在 bpy 模块下，工作进程以 UTF-8 模式（`-X utf8`）运行，Blender 也为自己的 Python 设置这一模式；否则 Windows 上的 Python 以 ANSI 代码页写出输出，遇到代码页之外的文本便会失败，例如 Blender 的 glTF 导出器打印的、位于非 ASCII 名称用户配置文件之下的路径。服务器从 uv 和工作进程的环境中移除 `PYTHONPATH`、`PYTHONHOME`、`PYTHONSTARTUP`、`VIRTUAL_ENV` 与 `ELECTRON_RUN_AS_NODE`，使用户的 Python 配置不影响 Blender。它把 `BLENDER_USER_RESOURCES` 设为工作进程自身目录中的 `blender-user` 文件夹，使 Blender 的扩展缓存、已启用扩展的 wheel、扩展的用户数据以及扩展写入 Blender 用户文件夹的文件，与用户自己的 Blender 和其他工作进程分开，并在工作进程停止时一并删除。工作进程在回复 `shutdown` 后以 `os._exit(0)` 退出，因为某些导出器运行之后，Blender 可能在自己的退出处理程序中崩溃。标准输入在没有 `shutdown` 请求的情况下关闭，或回复管道失去读取方，都表示服务器已不存在。工作进程中的一个线程每秒检查一次回复管道，因此即使在请求期间工作进程也能察觉；随后它终止自己的进程组（服务器在 POSIX 上为它创建了独立的进程组），执行的代码所启动的进程也随之结束。

`run_script` 像启动工作进程一样准备 Blender（准备过程与工作进程启动一起逐个进行），然后为每次运行以脚本模式启动一次工作脚本：服务器把 `WASD_BLENDER_SCRIPT` 设为脚本，把 `WASD_BLENDER_FILE` 设为 `.blend` 文件，在命令行末尾追加 `--` 和该运行的参数，并在该运行的文件描述符 3 上持有一个管道的读取端；运行像工作进程监视回复管道一样监视它，因此服务器不存在后，运行在大约一秒内结束。服务器从 uv 和工作进程的环境中移除这两个变量，因此继承来的值不会把工作进程变成一次运行。在 POSIX 上，每次运行都领导自己的进程组，运行退出、达到时间限制或被取消时，服务器停止该进程组，因此脚本启动的进程随之结束。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 宿主插件：展开了共享字段的配置 schema，以及服务器注册 |
| [`src/worker.ts`](src/worker.ts) | MCP 服务器进程入口：以 Blender 的选项、工作进程启动器、工具和指令调用 `runAppMcpServer` |
| [`src/environment.ts`](src/environment.ts) | 随附的运行时、uv 与 Blender 搜索、bpy 环境、后端选择和安装提示 |
| [`src/tools.ts`](src/tools.ts) | 工具声明、工作进程请求、回复校验、结果文本和图像文件 |
| [`src/scripts.ts`](src/scripts.ts) | `run_script` 的运行：共享的运行位置、调用与运行文件夹、进程和报告 |
| [`src/instructions.ts`](src/instructions.ts) | 服务器名称和指令，以及通过 WASD Engine 的 MCP 服务器连接的 agent 读到的描述 |
| [`py/wasd_blender_worker.py`](py/wasd_blender_worker.py) | 工作进程：协议循环、每个工具对应的一个方法，以及 `run_script` 的脚本模式 |

共享的 [`dsh-app-mcp`](../app-mcp/README.zh.md) 包负责共享的 Config 字段与服务器注册、服务器进程、工作进程协议客户端、监管器、结果大小上限、setup host（安装环境宿主）以及包括 `execute_python` 在内的工具辅助函数。

### 用真实 Blender 验证

在仓库根目录运行端到端测试套件。其中 bpy 套件以离线方式运行 uv，因此只有 uv 缓存中已有 bpy 5.2.3 时才会运行；随附套件只有本包的 `runtime/` 文件夹中有本平台的运行时时才会运行，并检查工作进程没有改动运行时的任何文件；app 套件只有找到已安装的 Blender 时才会运行。缺少运行时的套件会被跳过。每个套件还通过 `run_script` 的运行执行脚本，包括在 `.blend` 文件上同时运行四次。

```sh
pnpm run test:e2e packages/gamedev/blender/tests/blender-worker.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [游戏开发工具](../README.zh.md) — 本包所在的包组及其他游戏应用程序。
- [App MCP 运行时](../app-mcp/README.zh.md) — 服务器进程、工作进程协议、监管和结果上限。
- [MCP 服务器管理器](../../mcp/mcp-manager/README.zh.md) — 插件注册的服务器、它们的状态和重启。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 工具命名、服务器指令和图像准入。
- [Web 应用组合包](../../bundle/web-app/README.zh.md) — 携带 `blender` 行的 Web 与 Desktop 组合。
- [Blender Python API](https://docs.blender.org/api/current/) — `execute_python` 代码的上游参考。

-----

<a id="model-experience"></a>
## 模型体验

### Blender 工具声明

#### 模型可见内容

模型看到 15 个名为 `mcp__wasd_blender__<name>` 的工具，其描述和输入 schema 由 [`src/tools.ts`](src/tools.ts) 声明，并由 [`model-surface.spec.ts.snap`](tests/__snapshots__/model-surface.spec.ts.snap) 固定；生成的工具目录不列出 MCP 服务器工具。在 `execute_python` 与 `run_script` 中，`timeout_seconds` 的描述写明以秒计的 `requestTimeoutMs` 默认值，其最大值为 `toolCallTimeoutMs` 减去 30 s，以整秒计；`run_script` 还把它写作一次调用的所有运行结束的时限。服务器列出工具时不启动 Blender，因此无论是否安装了 uv 或 Blender，模型都能看到这些工具。

#### Token 影响

15 个声明合计约 13,600 个字符的 JSON（含名称），在服务器的工具保持注册期间进入每个请求。

#### KV Cache 影响

同一配置总是生成相同的声明，因此重连后工具定义前缀保持稳定。服务器在宿主启动后完成工具发现时注册这些工具；此前组装的请求不含 Blender 工具，注册后的第一个请求可能从第一个变化的定义开始失去缓存复用。修改 `requestTimeoutMs` 或 `toolCallTimeoutMs` 会改变 `execute_python` 与 `run_script` 的声明，禁用该行会移除全部 15 个声明。

### 系统提示词中的服务器指令

#### 模型可见内容

服务器连接后，MCP 客户端把 [`src/instructions.ts`](src/instructions.ts) 中的指令加入系统提示词，标题为 `### MCP server: wasd_blender`。

##### Blender 服务器指令

```markdown
Blender runs headless behind these tools: there is no window, viewport, or screenshot. Blender keeps one session for each conversation: its open scene persists between calls until new_scene or open_blend replaces it, so call scene_info before relying on earlier state. If Blender restarts after a crash or a timeout, or stops after a long pause in the calls, unsaved work is lost: save .blend files at milestones. The first result after a start names the Blender version; check API names with python_api instead of guessing, since APIs change between versions.

Paths are absolute. Resolve relative names against your working directory. Put game assets inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Inspect, change, look:
- scene_info gives the overview and object_info the details of one object (transforms, bounds, mesh statistics, modifiers, materials).
- execute_python changes the scene. Prefer bpy.data and direct property edits over bpy.ops operators: operators depend on the active object, selection, and mode, and some need a window that background Blender does not have. Create meshes with bmesh or Mesh.from_pydata, link new objects into a collection, and assign result to return data.
- render_preview shows the result without touching the scene's camera or settings: solid for shape and base colors, material for node materials and textures; views shows several directions in one image. Look at a preview after significant changes, or pass execute_python a preview to see a change in the same call, and fix what looks wrong before exporting. Look through these tools, not by rendering to files and reading them.
- render makes final images from a scene camera.
- run_script runs a .py file in new Blender processes of its own, once or many times at once with other arguments, without touching this session's scene: use it for batch work, such as processing many models or animations, and for long jobs.

Game assets:
- Model in meters at real scale, with -Y as the front and +Z as up in Blender; glTF export converts to +Y up. Apply rotation and scale (bpy.ops.object.transform_apply) and place each origin where the game expects the pivot, such as the feet of a character.
- Use Principled BSDF materials, and paint image textures for every model you make, as Textures below describes, unless the user asks for flat colors: glTF export, and with it the game, keeps image textures but drops procedural shader nodes. Keep the images next to the model or packed into the .blend so export can embed or copy them.
- Keep triangle counts suited to real-time rendering; scene_info reports them per mesh.
- Name objects, meshes, and materials meaningfully: glTF keeps the names. In Godot, an object name ending in -col adds a collision shape, -convcol a convex one, and -colonly keeps only the collision shape.
- export_gltf to a .glb inside the game project. It applies modifiers, exports animations, and never uses Draco compression, which Godot cannot import. Export the whole scene or name the objects in selection.
- Save the editable .blend next to the exported file with save_blend so the asset can be changed later.

Textures:
1. Unwrap UVs: with the object active and selected, run bpy.ops.object.mode_set(mode='EDIT'), bpy.ops.mesh.select_all(action='SELECT'), and bpy.ops.uv.smart_project(island_margin=0.02), then return to mode='OBJECT'.
2. Use a Poly Haven texture when one suits the game's art style: download it and connect its maps as step 5 describes, instead of baking. Otherwise build the look in the material from procedural nodes that suit the game's art style: Noise, Voronoi, and Wave textures through Color Ramps for color variation, wood grain, or stone; an inverted Ambient Occlusion node as the mask for dirt in creases; a Bump node for surface relief.
3. Bake it into images with Cycles: set scene.render.engine = 'CYCLES', scene.cycles.device = 'CPU', and scene.cycles.samples to about 8. Bake one object at a time, selected alone and active. Add an Image Texture node holding a new image, 512 pixels square for small props and 1024 or 2048 for large or close-up models, and make it the active node of each of the object's materials, then run bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=8). Where the material varies in roughness or relief, also bake type='ROUGHNESS' and type='NORMAL' into images whose colorspace_settings.name is 'Non-Color'. Set the render engine back afterwards.
4. Paint what nodes cannot make, such as stripes, markings, or chipped paint, into the pixels with numpy: image.pixels.foreach_get into an array, change it, foreach_set, then image.update(). To paint on a particular face, read where it lies from its loop UVs in mesh.uv_layers.active.uv: u and v from 0 to 1 span the image's width and height, with pixel row 0 at the bottom.
5. Connect each image to its Principled BSDF input in place of the procedural nodes, a normal image through a Normal Map node, save each as a PNG next to the model (set image.filepath_raw, then image.save()), and look at render_preview in material mode before export_gltf, which embeds the images in the .glb.

Use checkpoint before risky edits and undo to return to it. new_scene and open_blend remove every name that execute_python defined, and after undo, Python references held in variables can be invalid, so look objects up by name again.
```

#### Token 影响

服务器保持连接期间，该部分为每个请求增加约 5,500 个字符。

#### KV Cache 影响

指令文本固定不变，因此重连后渲染出相同的部分。该部分在服务器首次连接时出现，在该行被禁用或服务器的重连次数耗尽时消失；每次变化都会改变组装后的系统提示词，可复用的前缀有多长由[系统提示词的缓存规则](../../core/system-prompt/README.zh.md#model-experience)决定。

### 工具结果与图像

#### 模型可见内容

每个结果包含一个文本块，`render_preview`、`render` 以及带 `preview` 的 `execute_python` 另附一张图像：渲染出的 PNG 最长边不超过 1,568 像素且文件不超过 3 MiB 时直接使用该文件，否则使用缩小到该边长的副本，格式为 PNG，PNG 仍超过 3 MiB 时改为 JPEG；`render` 的文本会写明副本尺寸。每次工作进程启动后，下一个结果以 `Blender <version> started (<runtime>, Python <python>) with its default scene.` 开头，其中 `<runtime>` 为 `the bpy module that WASD Engine ships`、`bpy module` 或 `Blender app`；首次使用时，它前面还有 bpy 安装或解包提示；bpy 模块无法安装、解包或启动而由已安装的 Blender 代替时，前面同样有相应提示。`new_scene` 与 `open_blend` 清除了 `execute_python` 的名称时，其文本末尾会列出这些名称。`run_script` 的结果只有文本：先是其准备 Blender 时的提示（例如首次使用时的安装），然后是该调用的各次运行；它既不启动工作进程，也不报告工作进程的启动。错误结果携带失败信息：安装失败会说明如何安装 uv 或 Blender，或如何修复随附的运行时，工作进程失败会给出错误码，并在有内容时附上 traceback 和最近的工作进程输出。[MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)只在声明支持图像输入的模型路由上准入图像，其他路由收到诊断文本。

#### Token 影响

参数、结果文本和已准入的图像在对话中保留，直到压缩（compaction）。工具限制了文本长度：`scene_info` 最多列出 300 个对象，`execute_python` 最多保留 20,000 个字符的打印输出和异常消息，并把 JSON 超过 50,000 个字符的 `result` 替换为截断预览，`python_api` 最多返回 12,000 个字符，`run_script` 最多列出 64 次运行（每次的最后一行输出最多 200 个字符），并最多引用单次运行输出的 6,000 个字符，服务器会截断任何 JSON 超过 1 MiB 的文本块。超过 32 MiB 的工作进程回复（例如对一个巨大自定义属性调用 `object_info`）会变成一条说明请求已完成的错误。

#### KV Cache 影响

仅追加：调用及其结果接在现有请求前缀之后，不会使其失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制描述 Blender 工具当前的不足。

- **连接的 agent 除非指明会话，否则共享一个 Blender** — 通过 WASD Engine 的 MCP 服务器连接、调用时未传入 `session` 的 agent 共用一个打开的场景、Python 命名空间和一组检查点，因此其中一个可能修改或替换另一个的场景，一次耗时的渲染也会推迟其他 agent 的调用。
- **空闲的 Session 会丢失场景** — Session 的工作进程在 `workerIdleTimeoutMs` 内没有调用时停止，或在另一个 Session 需要占用 `maxWorkers` 中的位置时停止，未保存的场景随之丢失。
- **没有窗口** — 工具不提供视口、界面，也不提供窗口或区域截图，需要窗口的操作符会失败；`render_preview` 是查看场景的唯一方式，`render` 需要相机。
- **脚本运行只持续一次工具调用** — `run_script` 调用会等待其运行结束，所有运行都在 `toolCallTimeoutMs` 减去 30 s（默认 870 s）之内结束；更长的任务需要更大的预算或多次调用。
- **Windows 上的脚本运行** — Windows 没有进程组，也不能对运行所监视的管道使用 `poll()`，因此脚本留下继续运行的进程会比该运行存活得更久，服务器在运行期间终止时，运行也会继续。
- **重启会丢失未保存的工作** — 崩溃、`requestTimeoutMs` 或 `timeout_seconds` 到期，或正在运行的调用被取消，都会使工作进程停止；场景、Python 命名空间和检查点随之丢失，新的工作进程以 Blender 默认场景启动。
- **只为 Apple 芯片 macOS 与 Windows x64 随附** — Desktop 应用为 Apple 芯片 macOS 随附 `bpy`，使安装后的应用增大约 770 MB，下载增大约 270 MB；为 Windows x64 随附时，安装程序与安装后的应用增大约 360 MB；Web 与 Linux 用 uv 安装 `bpy` 或使用已安装的 Blender。
- **Windows 在首次使用时解包** — Windows 上首次启动 Blender 时会把约 1 GB 解包到 `dataRoot`，工具调用会等待解包完成；卸载 WASD Engine 后，解包的运行时仍留在原处；换用新的运行时版本后，首次启动会删除旧版本。EEVEE 渲染（例如 `material` 预览）需要支持 OpenGL 的 GPU，Windows 虚拟机和远程会话可能没有。
- **首次使用耗时且占用空间大** — 没有随附的运行时时，`bpy` 后端在首次工具调用期间安装，该调用会等待安装完成；调用超过 `toolCallTimeoutMs` 时，uv 停止，未完成的环境被删除，下一次调用重新开始安装。新的 `bpyVersion` 或 `pythonVersion` 会安装另一个环境，插件不删除任何可用的环境。
- **bpy 只覆盖四个平台** — PyPI 只为 macOS arm64、Linux x86_64 以及 Windows x64 与 arm64 发布 bpy 5.2.3；在其他平台上 `bpy` 后端失败，`auto` 需要已安装的 Blender。
- **检查点数量有限** — `undo_steps` 偏好设置（出厂设置为 32）限制 `undo` 能回退多远，`new_scene` 与 `open_blend` 会清除检查点。
- **图像需要支持图像的路由** — 在不支持图像输入的模型路由上，模型收到的是诊断文本，而不是预览和渲染图像。
- **耗时的原生调用会推迟服务器检查** — 察觉服务器终止的工作进程线程需要 Python 的锁，因此当代码处于一次持有该锁的耗时原生调用中（例如运行数分钟的单个操作符）时，Blender 会一直运行到该调用返回。
- **Windows 上察觉服务器终止较晚** — 在 Windows 上，工作进程既没有用于回复管道的 `poll()`，也没有进程组，因此它要等读取下一个请求时才结束，执行的代码所启动的进程会继续运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
