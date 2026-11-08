---
description: "面向部署方与维护者的无界面 GIMP 3 MCP 工具：配置数据目录、gimp-console 可执行文件与超时，或排查 mcp__wasd_gimp__ 工具、GIMP 搜索以及插件自己的 GIMP 配置目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-gimp

[English](README.md) | 中文

## 概述

让 agent（智能体）在没有窗口的 GIMP 3 中绘制分层图像、为其应用滤镜并进行变换：agent 通过快照查看自己的成果，并把纹理、精灵图和精灵图集（sprite sheet）导出到游戏项目中。WASD Engine 的 Web 与 Desktop 默认启用这些工具。Desktop 应用为 macOS 自带 GIMP；在其他环境中工具使用已安装的 GIMP 3。GIMP 使用新配置目录（profile）的首次启动约需 15 秒。每个对话都有自己的 GIMP 会话；崩溃、超时或长时间没有调用会关闭其打开的图像，并丢失未保存的更改。

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

当 agent 需要以文件形式创建或编辑 2D 图像（如纹理、精灵图、精灵图集、图标和界面美术素材）时，选用这些工具。插件以独立的配置目录启动自己的 GIMP 实例，从不连接用户已打开的 GIMP。激活插件只会注册其 MCP 服务器 `wasd_gimp`，不做其他事：首次工具调用之前不会搜索或启动 GIMP，因此在没有 GIMP 的机器上插件也能加载。

### 默认组合

fork 的 patch 文件 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 把 `gimp` 行插入每个 Web 与 Desktop profile，并把它的数据目录放在 harness 主目录下：`~/.wasdengine/gimp`；设置了 `DSH_HOME` 时为 `$DSH_HOME/gimp`。

```yaml
- id: gimp
  name: '@deepseek-ai/dsh-gimp'
  config:
    dataRoot: !!js dshHomePath('gimp')
```

插件需要 `mcpManager` 服务，由 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 组合包的 `mcp-manager` 行提供。在其他组合中，请在本行旁挂载 [`dsh-mcp-manager`](../../mcp/mcp-manager/README.zh.md)，并设置绝对路径的 `dataRoot`。

### 关闭工具或修改设置

profile patch 按 id 覆盖该行。把下面的条目加入 `$DSH_HOME/profiles/<name>/cordis.patch.yml`；未设置 `DSH_HOME` 时 `$DSH_HOME` 为 `~/.wasdengine`，标准 profile 名为 `web` 与 `desktop`。编辑 patch 后重启 Web 或 Desktop。插件页面「游戏工具」标签页上的开关（[`ui-game-tools`](../ui-game-tools/README.zh.md)）通过插件管理器添加或删除这一 `disabled` 条目，插件管理器随即应用更改，或说明更改需要重启后才生效。

```yaml
- id: gimp
  disabled: true
```

禁用该行后，模型不再看到这些工具和服务器指令，正在运行的 GIMP 也会停止，其打开的图像随之丢弃。设置 `config` 的 patch 会替换该行的整个配置，因此请在要修改的字段旁重新写出 `dataRoot`：

```yaml
- id: gimp
  config:
    dataRoot: !!js dshHomePath('gimp')
    gimpConsolePath: /Applications/GIMP.app/Contents/MacOS/gimp-console-3.2
```

### 配置

