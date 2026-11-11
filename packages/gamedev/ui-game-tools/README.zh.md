---
description: "WASD Engine Web 界面中「设置 › 内置插件」与「插件」页面上的「游戏工具」标签页：供维护者修改 Blender、ElevenLabs、游戏扩展、GIMP、Godot、Poly Haven 与 SuperCollider 在其中如何随标志与 Loader 状态显示，或排查在 profile patch 中关闭或开启某个工具的开关。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-tools

[English](README.md) | 中文

## 概述

在列出插件的地方查看并开关 agent（智能体）的游戏工具。「设置 › 内置插件」打开时先显示「游戏工具」标签页，列出 Blender、ElevenLabs、游戏扩展、GIMP、Godot、Poly Haven 与 SuperCollider 及其标志，以及每个工具是否在运行。「插件」页面也有一个「游戏工具」标签页，显示同样的卡片，并为每个工具提供一个开关，用于在 profile 中关闭或开启该工具。两个标签页都不显示工具的应用程序是否已安装；安装问题由工具自身的结果报告。

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

打开**设置** › **内置插件**即可查看游戏工具；该分区先显示**游戏工具**标签页。要关闭或开启某个工具，请打开侧栏中的**插件**并选择**游戏工具**。两个标签页都按 Blender、ElevenLabs、游戏扩展、GIMP、Godot、Poly Haven、SuperCollider 的顺序列出工具，并标出 profile 没有挂载的工具。

### 默认组合

fork 的 patch 文件 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 在每个 Web 与 Desktop profile 中、三个工具行之后插入下面这一行：

```yaml
- id: ui-game-tools
  name: '@deepseek-ai/dsh-client-ui-game-tools'
```

该行不接受配置，其 Host 半区什么也不做：这一行的存在只是为了让 Host 提供浏览器半区。浏览器半区需要 `pluginInventory` Remote。它的设置标签页出现在 [`ui-settings-plugins`](../../client/ui-settings-plugins/README.zh.md) 的「内置插件」分区中；它的插件页面标签页在 `pluginManager` Remote 存在后才注册，并出现在 [`ui-plugin-manager`](../../client/ui-plugin-manager/README.zh.md) 的页面上。带 `disabled: true` 的 profile patch 条目 `- id: ui-game-tools` 会移除两个标签页，工具本身照常运行。

### 阅读卡片

每张卡片显示工具的标志、当前语言下的标题与描述，以及工具的状态。标志是包的 `icon.svg`，由 Host 随包元信息一起发送；包没有图标或图标无法解码时，显示默认插件图稿。已启用的工具不带标签。**已关闭**标记所在行已停用的工具，**启动失败**标记启动失败的工具，**不在当前 profile 中**标记 profile 中没有任何行挂载的工具；Host 的启动诊断显示在描述下方。标题旁的圆点标记正在等待依赖、加载或卸载的工具，包元信息出错时卡片显示一条说明。

### 开关

