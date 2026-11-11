extends GutTest

# GUT 9.7.1 smoke: an assertion test and a node test that awaits frames and checks a signal.

class Counter:
	extends Node
	signal reached(value: int)
	var value := 0

	func _process(_delta: float) -> void:
		value += 1
		if value == 3:
			reached.emit(value)


func test_assertions() -> void:
	assert_eq(2 + 3, 5, "integer addition")
	assert_ne("wasd", "WASD", "strings are case-sensitive")
	assert_true("wasd".begins_with("wa"), "begins_with")
	assert_almost_eq(0.1 + 0.2, 0.3, 0.0001, "float tolerance")
	assert_has([1, 2, 3], 2, "array contains 2")


func test_node_process_and_signal() -> void:
	var counter: Counter = add_child_autofree(Counter.new())
	watch_signals(counter)
	await wait_process_frames(5)
	assert_gte(counter.value, 3, "_process ran")
	assert_signal_emitted_with_parameters(counter, "reached", [3])


func after_all() -> void:
	if gut.get_fail_count() == 0 and gut.get_pass_count() >= 7:
		print("SMOKE_PASS gut")
	else:
		print("SMOKE_FAIL gut: %d failed, %d passed asserts" % [gut.get_fail_count(), gut.get_pass_count()])
