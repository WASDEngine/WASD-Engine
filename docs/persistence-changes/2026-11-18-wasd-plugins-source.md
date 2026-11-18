---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-wasd-plugins-source

English | [中文](2026-11-18-wasd-plugins-source.zh.md)

## Summary

Adds the wasd-plugins source to logged model context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages and records are unchanged. When its Web check stops a release, the wasd_release_game tool of WASD Engine Plugins attaches the check's screenshot after the failed result as an ordinary user message whose source is the new wasd-plugins kind in the notice form, with a one-line summary. Readers without the plugin preserve the source kind and its JSON metadata, present the message as a notice row or as opaque context, and derive the recorded text and image as ordinary model context. Only the producer writes the source; it grants no authority and does not change replay interpretation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/gamedev/wasd-plugins/tests/tools.spec.ts packages/gamedev/wasd-plugins/tests/browser-composition.spec.ts: 39 tests passed, including a refused release through the real tool pipeline whose screenshot context, with the wasd-plugins notice source, follows the failed result.

<a id="dev-note"></a>
## Dev Note

None.