[`src/index.ts`](src/index.ts) 声明并校验以下字段。每个时限都是 1 到 2,147,483,647 之间的整数毫秒数。`dataRoot` 或非空的 `gimpConsolePath` 为相对路径时，或 `requestTimeoutMs` 没有比 `toolCallTimeoutMs` 至少少 30 s 时，激活失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | 必填 | 存放 GIMP 配置目录、快照和工作脚本副本的绝对目录 |
| `gimpConsolePath` | `''` | GIMP 3 的 `gimp-console` 可执行文件的绝对路径；为空时先使用 `GIMP_CONSOLE` 环境变量，再使用 Desktop 应用自带的运行时，然后查找标准安装位置（见[查找并安装 GIMP 3](#find-gimp)） |
| `toolCallTimeoutMs` | `900,000` | 单次工具调用的时限，包括启动 GIMP；一个 GIMP 请求（包括 `execute_python` 的超时）最多可用到其中除最后 30 s 以外的全部时间，这 30 s 留给工作进程启动和结果 |
| `startupTimeoutMs` | `30,000` | MCP 服务器连接并列出工具的时限；列出工具不会启动 GIMP |
| `readyTimeoutMs` | `120,000` | 正在启动的 GIMP 工作进程报告就绪的时限 |
| `requestTimeoutMs` | `600,000` | 单个 GIMP 请求的默认时限，至少比 `toolCallTimeoutMs` 少 30 s；到期时 GIMP 停止，打开的图像和未保存的更改丢失 |
| `graceMs` | `3,000` | 工作进程在收到 `shutdown` 请求后、再在收到 SIGTERM 后各有这么长时间退出，之后收到 SIGKILL |
| `maxLogBytes` | `65,536` | 为错误消息保留的最近 GIMP 输出的字节数 |
| `maxWorkers` | `4` | 同时运行的 GIMP 工作进程上限，每个调用的 Session 一个，取值 1 到 16 |
| `workerIdleTimeoutMs` | `600,000` | Session 的 GIMP 工作进程在没有调用多长时间后停止，其打开的图像随之丢失 |

<a id="find-gimp"></a>
### 查找并安装 GIMP 3

每次启动工作进程时，服务器都会查找 GIMP 3 的 `gimp-console` 可执行文件：首次工具调用时，以及工作进程停止后的那次调用时。它按以下顺序取第一个匹配项：

1. `gimpConsolePath`（非空时）。
2. `GIMP_CONSOLE` 环境变量（已设置且非空时）；服务器从启动 Web 或 Desktop 的环境中读取它。
3. Desktop 应用为当前平台与架构自带的运行时（[Desktop 应用中的 GIMP](#shipped-gimp)）。
4. 在 macOS 上，`/Applications` 或 `~/Applications` 中 GIMP 应用包（`gimp*.app`，不区分大小写）的 `Contents/MacOS` 里最新的带版本号控制台；版本相同时 `/Applications` 优先。
5. 第一个含带版本号控制台的 `PATH` 目录中最新的那个。
6. 第一个含 `gimp-console` 的 `PATH` 目录中的 `gimp-console`。
7. 在 Windows 上，`GIMP 3*` 安装目录的 `bin` 文件夹中最新的带版本号控制台；先尝试 `%ProgramFiles%`（未设置时为 `C:\Program Files`）下的安装，再尝试 `%LOCALAPPDATA%\Programs` 下的安装，各自按从新到旧的顺序。

带版本号的控制台名为 `gimp-console-3` 或 `gimp-console-3.<minor>`，后面还可以跟更多 `.<number>` 部分，版本号最高者即为最新；在 Windows 上，这些名称和 `gimp-console` 都以 `.exe` 结尾。只有绝对路径的 `PATH` 目录才计入。`gimpConsolePath` 或 `GIMP_CONSOLE` 的值不是可执行文件时，调用失败，消息会指出是哪项设置；搜索不会继续。

没有任何匹配时，调用在触及 `dataRoot` 之前失败，消息说明可从 <https://www.gimp.org/downloads/> 安装 GIMP 3，在 macOS 上也可以用 `brew install --cask gimp` 安装，并指出这两项设置。安装 GIMP 3 后再次调用工具即可；每次启动工作进程都会重新搜索，因此无需重启宿主。

<a id="shipped-gimp"></a>
### Desktop 应用中的 GIMP

面向 Apple 芯片 macOS 的 Desktop 应用把 GIMP 放在本包的 `runtime/darwin-arm64/` 文件夹中，位于 `app.asar` 之外；[`wasdengine/gimp/BUILD.md`](../../../wasdengine/gimp/BUILD.md) 说明如何由 GIMP 官方的 macOS 构建制作该运行时。该文件夹的 `runtime.json` 写明控制台以及数据、翻译和配置文件夹，服务器以 `GIMP3_DATADIR`、`GIMP3_LOCALEDIR` 与 `GIMP3_SYSCONFDIR` 把这些文件夹传给 GIMP，因为 GIMP 的 Python 插件从嵌套的 `Python.app` 中运行，无法根据自身位置找到它们。`runtime.json` 不是 JSON、描述的是其他平台，或写明的控制台不是可执行文件时，调用以 `GIMP_RUNTIME_INVALID` 失败，消息说明应重新安装 WASD Engine 或设置 `gimpConsolePath`。该运行时不含 GIMP 的翻译，因此 GIMP 及其插件以英文运行。其中的 `COPYING` 与 `SOURCE.txt` 带有 GIMP 的许可证，并写明对应的源代码。源码检出可用 `wasdengine/gimp/build.sh --out <dir> --install packages/gamedev/gimp/runtime` 把运行时安装到 git 忽略的文件夹中。

<a id="gimp-profile"></a>
### GIMP 配置目录与首次启动

GIMP 运行时，`GIMP3_DIRECTORY` 环境变量被设为 `<dataRoot>/profile`，因此 GIMP 把配置保存在该目录中，与用户自己的 GIMP 设置互不影响。服务器在首次启动前创建该目录，且从不删除。所有工作进程都使用这个配置目录；工作进程的启动从不重叠，因此由第一次启动单独填充它。GIMP 在首次启动时填充新的配置目录：在 macOS arm64 上使用 GIMP 3.2 时，这次启动约需 15 秒，之后的启动约需 2 秒。`readyTimeoutMs` 限制每次启动，触发启动的工具调用会等待启动完成。

<a id="tools"></a>
### 工具

模型以 `mcp__wasd_gimp__<name>` 调用每个工具，所有路径参数都是绝对路径。结果是文本，`snapshot` 另附一张图像；调用失败时返回错误结果，其文本说明原因。不适用于所选 `action` 或 `mode` 的参数会使调用失败。通过 WASD Engine 的 MCP 服务器 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 连接的 agent 以 `gimp_<name>` 调用同样的工具，并彼此共享一个 GIMP 会话。

| 工具 | 参数 | 结果 |
|---|---|---|
| `list_images` | 无 | JSON：最多 200 个打开的图像，每个都含 id、名称、文件、尺寸、颜色模式、精度、图层数和未保存更改标志，以及图像总数 |
| `open_image` | `path` | 新图像的 id、同一文件其他已打开副本的 id，以及 `image_info` 的 JSON；支持 GIMP 能读取的任何格式，包括含全部图层的 `.xcf` |
| `new_image` | `width`、`height`、`fill`、`name` | 新 RGB 图像的 id 和尺寸；该图像只有一个图层 `Background`，为透明或以 `fill` 填充 |
| `image_info` | `image` | JSON：文件、尺寸、颜色模式、精度、分辨率、未保存更改标志、从顶层开始最多 500 个条目的图层树、选中的图层、选区边界和浮动选区 |
| `snapshot` | `image`、`max_size` | 一张由可见图层合成并缩放到 `max_size` 以内的图像，以及图像尺寸和显示尺寸 |
| `export_image` | `image`、`path`、`quality` | 导出文件的路径、格式、尺寸和文件大小 |
| `save_xcf` | `image`、`path` | 保存的 `.xcf` 文件的路径和文件大小 |
| `close_image` | `image` | 已关闭的 id，以及是否丢弃了未保存的更改 |
| `layer` | `image`、`action`、`layer`、`name`、`opacity`、`visible`、`mode`、`offset_x`、`offset_y`、`position` | `add`、`duplicate`、`delete`、`rename`、`set`、`move`、`merge_down`、`merge_visible` 或 `flatten` 做了什么，以及 JSON 形式的图层树 |
| `select` | `image`、`mode`、`x`、`y`、`width`、`height`、`color`、`threshold`、`layer`、`amount`、`operation` | 执行 `all`、`none`、`invert`、`rect`、`ellipse`、`color`、`grow`、`shrink` 或 `feather` 后选区的外接矩形，或没有任何选区的说明 |
| `transform` | `image`、`action`、`width`、`height`、`x`、`y`、`angle`、`axis`、`layer`、`interpolation` | 执行 `scale_image`、`resize_canvas`、`crop`、`rotate`、`flip` 或 `scale_layer` 后的图像尺寸，以及被变换图层的边界 |
| `draw` | `image`、`action`、`layer`、`color`、`color2`、`x`、`y`、`x2`、`y2`、`text`、`font`、`size` | `fill`、`gradient` 或 `clear` 绘制的图层及限制它的选区，或新 `text` 图层的边界 |
| `filters` | `query` | 名称、标题或类别包含 `query` 的滤镜操作数量，以及其中最多 200 个及其标题和类别 |
| `filter_info` | `operation` | JSON：滤镜的标题、描述、类别，以及每个属性的类型、范围、默认值和可选值 |
| `apply_filter` | `image`、`layer`、`operation`、`properties` | 操作、设置的属性、图层，以及限制它的选区 |
| `pdb_search` | `query` | 匹配的过程数量，以及最多 200 个名称及其摘要，最佳匹配在前 |
| `pdb_describe` | `procedure` | JSON：摘要、帮助、类型、图像类型、菜单标签、作者、日期，以及每个参数和返回值的类型、范围、默认值和可选值 |
| `pdb_run` | `procedure`、`arguments` | 过程名称及 JSON 形式的返回值 |
| `execute_python` | `code`、`timeout_seconds` | 代码抛出异常时先给出 traceback（作为错误结果），然后是 `result` 的 JSON 值和打印输出 |
| `make_sprite_sheet` | `paths`、`columns`、`output`、`padding` | 图集的路径、尺寸、文件大小、网格和图像 id，以及 JSON 形式的每帧矩形 |
| `make_seamless` | `image`、`layer` | 现在可以无缝平铺的图层 |

`snapshot` 在图像的副本中合成可见图层，因此图像本身不会改变。最长边超过 `max_size`（16 到 1,568 像素，默认 1,024）的图像会以三次插值缩小。较小的图像会按最大的整数倍放大，使最长边既不超过 256 像素也不超过 `max_size`；放大时不做平滑，像素画因此保持清晰。透明区域显示在由 8 像素方格组成的灰色棋盘格上。快照以 PNG 传送；PNG 超过 3 MiB 时改为 85% 质量的 JPEG，并每步缩小四分之一，直到文件不超过上限或最长边降到 64 像素。快照文件位于 `dataRoot` 的 `snapshots/` 下，调用返回时删除。

`export_image` 与 `make_sprite_sheet` 按输出扩展名对应的格式写出可见图层的合成副本：`.png`、`.webp`、`.jpg` 或 `.jpeg`、`.tga`、`.bmp`、`.ico`，或保留全部图层的 `.xcf`。`.jpg`、`.jpeg` 与 `.bmp` 不支持透明，因此副本会拼合到白色背景上，结果也会说明这一点。`quality` 取值 0 到 100，只适用于 `.jpg`、`.jpeg` 与 `.webp`；未提供时，GIMP 3.2 以质量 90 导出这两种格式，对从其他质量的 JPEG 文件打开的图像也是如此。文件先写入目标旁的隐藏临时文件 `.<name>.wasd-<pid><extension>`，再重命名到位，因此 Godot 导入器等文件监视器不会看到不完整的文件。缺失的文件夹会被创建；没有可见图层的图像无法导出。

`save_xcf` 保存图像本身及其全部图层。提供 `path`（必须以 `.xcf` 结尾）时，保存到该路径，创建缺失的文件夹，并把该文件作为图像之后保存所用的文件。省略 `path` 时，保存到图像打开时所用或最近一次保存的 `.xcf` 文件；图像没有这样的文件时调用失败。

以下规则适用于 `layer`、`select`、`transform` 与 `draw`：

- 坐标、偏移和尺寸都以图像像素计。
- 填充、清除、渐变和滤镜只作用于选区内部；以 `none` 模式调用 `select` 后，它们重新作用于整个图层。`transform` 与 `make_seamless` 不受选区影响，作用于整个图层和图像。
- `layer` 的 `add` 或 `duplicate`，以及 `draw` 的 `text`，会把新图层设为选中图层。
- `resize_canvas` 把每个图层移动 `x`、`y`；随后每个既非文本图层也非图层组的图层（包括图层组内的图层）都变为画布大小，文本图层保持原有大小。
- 旋转整个图像只接受顺时针 90、180 或 270 度，旋转单个 `layer` 可用任意角度。`interpolation` 默认为 `cubic`，`none` 可让像素画保持清晰。
- 颜色可写作 `#rgb`、`#rgba`、`#rrggbb`、`#rrggbbaa`，或 `white`、`rgba(255, 136, 0, 0.5)` 等 CSS 颜色。填充以颜色的 alpha 作为不透明度，渐变保留两种颜色的 alpha。
- 文本图层使用 `font`（默认 `Sans-serif`），字号为 `size` 像素（默认 32）；字体不存在时调用失败，并列出最多十个相近的字体名称。

`filters`、`filter_info` 与 `apply_filter` 可使用 GIMP 能应用到图层上的 GEGL 滤镜操作，例如 `gegl:gaussian-blur`。`apply_filter` 把滤镜合并到图层的像素中，因此图层上不会留下可编辑的滤镜。`pdb_search`、`pdb_describe` 与 `pdb_run` 可访问 GIMP 的过程数据库（PDB）。`pdb_search` 匹配名称时把 `query` 中的空格和 `_` 视为 `-`，同时也匹配摘要；排序依次为名称完全相同、整词匹配、其他名称匹配和摘要匹配。`pdb_run` 总是把 `run-mode` 设为非交互模式，因此不会打开对话框。它按名称接受参数：图像和条目用 id，文件用绝对路径，颜色用十六进制字符串，枚举和选项用名称，单位用 `pixel`、`inch`、`mm`、`point`、`pica` 或 `percent`，数组用 JSON 数组。滤镜属性名和过程参数名都接受以 `_` 代替 `-`。未知的操作、过程、属性或参数会使调用失败，消息会列出相近或有效的名称。

`execute_python` 在同一个命名空间中运行代码，该命名空间在调用之间保留已定义的名称。命名空间中有 `Gimp`、`Gegl`、`Gio`、`GLib`、`GObject` 与 `Babl`，每次调用前工具还会在其中设置 `images`，把每个打开图像的 id 映射到对应的 `Gimp.Image`。赋给 `result` 的值以 JSON 返回：图像为 `{"image": <id>}`，图层和其他条目为 `{"item": <id>, "name": <name>}`，颜色为十六进制字符串，文件为路径，枚举为名称，其他值为其 `repr`。工具把打印输出（标准输出与标准错误合在一起）截断为 20,000 个字符，保留开头和结尾，代码运行期间工作进程只保存输出的开头和结尾，少于 60,000 个字符，无论代码打印多少。JSON 超过 20,000 个字符的 `result` 会变成截断后的字符串。标准输入读出为空。代码抛出异常或调用 `exit()` 时返回错误结果，开头是 traceback 或退出提示，工作进程继续运行。`timeout_seconds` 默认为 `requestTimeoutMs`，最大为 `toolCallTimeoutMs` 减去 30 s，两者均以秒计；到期时 GIMP 停止，打开的图像丢失。

`make_sprite_sheet` 把 1 到 256 个帧文件（GIMP 能读取的任何格式）载入为新图像的图层，并逐行排列，每行 `columns` 帧。每一帧居中放在一个单元格中，单元格尺寸为最大帧尺寸加上每边的 `padding`；任一边超过 8,192 像素的图集会失败。图集作为以输出文件命名的新图像保持打开，每帧一个图层，命名为 `frame <index>: <file name>`，结果列出每帧的序号、文件名和矩形。`make_seamless` 把整个图层与自身以环绕方式平移半个宽度的副本交叉淡化，再把结果与平移半个高度的副本交叉淡化，使纹理重复时每条边缘都与相对的边缘衔接。覆盖整个图层的升余弦权重使边缘显示平移后的副本、中间显示原图，并以预乘 alpha 混合颜色与透明度；因此远离中间的独特形状会出现两次并变淡，最适合噪声类纹理。

<a id="image-ids"></a>
### 图像与图层 id

工具以 GIMP 图像 id 指代图像；该 id 是正整数，由 `new_image`、`open_image`、`list_images` 与 `make_sprite_sheet` 给出。id 在 `close_image` 关闭图像或 GIMP 停止之前一直有效；重启之后，先前的 id 不再对应任何图像，或对应另一个图像。打开一个已打开的文件会创建另一个具有自己 id 的图像，`open_image` 的结果会给出其他 id。不对应任何打开图像的 id 会使调用失败，并提示使用 `list_images`。在 `save_xcf` 保存图像之前，`list_images` 与 `image_info` 显示传给 `new_image` 的 `name` 或精灵图集的输出文件名；其他情况下显示 GIMP 的图像名称，对已打开或已保存的图像即其文件名。

工具以 id 或精确名称指代图层，`image_info` 会列出这两者。多个图层共用的名称会使调用失败，并列出它们的 id。`layer` 的 `delete`、`rename`、`set` 与 `move` 操作必须提供 `layer`；其他情况下省略 `layer` 表示图像中选中的图层，没有选中图层时表示顶层图层。

<a id="one-gimp-session"></a>
### 每个对话一个 GIMP 会话

宿主只运行一个 GIMP MCP 服务器，该服务器为每个调用它的 Session 运行一个 GIMP 工作进程（[每个 Session 一个工作进程](../app-mcp/README.zh.md#one-worker-per-session)）。每个 Session 的工作进程拥有自己打开的图像、它们的选区和 `execute_python` 命名空间；同一个 Session 的调用按到达顺序逐个执行，其他 Session 的调用同时执行；通过 WASD Engine 的 MCP 服务器连接的 agent 彼此共享一个工作进程。打开的图像在调用之间保留，直到 `close_image` 将其关闭或工作进程停止；工作进程在 `workerIdleTimeoutMs` 内没有调用时会停止。

Session 的工作进程在其首次工具调用时启动，此时没有打开的图像。崩溃、请求时限到期或正在运行的调用被取消，都会使 GIMP 停止并丢失打开的图像和未保存的更改。GIMP 在调用期间停止时，该调用失败并说明状态已丢失，下一次调用启动新的工作进程。GIMP 在空闲时停止，或因正在运行的调用被取消而停止时，下一次调用不执行，直接以该通知失败，再下一次调用才启动新的工作进程。在 macOS 和 Linux 上，GIMP 的 Python 进程一旦终止，看门狗就会停止 GIMP，因此正在运行的调用无需等到时限到期就会失败。请在关键节点保存 `.xcf` 文件。

<a id="data-directory"></a>
### 数据目录中的文件

首次找到 GIMP 的工具调用会创建 `dataRoot`。每个工作进程在服务器进程的文件夹 `workers/<pid>/` 中自己的编号文件夹里运行。

| 路径 | 内容 | 生命周期 |
|---|---|---|
| `profile/` | `GIMP3_DIRECTORY` 指向的 GIMP 配置目录 | 保留；插件从不删除 |
| `payload/<hash>/wasd_gimp_worker.py` | 工作脚本的副本，是 Desktop 应用归档之外的普通文件；`<hash>` 是其 SHA-256 的前 16 位十六进制数字 | 脚本不变时复用；早期版本保留 |
| `snapshots/<uuid>.png` 或 `snapshots/<uuid>.jpg` | `snapshot` 图像 | 调用返回时删除 |
| `workers/<pid>/<n>/` | 工作进程的工作目录 | 工作进程停止后删除；服务器启动时删除已退出的服务器进程的文件夹 |

其他文件写到 agent 给出的绝对路径；`export_image`、`save_xcf` 与 `make_sprite_sheet` 会创建缺失的父文件夹。

<a id="plugin-icon"></a>
### 插件图标

「设置 › 内置插件」与「插件」页面上的「游戏工具」标签页（[`ui-game-tools`](../ui-game-tools/README.zh.md)）显示本包的 [`icon.svg`](icon.svg)，`package.json` 以 `icon` 字段指向该文件。该文件把 GIMP 标志 Wilber（作者 Aryeom Han，2024 年）原样嵌入 36 × 36 画布，只去掉了源文件中的 Inkscape 编辑器元数据与未使用的 id：源文件是 [gimp-data 仓库](https://gitlab.gnome.org/GNOME/gimp-data)中的 `images/logo/gimp-logo.svg`，取自文件注释写明的提交。Wilber 以[知识共享署名-相同方式共享 4.0 国际许可协议（CC BY-SA 4.0）](https://creativecommons.org/licenses/by-sa/4.0/)授权，不受本仓库的许可证覆盖，`icon.svg` 也以同一 CC BY-SA 4.0 许可协议共享。GIMP 名称与 Wilber 代表 GIMP 项目；该图标仅指代 GIMP 集成。WASD Engine 与 GIMP 项目没有关联，也未获其认可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件涉及三个进程。宿主插件在自身生命周期内向 MCP 服务器管理器注册一个 stdio MCP 服务器 `wasd_gimp`；`wasd_` 前缀使它有别于用户自行配置的 `gimp` 服务器。管理器用宿主自身的可执行文件、在 `ELECTRON_RUN_AS_NODE=1` 下运行服务器入口 `lib/worker.js`，因此 Desktop 应用无需另装 Node；harness 的源码启动则通过 tsx 运行 `src/worker.ts`。插件把工作进程设置编码为 base64url JSON，通过命令行传给服务器。服务器立即响应 MCP 工具发现，在工具调用到来之前不启动工作进程。

首次调用时，服务器找到 `gimp-console`，创建配置目录，把工作脚本复制到包外，并以下面的命令行启动 GIMP（不经过 shell）：

```text
GIMP3_DIRECTORY=<dataRoot>/profile <gimp-console> -n -s -c --batch-interpreter=python-fu-eval -b 'import runpy; runpy.run_path("<worker script>", run_name="__main__")' --quit
```

`-n` 启动新的 GIMP 实例，`-s` 跳过启动画面，`-c` 把消息输出到控制台。批处理命令在 GIMP 的 Python 插件进程中运行工作脚本，该进程继承服务器的管道：请求从标准输入到达，回复写到文件描述符 3，GIMP 自身的输出仍在标准输出和标准错误上。每个工具校验参数，向同名的工作进程方法发送一个请求，校验回复，并把它转换为简洁的文本和图像；不符合预期的回复会使调用以 `WorkerReplyError` 失败。监管器逐个执行调用，并在工作进程停止后启动新的工作进程。

服务器从 GIMP 的环境中移除 `PYTHONPATH`、`PYTHONHOME`、`PYTHONSTARTUP`、`VIRTUAL_ENV` 与 `ELECTRON_RUN_AS_NODE`，使用户的 Python 配置不影响 GIMP 自带的 Python。工作进程中的每个 GIMP 调用都使用非交互运行模式。GIMP 3.2 在其 Python 插件进程终止后仍继续运行，并保持回复管道打开，因此在 `os.name` 为 `posix` 的系统上，工作进程会启动一个 `/bin/sh` 看门狗：工作进程未告别就结束时，看门狗杀死 GIMP，GIMP 是进程组组长时则杀死整个进程组。工作进程在回复 `shutdown` 后或标准输入关闭时返回，随后 GIMP 通过 `--quit` 退出。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 宿主插件：展开了共享字段的配置 schema，以及服务器注册 |
| [`src/worker.ts`](src/worker.ts) | MCP 服务器进程入口：以 GIMP 的选项、工作进程启动器、工具和指令调用 `runAppMcpServer` |
| [`src/environment.ts`](src/environment.ts) | `gimp-console` 搜索、工作进程命令行与环境、配置目录和启动提示 |
| [`src/tools.ts`](src/tools.ts) | 工具声明、工作进程请求、回复校验、结果文本和快照文件 |
| [`src/instructions.ts`](src/instructions.ts) | 服务器名称和指令 |
| [`py/wasd_gimp_worker.py`](py/wasd_gimp_worker.py) | 工作进程：协议循环、崩溃看门狗，以及每个工具对应的一个方法 |

共享的 [`dsh-app-mcp`](../app-mcp/README.zh.md) 包负责共享的 Config 字段与服务器注册、服务器进程、工作进程协议客户端、监管器、结果大小上限、setup host（安装环境宿主）以及包括 `execute_python` 在内的工具辅助函数。

### 用真实 GIMP 验证

在仓库根目录运行端到端测试套件。只有 GIMP 搜索找到 GIMP 3 时套件才会运行：本包 `runtime/` 文件夹中的运行时，或已安装的 GIMP 3（可用 `GIMP_CONSOLE` 指定）；否则跳过。它的临时数据目录为 GIMP 提供新的配置目录，因此其中第一次 GIMP 启动就是较慢的那次。

```sh
pnpm run test:e2e packages/gamedev/gimp/tests/gimp-worker.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [游戏开发工具](../README.zh.md) — 本包所在的包组及其他游戏应用程序。
- [App MCP 运行时](../app-mcp/README.zh.md) — 服务器进程、工作进程协议、监管和结果上限。
- [MCP 服务器管理器](../../mcp/mcp-manager/README.zh.md) — 插件注册的服务器、它们的状态和重启。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 工具命名、服务器指令和图像准入。
- [Web 应用组合包](../../bundle/web-app/README.zh.md) — 携带 `gimp` 行的 Web 与 Desktop 组合。
- [libgimp 3 API 参考](https://developer.gimp.org/api/3.0/libgimp/) — `execute_python` 代码的上游参考。

-----

<a id="model-experience"></a>
## 模型体验

### GIMP 工具声明

#### 模型可见内容

模型看到 21 个名为 `mcp__wasd_gimp__<name>` 的工具，其描述和输入 schema 由 [`src/tools.ts`](src/tools.ts) 声明，并由 [`model-surface.spec.ts.snap`](tests/__snapshots__/model-surface.spec.ts.snap) 固定；生成的工具目录不列出 MCP 服务器工具。在 `execute_python` 中，`timeout_seconds` 的描述写明以秒计的 `requestTimeoutMs` 默认值，其最大值为 `toolCallTimeoutMs` 减去 30 s，以整秒计。服务器列出工具时不启动 GIMP，因此无论是否安装了 GIMP，模型都能看到这些工具。

#### Token 影响

21 个声明合计约 21,100 个字符的 JSON（含名称），在服务器的工具保持注册期间进入每个请求。

#### KV Cache 影响

同一配置总是生成相同的声明，因此重连后工具定义前缀保持稳定。服务器在宿主启动后完成工具发现时注册这些工具；此前组装的请求不含 GIMP 工具，注册后的第一个请求可能从第一个变化的定义开始失去缓存复用。修改 `requestTimeoutMs` 或 `toolCallTimeoutMs` 可能改变 `execute_python` 的声明，禁用该行会移除全部 21 个声明。

### 系统提示词中的服务器指令

#### 模型可见内容

服务器连接后，MCP 客户端把 [`src/instructions.ts`](src/instructions.ts) 中的指令加入系统提示词，标题为 `### MCP server: wasd_gimp`。

##### GIMP 服务器指令

```markdown
GIMP 3 runs headless behind these tools: there is no window. GIMP keeps one session for each conversation: its open images persist between calls until close_image. Refer to an image by the integer id that new_image, open_image, or list_images returns, and to a layer by id or exact name (image_info lists them); call list_images before relying on earlier state. If GIMP restarts after a crash or a timeout, or stops after a long pause in the calls, open images and unsaved changes are lost: save .xcf files at milestones. The first result after a start names the GIMP version.

Paths are absolute. Resolve relative names against your working directory. Write game assets inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Look, change, look again:
- snapshot shows an image as it would export: the visible layers composited, transparent areas as a gray checkerboard, and small images enlarged without smoothing. Look after significant changes and fix what looks wrong before exporting. Snapshots and exports never change the image.
- image_info gives sizes, the layer tree, text layer contents, and the selection.
- layer adds, duplicates, deletes, renames, restacks, and merges layers, and sets opacity, visibility, blend mode, and offset.
- select builds a selection (rectangle, ellipse, by color, grow, shrink, feather, invert). Fill, clear, gradients, and filters then act only inside it; select mode none to act on whole layers again.
- draw fills, clears, paints linear gradients, and adds text layers. Colors are #rrggbb, #rrggbbaa (with alpha), or CSS color names.
- transform scales the image or a layer, resizes the canvas, crops, rotates, and flips. Scale pixel art with interpolation none.
- filters lists GEGL filter operations (blur, noise, distort, light, color, artistic, ...), filter_info shows their properties, ranges, and defaults, and apply_filter applies one to a layer.
- pdb_search, pdb_describe, and pdb_run reach any other GIMP procedure, such as converting to indexed colors, with images and layers passed by id.
- execute_python runs Python with Gimp, Gegl, Gio, and GLib imported and images mapping ids to Gimp.Image objects, for anything the other tools do not cover. Assign result to return data.

Game assets:
- Work at the final pixel size, and keep sizes the engine handles well, such as powers of two for tiling textures.
- export_image writes the composited visible layers by extension (.png, .webp, .jpg, .tga, .bmp, .ico) and creates folders. Use .png or .webp to keep transparency; .jpg and .bmp have none, so transparent areas become white.
- Keep the editable source: save_xcf next to the exported asset, for example art/hero.xcf beside art/hero.png, so layers and text stay editable later.
- make_sprite_sheet packs frame files into one grid sheet and reports each frame's rectangle; make_seamless makes a texture tile without seams by cross-fading it with copies of itself shifted by half its size, which can fade and double distinct shapes, so use it on noise-like textures.

close_image discards unsaved changes, so save first when they matter.
```

#### Token 影响

服务器保持连接期间，该部分为每个请求增加约 3,200 个字符。

#### KV Cache 影响

指令文本固定不变，因此重连后渲染出相同的部分。该部分在服务器首次连接时出现，在该行被禁用或服务器的重连次数耗尽时消失；每次变化都会改变组装后的系统提示词，可复用的前缀有多长由[系统提示词的缓存规则](../../core/system-prompt/README.zh.md#model-experience)决定。

### 工具结果与图像

#### 模型可见内容

每个结果包含一个文本块，`snapshot` 另附一张 PNG 或 JPEG 图像，其最长边不超过 1,568 像素，文件不超过 3 MiB。每次工作进程启动后，下一个结果以 `GIMP <version> started (Python <python>) with no images open.`（Desktop 应用自带的运行时则为 `GIMP <version> started (the runtime that WASD Engine ships, Python <python>) with no images open.`）和一个空行开头。`list_images`、`image_info`、`filter_info` 与 `pdb_describe` 返回紧凑的 JSON；其他工具返回写明图像、图层和尺寸的句子，部分句子后面附有 JSON。错误结果携带失败信息：未找到 GIMP 3 时返回下面的安装消息，请求被拒绝或 GIMP 操作失败时返回工作进程的异常类型和消息以及 `Error code: WORKER_REMOTE`，`execute_python` 的异常返回其 traceback，工作进程停止时返回错误码、有内容时附上最近的 GIMP 输出，以及状态已丢失的通知。[MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)只在声明支持图像输入的模型路由上准入图像，其他路由收到诊断文本。

##### macOS 上的 GIMP 安装消息

```markdown
GIMP 3 was not found. Install GIMP 3 from https://www.gimp.org/downloads/ (on macOS, `brew install --cask gimp` also works), then call the tool again. The GIMP plugin setting gimpConsolePath or the GIMP_CONSOLE environment variable selects a specific gimp-console executable.
```

#### Token 影响

参数、结果文本和已准入的图像在对话中保留，直到压缩（compaction）。工具限制了文本长度：`list_images` 最多列出 200 个图像，图层树最多 500 个条目，`filters` 与 `pdb_search` 最多 200 个匹配项，`pdb_describe` 的帮助最多 3,000 个字符；`execute_python` 最多保留 20,000 个字符的打印输出和 `result` JSON，`pdb_run` 最多保留 20,000 个字符的返回值，服务器会截断任何 JSON 超过 1 MiB 的文本块。

#### KV Cache 影响

仅追加：调用及其结果接在现有请求前缀之后，不会使其失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制描述 GIMP 工具当前的不足。

- **连接的 agent 共享一个 GIMP** — 通过 WASD Engine 的 MCP 服务器连接的 agent 共用打开的图像、它们的 id 和一个 Python 命名空间，因此其中一个可能修改或关闭另一个的图像，一个耗时的滤镜或脚本也会推迟其他 agent 的调用。
- **空闲的 Session 会丢失图像** — Session 的工作进程在 `workerIdleTimeoutMs` 内没有调用时停止，或在另一个 Session 需要占用 `maxWorkers` 中的位置时停止，打开的图像和未保存的更改随之丢失。
- **没有窗口** — 工具不提供画布、界面或 GIMP 截图，`pdb_run` 以非交互方式运行每个过程，不显示其对话框；`snapshot` 是查看图像的唯一方式。
- **重启会丢失打开的图像** — 崩溃、`requestTimeoutMs` 或 `timeout_seconds` 到期，或正在运行的调用被取消，都会使 GIMP 停止；打开的图像、未保存的更改、选区和 Python 命名空间随之丢失，新的工作进程启动时没有打开的图像。
- **首次启动较慢** — 使用新配置目录的首次启动约需 15 秒，触发它的工具调用会一直等待。
- **只为 Apple 芯片的 macOS 自带** — Desktop 应用只为 Apple 芯片的 macOS 自带 GIMP，使安装后的应用增加约 290 MB、下载增加约 95 MB；Web、Linux 与 Windows 使用已安装的 GIMP 3。
- **GIMP 搜索范围固定** — 搜索覆盖两项设置、自带的运行时、macOS 应用包、`PATH`，以及 Windows 上 `%ProgramFiles%` 与 `%LOCALAPPDATA%\Programs` 下的安装；安装在其他位置的 GIMP 需要 `gimpConsolePath` 或 `GIMP_CONSOLE`。`PATH` 上不带版本号的 `gimp-console` 不经版本检查即被使用，因此若在那里找到的是 GIMP 2，工作进程无法启动。
- **Windows 上没有崩溃看门狗** — 工作进程只在 `os.name` 为 `posix` 时启动看门狗；在其他系统上，GIMP 的 Python 进程终止后，GIMP 继续运行并保持回复管道打开，因此正在运行的调用要等请求时限到期才会失败。
- **部分过程值无法访问** — `pdb_run` 无法设置类型没有 JSON 形式的参数，并把整数数组和数值数组作为占位文本返回，因为 GIMP 的 Python 绑定无法读取它们。
- **图像需要支持图像的路由** — 在不支持图像输入的模型路由上，模型收到的是诊断文本，而不是快照。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
