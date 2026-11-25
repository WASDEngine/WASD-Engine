---
description: "为智能体提供的游戏扩展：精选并固定到已测试版本的 Godot 与 Blender 扩展目录、列出这些扩展的系统提示词部分、智能体在判断游戏需要时用来把扩展安装到游戏项目中的 game_addons 工具、只有该项目的会话能以技能形式看到的使用指南，以及会话标题栏中的“扩展”对话框，其开关决定智能体可以使用哪些扩展。"
kind: "package-reference"
---

# @deepseek-ai/dsh-game-addons

[English](README.md) | 中文

## 概述

该插件为智能体提供经过 WASD Engine 的 Godot 4.7.2 与 Blender 5.2.3 测试的 Godot 扩展和 Blender 扩展，既有 WASD Engine 自己的，也有第三方的。系统提示词会按类别列出每个扩展，并用几个词说明其用途；搜索可以得知何时使用它。游戏需要时，智能体会用 `game_addons` 工具安装扩展而无需征求同意，并告诉用户；只有在安装之后，扩展的指南才会成为该项目会话的技能，通过 WASD Engine 的 MCP 服务器连接的智能体也能使用同一个工具。在会话标题栏的“扩展”对话框中，用户可以为所有智能体关闭任意扩展。

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
    guides: !!js [<the dsh-web-app package folder>/wasdengine/skills/game-look/SKILL.md]
```

“游戏工具”标签页会用其图标列出这一行，“插件”页面的开关会在 profile 补丁中写入 `- id: game-addons` 与 `disabled: true` 来关闭它。插件需要 `tools`、`systemPrompt`、`workingDirectory`、`skills` 和 `typert` 服务。当 [`@deepseek-ai/dsh-godot`](../godot/README.zh.md) 的 `godot` 服务在运行时，插件会在安装后通过它导入项目；它通过 [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.zh.md) 的 `gameMcp` 服务把工具提供给连接的智能体，并通过 Loader profile 提供的 [`@deepseek-ai/dsh-settings`](../../settings/settings/README.zh.md) 的 `settings` 服务保存“扩展”对话框的开关。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `catalogDir` | 必填 | 目录文件夹的绝对路径：每个扩展一个文件夹，内含 `addon.json` 与 `SKILL.md` |
| `dataRoot` | 必填 | 插件数据文件夹的绝对路径：下载的压缩包保存在 `archives/<sha256>.zip`，Blender 扩展的资源包解压到 `blender-assets/<id>/` |
| `blenderStore` | 必填 | Blender 扩展存储目录的绝对路径，`blender` 行的 `addonStore` 也指向它 |
| `guides` | `[]` | 与扩展配套、但不属于任何一个扩展的指南的 `SKILL.md` 文件绝对路径，例如 gamedev 预设内置的 `game-look` 技能：`action: guide` 按其 frontmatter 中的名称显示每份指南，不带查询词的搜索和 MCP 服务器的说明会列出每份指南及其描述 |
| `downloadTimeoutMs` | `600000` | 一次压缩包下载（含响应体）的时间上限 |
| `resultChars` | `8192` | `game_addons` 的结果保持完整时最多的 Unicode 码位数：指南只在此范围内附上它链接的 `references/` 文件，只带筛选条件的搜索也只在此范围内完整描述匹配项。应与 profile 中工具结果修剪器的 `thresholdChars` 保持一致，会话上下文占满时，修剪器会修剪更长的结果；gamedev 预设的值为 8,192 |
| `allowed` | `{}` | 按 id 记录智能体能否使用每个目录扩展；没有条目的扩展为开启。这是一个 volatile 字段：“扩展”对话框会在应用运行时写入它，profile 补丁也可以设置它，例如 `allowed: { gut: false }` |

插件启动时会加载并检查整个目录及其 `guides`，因此无效的条目、名称与 id 不同或链接了其文件夹中没有的 `references/` 文件的指南、指向不存在条目的冲突项，或无法读取、名称已被占用的 `guides` 文件，都会使插件无法启动。`allowed` 中目录没有的 id（例如后来的目录删除了的扩展）不起任何作用；插件会在启动时以及每次 `allowed` 变化后在警告中列出它。

### 目录

每个条目固定一个发布版本：压缩包的 URL、SHA-256 与大小，压缩包中要安装的文件夹，SPDX 许可证、版权行，以及许可证要求的署名（如有）。条目还记录它扩展的应用、它的类别和一条最多 60 个字符的提示（智能体在搜索之前只读到这两项）、何时使用它以及何时只用 Godot 或 Blender 就足够、搜索标签、它有帮助的开发阶段（`prototype`、`content`、`polish`、`ship`）、与之冲突的扩展，以及验证时使用的运行时版本。Godot 条目会给出它在 `res://addons/` 下的文件夹、编辑器插件，以及其 `_enable_plugin()` 添加的自动加载与项目设置，因为安装程序无法点击编辑器中的插件开关。它还可以指定叠加文件夹（`godot.overlay`）：目录中的文件夹，可位于它自己的目录文件夹中，也可位于各条目旁边；安装程序会把其中的文件加入扩展文件夹，但不会替换压缩包中的文件。条目可以把压缩包文件夹中的某些路径排除在安装之外（`archive.exclude`）：演示、示例场景、截图、C# 文件，以及只有 Godot 编辑器才能使用的编辑器插件，这些都不应被游戏打包；压缩包中不存在的路径会使安装失败，因此条目不会在不知不觉中与其压缩包不再相符。叠加文件可以放在被排除文件原来的位置：Starter Kit FPS 的 `objects/player.gd` 在 Web 构建中只在点击之后才捕获鼠标，Maaack's Menus Template 的制作人员名单标签以中性文本取代模板的占位内容，Controller Icons 的 `ControllerIcons.gd` 不再向浏览器查询键盘布局（那会在浏览器中打印错误），Easy Vehicle Physics 的 `scripts/wheel.gd` 在所属分组没有指明表面的地面上照常行驶，而不是报错停下；在不属于任何表面分组的地面上，它按车辆的 `Road` 表面行驶（车辆没有 `Road` 时按其第一个表面），而不是沿用上一次所在的表面；SO FLUFFY 的 `so_fluffy.gd` 读取相机和网格在世界中的位置，使毛发随主体移动而摆动、在相机支架附近保持细节，并在它添加毛发的表面下保留该表面自身的材质。这样的文件是压缩包中文件的修改副本，沿用压缩包的许可证。起始套件是一个完整的 Godot 项目，而不是扩展文件夹（`archive.projectRoot`）：安装程序会排除它的 `project.godot`、`.godot` 文件夹和 `export_presets.cfg`，把其余内容解压到条目在 `res://addons/` 下的文件夹中，并把其场景、脚本、资源、着色器以及 `.cfg` 和 `.json` 文件中的 `res://` 路径改写到该文件夹，套件的输入动作和自动加载则来自条目的 `settings` 和 `autoloads`。两个 Universal Animation Library 条目（Quaternius 的 CC0 动画包）以这种方式加入导入设置，把每个动画包导入为重定向到 Godot 人形骨架的 `AnimationLibrary`；二者都会加入 `humanoid-retarget/`，其中有骨骼映射和 `retarget.gd`，后者用来设置模型的导入，使其能播放这些片段。叠加文件会进入游戏，因此 WASD Engine 把自己编写的叠加文件贡献到公有领域（CC0-1.0），通知中的版权行也这样说明。WASD Engine 自己编写的扩展的条目没有压缩包：这样的 Godot 条目只由其叠加文件夹组成，例如 WASD Cloth 的 `wasd-cloth/addon/`（布料节点、风区、旗帜着色器与检查脚本），或 WASD Water 的 `wasd-water/addon/`（水体节点、其着色器、外观预设与泡沫纹理，以及浮体节点），或 WASD Post 的 `wasd-post/addon/`（屏幕处理通道、其着色器与外观预设）；这样的 Blender 扩展则给出 `blender.files`，即存放其 `blender_manifest.toml` 与 Python 包的目录文件夹，例如 WASD Cloth for Blender 的 `wasd-cloth-blender/extension/`。Blender 条目给出它的 Python 模块，以及它是扩展（来自压缩包或目录中的文件）还是 Blender 自带的扩展。它还可以固定一个资源包（`assets`：URL、SHA-256、大小、文件夹、SPDX 许可证和页面），并在其目录文件夹中指定一个设置脚本（`blender.setup`），Blender 工作进程启用扩展后会调用其中的 `setup(module, assets)`；MPFB 的脚本会让 MPFB 使用 MakeHuman 的 CC0 系统资源。条目可以设置 `bundled`，两个 Universal Animation Library 以及带 MakeHuman 资源包的 MPFB 就这样设置：桌面应用打包时会把它的压缩包及其资源包的压缩包以 `<sha256>.zip` 放进本包位于 `app.asar` 之外的 `archives/` 文件夹，安装时直接读取，既不下载也不删除；没有这样的文件时（例如 Web 配置或源码检出），安装会像其他条目一样下载压缩包。随附的目录只收录 GDScript 编写的 Godot 扩展，因此 Web 发布仍可正常工作，以及其运算符无需窗口即可运行的 Blender 扩展。每个条目在 [`tests/smoke/`](tests/smoke/) 中都有一个冒烟测试，由端到端测试套件运行；该套件还会用 `godot_check` 的脚本加载器，按整个项目检查的顺序及其逆序加载 Godot 条目的每个脚本，结果必须没有错误。Godot 冒烟测试的运行也不得打印任何错误，即以 `ERROR:` 或 `SCRIPT ERROR:` 开头的行，因为在浏览器中打印错误的游戏不会被发布；Godot 在关闭时报告的、关于场景仍占用的资源的内容不计在内，对于运行会打印而游戏不会遇到的其他错误行，冒烟测试在 `errors` 中各列出其中一段，例如 Beehave 的冒烟测试列出其调试器在游戏退出时打印的那一行。套件还会对每个已安装的 Godot 条目运行 Web 导出的功能扫描：条目自身的文件只能引出其冒烟测试列出的说明（`webNotes`），此时其指南要说明该扩展在 Web 构建中的表现。若两个互不冲突的条目声明了同名的全局类，套件也会失败，因为这会使二者在同一个项目中都无法加载。

