extends Node

# GLoot 3.0.2 smoke: grid and weight constraints, prototype inheritance, stack split/merge,
# transfer between inventories, an item slot, and a JSON save round trip.

const PROTOSET: JSON = preload("res://wasd_smoke/items.json")

var _failures: PackedStringArray = []


func _check(ok: bool, what: String) -> void:
	if not ok:
		_failures.append(what)


func _ready() -> void:
	_run()
	if _failures.is_empty():
		print("SMOKE_PASS gloot")
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", "; ".join(_failures))
		get_tree().quit(1)


func _run() -> void:
	# A 4x3 grid inventory.
	var bag := Inventory.new()
	bag.name = "Bag"
	bag.protoset = PROTOSET
	var grid := GridConstraint.new()
	grid.size = Vector2i(4, 3)
	bag.add_child(grid)
	add_child(bag)

	# Prototree parsed from the JSON resource, with inheritance.
	var tree := bag.get_prototree()
	_check(tree.has_prototype("great_sword"), "great_sword prototype missing")
	_check(int(tree.get_prototype_property("great_sword", "damage", 0)) == 12, "great_sword damage override")
	_check(tree.get_prototype_property("great_sword", "weapon_type", "") == "melee", "great_sword inherits weapon_type")

	var shield := bag.create_and_add_item("shield")
	_check(shield != null, "shield not added")
	if shield == null:
		return
	_check(grid.get_item_size(shield) == Vector2i(2, 2), "shield size %s" % grid.get_item_size(shield))
	_check(grid.get_item_position(shield) == Vector2i(0, 0), "shield position %s" % grid.get_item_position(shield))

	var sword := grid.create_and_add_item_at("sword", Vector2i(3, 0))
	_check(sword != null and grid.get_item_rect(sword) == Rect2i(3, 0, 1, 3), "sword not placed at (3,0) as 1x3")

	var potions := bag.create_and_add_item("potion")
	_check(potions != null, "potions not added")
	if sword == null or potions == null:
		return
	_check(potions.get_stack_size() == 5 and potions.get_max_stack_size() == 10, "potion stack 5/10")
	_check(potions.get_title() == "Health Potion", "potion title from 'name' property")
	_check(grid.move_item_to(potions, Vector2i(2, 2)), "move potions to (2,2)")
	_check(grid.get_item_at(Vector2i(2, 2)) == potions, "get_item_at(2,2) is potions")

	# Grid constraint rejects overlaps and items that do not fit.
	_check(grid.create_and_add_item_at("shield", Vector2i(1, 1)) == null, "overlapping shield was accepted")
	_check(bag.create_and_add_item("shield") == null, "second 2x2 shield fit in a full grid")
	_check(bag.get_item_count() == 3, "bag item count %d, expected 3" % bag.get_item_count())

	# Split and merge stacks.
	var half := bag.split_stack(potions, 2)
	_check(half != null, "split_stack returned null")
	if half != null:
		_check(potions.get_stack_size() == 3 and half.get_stack_size() == 2, "split sizes %d/%d" % [potions.get_stack_size(), half.get_stack_size()])
		_check(bag.get_item_count() == 4, "split did not add a stack")
		_check(bag.merge_stacks(potions, half), "merge_stacks failed")
		_check(potions.get_stack_size() == 5, "merged size %d" % potions.get_stack_size())
		_check(bag.get_item_count() == 3 and not bag.has_item(half), "emptied stack not removed")

	var more := InventoryItem.new(PROTOSET, "potion")
	more.set_stack_size(4)
	_check(bag.add_item_automerge(more), "add_item_automerge failed")
	_check(potions.get_stack_size() == 9 and bag.get_item_count() == 3, "automerge result %d stacks, potion %d" % [bag.get_item_count(), potions.get_stack_size()])

	# Save and load through JSON text.
	var saved := JSON.stringify(bag.serialize())
	var copy := Inventory.new()
	add_child(copy)
	_check(copy.deserialize(JSON.parse_string(saved)), "deserialize failed")
	var copy_grid := copy.get_constraint(GridConstraint) as GridConstraint
	_check(copy.get_item_count() == 3 and copy_grid != null and copy_grid.size == Vector2i(4, 3), "copy has %d items" % copy.get_item_count())
	var copy_potions := copy.get_item_with_prototype_id("potion")
	_check(copy_potions != null and copy_potions.get_stack_size() == 9, "copy potion stack")
	if copy_grid != null and copy_potions != null:
		_check(copy_grid.get_item_position(copy_potions) == Vector2i(2, 2), "copy potion position %s" % copy_grid.get_item_position(copy_potions))

	# A weight-limited inventory; adding an item moves it out of its old inventory.
	var pack := Inventory.new()
	pack.protoset = PROTOSET
	var weight := WeightConstraint.new()
	weight.capacity = 10.0
	pack.add_child(weight)
	add_child(pack)
	_check(pack.add_item(sword), "sword (3) did not fit the pack")
	_check(pack.add_item(potions), "potions (9 x 0.5) did not fit the pack")
	_check(not bag.has_item(potions) and potions.get_inventory() == pack, "transfer left potions in the bag")
	_check(is_equal_approx(weight.get_occupied_space(), 7.5), "occupied %s, expected 7.5" % weight.get_occupied_space())
	_check(pack.create_and_add_item("anvil") == null, "anvil (8) exceeded capacity but was added")
	_check(is_equal_approx(weight.get_free_space(), 2.5), "free %s, expected 2.5" % weight.get_free_space())

	# An item slot holds one item and takes it out of its inventory.
	var hand := ItemSlot.new()
	hand.protoset = PROTOSET
	add_child(hand)
	_check(hand.equip(sword), "equip failed")
	_check(hand.get_item() == sword and not pack.has_item(sword), "slot did not take the sword")
	_check(is_equal_approx(weight.get_occupied_space(), 4.5), "occupied after equip %s" % weight.get_occupied_space())
