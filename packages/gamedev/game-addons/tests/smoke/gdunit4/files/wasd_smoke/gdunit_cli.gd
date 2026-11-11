extends SceneTree
## Runs GdUnit4's command-line test runner with the arguments given after "--".
## GdUnit4's own bin/GdUnitCmdTool.gd reads only the engine arguments (before "--"), so it ignores them.


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
