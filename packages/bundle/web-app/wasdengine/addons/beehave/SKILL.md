---
name: beehave
description: Beehave 2.9.3 is installed in this project for behavior trees in NPC and enemy AI, built from nodes (BeehaveTree, selectors, sequences, decorators, ActionLeaf/ConditionLeaf scripts, a Blackboard). Load before writing or changing AI behavior with it.
---

# Beehave 2.9.3

Installed in `res://addons/beehave/` with the autoloads `BeehaveGlobalMetrics` and `BeehaveGlobalDebugger`; a `BeehaveTree` fails in `_ready` without them, so never remove them. Do not edit the add-on folder.

## Nodes

- `BeehaveTree` (script `nodes/beehave_tree.gd`): put it under the character; `actor` defaults to its parent (or set `actor_node_path`). It must have exactly one child, the root of the tree. Properties: `enabled`, `tick_rate` (tick every N frames), `process_thread` (`BeehaveTree.ProcessThread` IDLE 0, PHYSICS 1 = default, MANUAL 2), `blackboard` (optional shared `Blackboard` node), `status`. Methods: `tick()` (returns the status), `enable()`, `disable()`, `interrupt()`, `get_running_action()`, `get_last_condition()`, `get_last_condition_status()`. Signals: `tree_enabled`, `tree_disabled`.
- Status codes on every node: `SUCCESS` 0, `FAILURE` 1, `RUNNING` 2.
- Composites (`nodes/composites/`): `SequenceComposite` (`sequence.gd`, all children in order until one fails), `SelectorComposite` (`selector.gd`, children in order until one succeeds), `SequenceReactiveComposite` and `SelectorReactiveComposite` (`*_reactive.gd`), `SequenceStarComposite`, `SequenceRandomComposite`, `SelectorRandomComposite`, `SimpleParallelComposite` (two children).
- Decorators (`nodes/decorators/`, one child): `InverterDecorator`, `AlwaysSucceedDecorator` (`succeeder.gd`), `AlwaysFailDecorator` (`failer.gd`), `LimiterDecorator` (`max_count`), `RepeaterDecorator` (`repetitions`), `CooldownDecorator`, `DelayDecorator` (`delayer.gd`) and `TimeLimiterDecorator` (each `wait_time` seconds), `UntilFailDecorator`.
- Leaves (`nodes/leaves/`): extend `ActionLeaf` (does work, may return RUNNING over many ticks) or `ConditionLeaf` (SUCCESS or FAILURE only). Ready-made: `BlackboardSetAction` (`key`, `value`), `BlackboardCompareCondition` (`left_operand`, `operator` 0 `==`, 1 `!=`, 2 `>`, 3 `<`, 4 `>=`, 5 `<=`, `right_operand`), `BlackboardHasCondition`, `BlackboardEraseAction`. Their fields are Expression strings run on the blackboard: a key is written `"\"hp\""` in `.tscn`, a value can be `get_value("hp") - 1`.
- `Blackboard`: `set_value(key, value)`, `get_value(key, default = null)`, `has_value(key)`, `erase_value(key)`; each takes an optional last argument naming a separate blackboard (default `"default"`). Its exported `blackboard` Dictionary sets start values.

Override in leaves: `func tick(actor: Node, blackboard: Blackboard) -> int`, and optionally `before_run`, `after_run`, `interrupt` (same two parameters; call `super(actor, blackboard)` in `interrupt`). Keep `actor: Node`: a narrower type fails with "The function signature doesn't match the parent"; cast inside instead.

## Memory vs reactive

`SequenceComposite` and `SelectorComposite` remember progress: while a child is RUNNING, the next ticks resume at that child and do not re-check the children before it. Use `SelectorReactiveComposite`/`SequenceReactiveComposite` when conditions must be re-checked every tick (stop chasing when the player leaves).

## Example: chase the player when near, else idle

`res://enemy/player_near.gd`:

```gdscript
extends ConditionLeaf

@export var radius := 200.0

func tick(actor: Node, blackboard: Blackboard) -> int:
	var player := actor.get_tree().get_first_node_in_group("player") as Node2D
	if player and actor.global_position.distance_to(player.global_position) < radius:
		blackboard.set_value("target", player)
		return SUCCESS
	return FAILURE
```

`res://enemy/move_to_target.gd` (`res://enemy/enemy.gd` is `extends CharacterBody2D` with `@export var speed := 80.0`):

```gdscript
extends ActionLeaf

func tick(actor: Node, blackboard: Blackboard) -> int:
	var target: Node2D = blackboard.get_value("target")
	if target == null:
		return FAILURE
	var to_target: Vector2 = target.global_position - actor.global_position
	if to_target.length() < 16.0:
		return SUCCESS
	actor.velocity = to_target.normalized() * actor.speed
	actor.move_and_slide()
	return RUNNING
```

`res://enemy/idle.gd`:

```gdscript
extends ActionLeaf

func tick(actor: Node, _blackboard: Blackboard) -> int:
	actor.velocity = Vector2.ZERO
	return RUNNING
```

`res://enemy/enemy.tscn` (add-on nodes are `type="Node"` plus `script =`):

```
[gd_scene load_steps=8 format=3]

[ext_resource type="Script" path="res://enemy/enemy.gd" id="1"]
[ext_resource type="Script" path="res://addons/beehave/nodes/beehave_tree.gd" id="2"]
[ext_resource type="Script" path="res://addons/beehave/nodes/composites/selector_reactive.gd" id="3"]
[ext_resource type="Script" path="res://addons/beehave/nodes/composites/sequence_reactive.gd" id="4"]
[ext_resource type="Script" path="res://enemy/player_near.gd" id="5"]
[ext_resource type="Script" path="res://enemy/move_to_target.gd" id="6"]
[ext_resource type="Script" path="res://enemy/idle.gd" id="7"]

[node name="Enemy" type="CharacterBody2D"]
script = ExtResource("1")

[node name="BeehaveTree" type="Node" parent="."]
script = ExtResource("2")

[node name="Root" type="Node" parent="BeehaveTree"]
script = ExtResource("3")

[node name="Chase" type="Node" parent="BeehaveTree/Root"]
script = ExtResource("4")

[node name="PlayerNear" type="Node" parent="BeehaveTree/Root/Chase"]
script = ExtResource("5")

[node name="MoveToTarget" type="Node" parent="BeehaveTree/Root/Chase"]
script = ExtResource("6")

[node name="Idle" type="Node" parent="BeehaveTree/Root"]
script = ExtResource("7")
```

Add the player node to the group `player`. Child order is priority: the first child of a selector wins when it can.

## Verify in WASD Engine

`godot_run` the level, move the player with `godot_input`, then `godot_eval` with `node` set to the enemy's path: `get_node("BeehaveTree").get_running_action()` (the RUNNING leaf, here `MoveToTarget` or `Idle`; null when none runs), `get_node("BeehaveTree").status`, `get_node("BeehaveTree").blackboard.get_value("target")`. For deterministic tests set `process_thread = 2` (MANUAL) and call `tick()` yourself; in a `godot_script` SceneTree script, add the scene to `root` and `await process_frame` first, because nodes become ready on the first frame.

## Pitfalls

- When the game runs from the editor build without the editor debugger (as `godot_run` does), Beehave logs `Can't send message. No active debugger` errors from `beehave/debug/debugger_messages.gd` and one `Capture not registered: 'beehave'` at exit. They are harmless (exported games do not send these messages); do not try to fix them.
- `process_thread = 0` (IDLE) set in a `.tscn` is reset to PHYSICS in `_ready`; to tick in `_process`, set `tree.process_thread = BeehaveTree.ProcessThread.IDLE` in code after the tree is ready.
- Setting MANUAL also sets `enabled = false`; after switching back to PHYSICS or IDLE, call `enable()`.
- `blackboard.keys()` returns blackboard names, not value keys. `has_value` is false for a key set to null.
- Leaves tick inside `_physics_process` by default, so `move_and_slide()` belongs there; keep heavy work out of conditions.
