---
name: godot-state-charts
description: Godot State Charts 0.22.5 is installed in this project for hierarchical state machines built from nodes (StateChart, CompoundState, ParallelState, AtomicState, Transition, guards) driven by events, with enter/exit/processing signals. Load before writing player, enemy or game-flow states with it.
---

# Godot State Charts 0.22.5

Installed in `res://addons/godot_state_charts/`; it has no autoload. Do not edit that folder; ignore its `csharp/` files. In `.tscn` text each add-on node is `type="Node"` with `script = ExtResource(...)` of the script named below.

## Nodes

- `StateChart` (`state_chart.gd`): has exactly one child state, the root. Methods: `send_event(&"name")`, `set_expression_property(&"name", value)`, `get_expression_property(&"name", default)`, `step()` (emits `state_stepped` in active states), `freeze()`, `thaw()`. Signal `event_received(event)`. Export `initial_expression_properties` (Dictionary) sets start values.
- `CompoundState` (`compound_state.gd`): exactly one child active at a time. `initial_state` (NodePath relative to it, such as `NodePath("Idle")`) is required. Signals `child_state_entered`, `child_state_exited`.
- `ParallelState` (`parallel_state.gd`): all child states are active together.
- `AtomicState` (`atomic_state.gd`): a state without child states. `AnimationPlayerState` (`animation_player`, `animation_name`) and `AnimationTreeState` (`animation_tree`, `state_name`) also play an animation on enter.
- `HistoryState` (`history_state.gd`: `deep`, `default_state`): a transition to it re-enters the child of its parent that was active last.
- Every state has `active` and the signals `state_entered`, `state_exited`, `event_received(event)`, `state_processing(delta)`, `state_physics_processing(delta)`, `state_stepped`, `state_input(event)`, `state_unhandled_input(event)`, `transition_pending(initial_delay, remaining_delay)`.
- `Transition` (`transition.gd`) is a child of the state it leaves: `to` (NodePath relative to the transition, such as `NodePath("../../Walking")`), `event` (StringName; empty makes it automatic: checked on entering the state and, if its guard reads them, when expression properties or states change), `guard` (a Guard resource), `delay_in_seconds` (String expression; `"0.0"` is immediate; leaving the state cancels it). Signal `taken`; `take()` forces it.
- Guards are sub-resources with a script: `ExpressionGuard` (`expression_guard.gd`, `expression` such as `"stamina >= 1"` over expression properties), `StateIsActiveGuard` (`state`, NodePath relative to the transition), `AllOfGuard`/`AnyOfGuard` (`guards` array), `NotGuard` (`guard`).

An event goes to the innermost active state first, then to its parents; in each state the first matching transition in child order wins; a ParallelState passes it to every child.

## Example: player with Idle, Walking and a guarded, timed Dash

```
[gd_scene load_steps=7 format=3]

[ext_resource type="Script" path="res://player/player.gd" id="1"]
[ext_resource type="Script" path="res://addons/godot_state_charts/state_chart.gd" id="2"]
[ext_resource type="Script" path="res://addons/godot_state_charts/compound_state.gd" id="3"]
[ext_resource type="Script" path="res://addons/godot_state_charts/atomic_state.gd" id="4"]
[ext_resource type="Script" path="res://addons/godot_state_charts/transition.gd" id="5"]
[ext_resource type="Script" path="res://addons/godot_state_charts/expression_guard.gd" id="6"]

[sub_resource type="Resource" id="HasStamina"]
script = ExtResource("6")
expression = "stamina >= 1"

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")

[node name="StateChart" type="Node" parent="."]
script = ExtResource("2")
initial_expression_properties = {
"stamina": 3
}

[node name="Root" type="Node" parent="StateChart"]
script = ExtResource("3")
initial_state = NodePath("Idle")

[node name="Idle" type="Node" parent="StateChart/Root"]
script = ExtResource("4")

[node name="OnMove" type="Node" parent="StateChart/Root/Idle"]
script = ExtResource("5")
to = NodePath("../../Walking")
event = &"move"

[node name="Walking" type="Node" parent="StateChart/Root"]
script = ExtResource("4")

[node name="OnStop" type="Node" parent="StateChart/Root/Walking"]
script = ExtResource("5")
to = NodePath("../../Idle")
event = &"stop"

[node name="OnDash" type="Node" parent="StateChart/Root/Walking"]
script = ExtResource("5")
to = NodePath("../../Dashing")
event = &"dash"
guard = SubResource("HasStamina")

[node name="Dashing" type="Node" parent="StateChart/Root"]
script = ExtResource("4")

[node name="DashOver" type="Node" parent="StateChart/Root/Dashing"]
script = ExtResource("5")
to = NodePath("../../Walking")
delay_in_seconds = "0.25"

[connection signal="state_physics_processing" from="StateChart/Root/Walking" to="." method="_on_walking_physics"]
[connection signal="state_entered" from="StateChart/Root/Dashing" to="." method="_on_dash_entered"]
[connection signal="state_physics_processing" from="StateChart/Root/Dashing" to="." method="_on_dash_physics"]
```

`res://player/player.gd`:

```gdscript
extends CharacterBody2D

@onready var chart: StateChart = $StateChart
var stamina := 3

func _physics_process(_delta: float) -> void:
	var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	chart.send_event(&"move" if dir != Vector2.ZERO else &"stop")
	if Input.is_action_just_pressed("ui_accept"):
		chart.send_event(&"dash")

func _on_walking_physics(_delta: float) -> void:
	velocity = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down") * 200.0
	move_and_slide()

func _on_dash_entered() -> void:
	stamina -= 1
	chart.set_expression_property(&"stamina", stamina)
	velocity = velocity.normalized() * 600.0

func _on_dash_physics(_delta: float) -> void:
	move_and_slide()
```

## Verify in WASD Engine

`godot_run`, hold a direction and press `ui_accept` with `godot_input`, then `godot_eval`: `scene.get_node("Player/StateChart/Root/Dashing").active`, `scene.get_node("Player/StateChart").get_expression_property("stamina")`. To see it, instance `res://addons/godot_state_charts/utilities/state_chart_debugger.tscn` under a CanvasLayer, call its `debug_node(chart)` (or set `initial_node_to_watch`) and take a `godot_screenshot`: it shows the active states, pending delayed transitions and expression properties, and a History tab. It covers the screen; remove it before shipping.

## Pitfalls

- The chart enters its initial states in a deferred call at the end of the frame it becomes ready. Events sent before that, such as from `_ready`, are dropped without an error; send the first events after `await get_tree().process_frame`.
- Connect `state_processing`, `state_physics_processing` and the input signals in the `.tscn` or before the state is entered: a state only turns on processing for signals connected when it is entered.
- Inactive states get `process_mode = PROCESS_MODE_DISABLED`, which also stops nodes placed under them; keep gameplay nodes outside the chart.
- A CompoundState without `initial_state` logs "No initial state set for state"; an event no transition uses logs "State chart does not have an event".
- `delay_seconds` is deprecated; write `delay_in_seconds` as a string.
- Save and load: `StateChartSerializer.serialize(chart)` returns a `SerializedStateChart` resource; `StateChartSerializer.deserialize(saved, chart)` restores it and returns error messages (empty on success).
