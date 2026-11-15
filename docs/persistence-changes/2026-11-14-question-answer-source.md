---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-question-answer-source

English | [中文](2026-11-14-question-answer-source.zh.md)

## Summary

Records on a steered user prompt that it carries part of the user's answer to the agent's question.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages and records are unchanged. The Session controller adds the optional `answersQuestion: true` to an ordinary user prompt's source only when the Client marks the prompt as part of the user's answer to the agent's `ask_user_question` call, such as the images the user attaches to the answer, and it refuses the field on a queued or empty prompt. The field changes neither the message's content nor any model request. Readers that do not know the field preserve it with the source and treat the message as an ordinary user message, as before; the todo continuation plugin reads it so that the answer does not count as the user steering the turn. Older readers handle new records the same way, and a source without the field is an ordinary user message.

<a id="verification"></a>
## Verification

vitest run packages/api/session-controller: 53 files, 1139 tests passed, including tests/wasdengine-question-answer.host.spec.ts, which checks the recorded source and the refusals, and tests/wasdengine-question-answer.client.spec.ts. vitest run packages/gamedev/todo-continuation packages/client/ui-user-questions: the answer's steered message keeps the reminder in the real Agent loop and in the Loader-booted gamedev preset, while a plain steer still stops it.

<a id="dev-note"></a>
## Dev Note

None.
