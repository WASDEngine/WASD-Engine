---
description: "为智能体提供的游戏扩展：精选并固定到已测试版本的 Godot 与 Blender 扩展目录、列出这些扩展的系统提示词部分、智能体在判断游戏需要时用来把扩展安装到游戏项目中的 game_addons 工具、只有该项目的会话能以技能形式看到的使用指南，以及会话标题栏中的“扩展”对话框。"
kind: "package-reference"
---

# @deepseek-ai/dsh-game-addons

[English](README.md) | 中文

## 概述

该插件为智能体提供经过 WASD Engine 的 Godot 4.7.2 与 Blender 5.2.3 测试的第三方 Godot 扩展和 Blender 扩展。系统提示词会列出每个扩展、它有帮助的游戏阶段以及何时使用它。智能体自行判断游戏何时需要某个扩展，用 `game_addons` 工具安装它而无需征求用户同意，并告诉用户它添加了什么。只有在安装之后，该扩展的指南才会以技能形式出现，并且只出现在该项目的会话中。用户可以在会话标题栏的“扩展”对话框中管理扩展，通过 WASD Engine 的 MCP 服务器连接的智能体也能使用同一个工具和列表。

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

WASDEngine 覆盖层 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 会在每个 Web 与 Desktop profile 中插入 `game-addons` 行，并把 `blender` 行的 `addonStore` 设为同一个存储目录：

```yaml
- id: game-addons
  name: '@deepseek-ai/dsh-game-addons'
  config:
    catalogDir: !!js <the dsh-web-app package folder>/wasdengine/addons
    dataRoot: !!js dshHomePath('game-addons')
    blenderStore: !!js dshHomePath('game-addons', 'blender')
```

“游戏工具”标签页会用其图标列出这一行，“插件”页面的开关会在 profile 补丁中写入 `- id: game-addons` 与 `disabled: true` 来关闭它。插件需要 `tools`、`systemPrompt`、`workingDirectory`、`skills` 和 `typert` 服务。当 [`@deepseek-ai/dsh-godot`](../godot/README.zh.md) 的 `godot` 服务在运行时，插件会在安装后通过它导入项目，并通过 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务把工具提供给连接的智能体。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `catalogDir` | 必填 | 目录文件夹的绝对路径：每个扩展一个文件夹，内含 `addon.json` 与 `SKILL.md` |
| `dataRoot` | 必填 | 插件数据文件夹的绝对路径：下载的压缩包保存在 `archives/<sha256>.zip`，Blender 扩展的资源包解压到 `blender-assets/<id>/` |
| `blenderStore` | 必填 | Blender 扩展存储目录的绝对路径，`blender` 行的 `addonStore` 也指向它 |
| `downloadTimeoutMs` | `600000` | 一次压缩包下载（含响应体）的时间上限 |

插件启动时会加载并检查整个目录，因此无效的条目、名称与 id 不同的指南，或指向不存在条目的冲突项，都会使插件无法启动。

### 目录

每个条目固定一个发布版本：压缩包的 URL、SHA-256 与大小，压缩包中要安装的文件夹，SPDX 许可证、版权行，以及许可证要求的署名（如有）。条目还记录它扩展的应用、何时使用它以及何时只用 Godot 或 Blender 就足够、搜索标签、它有帮助的开发阶段（`prototype`、`content`、`polish`、`ship`）、与之冲突的扩展，以及验证时使用的运行时版本。Godot 条目会给出它在 `res://addons/` 下的文件夹、编辑器插件，以及其 `_enable_plugin()` 添加的自动加载与项目设置，因为安装程序无法点击编辑器中的插件开关。Blender 条目给出它的 Python 模块，以及它是从压缩包下载的扩展还是 Blender 自带的扩展。它还可以固定一个资源包（`assets`：URL、SHA-256、大小、文件夹、SPDX 许可证和页面），并在其目录文件夹中指定一个设置脚本（`blender.setup`），Blender 工作进程启用扩展后会调用其中的 `setup(module, assets)`；MPFB 的脚本会让 MPFB 使用 MakeHuman 的 CC0 系统资源。随附的目录只收录 GDScript 编写的 Godot 扩展，因此 Web 发布仍可正常工作，以及其运算符无需窗口即可运行的 Blender 扩展。每个条目在 [`tests/smoke/`](tests/smoke/) 中都有一个冒烟测试，由端到端测试套件运行。