### 工具

| 动作 | 作用 |
|---|---|
| `search` | 不带查询词和筛选条件时，显示目录索引：每个扩展列在其类别之下，附带提示以及项目中是否已有它，之后是 `guides` 中的指南及其描述。提到 Godot 或 Blender 的 `query`（扩展的 id 或查询词）只搜索该应用的扩展，与 `host`（`godot` 或 `blender`）相同，除非它同时提到两者或设置了 `host`；`game`、`plugin`、`add-ons` 等常见词不参与排序。带用于排序的 id 或查询词时，对匹配的扩展排序，显示最佳的 8 个以及匹配总数；查询为某个 id 时只显示该扩展。只带 `category`、`host`、`stage` 或只提到应用名称时，显示每个匹配项：结果不超过 `resultChars` 时完整描述，每个类别的扩展都是如此，否则像索引那样列在各自类别之下。每个完整描述的匹配项会显示其 id、版本、许可证、下载大小（无需下载时则说明它是 Blender 自带还是随 WASD Engine 提供）、摘要、何时使用、何时不必使用、与之冲突的扩展、要求的署名，以及像索引那样标注项目已有的情况；这些标注放不下时，改为用一行说明项目已有其中多少个，并指出 `list` 会列出它们。是否完整描述匹配项在每个项目中都相同：描述的第一行不写项目文件夹，结果也为那一行留出了空间 |
| `guide` | 返回扩展的使用指南，并注明项目中尚未安装该扩展的情况，之后在结果不超过 `resultChars` 的范围内附上指南链接的每个 `references/` 文件，因为结果的读者无法通过链接打开它们；放不下的文件会连同显示它的调用一起列出，即把 `reference` 设为该文件的路径，此时只返回该文件。对于 `guides` 中某份指南的名称，以同样方式返回该指南，并注明其中提到的、已被用户关闭的扩展 |
| `install` | 把 `id` 安装到项目中；`replace` 会替换 `addons/` 中已有但没有 WASD Engine 记录的副本 |
| `remove` | 从项目中移除 `id`，把它的文件夹保留在备份中，并列出仍在使用它的项目文件，以及保留了项目所设值的该扩展设置 |
| `list` | 列出项目中的目录扩展 |

