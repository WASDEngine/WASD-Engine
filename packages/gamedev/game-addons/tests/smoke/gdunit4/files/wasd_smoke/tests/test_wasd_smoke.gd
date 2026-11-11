extends GdUnitTestSuite

# GdUnit4 6.2.3 smoke: an assertion test and a node test that awaits a signal.

class Counter:
	extends Node
	signal reached(value: int)
	var value := 0

	func _process(_delta: float) -> void:
		value += 1
		if value == 3:
			reached.emit(value)


var _passed := 0


func test_assertions() -> void:
	assert_int(2 + 3).is_equal(5)
	assert_str("wasd").is_not_equal("WASD").starts_with("wa")
	assert_float(0.1 + 0.2).is_equal_approx(0.3, 0.0001)
	assert_array([1, 2, 3]).contains(2, 3)
	assert_bool("wasd".is_empty()).is_false()
	if not is_failure():
		_passed += 1


func test_node_signal() -> void:
	var counter: Counter = auto_free(Counter.new())
	add_child(counter)
	monitor_signals(counter, false)
	await assert_signal(counter).wait_until(2000).is_emitted("reached", 3)
	assert_int(counter.value).is_greater_equal(3)
	if not is_failure():
		_passed += 1


func after() -> void:
	if _passed == 2:
		print("SMOKE_PASS gdunit4")
	else:
		print("SMOKE_FAIL gdunit4: %d of 2 tests passed" % _passed)