### 工具

| 动作 | 作用 |
|---|---|
| `search` | 为 `query` 对目录中的扩展排序，或列出全部扩展，可以只看某个 `host`（`godot` 或 `blender`）或 `stage`。每个扩展会显示其 id、版本、许可证、下载大小、摘要、何时使用、何时不必使用、与之冲突的扩展、要求的署名，以及项目中是否已有它 |
| `guide` | 返回扩展的使用指南，并注明项目中尚未安装该扩展的情况 |
| `install` | 把 `id` 安装到项目中；`replace` 会替换 `addons/` 中已有但没有 WASD Engine 记录的副本 |
| `remove` | 从项目中移除 `id`，并列出仍在使用它的项目文件 |
| `list` | 列出项目中的目录扩展 |

`project` 指定包含 `project.godot` 的文件夹，相对于工作目录；省略时会像 Godot 工具那样使用最近的项目。一次 Godot 安装依次执行以下步骤：

1. 若缓存中没有固定的压缩包则下载，并检查其大小和 SHA-256。
2. 把扩展的文件夹解压到 `.wasdengine/` 下的暂存文件夹中；若许可证文件在压缩包中位于该文件夹之外，则一并加入。
3. 把文件夹移动到 `res://addons/<folder>/`。
4. 启用编辑器插件，并把其自动加载和设置写入 `project.godot`，其他行保持不变。
5. 在 `THIRD_PARTY_NOTICES.md` 中添加一个带有许可证文本的标记段落。
6. 在 `.wasdengine/addons.json` 中记录该扩展。
7. 导入项目一次；对于其格式要到第二遍才能完全导入的扩展，导入两次，并报告导入时的错误。

在写入记录之前失败时，会恢复原有的文件夹和 `project.godot`。如果与之冲突的扩展已在项目中，或其自动加载名称已被另一个脚本占用，安装会失败并说明该怎么做。再次安装同一版本不会下载任何内容，只会重写丢失的 `project.godot` 条目。Blender 安装会把扩展只解压一次到存储目录中，即 `<blenderStore>/<module>/`，并把其资源包只解压一次到 `<dataRoot>/blender-assets/<id>/`，二者都带有一个注明其压缩包的标记文件。之后它们的压缩包会离开缓存，因为存储目录会为所有项目保留这些文件。安装还会写入存储索引（其中给出每个 Blender 扩展的模块、设置脚本和资源文件夹），并在项目中记录该扩展。Blender 自带的扩展只会被记录。解压时会读取压缩包的中央目录并逐个文件流式写出，因此即使是 MPFB 的 268 MB 资源包，内存占用也保持有限。

移除会删除记录中列出的内容，并移除该扩展的 `project.godot` 条目和声明段落。它会列出最多 20 个仍引用该扩展文件夹或其自动加载的场景、脚本和资源，便于智能体修改它们。在 `addons/` 中发现但没有记录的目录扩展也可以用同样的方式移除。移除 Blender 扩展只会删去项目中的记录；存储目录会为其他项目保留它。

### 智能体何时安装扩展

由智能体判断何时值得安装某个扩展。插件在系统提示词中 Godot 游戏部分的位置添加 `game-addons` 部分。它告诉智能体：当手头的工作需要某个扩展的功能，而只用 Godot 或 Blender 会耗时更长或效果更差时，在该扩展有帮助的游戏阶段直接安装它，无需先征求用户同意；当引擎自带的节点和工具或一小段脚本就能完成时则不用它，也绝不因为以后可能用到而预先安装；安装之后，在使用扩展前先加载其指南，并告诉用户它添加了什么、为什么添加，以及许可证和许可证要求的署名。随后每个目录扩展占一行：其 id、应用、有帮助的阶段以及何时使用它。

在任何审批策略下，`install` 和 `remove` 都不询问任何人，这与其他游戏工具相同，会话的权限模式也不限制它们。用户在“扩展”对话框中的点击会以同样的方式更改项目。连接的智能体会在 MCP 服务器的说明中读到相同的判断规则和列表，并由其自身的运行框架决定是否询问其用户。

### 以技能形式提供的指南

