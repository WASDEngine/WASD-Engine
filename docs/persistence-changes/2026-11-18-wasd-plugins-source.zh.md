---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-wasd-plugins-source

[English](2026-11-18-wasd-plugins-source.md) | 中文

## 概述

为记录的模型上下文新增 wasd-plugins 来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-wasd-plugins-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-14-question-answer-source"
    after: "126fd28a5d0c63c040fc0798aa86e869ae132fc1bc071f12bb29f579f8a8f536"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-14-question-answer-source"
    after: "97fd3d2d2af0c70ee36362038db4e5fd822f681d906f6f37dce02c99408fae3d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-14-question-answer-source"
    after: "5259d774e75152e212e1c255de0b393e3b4aa320a49dc7fb0275b1dd8dc19b5f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-14-question-answer-source"
    after: "f43728109434e22b7153e3999052f2377259d1a8544d5b3918411ab44b34e5d9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息与记录保持不变。当 Web 检查阻止一次发布时，WASD Engine 插件的 wasd_release_game 工具会在失败的结果之后附上检查的截图，作为一条普通用户消息，其来源是 notice 形式的新 wasd-plugins 类型，并带有单行摘要。没有该插件的读取方会保留该来源类型及其 JSON 元数据，将消息显示为 notice 行或不透明的上下文，并把记录的文本和图片作为普通模型上下文推导。只有生产者写入该来源；它不授予任何权限，也不改变回放的解释方式。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/gamedev/wasd-plugins/tests/tools.spec.ts packages/gamedev/wasd-plugins/tests/browser-composition.spec.ts：39 个测试通过，其中包括一次经由真实工具流水线被拒绝的发布，其带 wasd-plugins notice 来源的截图上下文跟在失败结果之后。

<a id="dev-note"></a>
## 开发备注

无。
