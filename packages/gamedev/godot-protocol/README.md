---
description: "The godot/record request a Godot plugin's Host makes of a WASD Engine window, and the window's answer."
kind: "package-reference"
---

# @deepseek-ai/dsh-godot-protocol

English | [中文](README.zh.md)

## Summary

`godot_record` records a game while it runs, and a WASD Engine window encodes the recording into an MP4 video. This package declares that exchange: the forwarded `godot/record` event, the request it carries (`GodotVideoEncodeRequest`, and `GodotVideoEncodeEvent` with the calling Agent and the call's cancellation), and the window's answer (`GodotVideoEncodeResult`). It holds declarations only, with no runtime code, so the Godot plugin and the Remote event list can share them without one depending on the other.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import the types from `@deepseek-ai/dsh-godot-protocol/types`. A type import also brings the `godot/record` member of Cordis' `Events` into the program. The [Godot plugin](../godot/README.md) emits the event from its Host when `godot_record` finishes a recording, re-exports the three types from its own `types` entry, and its window half answers the event. [`@deepseek-ai/dsh-api-remotes`](../../api/remotes/README.md) imports the event so that its Remote event list forwards `godot/record` to the windows that may read the Session, as a waterfall.

The Godot plugin keeps separate Host and Client compiles, and its Client compile reaches the Remote event list; when the list took these declarations from the plugin itself, its Client compile entered the plugin through the plugin's Host compile. This package depends on neither, so both compiles of the list reach it directly.

<a id="model-experience"></a>
## Model Experience

None, as this package only declares types: what the model sees of `godot_record` is the Godot plugin's tool description and result.

#### KV Cache effect

Type declarations add no model input, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Host checks the window's answer with its own schema in the Godot plugin's `video.ts`; this package declares the answer's fields but does not validate them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