插件注册名为 `game-addons` 的技能提供者。对于会话的工作目录，它会像 Godot 工具那样找到游戏项目，并列出该项目已安装或其 `addons` 文件夹中存在的每个目录扩展的指南。指南的技能名称就是扩展 id。其等级为 550，因此同名的项目技能、自定义技能和用户技能会优先于它，而内置技能则让位于它。如果某个副本的 `plugin.cfg` 写着另一个版本，其指南的描述会注明这一点。提供者会监视项目的 `addons` 与 `.wasdengine` 文件夹，因此在工具之外（例如通过 Git）安装或移除的扩展，也会改变下一步模型看到的列表。

### Blender 扩展

`blender` 行的 `addonStore` 会以 `WASD_ADDON_STORE` 传给每个 Blender 工作进程。在工作进程中，`import wasd_addons; wasd_addons.enable("<id>")` 会通过名为 `wasd` 的扩展仓库以 `bl_ext.wasd.<module>` 启用存储目录中的扩展，或启用 Blender 自带的扩展，例如 Rigify，并运行条目的设置脚本；`wasd_addons.assets("<id>")` 返回其资源包所在的文件夹。`new_scene` 和执行的代码都可能加载出厂设置，从而停用所有扩展并重置其偏好设置，因此工作进程会再次启用它之前启用过的扩展，并再次运行它们的设置脚本。每个 Blender 扩展的指南都以这一调用开头。

### “扩展”对话框

浏览器端会在工作区中每个会话标题栏的“发布”按钮之后注册一个“扩展”按钮。它的对话框列出目录中的 Godot 与 Blender 扩展，以及各自的图标、版本、许可证、大小、资源包、摘要、用途、要求的署名和会话项目中是否已有它。每个图标是条目目录文件夹中不超过 16 KiB 的 `icon.png` 或 `icon.svg`，由条目的 `icon` 指定，并记录其来源 URL、许可证和版权行；目录各文件夹旁的 `ICONS.md` 列出所有图标及许可证全文。目录只读取一次每个图标并转换为 data URL，拒绝含脚本或外部引用的 SVG；`project` Remote 把图标与视图并列返回，因此工具结果从不包含图标。没有图标的扩展显示一个带有其标题首字母的方块。点击即可安装，确认后即可移除；这些操作通过 `gameAddons` Remote 的 `project`、`installAddon` 和 `removeAddon` 方法完成，它们接收工作区文件夹。LiveShare 把这三个端点归类为仅所有者可用。

<a id="plugin-icon"></a>
### 插件图标

“游戏工具”标签页显示该包的 [`icon.svg`](icon.svg)：一个配色取自 WASD Engine Plugins 标志的 WASD Engine 键帽，上面带有加号。它尚待设计师审核。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、目录加载、工具、提示词部分、技能提供者与游戏 MCP 注册，以及 `gameAddons` Remote |
| [`src/catalog.ts`](src/catalog.ts) | 条目校验、指南 frontmatter 和搜索排序 |
| [`src/manager.ts`](src/manager.ts) | 项目中的状态、安装、移除、引用查找和 Blender 存储 |
| [`src/archive.ts`](src/archive.ts) | 固定版本的下载缓存，以及用 yauzl 逐个文件解压压缩包中的一个文件夹 |
| [`src/project-file.ts`](src/project-file.ts) | 保持其他行不变的 `project.godot` 编辑 |
| [`src/record.ts`](src/record.ts) | 在文件锁下读写 `.wasdengine/addons.json` |
| [`src/notices.ts`](src/notices.ts) | `THIRD_PARTY_NOTICES.md` 中的标记段落 |
| [`src/skills.ts`](src/skills.ts) | 指南的技能提供者与文件夹监视器 |
| [`src/tools.ts`](src/tools.ts) | `game_addons` 定义及其结果文本 |
| [`src/prompt.ts`](src/prompt.ts) | `game-addons` 系统提示词部分与提供者说明：何时安装扩展，以及每个目录扩展一行 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接智能体的工具与提供者 |
| [`src/client/`](src/client/) | “扩展”按钮与对话框 |

