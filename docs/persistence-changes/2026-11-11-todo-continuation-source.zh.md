---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-todo-continuation-source

[English](2026-11-11-todo-continuation-source.md) | 中文

## 概述

在记录的模型上下文中加入 todo-continuation 来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-todo-continuation-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "c43726b372e7de177b321b82b5cad4688486dc601ed38fbfffa9dfe25bbf7e16"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "ec9bc81b31f45536b12be34198faa190fb7fac23154c715f4e0ba44c7d10502e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "64662cd73664df40746f680ebdb90887a8cfeb4ef00469b75e11b1b063f4c1e7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "dcf491c6434d349b77f4a35f5f351eea1317ac7159d7b003ef0d159991849196"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息与记录保持不变。todo-continuation 插件以 steering 方式插入一条普通用户消息作为提醒，其来源是 notice 形式的新 todo-continuation 类型，并带有单行摘要。没有该插件的读取方会保留该来源类型及其 JSON 元数据，将消息显示为 notice 行或不透明的上下文，并把记录的文本作为普通模型上下文推导。只有生产者写入该来源；它不授予任何权限，也不改变回放的解释方式。

<a id="verification"></a>
## 验证

vitest run packages/gamedev/todo-continuation：10 个测试通过，覆盖真实的 Agent loop、工具运行时、会话投影与 todo_write 工具，包括记录的提醒来源以及回放它的请求。

<a id="dev-note"></a>
## 开发备注

无。
