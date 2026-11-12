---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-todo-continuation-source

English | [中文](2026-11-11-todo-continuation-source.zh.md)

## Summary

Adds the todo-continuation source to logged model context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages and records are unchanged. The todo-continuation plugin steers a reminder as an ordinary user message whose source is the new todo-continuation kind in the notice form, with a one-line summary. Readers without the plugin preserve the source kind and its JSON metadata, present the message as a notice row or as opaque context, and derive the recorded text as ordinary model context. Only the producer writes the source; it grants no authority and does not change replay interpretation.

<a id="verification"></a>
## Verification

vitest run packages/gamedev/todo-continuation: 10 tests passed through the real Agent loop, tool runtime, session projections, and todo_write tool, including the logged reminder source and the request that replays it.

<a id="dev-note"></a>
## Dev Note

None.
