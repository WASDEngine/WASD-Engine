---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-new-game-guidance-source

[English](2026-11-18-new-game-guidance-source.md) | 中文

## 概述

为记录的模型上下文新增 new-game-guidance 来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-new-game-guidance-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-18-wasd-plugins-source"
    after: "43130812693974755df1d9185cd39704886775af92b2c4123ca650c2c912ba8c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-18-wasd-plugins-source"
    after: "ee6a37c400775b7239e521c90cf14e938875fbdeb6e5f38d26f82585a5047216"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-18-wasd-plugins-source"
    after: "a8d91e9c2e1beba1f78ab26139898d286832499bea5bf1d4a1679b5cd2dc03e3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-18-wasd-plugins-source"
    after: "8521878e462f2a7defa7aa8e93416a925f2b455e55bcd6f6afc16cd34991f548"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息与记录保持不变。当顶层 Session 中用户的第一条提示进入一个步骤、而该 Session 的项目文件夹只含隐藏条目和系统文件时，WASD Engine 的 gamedev 预设中的 new-game-guidance 插件会紧接在这条提示之后加入配置的指引，作为一条普通用户消息，其来源是不带 form 的新类型。没有该插件的读取方会保留该来源类型，将消息显示为不透明的上下文，并把其中的文本作为普通模型上下文推导；WASD Engine 插件的浏览器部分不会在 Chat 中显示它。只有生产者写入该来源；它不授予任何权限，也不改变回放的解释方式。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/gamedev/new-game-guidance packages/gamedev/wasd-plugins/tests/new-game-guidance.client.spec.ts：15 个测试通过，其中包括经由真实 Agent 循环和经 Loader 启动的 gamedev 预设、紧接在第一条提示之后记录的指引，以及不显示该指引的 Chat 组装。

<a id="dev-note"></a>
## 开发备注

无。
