---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-new-game-guidance-source

English | [中文](2026-11-18-new-game-guidance-source.zh.md)

## Summary

Adds the new-game-guidance source to logged model context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages and records are unchanged. When the user's first prompt in a top-level Session enters a step while the Session's project folder holds only hidden entries and system files, the new-game-guidance plugin of WASD Engine's gamedev preset enters the configured guidance right after that prompt as an ordinary user message whose source is the new kind, with no form. Readers without the plugin preserve the source kind, present the message as opaque context, and derive its text as ordinary model context; WASD Engine Plugins' browser half leaves it out of Chat. Only the producer writes the source; it grants no authority and does not change replay interpretation.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/gamedev/new-game-guidance packages/gamedev/wasd-plugins/tests/new-game-guidance.client.spec.ts: 15 tests passed, including the guidance logged right after the first prompt through the real Agent loop and through a Loader-booted gamedev preset, and a Chat assembly that leaves it out.

<a id="dev-note"></a>
## Dev Note

None.