搜索会按每个查询词在字段中匹配到的最佳位置计分：词作为某个字段单词的开头时，id 或标题计 3 分，标签计 2 分，摘要或用途计 1 分。常见词不计分。五个字母及以上的词，若以某个四个字母及以上的字段单词开头，也算匹配，因此 `characters` 能匹配标签 `character`。解压时先读取压缩包目录，再以约 8 MB 为一批解压条目，各批之间稍作停顿，以独占创建方式写入每个文件，并跳过 `__MACOSX` 与 `.DS_Store` 条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md) — 游戏工具、它们的行以及 MCP 服务器。
- [技能子系统页面](../../../docs/subsystems/skills.zh.md) — 提供者等级、会话目录和 `skill` 工具。
- [godot](../godot/README.zh.md) — 导入步骤和 `godot_script`，后者运行 GUT 与 GdUnit4 扩展的命令行运行器。
- [blender](../blender/README.zh.md) — 工作进程和 `execute_python`，`wasd_addons` 就在其中运行。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词部分

#### 模型看到的内容

会话的智能体会在 Godot 游戏部分之前看到 `game-addons` 部分：先是下面的部分文本，然后每个目录扩展占一行，Godot 扩展在前，格式同下面的目录行。连接的智能体会在 MCP 服务器说明的 `## Game add-ons` 之下读到相同的判断规则和各行，只是以绝对路径的 `project`、`guide` 动作和 Blender 的 `wasd_addons.enable` 调用代替指南技能。

##### 部分文本

```markdown
# Game add-ons

game_addons installs tested third-party add-ons into the game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with the built-in Godot and Blender. Decide yourself when one is worth it; you do not need to ask the user first. Install an add-on when the work at hand needs what it does and building that with plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps. Skip it when Godot's own nodes, Blender's own tools, or a short script do the job, and do not install one in case it is needed later. action search shows each add-on's download size, conflicts, and when to skip it.
After installing one, load its guide, the skill named by its id, before using it, and tell the user what you added and why, with its license and any credit it requires. Remove an add-on only when the game no longer uses it.

Each add-on below shows its id, its application, the stages at which it helps (prototype makes the core game playable, content adds levels, characters, and assets, polish adds game feel and finish, and ship tests and releases the game), and when to use it:
```

##### 目录行

```markdown
- beehave (Godot; prototype, content): Enemies or NPCs need layered decisions such as patrol, chase, attack, flee and cooldowns that would become a tangle of if-statements or one large state machine script.
```

#### Token 影响

随附目录有 22 个扩展，该部分约 6,100 个字符，约 1,500 个 token，出现在每个会话的每个请求中，无论会话是否有 Godot 项目。每新增一个条目会增加一行，约 180 至 270 个字符；随附目录测试会把该部分限制在 8,000 个字符以内。

#### KV Cache 影响

文本只随随附目录变化，因此保留在已缓存的系统提示词前缀中；改变目录的 WASD Engine 更新只会改变它一次。

### 工具声明

#### 模型看到的内容

会话的智能体会看到 `game_addons`，带有 `action`（`search`、`guide`、`install`、`remove` 或 `list`）以及可选的 `query`、`host`、`stage`、`id`、`replace` 和 `project`。描述会列出目录收录的扩展类别，并告诉模型：当游戏需要某个扩展的功能、而只用 Godot 或 Blender 会耗时更长时，无需先征求用户同意即可自行安装，然后告诉用户它添加了什么及其许可证。连接的智能体看到的是同一个工具，其中 `project` 为绝对路径。

#### Token 影响

该声明约为 2,300 个字符的 JSON。提供者说明会为 MCP 服务器的说明增加约 6,500 个字符，其中大部分是目录各行。

#### KV Cache 影响

声明是静态的，因此无论项目是否有扩展，它都保留在已缓存的工具前缀中。

### 指南

#### 模型看到的内容

会话的技能目录会为项目中的每个扩展列出一行：扩展 id 及其指南描述，最多 500 个字符。`skill` 工具返回的指南最多 8,192 个字符，包含该扩展经过测试的 API、一个可运行的示例、如何用 Godot 或 Blender 工具验证，以及常见陷阱。

#### Token 影响

没有目录扩展的项目不会增加任何内容。每个扩展增加一行目录，约 200 至 350 个字符；加载的指南按其长度计入一次。

#### KV Cache 影响

安装或移除会改变目录，模型会以追加到对话中的新目录消息收到这一变化；之前的请求仍保持缓存。

### 工具结果

#### 模型看到的内容

