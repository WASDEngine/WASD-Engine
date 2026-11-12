---
description: "待办续行插件：当顶层智能体在当前轮次写下的待办列表仍有未完成项时，让它继续工作；面向选择、配置或调试该插件的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-todo-continuation

[English](README.md) | 中文

## 概述

本包防止智能体在请求做到一半时停下。当模型以一条回复结束轮次，而它在该轮次写下的待办列表仍有待处理或进行中的项时，插件会添加一条列出这些项的提醒，轮次随之继续：模型会完成这些项、把已完成的项标记为 completed，或说明它需要用户提供什么。每个不同的未完成列表只提醒一次，单个轮次的提醒次数受配置上限约束。子智能体 Session 以及由工具结束的轮次不受影响。`gamedev` 预设以上限 5 挂载本插件。

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

在智能体预设中把本插件挂载在 `@deepseek-ai/dsh-tool-todo` 旁边，插件读取的正是它的 `todo_write` 列表。没有 `todo_write` 时，插件永远看不到列表，也不会添加任何内容。

### 何时选用

当模型倾向于在多步骤请求只完成一部分时就结束轮次、汇报进度或询问是否继续，而部署希望智能体无需用户输入"继续"就能按自己的计划做完时，选用本插件。它只处理模型在当前轮次用 `todo_write` 写下的列表，因此应搭配要求模型列出多步骤请求每个部分的提示语；`gamedev` 人设就是这样做的。如果每一步都应等待用户，则不要选用：提醒会让模型继续。

### 配置

```yaml
- id: todo-continuation
  name: '@deepseek-ai/dsh-todo-continuation'
  config:
    maxRemindersPerTurn: 5
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxRemindersPerTurn` | 必填 | 单个轮次最多收到的提醒数；正整数 |

缺少该值或该值小于 1 时，加载即失败。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-todo-continuation)记录了该字段接受的取值。

### 轮次结束时会发生什么

当顶层智能体的轮次因模型未调用工具而直接回复、即将结束时，插件开始工作。如果该轮次最新的 `todo_write` 列表中有状态不是 `completed` 的项，插件会以 steering 方式插入一条提醒，按顺序列出这些项及其状态，轮次随之再运行一步。提醒要求模型不经询问继续工作，把已完成的项标记为 completed，并且只有当某项需要用户的回答，或在等待它自己无法完成的工作（例如仍在运行的子智能体或后台作业）时，才让该项保持未完成。

以下情况轮次直接结束、不提醒：所有项都已完成；该轮次没有写过列表；未完成的项及其状态与本轮次之前某次提醒时相同；或者该轮次已收到 `maxRemindersPerTurn` 条提醒。之前轮次的列表不计入，因为列表属于写下它的轮次。由工具结束的轮次（例如用户关闭的计划审阅）保持结束，被取消的轮次同样如此。子智能体 Session 不会收到提醒：由父智能体读取其结果并决定是否继续。

提醒是 `todo-continuation` 生产者发出的 `notice`，其单行摘要统计未完成项的数量，例如 `2 todos left`，因此对话中显示为一条折叠行，而不是一条用户消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明插件如何跟踪轮次并决定是否提醒；可观察的行为已在[使用本包](#use-this-package)中说明。

### 设计

- **插件，而非修改 loop。** 插件监听 `agent/turn-stopping`，即本可完成的轮次关闭前的 serial 检查点；进行 steering 的监听器会让 loop 再运行一步，没有待处理的 steering 时轮次才关闭。
- **状态来自日志。** 一个 `session/event` 监听器在 `WeakMap` 中为每个 Session 的进行中轮次保存一条记录：来自 `turn/start` 的轮次号、最新的 `todo/write` 列表，以及最新的 `assistant/message` 是否调用了工具。`turn/end` 会删除该记录。
- **回复，而非工具。** 工具通过 `concludeTurn` 结束的轮次，结束于一条带工具调用的消息，因此记录显示没有回复，插件不会干预该轮次。
- **由数据限定。** 被提醒列表的键是其未完成项按顺序排列的状态与内容。同一轮次中提醒过的键不会再次提醒，`maxRemindersPerTurn` 限制不同键的数量。
- **有日志记录。** 提醒以带 `todo-continuation` 来源的普通 `user/message` 进入 Session，因此每个模型可见的输入都能从日志重建。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、轮次记录、提醒文本与两个监听器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级说明不足时，请阅读以下页面。

- [智能体生命周期](../../../docs/agent-lifecycle.zh.md)——`agent/turn-stopping` 在轮次中的运行位置。
- [`@deepseek-ai/dsh-tool-todo`](../../todo/tool-todo/README.zh.md)——`todo_write` 工具及其 `todo/write` 事件。
- [游戏开发分组](../README.zh.md)——其他由分叉维护的包。

-----

<a id="model-experience"></a>
## 模型体验

### 提醒上下文消息

#### 模型看到什么

当顶层轮次结束、而其最新的 `todo_write` 列表仍有未完成项时，模型会在下一条消息中收到这条提醒，每个未完成项按列表顺序占一行。`<status>` 为 `pending` 或 `in_progress`，`<content>` 为该项的文本。

##### 提醒

```markdown
<unfinished_todos>
Your turn is about to end, but your todo list still has unfinished items:
- [<status>] <content>

Continue working on them now, without asking the user whether to continue. Update the list with todo_write as you go, and mark every finished item completed, including any you already finished. Leave an item unfinished only when it needs an answer that only the user can give, or waits on something you cannot do yourself, such as a subagent or background job that is still running; then end your turn with one short sentence that says so.
</unfinished_todos>
```

#### Token 影响

轮次结束时没有未完成项则为零 token。每条提醒都会保留在历史中；其长度随未完成项增长，单个轮次最多收到 `maxRemindersPerTurn` 条提醒。

#### KV Cache 影响

仅追加；新出现的内容位于可复用的请求前缀之后，不会使已有的 KV cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只处理模型写下的列表**——模型没有拆分为 `todo_write` 项的请求不会收到提醒，因此插件依赖要求列出列表的提示语。
- **不检查真实完成情况**——模型标记为 completed 的项即视为完成；插件不验证工作本身。
- **仍在运行的后台工作也会触发一次提醒**——插件看不到子智能体或作业是否仍在工作，因此为等待它们而结束的轮次会收到一条提醒，提醒会告诉模型：如果只是在等待，就结束轮次。
- **轮次记录只在内存中**——被重启打断的轮次不会延续提醒历史；下一个轮次会开始一条新记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