`project` 指定包含 `project.godot` 的文件夹，相对于工作目录；省略时会像 Godot 工具那样使用最近的项目。用户关闭的扩展不会出现在 `search` 中，其计数只包括智能体可以使用的扩展；`guide` 和 `install` 会拒绝它，消息会告诉智能体不用它完成工作，或请用户在“扩展”对话框中开启它；项目中有它时，`list` 仍会列出它并标明已关闭；`remove` 仍可将其移出。所有扩展都关闭时，`search` 会说明这一点。拒绝，以及本包能识别的失败（例如下载失败或压缩包与其固定值不符），会抛出 `GameAddonError`，或其针对目录、压缩包、路径和记录的子类，并带有 [`src/errors.ts`](src/errors.ts) 说明的代码，例如 `GAME_ADDON_CONFLICT`；缺少或不匹配的参数会抛出 `ToolArgsError`（`INVALID_ARGS`）；因此工具结果会记录各自的类和代码。计算机文件操作的失败（例如磁盘已满 `ENOSPC` 或文件夹没有权限 `EACCES`）则以 Node 自己的错误及其 `code` 抛出，工具结果只显示其消息，不带类和代码。一次 Godot 安装依次执行以下步骤：

1. 若缓存中没有固定的压缩包则下载，并检查其大小和 SHA-256。没有压缩包的扩展不下载任何内容。
2. 把扩展的文件夹解压到 `.wasdengine/` 下的暂存文件夹中，不含条目排除的路径；若许可证文件在压缩包中位于该文件夹之外，则一并加入，并加入条目叠加文件夹中的文件；项目压缩包还会去掉 `project.godot`、导入缓存和导出预设，并把 `res://` 路径改写到扩展的文件夹；没有压缩包的扩展只由其叠加文件组成。
3. 获取项目记录的锁 `.wasdengine/addons.json.lock`，并再次检查项目。
4. 把文件夹移动到 `res://addons/<folder>/`。
5. 启用编辑器插件，并把其自动加载和设置写入此刻读取的 `project.godot`，其他行保持不变。`[importer_defaults]` 中的设置（例如 Extra Import Hints 的 `scene`）会把该扩展的条目合并到项目自己的导入选项 Dictionary 中；其他设置一律整体采用该扩展的值，值为 Dictionary 时也是如此，例如起始套件的输入动作或 LiteTerrain 的着色器全局变量 `world_haze`。记录旁的 `.wasdengine/addon-settings.json` 保存这次安装写入的每个设置，以及该扩展的值和项目自己的值（或项目原本没有它）。更新扩展时，会先像移除那样去掉已安装版本写入、而目录中的版本不再设置的设置；设置仍为某个扩展的值时，项目自己的值是记住的那个值，否则是项目此后给它的值。结果的备注会列出项目自己的值被该扩展的值取代的每个设置，例如游戏也定义了的起始套件输入动作；更新时会再次列出它们；项目在安装之后给这类设置的值，会在移除时恢复。
6. 在 `THIRD_PARTY_NOTICES.md` 中添加一个带有许可证文本的标记段落。
7. 在 `.wasdengine/addons.json` 中记录该扩展，并释放锁。
8. 导入项目一次；对于其格式要到第二遍才能完全导入的扩展，导入两次，并报告导入时的错误。

每次安装和移除在更改项目期间都持有记录的锁，因此会话的智能体、其队友、连接的智能体和“扩展”对话框所做的更改会依次进行，跨进程时也是如此，任何一方都不会写回被另一方改过的 `project.godot` 或声明文件。第 4 到第 7 步中的失败会撤销此前的步骤：原有的文件夹放回原处，`project.godot` 和声明文件只去掉这次安装写入的内容，并保留其他人在此期间所做的更改。错误信息会说明未能恢复的内容，例如留在 `.wasdengine/trash/` 中的被替换文件夹。在第 4 步之前按下停止，项目保持原样；从第 4 步起，安装会完成，按下停止只会结束导入。如果与之冲突的扩展已在项目中，或其自动加载名称已被另一个脚本占用，安装会失败并说明该怎么做。再次安装同一版本不会下载任何内容，只会补回 `project.godot` 丢失的该扩展的内容：其编辑器插件、缺少的自动加载或设置，以及 `[importer_defaults]` 的 Dictionary 中缺少的条目。项目已有的值保持不变，即使与该扩展的值不同；备注会列出补回的内容，以及每个保留了与扩展不同的项目自有值的设置。Blender 安装会把扩展只解压一次到存储目录中，即 `<blenderStore>/<module>/`，并把其资源包只解压一次到 `<dataRoot>/blender-assets/<id>/`，二者都带有一个注明其压缩包的标记文件。WASD Engine 自己编写的扩展则从其目录文件夹复制到那里，标记文件记录其文件路径与内容的 SHA-256，因此其中任一文件改动后，下一次安装会替换这份副本。之后它们的压缩包会离开缓存，因为存储目录会为所有项目保留这些文件。安装还会写入存储索引（其中给出每个 Blender 扩展的模块、设置脚本和资源文件夹），并在项目中记录该扩展。索引中的设置脚本一律指向 `<blenderStore>/.wasd-setup/<id>/` 中的副本，该副本带有一个记录其路径与内容 SHA-256 的标记文件，而从不指向目录中的文件：Blender 工作进程用自己的 Python 运行设置脚本，而这个 Python 无法读取桌面应用 `app.asar` 内的目录。插件每次启动时也会写入索引和这些副本，从而替换早期版本写入的、指向目录文件的索引。Blender 自带的扩展只会被记录。解压时会读取压缩包的中央目录并逐个文件流式写出，因此即使是 MPFB 的 268 MB 资源包，内存占用也保持有限。磁盘已满或文件夹没有权限时，会以文件系统自己的错误（例如 `ENOSPC` 或 `EACCES`）失败，而不会报告为压缩包损坏。

