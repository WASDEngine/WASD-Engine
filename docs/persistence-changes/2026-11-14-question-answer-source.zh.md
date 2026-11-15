---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-question-answer-source

[English](2026-11-14-question-answer-source.md) | 中文

## 概述

在插入的用户提示上记录它是用户对智能体提问所作回答的一部分。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-question-answer-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-11-todo-continuation-source"
    after: "8b5db70cf56faf4b55fb2efa2931d1acbe603ba8bf84c01f51e7d8b44e026e1c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-11-todo-continuation-source"
    after: "2194d17bb789e558307cba7ba622467199eb2ff65b5265995fa8d11a51322902"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-11-todo-continuation-source"
    after: "01137fbe6883d32c6cf2b437142dbc30d1dbd0e877e87a7ad54fa539d45dc10e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-11-todo-continuation-source"
    after: "2cde6b6988c52d7edfe104fde81c9d0022cb7572713bae414cf5ef3e73777d94"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息和记录不变。仅当客户端把提示标记为用户对智能体 `ask_user_question` 调用所作回答的一部分（例如用户附在回答上的图片）时，Session 控制器才在普通用户提示的来源上加入可选的 `answersQuestion: true`；排队或内容为空的提示带此字段会被拒绝。该字段既不改变消息内容，也不改变任何模型请求。不认识该字段的读取方随来源一起保留它，并照旧把消息当作普通用户消息；todo continuation 插件读取它，使这条回答不被算作用户插话改变本轮。旧读取方以同样方式处理新记录；不带该字段的来源即普通用户消息。

<a id="verification"></a>
## 验证

vitest run packages/api/session-controller：53 个文件、1139 个测试通过，其中 tests/wasdengine-question-answer.host.spec.ts 检查记录的来源和拒绝情形，另有 tests/wasdengine-question-answer.client.spec.ts。vitest run packages/gamedev/todo-continuation packages/client/ui-user-questions：在真实的 Agent 循环和经 Loader 启动的 gamedev 预设中，回答插入的消息不会中止提醒，而普通插话仍会中止。

<a id="dev-note"></a>
## 开发备注

无。
