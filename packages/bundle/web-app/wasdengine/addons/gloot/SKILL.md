---
name: gloot
description: GLoot 3.0.2 is installed in this project. It gives inventories as Inventory nodes with GridConstraint, WeightConstraint, or ItemCountConstraint children, stackable items from a JSON prototree, ItemSlot, and inventory UI controls. Load before adding or changing inventories, items, or equipment.
---

# GLoot 3.0.2 inventories

GLoot 3 replaced the 2.x API: there is no `InventoryGrid`, `InventoryStacked`, `ItemProtoset`, `prototree_json`, or `item_protoset`. Use an `Inventory` node, constraint child nodes, and a JSON resource in `protoset`. All classes below are global (`class_name`); the code is in `res://addons/gloot/`.

## Item types: the prototree JSON

Write item types to a `.json` file (Godot loads it as a `JSON` resource). Keys are prototype ids; values are properties:

```json
{
  "potion": {"name": "Health Potion", "image": "res://art/potion.png", "stack_size": 5, "max_stack_size": 10, "weight": 0.5},
  "sword": {"damage": 8, "size": "Vector2i(1, 3)", "weight": 3},
  "great_sword": {"inherits": "sword", "damage": 12},
  "shield": {"size": "Vector2i(2, 2)", "weight": 4}
}
```

- Properties GLoot reads: `stack_size` and `max_stack_size` (both default 1, so an item stacks only when `max_stack_size` > 1), `weight` (per unit, default 1.0), `size` (grid cells, default `Vector2i(1, 1)`), `rotated`, `name` (`get_title()`), `image` (texture path, `get_texture()`), `inherits`. Any other key is your own data (`get_property("damage")`).
- String values go through `str_to_var`: write vectors and booleans as strings (`"Vector2i(2, 2)"`, `"true"`). JSON numbers come back as `float`: use `int(item.get_property("damage"))`.
- Plain JSON only: no comments, no trailing commas.
- Put each base prototype above the prototypes that inherit from it: a chain listed child first is dropped.

## API

`Inventory` (Node): `protoset: JSON`; `create_and_add_item(id) -> InventoryItem` (null when a constraint refuses), `create_item(id)`, `add_item(item) -> bool` (also takes it out of its old inventory), `remove_item(item) -> bool`, `has_item(item)`, `get_items()`, `get_item_count()` (stacks, not units), `get_item_with_prototype_id(id)`, `get_items_with_prototype_id(id)`, `has_item_with_prototype_id(id)`, `split_stack(item, n) -> InventoryItem`, `merge_stacks(dst, src, split_source = false) -> bool`, `add_item_automerge(item)`, `add_item_autosplit(item)`, `add_item_autosplitmerge(item)`, `get_constraint(GridConstraint)`, `get_prototree()`, `clear()`, `serialize() -> Dictionary`, `deserialize(dict) -> bool`. Signals: `item_added(item)`, `item_removed(item)`, `item_property_changed(item, property)`.

Constraints are child nodes of the `Inventory`; combine them freely:
- `GridConstraint`: `size: Vector2i`; `get_item_position(item)`, `get_item_size(item)`, `get_item_rect(item)`, `get_item_at(cell)`, `move_item_to(item, cell) -> bool`, `add_item_at(item, cell) -> bool`, `create_and_add_item_at(id, cell)`, `rect_free(rect)`, `find_free_place(item)` (`{success, position}`), `rotate_item(item) -> bool`, `sort()`.
- `WeightConstraint`: `capacity: float`; `get_occupied_space()`, `get_free_space()`.
- `ItemCountConstraint`: `capacity: int` (stacks).

`InventoryItem` (RefCounted; never `free()` it): `InventoryItem.new(protoset, id)`, `get_prototype().get_prototype_id()`, `get_property(name, default)`, `set_property(name, value)`, `clear_property(name)`, `get_stack_size()`, `set_stack_size(n) -> bool`, `get_max_stack_size()`, `split(n)`, `merge_into(dst) -> bool`, `get_title()`, `get_texture()`, `get_inventory()`, static `InventoryItem.swap(a, b) -> bool`.