在插件页面的标签页中，只要 Host 管理着 profile，profile 挂载的每个工具都有一个开关。开关以工具的 Loader 条目调用 `pluginManager.setPluginEnabled`，[插件管理器](../../boot/plugin-manager/README.zh.md#use-this-package)把更改记录到 profile patch 中并应用：关闭工具时在该行的条目上设置 `disabled: true`，patch 中没有该条目时追加 `- id: <row>`；开启工具时删除不含其他内容的条目，否则设置 `disabled: false`。更改进行期间，开关保持禁用，旁边显示进度圆点，屏幕阅读器会播报正在更改的工具；更改结束后，原先持有焦点的开关重新获得焦点。应用成功的更改不再另行提示；需要重启才能生效的更改、被更高优先级的 patch 覆盖的更改以及失败的更改，都会显示一条写明工具与原因的 toast，即使用户离开该标签页或插件页面，toast 也会保留到淡出为止。profile patch 无法唯一定位的行，或插件管理需要的行，显示禁用的开关，悬停提示给出原因。Host 不管理 profile 时，卡片不带开关，并有一行文字说明原因。

### 重新读取与失败

设置标签页每次挂载时读取插件清单。插件页面标签页同样在每次挂载时读取，并在每次开关更改、插件管理器每次宣布更改以及每次重连后再次读取，因此在插件页面别处或其他客户端中所做的更改也会显示在这里；之后的读取进行期间，它保留上一次读取的卡片。两个标签页在首次读取返回前显示占位卡片。首次读取失败时显示一条带**重试**的消息；没有 owner 权限的 Peer（例如 LiveShare 观看者）会看到只有 owner 才能查看游戏工具。插件页面上之后的读取失败时，卡片保留，其下方提供**重试**。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包通过两个页面的扩展点添加两个标签页，不修改任何一个页面。它的浏览器插件以 id `game-tools` 和顺序 5 把设置标签页注册到 `settings.plugins.tab`，排在清单的「插件列表」（顺序 10）之前；并在一个等待 `remote.pluginManager` 的 scope 中，以相同 id 和顺序 −10 把插件页面标签页注册到 `plugins.tab`，排在「已安装」之后、「发现」之前，同时注册 `shell.overlay` 条目 `game-tools.toast`，在标签页之外显示开关的 toast。每次注册都使用 `ctx.slots.inject()`，因此能跟随 slot 的延迟声明与 teardown；本包从其他插件只导入类型。

插件激活期间不执行任何 Remote 调用。设置标签页在挂载 effect 中调用 `pluginInventory.list()`。插件页面标签页的控制器先读取 `pluginInventory.list()` 以获得 `managementAvailable`，再读取 `pluginManager.listPlugins()`，后者的每一行要么带 `patchId`，要么带 `readOnlyReason`。控制器把标签页状态保存在快照存储中，标签页与 toast 都读取它；控制器为读取编号，只采用最新一次读取的结果，并把开关的每个 `ChangeResult` 转换为一条提示；应用成功的写入会保留另一个工具的提示。两个标签页都按包名从 `GAME_TOOL_MODULES` 中挑选工具，web-app overlay 的漂移测试会把该列表与 overlay 中的工具行比对。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Loader 行的空 Host `apply` |
| [`src/client/index.ts`](src/client/index.ts) | 字典、两个标签页的注册与 toast 的注册 |
| [`src/client/tools.ts`](src/client/tools.ts) | `GAME_TOOL_MODULES`、条目查找与读取失败分类 |
| [`src/client/controller.ts`](src/client/controller.ts) | 插件页面标签页的读取、开关写入与提示 |
| [`src/client/presentation.ts`](src/client/presentation.ts) | 锁定原因与提示语句 |
| [`src/client/GameToolsNoticeToast.tsx`](src/client/GameToolsNoticeToast.tsx) | 显示提示的 `shell.overlay` toast |
| [`src/client/GameToolCard.tsx`](src/client/GameToolCard.tsx) | 两个标签页共用的卡片、占位卡片与读取失败提示 |
| [`src/client/SettingsGameToolsTab.tsx`](src/client/SettingsGameToolsTab.tsx)、[`src/client/PluginsGameToolsTab.tsx`](src/client/PluginsGameToolsTab.tsx) | 两个标签页 |
| [`src/client/locales.ts`](src/client/locales.ts) | 八种语言的 `gameTools` 字典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖工具行、承载这两个标签页的页面，以及标签页读取的 Host 服务。

- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md#game-tools-tabs)——标签页与工具行及其标志的关系。
- [ui-settings-plugins](../../client/ui-settings-plugins/README.zh.md)——承载设置标签页的「内置插件」分区。
- [ui-plugin-manager](../../client/ui-plugin-manager/README.zh.md)——「插件」页面及其 `plugins.tab` slot。
- [plugin-manager](../../boot/plugin-manager/README.zh.md)——开关背后的 Host 操作。
- [plugin-inventory](../../host/plugin-inventory/README.zh.md)——两个标签页读取的 Host 只读 Loader 投影。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是游戏工具行在浏览器端的视图与开关，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义标签页显示什么以及何时更新；它们是当前包约束。

- **工具固定为三个**：标签页列出 `GAME_TOOL_MODULES` 中的包；overlay 新增的工具行只有在其包加入该列表后才会出现在标签页中，两者一致之前 overlay 漂移测试会失败。
- **只显示 Loader 状态**：卡片显示所在行是否启用、正在加载或启动失败，而不显示工具的应用程序是否就绪，例如 Blender 的 `bpy` 环境、GIMP 3、LibGodot 运行时、SuperCollider，或 ElevenLabs 需要的 WASD Engine 登录；这些由工具的结果与 Game 标签页报告。
- **设置标签页每次挂载或重试只读取一次**：设置标签页保持挂载期间不跟随之后的变化；重新打开设置会再次读取。
- **未宣布的 profile 编辑**：对 profile patch 的手工编辑由 HMR 应用，插件管理器不会为它宣布更改，因此插件页面标签页要到再次挂载时才显示它；该标签页没有刷新控件，而贡献的标签页打开期间，页面会隐藏自己的刷新按钮。
- **插件列表中没有标志**：「内置插件」的「插件列表」标签页仍把这三个工具列在默认收起的全局插件中，且不带标志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
