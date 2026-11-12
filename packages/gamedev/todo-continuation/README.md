---
description: "The todo continuation plugin, which keeps a top-level agent working while the todo list it wrote in the current turn has unfinished items, for users and maintainers choosing, configuring, or debugging it."
kind: "package-reference"
---

# @deepseek-ai/dsh-todo-continuation

English | [中文](README.zh.md)

## Summary

This package keeps the agent from stopping partway through a request. When the model ends a turn with a reply while the todo list it wrote in that turn still has pending or in-progress items, the plugin adds one reminder naming them, and the turn continues: the model finishes the items, marks finished ones completed, or says what it needs from the user. Each distinct unfinished list is reminded once, and a configured cap bounds one turn's reminders. Subagent Sessions, and turns that a tool ended or the user interrupted, are left alone. The `gamedev` preset caps it at five.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in an agent preset beside `@deepseek-ai/dsh-tool-todo`, whose `todo_write` list it reads. Without `todo_write` the plugin never sees a list and adds nothing.

### When to choose it

Choose it when a model tends to end its turn after part of a multi-step request, reporting progress or asking whether to continue, and the deployment wants the agent to work through its own plan without the user typing "keep going". It acts only on lists that the model wrote with `todo_write` in the current turn, so pair it with guidance that asks the model to list every part of a multi-step request; the `gamedev` persona does. Avoid it when every step should wait for the user: a reminder asks the model to continue.

### Configure it

```yaml
- id: todo-continuation
  name: '@deepseek-ai/dsh-todo-continuation'
  config:
    maxRemindersPerTurn: 5
```

| Field | Default | Meaning |
|---|---|---|
| `maxRemindersPerTurn` | required | Most reminders one turn receives; a positive integer |

A missing value or one below 1 fails at load. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-todo-continuation) documents the accepted field.

### What happens at the end of a turn

The plugin acts when a top-level agent's turn is about to end because the model replied without calling a tool. If the latest `todo_write` list of that turn has items that are not `completed`, the plugin steers one reminder listing them in order with their status, and the turn runs another step. The reminder tells the model to continue without asking, to mark finished items completed, and to leave an item unfinished only when it needs the user's answer or waits on work it cannot do itself, such as a running subagent or background job.

The turn ends without a reminder when every item is completed, when the turn wrote no list, when the unfinished items and their statuses are the same as at an earlier reminder in the turn, or when the turn already received `maxRemindersPerTurn` reminders. A list from an earlier turn does not count, because the list belongs to the turn that wrote it. A turn that a tool ended, such as a plan review the user dismissed, stays ended, and so does a cancelled turn, including one the user stopped while another plugin was still finishing the turn. Subagent Sessions get no reminder: the parent agent reads their result and decides whether they continue.

The user's own messages come first. While a message from the user waits, either one typed during the turn that runs as the next turn or steering for the next step, the plugin adds no reminder: the turn ends so the queued message runs, or its next step answers the steering. Once the user steers a turn, the rest of that turn follows the user and gets no further reminder.

The reminder is a `notice` from the `todo-continuation` producer whose one-line summary counts the unfinished items, such as `2 todos left`, so the conversation shows it as a collapsed row rather than a user message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the plugin tracks a turn and decides to remind; the observable behavior is covered in [Use this package](#use-this-package).

### Design

- **Plugin, not loop change.** The plugin listens on `agent/turn-stopping`, the serial checkpoint before an otherwise completed turn closes; a listener that steers makes the loop run another step, and the turn closes once no steering is pending.
- **State from the log.** A `session/event` listener keeps one record per Session's open turn in a `WeakMap`: the turn number from `turn/start`, the latest `todo/write` list, and whether the latest `assistant/message` called a tool. `turn/end` deletes the record.
- **Reply, not tool.** A turn that a tool ended through `concludeTurn` ends after a message with tool calls, so the record shows no reply and the plugin leaves the turn alone.
- **The user first.** The listener steers nothing once the turn's abort signal fired, which a Stop during an earlier `agent/turn-stopping` listener leaves set, while a message whose source is `user` waits in the inbox's next-step or next-turn list, or after a `user` message entered the turn in a step after its first; the record counts the turn's `step/start` events for that.
- **Bounded by data.** The key of a reminded list is its unfinished items' statuses and contents in order. A key reminded once in the turn is never reminded again, and `maxRemindersPerTurn` caps the distinct keys.
- **Logged.** The reminder enters the Session as an ordinary `user/message` with the `todo-continuation` source, so every model-visible input is reconstructable from the log.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the turn record, the reminder text, and both listeners |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Agent lifecycle](../../../docs/agent-lifecycle.md) — where `agent/turn-stopping` runs in a turn.
- [`@deepseek-ai/dsh-tool-todo`](../../todo/tool-todo/README.md) — the `todo_write` tool and its `todo/write` event.
- [Game development group](../README.md) — the other fork-owned packages.

-----

<a id="model-experience"></a>
## Model Experience

### Reminder context message

#### What the model sees

At the end of a top-level turn whose latest `todo_write` list has unfinished items, the model receives this reminder as the next message, with one line per unfinished item in list order. `<status>` is `pending` or `in_progress`, and `<content>` is the item's text.

##### Reminder

```markdown
<unfinished_todos>
Your turn is about to end, but your todo list still has unfinished items:
- [<status>] <content>

Continue working on them now, without asking the user whether to continue. Update the list with todo_write as you go, and mark every finished item completed, including any you already finished. Leave an item unfinished only when it needs an answer that only the user can give, or waits on something you cannot do yourself, such as a subagent or background job that is still running; then end your turn with one short sentence that says so.
</unfinished_todos>
```

#### Token effect

Zero tokens when a turn ends with no unfinished items. Each reminder is retained history; its length grows with the unfinished items, and one turn receives at most `maxRemindersPerTurn` reminders.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only lists the model writes** — a request that the model does not break into `todo_write` items gets no reminder, so the plugin depends on prompt guidance that asks for a list.
- **No check of real completion** — an item the model marks completed counts as finished; the plugin does not verify the work.
- **Running background work still draws one reminder** — the plugin cannot see whether subagents or jobs are still working, so a turn that ends to wait for them receives one reminder, which tells the model to end its turn when it is only waiting.
- **In-memory turn records** — a turn that a restart interrupts starts no reminder history; the next turn starts a new record.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