移除会先列出最多 20 个仍引用该扩展文件夹或其自动加载的场景、脚本和资源，便于智能体修改它们；在这次扫描期间按下停止不会改变任何内容。随后，移除在持有记录的锁时把该扩展的文件夹移出项目，并移除该扩展的 `project.godot` 条目和声明段落：安装写入、且仍为该扩展所设值的每个设置会恢复项目自己的值，项目原本没有的则被移除，除非项目中的另一个扩展也设置了它。在 `[importer_defaults]` 中，这对安装添加的每个条目分别成立；那里取代了非 Dictionary 值的设置，在去掉该扩展的条目后恢复那个值。此后被项目修改过的设置或 `[importer_defaults]` 条目整体保留项目的值，因此输入动作不会丢失其 `deadzone`，着色器全局变量也不会丢失其 `type`，移除结果会列出它。安装写入了哪些设置来自 `addon-settings.json`，而 WASD Engine 0.2.4 及更早版本只在其中保存项目的值：对于它们的安装，已安装版本的设置即 [`src/record.ts`](src/record.ts) 中 `UNRECORDED_SETTINGS` 列出的设置，例如 ProtonScatter 4.2.0-dev+7198cc0 的 `[filesystem] import/blender/enabled`；未列出时，对于目录中的版本，即目录条目的设置。该文件不含其值的其他版本的安装没有写入任何设置，因为此后的每次安装都会记录其设置。失败时会像安装一样撤销移除。该文件夹会移到为该扩展新建的备份文件夹 `.wasdengine/backups/<id>/<time>/`，该文件夹以移除的时间命名，例如 `2026-11-12T09-45-10.000Z`，移除结果会给出它；任何备份都不会取代另一个备份，也不会被删除。`.wasdengine/backups/` 中的 `.gitignore` 使备份不进入版本控制；带 `replace` 的安装也会以同样方式保留被替换的文件夹，并在说明中给出该备份。在 `addons/` 中发现但没有记录的目录扩展也可以用同样的方式移除。移除 Blender 扩展只会删去项目中的记录；存储目录会为其他项目保留它。

项目中的记录可能由他人写入，因此移除只会移出记录所列、位于该扩展文件夹 `addons/<folder>/` 之内的路径：记录中有其他位置的路径时，移除会在做出任何更改之前停止；路径含反斜杠、冒号或 `..` 段的记录无效。任何更改都不会沿符号链接离开项目：如果 `addons` 或 `.wasdengine` 文件夹指向别处，安装或移除会在那里移动或写入任何内容之前失败；作为链接的扩展文件夹会以链接本身被移动。

### 智能体何时安装扩展

由智能体判断何时值得安装某个扩展。插件在系统提示词中 Godot 游戏部分的位置添加 `game-addons` 部分。它告诉智能体：当手头的工作需要某个扩展的功能，而只用 Godot 或 Blender 会耗时更长或效果更差时，在该扩展有帮助的游戏阶段直接安装它，无需先征求用户同意；当引擎自带的节点和工具或一小段脚本就能完成时则不用它，也绝不因为以后可能用到而预先安装；安装之后，在使用扩展前先加载其指南，并告诉用户它添加了什么、为什么添加，以及许可证和许可证要求的署名。随后是目录索引：每个类别一个标题，其下用户未关闭的每个扩展占一行，包含其 id、Blender 扩展的 `(Blender)` 标记以及它的提示。该部分要求智能体在自己动手实现某个已列出扩展的功能之前，先用 id、类别或查询词搜索，读到该扩展何时有帮助、何时不必使用，以及它的大小、许可证和冲突。该部分在每个模型步骤读取开关，所有扩展都关闭时会被省略。

在任何审批策略下，`install` 和 `remove` 都不询问任何人，这与其他游戏工具相同，会话的权限模式也不限制它们。用户在“扩展”对话框中的点击会以同样的方式更改项目。连接的智能体会在 MCP 服务器的说明中读到相同的判断规则，但说明不列出任何扩展：说明的概述、指南和该工具的描述都会要求它们在规划游戏之前用 `action: search` 读目录索引，并由其自身的运行框架决定是否询问其用户。

### 以技能形式提供的指南

插件注册名为 `game-addons` 的技能提供者。对于会话的工作目录，它会像 Godot 工具那样找到游戏项目，并列出该项目已安装或其 `addons` 文件夹中存在的每个目录扩展的指南，用户关闭的扩展除外；关闭之前列出的指南也不再提供。指南的技能名称就是扩展 id。其等级为 550，因此同名的项目技能、自定义技能和用户技能会优先于它，而内置技能则让位于它。如果某个副本的 `plugin.cfg` 写着另一个版本，其指南的描述会注明这一点。提供者会监视项目的 `addons` 与 `.wasdengine` 文件夹，因此在工具之外（例如通过 Git）安装或移除的扩展，也会改变下一步模型看到的列表；`allowed` 变化时列表同样会刷新。

### Blender 扩展

`blender` 行的 `addonStore` 会以 `WASD_ADDON_STORE` 传给每个 Blender 工作进程。在工作进程中，`import wasd_addons; wasd_addons.enable("<id>")` 会通过名为 `wasd` 的扩展仓库以 `bl_ext.wasd.<module>` 启用存储目录中的扩展，或启用 Blender 自带的扩展，例如 Rigify，并运行条目的设置脚本；`wasd_addons.assets("<id>")` 返回其资源包所在的文件夹。`new_scene` 和执行的代码都可能加载出厂设置，从而停用所有扩展并重置其偏好设置，因此工作进程会再次启用它之前启用过的扩展，并再次运行它们的设置脚本。每个 Blender 扩展的指南都以这一调用开头，用 Blender 工具 `execute_python` 运行，多数指南按会话列出的名称将其写作 `mcp__wasd_blender__execute_python`；对连接的智能体，指南和安装结果的备注会把这类名称写成 MCP 服务器提供的名称 `blender_execute_python`，GIMP 和 SuperCollider 工具也是如此。存储目录的索引会用 `allowed: false` 和工具的拒绝消息标记用户关闭的扩展，`enable` 和 `assets` 会抛出这条消息；每次 `allowed` 变化后，插件都会依次重写索引，因此最后一次变化会保留下来。

### “扩展”对话框