`ItemSlot` (Node): `protoset: JSON` (same resource as the inventories), `equip(item) -> bool` (takes the item out of its inventory), `get_item()`, `clear()`; signals `item_equipped`, `cleared(item)`.

UI: `CtrlInventory` (an `ItemList`, property `inventory`), `CtrlInventoryGrid` (`inventory`, `field_dimensions: Vector2`; signals `item_dropped(item, offset)`, `inventory_item_activated(item)`), `CtrlItemSlot` (`item_slot`), `CtrlInventoryCapacity` (`inventory`, for weight or count limits).

## Example

```gdscript
extends Node

const ITEMS: JSON = preload("res://items.json")

var bag := Inventory.new()

func _ready() -> void:
	bag.protoset = ITEMS
	var grid := GridConstraint.new()
	grid.size = Vector2i(6, 4)
	bag.add_child(grid)
	add_child(bag)

	var potions := bag.create_and_add_item("potion")      # one stack of 5
	var sword := grid.create_and_add_item_at("sword", Vector2i(5, 0))
	if sword == null:
		print("no room for the sword")
	var two := bag.split_stack(potions, 2)               # stacks of 3 and 2
	bag.merge_stacks(potions, two)                        # one stack of 5 again
	var list := CtrlInventory.new()
	list.inventory = bag
	list.size = Vector2(240, 160)
	add_child(list)
```

The same inventory in a `.tscn`:

```
[ext_resource type="Script" path="res://addons/gloot/core/inventory.gd" id="1_inv"]
[ext_resource type="JSON" path="res://items.json" id="2_items"]
[ext_resource type="Script" path="res://addons/gloot/core/constraints/grid_constraint.gd" id="3_grid"]

[node name="Backpack" type="Node" parent="."]
script = ExtResource("1_inv")
protoset = ExtResource("2_items")

[node name="GridConstraint" type="Node" parent="Backpack"]
script = ExtResource("3_grid")
size = Vector2i(6, 4)
```

Save and load: `var text := JSON.stringify(bag.serialize())`, later `bag.deserialize(JSON.parse_string(text))`; it restores items, stack sizes, constraints, and grid positions.

## Check it in WASD Engine

Run the game with `godot_run`, read state with `godot_eval` (for example `scene.get_node("Backpack").get_item_count()` or `scene.get_node("Backpack").get_item_with_prototype_id("potion").get_stack_size()`), and look at inventory UI with `godot_screenshot`. Logic can also be checked in a headless scene that prints the results and calls `get_tree().quit()`.

## Pitfalls

- An unknown prototype id does not fail: `create_and_add_item("swrod")` returns an item of the first prototype in the JSON. Check `bag.get_prototree().has_prototype(id)` first.
- A stack whose size reaches 0 leaves its inventory. Two stacks merge only when they share the prototype and the same overridden properties (`set_property` on one stack blocks merging).
- Constraints refuse silently: check the `null` or `false` results of the add and move calls.
- At exit Godot prints `ObjectDB instances were leaked` and `1 resources still in use` from GLoot's prototree cache. They are harmless.
- `CtrlInventoryGrid` is not safe for the Web export: it preloads `addons/gloot/editor/undoables.gd`, which declares the editor-only type `EditorUndoRedoManager`, and a release build cannot compile it (GLoot issue #188 was the same failure). In games you export, show grid inventories with your own `Control` that reads `GridConstraint` (`size`, `get_item_rect`), or use `CtrlInventory`.

## Do not

- Do not write 2.x code (`InventoryGrid`, `ItemProtoset`, `item.get_property("id")` for the type).
- Do not edit GLoot's files or the `.godot/` folder; do not enable plugins: the installer already did.
