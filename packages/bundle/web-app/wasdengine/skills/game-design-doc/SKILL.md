---
name: game-design-doc
description: Plan a new game or a feature that changes how a game plays before building it, and keep a short design doc in the repository (pitch, core loop, controls, rules, scope, milestones). Load when the user asks for a new game, a game jam entry, or a gameplay feature.
---

# Game design doc

A short design doc keeps the scope small and makes each later change checkable. It is a working file, not a pitch deck: about one page per game, plus a section for each large feature.

## When to write or update it

- A new game or prototype: write the doc before creating the project, then confirm it with the user.
- A feature that changes rules, controls, progression, or win and lose conditions: update the doc first.
- A decision that changes during implementation: update the doc in the same turn.

Keep it in `docs/game-design.md` unless the project already has a design document; then edit that one.

## Ask only what you cannot infer

Ask a few questions at most, each with a default the user can accept: genre and one reference game, target platform and input (keyboard, gamepad, touch), session length, art style, and whether assets must be original or may come from licensed packs. Take the engine from the existing workspace. Make every new project a Godot game, including one that runs in a browser: Godot is built in, and `wasd_export_web` builds a Godot project for the Web.

## Template

```markdown
# <Title>

## Pitch
One sentence: who the player is, what they do, and why it is fun.

## Pillars
Two or three experience goals that settle trade-offs, for example "every jump is readable".

## Core loop
The 30-second loop as verbs (move, collect, avoid, spend), then the longer loop that gives progression.

## Controls
| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|

## Rules
Win and lose conditions, scoring, difficulty curve, and what resets after a failure.

## Content
Levels, enemies, items, and UI screens of the first playable version, with counts.

## Art and audio
Style, resolution, palette, and the source and license of every third-party asset.

## Technical
Engine and version, target platforms, resolution and aspect ratio, save data, and a performance target such as 60 fps on a mid-range laptop.

## Scope
Must have for the first playable version, nice to have, and out of scope.

## Milestones
1. Gray-box prototype of the core loop.
2. Vertical slice: one complete level with final-quality game feel.
3. Content pass, polish, release build.

## Open questions
```

## Build from the doc

- Turn the current milestone into a short task list in which every task ends with something runnable and checkable.
- Build the gray-box core loop with placeholder shapes before art, menus, or save systems.
- After each milestone, play-test against the pillars and record findings and tuning values in the doc.
- Keep the out-of-scope list honest: move new ideas there instead of growing the current milestone.
