---
name: gut
description: GUT 9.7.1 (Godot Unit Test) is installed in this project. Test scripts extend GutTest and run headless with godot_script and res://addons/gut/gut_cmdln.gd. Load before writing, running, or reading the results of GUT tests.
---

# GUT 9.7.1 unit tests

GUT runs only from its command-line runner here; its editor panel is not used. Write tests as files, run them with `godot_script`, and read the result from the output text.

## Write a test file

- Put tests in `res://tests/`. A test file name starts with `test_` and ends with `.gd`; it `extends GutTest`. Every method whose name starts with `test_` is a test.
- Hooks: `before_all()`, `before_each()`, `after_each()`, `after_all()`. Inner classes named `Test...` that extend `GutTest` are run as their own groups.
- `preload()` the scripts and scenes under test. A `class_name` added since the last import is unknown to a headless script run (see Pitfalls).

```gdscript
# res://tests/test_health.gd
extends GutTest

const Health = preload("res://scripts/health.gd")  # extends Node; var hp := 10; signal died; func hit(n)

var health: Node

func before_each() -> void:
	health = add_child_autofree(Health.new())

func test_hit_lowers_hp() -> void:
	health.hit(3)
	assert_eq(health.hp, 7, "10 - 3")

func test_death_signal() -> void:
	watch_signals(health)
	health.hit(20)
	assert_signal_emitted(health, "died")

func test_player_scene_falls() -> void:
	var player: Node2D = add_child_autofree(load("res://player.tscn").instantiate())
	var start_y := player.position.y
	await wait_physics_frames(10)
	assert_gt(player.position.y, start_y, "gravity moved the player")
```

## Run it

Call `godot_script` with:
- `script`: `res://addons/gut/gut_cmdln.gd`
- `args`: `["-gdir=res://tests", "-ginclude_subdirs", "-gexit"]`

More arguments (each one string, `name=value` without spaces):
- `-gtest=res://tests/test_health.gd` runs one file (repeatable); `-gselect=health` runs files whose name contains the text.
- `-gunit_test_name=death` runs only tests whose name contains the text.
- `-glog=2` also prints every passing assert and the line `Exiting with code N`.
- `-gjunit_xml_file=user://gut.xml` writes a JUnit report.
- `-gconfig=` ignores a `res://.gutconfig.json` (GUT reads it when present).
- Unknown arguments stop the run with `Unknown arguments: [...]`.

## Read pass or fail

Decide from the output, not from `exitCode`: through this runtime the process exits 0 even when tests fail. The end of the output is a summary:

```
Totals
------
Scripts               1
Tests                 3
Passing Tests         2
Failing Tests         1
Asserts             3/4
---- 1 failing tests ----
```

- Pass: the last line is `---- All tests passed! ----` and `Tests` matches the number of tests you wrote.
- Fail: `---- N failing tests ----`; above it, each failing test is listed as `- test_name` with lines such as `[Failed]:  [10] expected to equal [7]:  10 - 3`. With `-glog=2`, `Exiting with code 1`.
- `---- N pending/risky tests. ----`: a test made no assert (risky) or called `pending()`.
- `Some GUT class_names have not been imported`: the project has not been imported since GUT was installed. Run the game once with `godot_run` (it imports), then run the tests again.
- `[GUT ERROR]:  Nothing was run.`: no file matched `-gdir`/`-gtest`, or every file failed to load.

## Asserts and helpers (9.7.1 names)

`assert_eq(got, expected, text = "")`, `assert_ne`, `assert_true(got)`, `assert_false`, `assert_null`, `assert_not_null`, `assert_almost_eq(got, expected, error_interval)`, `assert_gt`, `assert_gte`, `assert_lt`, `assert_lte`, `assert_between(got, low, high)`, `assert_has(container, element)`, `assert_does_not_have`, `assert_string_contains(text, search)`, `assert_is(object, Class)`, `assert_signal_emitted(object, "name")`, `assert_signal_not_emitted`, `assert_signal_emitted_with_parameters(object, "name", [args])`, `assert_signal_emit_count(object, "name", count)`, `assert_push_error("text")`, `assert_engine_error("text")`, `pass_test("why")`, `fail_test("why")`, `pending("why")`.

Helpers: `watch_signals(object)` (before the signal fires), `add_child_autofree(node)` and `autofree(object)` (freed after the test), `await wait_process_frames(n)`, `await wait_physics_frames(n)`, `await wait_seconds(s)`, `await wait_for_signal(object.signal_name, max_seconds)` (returns true when it fired), `await wait_until(callable, max_seconds)`, `simulate(node, times, delta)`. Parameterized test: `func test_hits(p = use_parameters([[1, 9], [5, 5]])) -> void:`.

Doubles: `var d = double(Health).new()` replaces every method with a stub that does nothing; `stub(d, "roll").to_return(6)`; `assert_called(d, "hit")`, `assert_called(d, "hit", [3])`. `partial_double(Health).new()` keeps the real methods and still records calls. On Godot 4.7 a stubbed typed method returns that type's default (0, "", false) instead of null.

## Pitfalls

- A test file that does not compile is skipped. The output then shows `SCRIPT ERROR: Parse Error: ...` and `[GUT WARNING]:  Ignoring script res://tests/... because it does not extend GutTest`, and the summary can still say `All tests passed!` for the other files. Check the `Scripts` and `Tests` counts, and run `godot_check` on new test files first.
- `godot_script` does not import the project. After you add or rename a `class_name` script, tests that use the class name fail to compile until the next import (`godot_run` imports first). `preload()` avoids this.
- `push_error()` or an engine error during a test fails it (`Unexpected Errors`). Expect one with `assert_push_error("text")` or `assert_engine_error("text")`.
- `wait_frames()` is deprecated; use `wait_process_frames()` or `wait_physics_frames()`.
- Tests run in a headless process: nothing renders, so check visuals with `godot_run` and `godot_screenshot` instead.
- `godot_script` keeps about the last 6,000 characters of output; the summary is at the end. Avoid `-glog=2` on large suites.
- GUT and GdUnit4 do not mix in one project; use GUT's API only.

## Do not

- Do not enable GUT's editor plugin or open its panel; do not edit files in `res://addons/gut/`.
- Do not write GUT 7 (Godot 3) code such as `yield(wait_seconds(1), "timeout")`; write `await wait_seconds(1)`.
- Do not judge a run by `exitCode` alone, and do not report tests as passing without the summary line.
