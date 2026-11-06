---
description: "在 Web 中选择 Agent preset 和新任务默认值，查看各模式的说明与声明的配置。创建与修改引导至自定义模式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-preset

[English](README.md) | 中文

## 概述

在 Web 中选择 Agent preset 和新任务默认值，查看各模式的说明与声明的配置。创建与修改引导至自定义模式。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

设置页显示内置与自定义卡片分组、默认项高亮和点击卡片选择；没有 preset 的分组不显示，但自定义分组会保留其自定义模式入口。粗指针设备完整显示卡片描述；其他设备最多显示四行描述，悬停可查看全文。每张卡片都提供「查看配置」，以只读 YAML 打开该 preset 声明的插件列表，使用 Loader 自己的方言（含 `!!js` 条件）；加载失败的 preset 同样可读，因为其诊断信息正指向这份 YAML。Escape 只关闭查看器并将焦点还给卡片；离开设置页会清空查看器，迟到的读取结果不会重新打开它。本页不编辑任何内容：自定义模式入口启动一个自定义模式任务，以 bundle 形式创建或覆盖 preset；当 `cordis` preset 在列表中且存在会话流程时提供。

新会话选择器和设置页列表提供列表中的全部预设：WASDEngine 内置「游戏开发者」（`gamedev`，即默认预设）和自定义模式（`cordis`），自定义预设与之并列。选择健康定义作为默认值也会同步当前新任务页面的空白会话。自定义模式开启一个使用 `cordis` preset 的新任务。

关闭 Developer tools 时，沿用现有订阅清空所有尚未应用的选择并关闭已打开的选择器；不会隐藏任何预设，也不改变已保存的默认值。已有会话保留所选模式；新会话使用当前默认值。

自定义模式提供只读的模式说明与使用示例对话框；另一个内置预设「游戏开发者」没有指南。对话框各页签保留各自的滚动位置；关闭后焦点回到打开它的操作。帮助不会改变新任务默认值。默认徽标取代卡片的分组徽标，预设 id 显示在标题旁。指南文案与示例归本包所有。

插件页**添加插件**箭头菜单中的**让 Agent 创建插件**进入与设置页相同的自定义模式流程，不发送消息，并保留未发送的草稿。读取预设列表或自定义模式不可用时，菜单项禁用并说明原因。Host 拒绝切换预设时，两处入口均通过 Toast 显示原因。

进入自定义模式会为接收该选择的空白 Session 选择 `cordis`，不改变新任务默认值或代码工作工具设置。尚未绑定工作区或空白 Session 时，选择等待绑定完成后应用。应用后，自定义模式 Session 保留该预设；之后真正创建的新 Session 使用配置的默认值，例如「游戏开发者」。

在桌面端，模式选择器中的直接选择切换到另一个内置 preset 时，可选的[产品埋点](../product-analytics/README.zh.md)服务会收到 `agent_preset_switch`：未绑定 Session 的选择在暂存给下一个 Session 时计入，已绑定空白 Session 的选择在 Host 应用后计入。事件携带按 preset id 映射的来源与目标类别（`cordis` 记为 `creator`；其他 id，包括 `gamedev`，记为 `other`），以及选择时已知的代码工作工具设置。选择自定义目标、被拒绝的选择、Host 最终落在其他 preset 的选择、默认值修改及其空白 Session 同步均不报告；来源模式或代码工作工具设置未知时做出的选择同样不报告。不采集自定义 preset 的 id 和名称。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`agentPresets/list` 提供列表并标记当前默认值，`agentPresets/read` 为查看器提供一条声明的 YAML；默认值的修改写入 `agent-preset-registry` settings 命名空间。选择器、空白会话同步和只读会话标签使用记录的 preset 标识。连接重置和设置更新会刷新列表。

`CreatePluginMenuItem` 使用共享的预设列表 store，向 `plugins.add.actions` 贡献菜单项。选择时先调用页面传入的 `onDismiss()`，再调用与设置页 `creatorDraft` 相同的 `startCreatorDraft` 回调。该回调通过 `AgentPresetSeatController` 暂存 `cordis`（主区空白 Session 列出其他 preset 时不暂存，因为导航会打开另一个空白 Session，原空白 Session 保持不变），再通过显式保留草稿并传入 `agentPreset: 'cordis'` 的 `uiWorkspace.startSession` 调用打开任务，由 Host 以创造模式组合被复用的空白 Session 或新 Session；没有目标工作区时，暂存选择在 Session 绑定可用时应用。暂存选择应用后即清除。代码工作工具开启或关闭时均使用同一个选择器和选择 store，`AgentPresetSeat` 通过共享的 `Toast` 组件显示拒绝原因。

`AgentPresetSeatController.select()` 与 `apply()` 返回本次尝试的结果：Host 提交暂存 preset 时为 `applied`；没有当前 Session 时为 `staged`；忙碌、没有暂存选择、Session 已开始或已使用该 preset，或 Host 最终落在其他 preset 时为 `unchanged`；Host 拒绝时为携带原始原因的 `refused`。选择器注入的 `select` 根据该结果报告 `agent_preset_switch`，并且只返回拒绝原因。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Scope](../../core/scope/README.zh.md) — 注册隔离。
- [Agent](../../core/agent/README.zh.md) — 会话运行时。
- [Cordis](../../../docs/cordis-primer.zh.md) — 插件配置与生命周期。

<a id="model-experience"></a>
## 模型体验

通过选定的 preset 间接影响模型，其插件拥有模型可见能力。

#### KV Cache effect

选择变更只影响之后的任务，已有插件与提示词保持不变。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- Web 不创建也不编辑 preset：配置查看器是只读的；通过自定义模式安装的 bundle 声明新 preset，或按行 id 覆盖内置 preset，覆盖会替换整个子插件列表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
