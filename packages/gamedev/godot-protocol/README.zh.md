---
description: "Godot 插件的 Host 向 WASD Engine 窗口发出的 godot/record 请求，以及窗口的答复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-godot-protocol

[English](README.md) | 中文

## 概述

`godot_record` 在游戏运行时录制画面，由 WASD Engine 窗口把录制编码为 MP4 视频。本包声明这一交互：转发的 `godot/record` 事件、它携带的请求（`GodotVideoEncodeRequest`，以及附带调用方 Agent 与调用取消信号的 `GodotVideoEncodeEvent`），和窗口的答复（`GodotVideoEncodeResult`）。本包只有声明，没有运行时代码，因此 Godot 插件与 Remote 事件列表可以共用这些声明，彼此不相互依赖。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

从 `@deepseek-ai/dsh-godot-protocol/types` 导入这些类型。类型导入也会把 Cordis `Events` 的 `godot/record` 成员带入程序。[Godot 插件](../godot/README.zh.md) 在 `godot_record` 完成录制时从其 Host 发出该事件，在自己的 `types` 入口中重新导出这三个类型，其窗口一侧负责答复该事件。[`@deepseek-ai/dsh-api-remotes`](../../api/remotes/README.zh.md) 导入该事件，使其 Remote 事件列表以 waterfall 方式把 `godot/record` 转发给可读取该 Session 的窗口。

Godot 插件的 Host 与 Client 分开编译，其 Client 编译会引用 Remote 事件列表；当该列表直接从插件本身获取这些声明时，列表的 Client 编译会经由插件的 Host 编译进入插件。本包不依赖二者中的任何一个，因此列表的两种编译都可直接引用它。

<a id="model-experience"></a>
## 模型体验

无，因为本包仅声明类型：模型看到的 `godot_record` 内容来自 Godot 插件的工具说明与结果。

#### KV Cache 影响

类型声明不增加模型输入，因此不影响提供方的缓存复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Host 使用 Godot 插件 `video.ts` 中自己的 schema 检查窗口的答复；本包声明答复的字段，但不验证它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