浏览器端会在工作区中每个会话标题栏的“导出 / 分享”按钮之后注册一个“扩展”按钮。它的对话框按目录的类别列出目录中的扩展，类别的顺序与智能体读到的索引相同，每个扩展带有图标、Blender 扩展的标记、版本、许可证、大小（无需下载时则是它的来处：Blender 自带，或对 WASD Engine 自己编写的扩展而言随 WASD Engine 提供）、资源包、摘要、用途、要求的署名、会话项目中是否已有它，以及表示智能体能否使用它的开关；没有 Godot 项目的工作区文件夹会显示列表和开关，但不显示是否已有。列表上方有一个搜索框，对话框打开时焦点在其中（手机上除外）；它把列表缩小到标题、id、所属应用、提示语、摘要、用途、搜索词或类别标题中包含所输入每个词的扩展，并在列表滚动时留在原位。每个图标是条目目录文件夹中不超过 16 KiB 的 `icon.png` 或 `icon.svg`，由条目的 `icon` 指定，并记录其来源 URL、许可证和版权行；目录各文件夹旁的 `ICONS.md` 列出所有图标及许可证全文。目录只读取一次每个图标并转换为 data URL，拒绝含脚本或外部引用的 SVG；`project` Remote 把图标与视图并列返回，因此工具结果从不包含图标。WASD Engine 自有扩展显示来自 [Lucide](https://lucide.dev) 的图标，每个图标对应该扩展的用途；以图片形式绘制的图标不会采用页面的文字颜色，因此每个文件都把描边颜色设为 WASD Engine 的紫色。没有图标的扩展显示一个方块，其中是标题的首字母；WASD Engine 自有扩展的标题以“WASD”开头，方块显示其后的首字母。开关会调用 `gameAddons` Remote 的 `setAllowed`，它通过 Settings 服务的一次路径编辑设置 `allowed.<id>`：编辑写入该行的 profile 补丁，无需重启即可生效，适用于所有项目和所有智能体，包括会话的智能体和连接的智能体。开关显示 Host 接受的值，因此被拒绝的写入会让开关保持原样，并通过提示说明原因；保存一次更改时，所有开关都会等待；更改后的提示始终显示在列表底部，它会说明智能体那边有什么变化，对于会话的游戏中已有的扩展，还会说明游戏会保留它，直到智能体将其移除。对话框既不安装也不移除扩展，这些由智能体完成。对话框通过 Remote 的 `project` 读取列表，它接收工作区文件夹；LiveShare 把这两个端点都归类为仅所有者可用。

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
| [`src/index.ts`](src/index.ts) | 配置、目录加载、工具、提示词部分、技能提供者与游戏 MCP 注册、`gameAddons` Remote，以及开关的写入及其对指南和 Blender 索引的影响 |
| [`src/catalog.ts`](src/catalog.ts) | 条目校验、类别、指南 frontmatter 和搜索排序 |
| [`src/errors.ts`](src/errors.ts) | `GameAddonError` 及其代码 |
| [`src/manager.ts`](src/manager.ts) | 项目中的状态、安装、移除、引用查找、Blender 存储，以及对用户关闭的扩展的拒绝 |
| [`src/archive.ts`](src/archive.ts) | 固定版本的下载缓存，以及用 yauzl 逐个文件解压压缩包中的一个文件夹，不含条目排除的路径 |
| [`src/project-root.ts`](src/project-root.ts) | 安装时从不取自项目压缩包的内容，以及把其 `res://` 路径改写到扩展文件夹 |
| [`src/project-file.ts`](src/project-file.ts) | 保持其他行不变的 `project.godot` 编辑，以及保留他人此后更改的撤销 |
| [`src/record.ts`](src/record.ts) | `.wasdengine/addons.json` 及其文件锁（每次安装和移除在更改项目期间都持有该锁）、`.wasdengine/addon-settings.json`（安装写入的设置及项目自己的值），以及该文件未保存的、WASD Engine 0.2.4 及更早版本的安装所写入的设置 |
| [`src/paths.ts`](src/paths.ts) | 记录路径的规则，以及经过解析、使任何更改都不离开项目的项目路径 |
| [`src/notices.ts`](src/notices.ts) | `THIRD_PARTY_NOTICES.md` 中的标记段落 |
| [`src/skills.ts`](src/skills.ts) | 指南的技能提供者与文件夹监视器 |
| [`src/tools.ts`](src/tools.ts) | `game_addons` 定义及其结果文本 |
| [`src/prompt.ts`](src/prompt.ts) | `game-addons` 系统提示词部分与提供者说明：何时安装扩展，以及按类别排列的目录索引 |
| [`src/mcp.ts`](src/mcp.ts) | 面向连接智能体的工具与提供者 |
| [`src/client/`](src/client/) | “扩展”按钮与对话框 |

查询恰为某个扩展的 id 时，只返回该扩展。否则搜索会按每个查询词在字段中匹配到的最佳位置计分：词作为某个字段单词的开头时，id 或标题计 3 分，标签或提示计 2 分，摘要或用途计 1 分。常见词和只由数字组成的词（例如版本号）不计分，其中 `add-on` 的各种写法 `add-ons`、`addons` 和 `add on`（中间可以是任意连字符或空格）都算作一个词，所有格 `'s` 会被去掉；`godot` 或 `blender` 则改为按应用筛选，除非查询同时提到两者。五个字母及以上的词，若以某个四个字母及以上的字段单词开头，也算匹配，因此 `characters` 能匹配标签 `character`。解压时先读取压缩包的中央目录，再逐个文件以流式方式写入，以独占创建方式写入每个文件，并跳过 `__MACOSX` 与 `.DS_Store` 条目。

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

会话的智能体会在 Godot 游戏部分之前看到 `game-addons` 部分：先是下面的部分文本，然后是目录索引：每个收录了扩展的类别一个标题，其下用户未关闭的每个扩展占一行，Godot 扩展在前，格式同下面的索引行；标题列出该类别随附条目所涵盖的内容，末尾的括号中是该类别的搜索值。连接的智能体会在 MCP 服务器说明的 `## Game add-ons` 之下读到相同的判断规则，但没有索引：指南让它用不带查询的 `action: search` 读同一份索引，用扩展的 id、类别或查询词搜索以了解细节，并以绝对路径的 `project`、`guide` 动作和 Blender 的 `wasd_addons.enable` 调用代替指南技能。指南的末尾列出 `guides` 中的指南及其描述，并要求在开展每份指南所针对的工作之前用 `action: guide` 读它：在 Web 与 Desktop profile 中，这就是随附的 `game-look` 技能，即构建 3D 游戏观感的顺序以及每一步所用的扩展；会话的智能体把它当作技能读取，而没有技能的连接智能体通过该动作读取，其中提到的、已被用户关闭的扩展会被标出。因此连接的智能体只从这次搜索读一次索引。Claude Code 的模型只能通过 `search_game_tools` 读到这份指南；在它之前，说明的概述会列出该 provider 的描述：精选扩展能比新写的代码更好地完成常见的游戏工作，并附有示例，还要求在规划游戏之前用 `game_addons` 的 `action: search` 读目录索引，并在 `project.godot` 存在之后安装合适的扩展：安装需要它，而新游戏项目的文件夹里还没有它。

##### 部分文本

```markdown
# Game add-ons

game_addons installs tested add-ons, WASD Engine's own and third-party ones, into the game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with the built-in Godot and Blender. Decide yourself when one is worth it; you do not need to ask the user first. Install an add-on when the work at hand needs what it does and building that with plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps. Skip it when Godot's own nodes, Blender's own tools, or a short script do the job, and do not install one in case it is needed later.
Before you build what a listed add-on does, read about it: action search with an add-on's id, a category, or words shows when it helps, when to skip it, its download size, license, and conflicts. After installing one, load its guide, the skill named by its id, before using it, and tell the user what you added and why, with its license and any credit it requires. Remove an add-on only when the game no longer uses it.

Every add-on, under its category, with what it is for:
```

##### 索引行

```markdown
Characters: humans, rigs, animation clips, movement, faces, crowds (characters)
- universal-animation-library: 45 humanoid clips: move, jump, fight, die; retargeting
- mpfb (Blender): realistic rigged humans: skin, hair, clothes, a face
Game systems: AI, state, dialogue, inventories (gameplay)
- beehave: behavior trees for NPC and enemy AI
```

#### Token 影响

随附目录有 56 个扩展，该部分约 5,500 个字符，约 1,370 个 token，出现在每个会话的每个请求中，无论会话是否有 Godot 项目。每新增一个条目会增加一行，约 30 至 90 个字符，用户每关闭一个扩展就去掉它的一行；所有扩展都关闭时会省略该部分。随附目录测试会把该部分限制在 8,000 个字符以内，约可容纳 90 个条目。

#### KV Cache 影响

文本只随随附目录和用户的开关变化，因此在两次变化之间保留在已缓存的系统提示词前缀中；改变目录的 WASD Engine 更新或用户切换开关，只会在每个会话的下一个模型步骤改变它一次，该步骤会记录新的系统提示词。

### 工具声明

#### 模型看到的内容

会话的智能体会看到 `game_addons`，带有 `action`（`search`、`guide`、`install`、`remove` 或 `list`）以及可选的 `query`、`category`、`host`、`stage`、`id`、`reference`、`replace` 和 `project`；对 `guide`，`id` 也可以是 `guides` 中某份指南的名称，`reference` 可以是指南结果中列为未显示的文件。`query` 的说明指出，提到 Godot 或 Blender 时只搜索该应用的扩展。描述会列出目录收录的扩展类别，说明不带查询词的搜索给出索引、带 id、类别或查询词的搜索给出细节，并告诉模型：当游戏需要某个扩展的功能、而只用 Godot 或 Blender 会耗时更长时，无需先征求用户同意即可自行安装，然后告诉用户它添加了什么及其许可证。连接的智能体看到的是同一个工具，其中 `project` 为绝对路径，描述末尾还有一句 `Before you plan a game, read the catalog's index with action search and no query.`，因为它的系统提示词中没有目录部分。

#### Token 影响

该声明约为 3,000 个字符的 JSON。提供者说明会为 MCP 服务器的说明增加约 2,000 个字符，其中包括随附 `game-look` 指南的那一行；它们不列出任何扩展，因为连接的智能体用 `action: search` 读索引，也不包含任何指南的正文，正文由 `action: guide` 返回。

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

不带查询词和筛选条件的搜索会列出索引，每个扩展一行，约 30 至 100 个字符，项目已有的扩展带 `[installed]` 或其他备注，之后 `guides` 中的每份指南占一行，`game-look` 约 400 个字符。带 id 或查询词的搜索最多列出 8 个匹配项，每个约 500 至 1,000 个字符，匹配更多时会说明匹配总数。只带筛选条件、或查询词只提到 Godot 或 Blender 的搜索，在结果不超过 `resultChars` 时完整描述每个匹配项，例如每个类别和 Blender 的 7 个扩展，在每个项目中都是如此，每个匹配项上关于项目已有情况的标注放不下时，改用一行约 50 个字符的文字说明项目已有其中多少个；否则在一行说明匹配项太多、无法逐一描述之后，以索引的行列出每个匹配项，例如 Godot 的 49 个扩展。指南结果的末尾会为每个放不下的链接文件写一行，给出显示它的 `reference`，MPFB 和 Gaea 的指南就是如此。安装结果会写明版本、许可证、安装路径、指南的技能名称（对没有技能的连接智能体，则改为可显示指南的 `guide` 动作）、诸如要求的署名或跳过导入之类的备注，以及最多 20 个导入问题，并请模型告诉用户它添加了该扩展、原因及其许可证；项目已有该版本时不提此请求，这样的重新安装会列出它补回的 `project.godot` 条目，以及保留了与扩展不同的项目自有值的设置。移除结果会写明移出的路径、保留它们的备份、安装之后被项目修改而保留项目所设值的设置，以及最多 20 个仍在使用该扩展的文件。列表会标出用户关闭的扩展，对这类扩展的 guide 或 install 会失败，并给出约 200 个字符的说明。

#### Token 影响

整个目录的索引约为 5,200 个字符，随附目录中带查询词的搜索最多约 6,000 个字符，只带筛选条件的搜索最多为 `resultChars`，即 8,192 个码位，环境类别的 12 个扩展几乎占满；指南结果是指南本身及其在 `resultChars` 内放得下的链接文件，`reference` 的结果就是该文件，例如 MPFB 列出 MakeHuman 资源的约 2,200 个字符的清单；其他结果为几百个字符。

#### KV Cache 影响

仅在对话中追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了插件提供的范围；它们是当前包的约束。

- **更改前不征求同意** — 在任何审批策略和权限模式下，智能体都会自行判断安装和移除目录扩展，因此用户通过智能体的回复、对话记录中的工具调用以及项目的 `.wasdengine/addons.json` 得知安装情况。“扩展”对话框可以阻止智能体再次安装某个扩展；把它移出游戏则由智能体的 `remove` 完成。
- **开关作用于所有项目** — 开关属于 profile，因此关闭的扩展在每个游戏中都是关闭的；关闭它不会把它从已有它的游戏中移除，而智能体修改使用它的代码时将看不到它的指南。
- **开关会复制整行** — 与每次 Settings 写入一样，开关写入会把整个 `game-addons` 行的配置保存到 profile 补丁中，因此只要该 profile 的补丁中保留这一行，之后在 bundle 覆盖层中对该行其他字段的更改就不会影响这个 profile。
- **Blender 工作进程保留已启用的扩展** — 在用户关闭某个扩展之前就已启用它的工作进程，会一直保留它，直到加载出厂设置或工作进程停止；只有更改之后的 `enable` 和 `assets` 调用会拒绝它。
- **每个请求都带有索引** — 每个会话的系统提示词都会列出目录索引，没有 Godot 项目的会话也不例外；目录超过约 90 个条目时会超出该部分 8,000 个字符的预算，届时需要只列类别的索引。
- **智能体起初只知道一条提示** — 索引只给每个扩展六到十个词，因此不先搜索就动手实现的智能体可能会错过合适的扩展；该部分要求先搜索。
- **应用名称会筛选** — 提到 Godot 或 Blender 的查询只搜索该应用的扩展，因此 `blender physics props` 会漏掉 Extra Import Hints，即把 Blender 中建模的网格做成碰撞体的 Godot 扩展；同时提到两个应用或都不提的查询会搜索所有扩展。
- **长指南整体返回** — 指南本身的文本和用 `reference` 读取的文件即使超过 `resultChars` 也会整体返回，会话上下文占满时修剪器可能会修剪它们；随附目录的测试会让每份随附的指南和文件都不超过这一限制。
- **套件按文本改写路径** — 起始套件的 `res://` 路径在其场景、脚本、资源、着色器以及 `.cfg` 和 `.json` 文件中写明的位置被改写；套件代码用若干部分拼出的路径必须从被改写的 `res://` 开始，Starter Kit FPS 的 `Audio.play("sounds/land.ogg")` 即是如此。套件的冒烟测试会从扩展文件夹运行其关卡，以证明这一点。
- **修改副本在更新时需留意** — 取代被排除的压缩包文件的叠加文件（例如 Starter Kit FPS 的玩家脚本、Controller Icons 的 `ControllerIcons.gd`、Easy Vehicle Physics 的 `scripts/wheel.gd` 和 SO FLUFFY 的 `so_fluffy.gd`）是某个上游版本的副本；固定新版本时需要重新做这处修改。
- **不安装的编辑器插件** — 若扩展的编辑器插件只提供笔刷、停靠面板或设置向导，条目会排除该插件，并声明其 `_enable_plugin()` 会添加的内容；扩展的指南则说明如何用代码完成编辑器所做的事。
- **固定的上游压缩包** — 压缩包从各项目的发布或标签 URL 下载。若 GitHub 用不同的字节重新生成了标签压缩包，SHA-256 检查会失败，直到重新固定该条目。
- **不收录仅限编辑器的扩展** — 智能体无法使用编辑器的停靠面板、笔刷或控件，因此目录不收录只能通过编辑器界面使用的扩展。
- **不收录 GDExtension 扩展** — WASD Engine 的 Web 发布不加载 GDExtension，因此目录不收录 Terrain3D 或 LimboAI 等编译型扩展。
- **声明文件留在项目中** — `THIRD_PARTY_NOTICES.md` 不属于导出的游戏；附带扩展的游戏需自行为其署名。
- **Blender 存储只保留一个版本** — 所有项目都使用目录中 Blender 扩展的版本；目录中的较新版本会为所有项目替换已存储的版本。
- **手工复制的副本** — 在 `addons/` 中发现的目录扩展副本会得到目录中的指南，而该指南可能与其版本不符。
- **被删去的自动加载会留下** — 更新会去掉已安装版本写入、而目录中的版本不再设置的设置，但目录中的版本不再包含的自动加载或编辑器插件会留在 `project.godot` 中，直到有人将其删去。
- **开发用扩展会被打包** — Web 导出会打包所有资源，因此 GUT 这类测试扩展（约 3 MB）在被移除之前会随发布的游戏一起发布。条目的 `archive.exclude` 能把演示和示例排除在项目之外（例如 ProtonScatter 的 12 MB 演示），但不能排除扩展需要的文件。
- **Web 扫描按文本匹配** — 只要扩展的文件写明了浏览器缺少的功能，Web 导出就会点名该文件，即使相关代码在游戏中从不运行（例如编辑器面板的预览）；条目的冒烟测试会列出这些说明，其指南会解释它们的含义。
- **编辑器设置** — 编辑器插件在导入步骤中使用用户的 Godot 编辑器设置加载；Importality 会在其中的 `editor_settings-4.7.tres` 里添加空的 `importality/*` 键。
- **无界面运行时崩溃的扩展** — Sprite Sheet Generator 2.2.3 在写出精灵图之后会以段错误结束无界面的 Blender，因此目录不收录它；智能体改用 `bpy` 渲染精灵帧。
- **`project.godot` 的其他写入者** — 安装或移除在持有记录的锁时，会在片刻之内读取并写入 `project.godot`，但 Godot 编辑器、智能体的文件工具和其他程序不获取该锁，因此它们在这次读取与写入之间保存的更改会丢失。
- **备份占用空间** — 每次移除或替换扩展都会在 `.wasdengine/backups/<id>/` 中新增一个备份文件夹，它会一直保留到有人将其删除；删除备份文件夹即可释放其空间。
- **资源包很大** — MPFB 附带 MakeHuman 的系统资源：与扩展一起下载 312 MB，在扩展存储和资源文件夹中占用 358 MB；所有项目共用它们，移除扩展时会保留。
- **字母方块** — Extra Import Hints、GdUnit4 和 YATI 只有以 Godot 或 Blender 标志改作的图标，而商标条款禁止把这些标志用作其他项目的标志；VRM 的列表图标没有许可证。这四个扩展显示字母方块。
- **AGPL 图标** — MPFB 的图标是采用 AGPL-3.0-or-later 的 MakeHuman 标志，因此 `ICONS.md` 旁随附 `LICENSE-AGPL-3.0.txt`，其中是该许可证的全文。
- **只适用于人形的片段** — Universal Animation Library 的片段可在骨骼映射所列出的人形骨架上播放；`retarget.gd` 随附 MPFB 的 `game_engine` 与 `mixamo` 骨架、Rigify 的游戏骨架、Mixamo 下载的模型以及 Quaternius 人体模型的映射，其他骨架则由智能体编写映射。在这些骨架上，四肢方向与片段的偏差约在 10 度以内；MPFB 的 `game_engine` 躯干在大幅弯曲时偏差可达约 23 度。
- **扩展偏好设置会被重置** — 出厂设置会重置 Blender 扩展的偏好设置；工作进程会再次运行每个扩展的设置脚本，从而恢复目录设定的内容（例如 MPFB 的资源文件夹），但不会恢复智能体自己设置的偏好。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

添加或更新条目时，先固定发布版本的压缩包与 SHA-256，再阅读其 `plugin.gd`，了解 `_enable_plugin()` 添加了什么。若项目没有发布版本，或其最新发布缺少条目所需的主分支上的工作，就固定某次提交的压缩包，并在 `version` 末尾加上 `+` 和该提交的前七个字符。为条目设置 `category` 和一条用几个词说明扩展用途的 `cue`，因为智能体是否继续了解它取决于这一行；若条目带来了类别标题未列出的内容，就修改 `CATEGORY_TITLES` 中该类别的标题。用 `archive.exclude` 排除游戏不应打包的内容，并运行测试套件：若被排除的路径仍被扩展自身的文件需要，套件会失败。压缩包中位于游戏要加载的文件夹里的 `.gdignore` 文件也要排除：Godot 既不导入也不导出这样的文件夹，其中的着色器与资源在编辑器中可以加载，却不会出现在任何导出的游戏里。套件会因此失败，SimpleGrassTextured 的着色器与材质文件夹就是这样发现的，此前只有对导出游戏的 Web 检查显示过这个问题。若扩展包自身的下载链接会过期（例如 itch.io 的链接），请改为固定 WASD Engine 某个 GitHub 发布中的副本。指南须在目录内容测试检查的大小之内，它链接的每个文件须在随附结果测试为 `action: guide` 检查的 `resultChars` 之内（该值等于 gamedev 预设的修剪器阈值），并且每个类别的扩展须能在一次搜索结果中描述完，这也由该测试检查。在 `tests/smoke/<id>/` 下添加冒烟测试。测试绘制内容时以 `render` 方式运行，并用 `override.cfg` 选择 Web 构建所用的兼容性渲染器，等待时按实际时钟计时，因为这种运行不受显示器帧率限制。它的检查在任何帧率下都成立：在软件渲染器上（GitHub 的 macOS 运行器为 OpenGL 提供的就是这种渲染器），一帧最多要一秒或更久，游戏时间每帧最多前进八个物理步，因此它按游戏时间或物理步等待，而不是按帧数等待；在那里，测试套件给它 `SOFTWARE_RENDER_BUDGET` 倍于 `timeoutSeconds` 的时间。在指南说明扩展在 Web 构建中的表现之前，先用 `wasd_export_web` 导出包含它的项目并阅读 Web 检查的结果：Maaack's Scene Loader 没有收录进目录，因为它的加载画面在那里从不出现，单线程构建会在一个阻塞步骤中加载完场景。设置 `WASD_LIBGODOT_DIR` 为已安装的运行时文件夹并缓存 uv 的 bpy 5.2.3 后，运行 `vitest run --config vitest.e2e.config.ts packages/gamedev/game-addons/tests/catalog.e2e.ts`；`WASD_ADDON_ARCHIVES` 可在多次运行之间保留下载的文件。冒烟测试可以复制另一个冒烟测试文件夹中的文件（`files`），在两次导入之间运行一个 `prepare` 脚本，就像动画包运行 `retarget.gd` 那样，还可以指定与自身一同安装的其他 Godot 扩展（`with`），用于测试它们配合时的表现，例如 WASD Face 指定了 WASD Character，并为后者的角色添加面部；`tests/smoke/universal-animation-library/rigs.py` 用 MPFB 和 Rigify 生成它们的骨架。只要安装放进项目的内容改变，即其 `archive` 或 `godot` 字段、其声明段落显示的字段（`title`、`license`、`copyright`、`homepage` 和 `credit`）或叠加文件改变，就修改条目的 `version`，因为安装项目已有的版本只会补回丢失的 `project.godot` 条目：在末尾加上 `+wasd.1`（版本已有 `+` 部分时加上 `.wasd.1`），之后依次递增，例如 Beehave 的 `2.9.3+wasd.1` 和 ProtonScatter 的 `4.2.0-dev+7198cc0.wasd.1`。[`tests/catalog-lock.spec.ts`](tests/catalog-lock.spec.ts) 会在某个 Godot 条目的安装内容与 [`tests/catalog.lock.json`](tests/catalog.lock.json) 为其版本记录的不同时失败；该锁写明它所记录的 Godot 条目属于哪一次发布，当 engine 根目录 `package.json` 写着另一个版本时，该测试也会失败。Blender 条目不在其中，因为存储目录会在扩展的压缩包或文件改变时替换它。准备发布时，在 `bump.ts` 设置了发布版本、且目录已包含该版本要发布的内容之后，于 engine 文件夹中运行 `node --import tsx/esm packages/gamedev/game-addons/tests/write-catalog-lock.ts` 写入该锁，[FORK.md](../../../wasdengine/FORK.md#releases) 的发布步骤也这样说明；若给出一个目录文件夹及其发布版本（例如用 `git archive` 从发布标签中解出的文件夹），它会改为写入该目录的锁。

</details>