搜索会列出匹配的扩展，每个约 300 至 600 个字符。安装结果会写明版本、许可证、安装路径、指南的技能名称、诸如要求的署名或跳过导入之类的备注，以及最多 20 个导入问题，并请模型告诉用户它添加了该扩展、原因及其许可证；项目已有该版本时不提此请求。移除结果会写明删除的路径，以及最多 20 个仍在使用该扩展的文件。

#### Token 影响

搜索整个目录的结果约为 9,000 个字符；指南结果即指南本身；其他结果为几百个字符。

#### KV Cache 影响

仅在对话中追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了插件提供的范围；它们是当前包的约束。

- **更改前不征求同意** — 在任何审批策略和权限模式下，智能体都会自行判断安装和移除目录扩展，因此用户通过智能体的回复、对话记录中的工具调用以及项目的 `.wasdengine/addons.json` 得知安装情况，并可在“扩展”对话框中撤销。
- **每个请求都带有目录** — 每个会话的系统提示词都会列出整个目录，没有 Godot 项目的会话也不例外；目录超出该部分 8,000 个字符的预算时，需要更短的列表。
- **固定的上游压缩包** — 压缩包从各项目的发布或标签 URL 下载。若 GitHub 用不同的字节重新生成了标签压缩包，SHA-256 检查会失败，直到重新固定该条目。
- **不收录仅限编辑器的扩展** — 智能体无法使用编辑器的停靠面板、笔刷或控件，因此目录不收录只能通过编辑器界面使用的扩展。
- **不收录 GDExtension 扩展** — WASD Engine 的 Web 发布不加载 GDExtension，因此目录不收录 Terrain3D 或 LimboAI 等编译型扩展。
- **声明文件留在项目中** — `THIRD_PARTY_NOTICES.md` 不属于导出的游戏；附带扩展的游戏需自行为其署名。
- **Blender 存储只保留一个版本** — 所有项目都使用目录中 Blender 扩展的版本；目录中的较新版本会为所有项目替换已存储的版本。
- **手工复制的副本** — 在 `addons/` 中发现的目录扩展副本会得到目录中的指南，而该指南可能与其版本不符。
- **开发用扩展会被打包** — Web 导出会打包所有资源，因此 GUT 这类测试扩展（约 3 MB）在被移除之前会随发布的游戏一起发布。
- **编辑器设置** — 编辑器插件在导入步骤中使用用户的 Godot 编辑器设置加载；Importality 会在其中的 `editor_settings-4.7.tres` 里添加空的 `importality/*` 键。
- **无界面运行时崩溃的扩展** — Sprite Sheet Generator 2.2.3 在写出精灵图之后会以段错误结束无界面的 Blender，因此目录不收录它；智能体改用 `bpy` 渲染精灵帧。
- **资源包很大** — MPFB 附带 MakeHuman 的系统资源：与扩展一起下载 312 MB，在扩展存储和资源文件夹中占用 358 MB；所有项目共用它们，移除扩展时会保留。
- **字母方块** — Extra Import Hints、GdUnit4 和 YATI 只有以 Godot 或 Blender 标志改作的图标，而商标条款禁止把这些标志用作其他项目的标志；VRM 的列表图标没有许可证。这四个扩展显示字母方块。
- **AGPL 图标** — MPFB 的图标是采用 AGPL-3.0-or-later 的 MakeHuman 标志，因此 `ICONS.md` 旁随附 `LICENSE-AGPL-3.0.txt`，其中是该许可证的全文。
- **扩展偏好设置会被重置** — 出厂设置会重置 Blender 扩展的偏好设置；工作进程会再次运行每个扩展的设置脚本，从而恢复目录设定的内容（例如 MPFB 的资源文件夹），但不会恢复智能体自己设置的偏好。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

添加或更新条目时，先固定发布版本的压缩包与 SHA-256，再阅读其 `plugin.gd`，了解 `_enable_plugin()` 添加了什么。指南须在目录内容测试检查的大小之内，并在 `tests/smoke/<id>/` 下添加冒烟测试。设置 `WASD_LIBGODOT_DIR` 为已安装的运行时文件夹并缓存 uv 的 bpy 5.2.3 后，运行 `vitest run --config vitest.e2e.config.ts packages/gamedev/game-addons/tests/catalog.e2e.ts`；`WASD_ADDON_ARCHIVES` 可在多次运行之间保留下载的文件。

</details>
