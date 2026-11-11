---
name: gdunit4
description: GdUnit4 6.2.3 is installed in this project. Test suites that extend GdUnitTestSuite, with fluent asserts, signal asserts, a scene runner, and mocks, run headless with godot_script through a small runner script. Load before writing, running, or reading the results of GdUnit4 tests.
---

# GdUnit4 6.2.3 unit tests

GdUnit4 runs only from the command line here; its editor panels are not used. Write tests as files, run them with `godot_script`, and read the result from the output text.

## One-time setup: the runner script

GdUnit4's own `res://addons/gdUnit4/bin/GdUnitCmdTool.gd` reads only engine arguments, while `godot_script` passes `args` after `--`: called directly it prints its usage text and runs nothing. Write this file once, outside the tests folder:

```gdscript
# res://tools/gdunit_cli.gd
extends SceneTree
## Runs GdUnit4's command-line runner with the arguments given after "--".

class UserArgsRunner:
	extends GdUnitTestCIRunner

	func get_cmdline_args() -> PackedStringArray:
		var args := PackedStringArray(["GdUnitCmdTool.gd"])
		args.append_array(OS.get_cmdline_user_args())
		return args

var _runner: Node

func _initialize() -> void:
	_runner = UserArgsRunner.new()
	root.add_child(_runner)

func _finalize() -> void:
	queue_delete(_runner)
```

## Write a test suite

Any `.gd` file under the folder you pass with `-a` (subfolders included) whose script `extends GdUnitTestSuite` is a suite; each method whose name starts with `test_` is a test. Hooks: `before()`, `after()` (once per suite), `before_test()`, `after_test()`. `preload()` the scripts under test.

```gdscript
# res://tests/test_health.gd
extends GdUnitTestSuite

const Health = preload("res://scripts/health.gd")  # extends Node; var hp := 10; signal died; func hit(n)

func test_hit_lowers_hp() -> void:
	var health: Node = auto_free(Health.new())
	health.hit(3)
	assert_int(health.hp).is_equal(7)

func test_death_signal() -> void:
	var health: Node = auto_free(Health.new())
	add_child(health)
	get_tree().create_timer(0.1).timeout.connect(func() -> void: health.hit(20))
	await assert_signal(health).wait_until(1000).is_emitted("died")

func test_player_scene() -> void:
	var runner := scene_runner("res://player.tscn")
	await runner.simulate_frames(10)
	var pos: Vector2 = runner.get_property("position")
	assert_float(pos.y).is_greater(0.0)
```

## Run it

Call `godot_script` with:
- `script`: `res://tools/gdunit_cli.gd`
- `args`: `["-a", "res://tests", "--ignoreHeadlessMode", "-c", "-rd", "user://gdunit4_reports"]`

`-a` takes a folder or one test file and can repeat. `--ignoreHeadlessMode` is required: without it the run stops with `Headless mode is not supported!` and `Abnormal exit with 103`. `-c` runs every test; without it the run stops at the first failure. `-rd user://...` keeps the HTML/XML reports out of the game folder (the default is `res://reports/`). `-i res://tests/test_slow.gd` or `-i test_health:test_death_signal` skips a suite or one test.

## Read pass or fail

Decide from the output, not from `exitCode`: through this runtime the process exits 0 even when tests fail. Each test prints `res://tests/test_health.gd > test_hit_lowers_hp PASSED 1ms` or `FAILED`, and a failure adds its report:

```
  res://tests/test_health.gd > test_hit_lowers_hp FAILED 1ms
  Report:
  Expecting:
 7
 but was
 10	at 'test_hit_lowers_hp' in res://tests/test_health.gd:8
Overall Summary: 3 test cases | 0 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans |
Exit code: 100
```

- `Exit code: 0`: all passed. `Exit code: 100`: failures or errors. `Exit code: 101`: tests passed but left orphan nodes (free them with `auto_free()`).
- `Script errors were detected during test discovery!` and `Abnormal exit with 105`: a test file does not compile; nothing ran. The parse error is listed.
- `No test cases found, abort test run!`, then `Exit code: 0`: nothing matched `-a` (or everything was skipped with `-i`); nothing was tested.
- The usage text (`runtest -a <directory|path of testsuite>`) and no tests: the arguments did not arrive; run `res://tools/gdunit_cli.gd`, not `GdUnitCmdTool.gd`.
- `Could not find base class "GdUnitTestCIRunner"`: the project has not been imported since GdUnit4 was installed. Run the game once with `godot_run` (it imports), then retry.

## API (6.2.3)

Asserts: `assert_int(v).is_equal(5)` / `.is_greater(3)` / `.is_between(1, 9)`, `assert_float(v).is_equal_approx(0.3, 0.0001)`, `assert_str(s).is_equal("a")` / `.contains("b")` / `.starts_with("c")`, `assert_bool(b).is_true()`, `assert_array(a).has_size(3)` / `.contains(2, 3)` / `.contains_exactly(1, 2, 3)`, `assert_dict(d).contains_keys(["hp"])`, `assert_vector(v).is_equal(Vector2(2, 4))`, `assert_object(o).is_instanceof(Node)`, `assert_that(v).is_equal(x)`, `await assert_signal(obj).wait_until(ms).is_emitted("name", arg1, arg2)` (or `.is_not_emitted`), `await assert_error(func() -> void: ...).is_push_error("text")`, `fail("message")`. Asserts chain: `assert_str("wasd").is_not_equal("WASD").starts_with("wa")`.

Helpers: `auto_free(obj)` (freed after the test), `add_child(node)` (the suite is in the scene tree), `monitor_signals(obj)` (record signals emitted before you assert), `await await_idle_frame()`, `await await_millis(ms)`.

Scene runner: `var runner := scene_runner("res://level.tscn")`; `await runner.simulate_frames(n)`, `runner.get_property("name")`, `runner.set_property("name", value)`, `runner.invoke("method", args...)`, `runner.find_child("Player")`, `runner.scene()`, `runner.simulate_action_pressed("jump")` then `await runner.await_input_processed()`, `runner.simulate_key_pressed(KEY_SPACE)`.

Mocks: `var m = mock(Health)` (methods return defaults), `do_return(6).on(m).roll()`, `verify(m, 1).hit(3)`; `var s = spy(auto_free(Health.new()))` keeps the real code and records calls.

Parameterized test: `func test_hits(dmg: int, left: int, test_parameters := [[1, 9], [5, 5]]) -> void:`.

## Pitfalls

- 6.x asserts take variadic arguments: `is_emitted("died", 3)`, `contains(2, 3)`. The old array form (`is_emitted("died", [3])`) is still accepted.
- `push_error()` inside a test does not fail it; check one with `assert_error(...).is_push_error("text")`.
- `godot_script` does not import the project: a `class_name` added since the last import is unknown in tests until `godot_run` imports. `preload()` avoids this.
- `godot_script` keeps about the last 6,000 characters of output; the summary is at the end.
- GdUnit4 and GUT do not mix in one project; use GdUnit4's API only.

## Do not

- Do not run `addons/gdUnit4/runtest.sh` or `bin/GdUnitCmdTool.gd`; do not edit files in `res://addons/gdUnit4/`.
- Do not put the runner script inside the tests folder.
- Do not report tests as passing without the `Overall Summary` and `Exit code: 0` lines.
