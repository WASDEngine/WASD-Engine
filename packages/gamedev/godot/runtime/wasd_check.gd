extends SceneTree
## WASD Engine static script check.
##
## The Host runs `--headless --path <project> --script <this file> -- <res paths...>`. For each path the check
## loads the script, bypassing the resource cache, and prints one line: `WASD_CHECK ` followed by a JSON object
## {"path": <res path>, "loaded": <bool>, "errors": [{"level", "message", "file", "line", "function"}]}. The
## errors are the engine errors and warnings logged while that script loaded, so an error in a script it
## preloads carries that script's file.
##
## The check instantiates no autoload and opens no scene, so no autoload `_init`, `_ready`, or `_process` runs.
## Scripts that name a singleton autoload compile as in a game: the analyzer types a script autoload from its
## script, and a scene autoload as `Node`, because only an instance of the scene carries its root script.
## Loading a script runs its static initializers. As in a game, Godot creates the custom resource loaders and
## savers that the project declares as global classes, so scripts can preload the resources those loaders read.

const MARKER := "WASD_CHECK "
const AUTOLOAD_PREFIXES: Array[String] = ["autoload/", "autoload_prepend/"]

## Original values of the project's autoload settings, keyed by setting name, while they point at this script.
var _autoloads := {}
var _printing_errors := true


class CheckLogger extends Logger:
	var _mutex := Mutex.new()
	var _errors: Array[Dictionary] = []

	func _log_message(_message: String, _error: bool) -> void:
		pass

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		var level := "error"
		match error_type:
			Logger.ERROR_TYPE_WARNING:
				level = "warning"
			Logger.ERROR_TYPE_SCRIPT:
				level = "script_error"
			Logger.ERROR_TYPE_SHADER:
				level = "shader_error"
		_mutex.lock()
		_errors.append({
			"level": level,
			"message": rationale if not rationale.is_empty() else code,
			"file": file,
			"line": line,
			"function": function,
		})
		_mutex.unlock()

	func take() -> Array[Dictionary]:
		_mutex.lock()
		var taken := _errors
		_errors = []
		_mutex.unlock()
		return taken


func _init() -> void:
	# Godot creates the autoloads after this main loop and before _initialize: it registers every singleton name
	# with the script languages, which the GDScript compiler needs, then loads each entry's path and refuses one
	# that is not a Node. Pointing the entries at this SceneTree script keeps the names and creates no autoload.
	# The refusals are expected, so error printing stays off until _initialize restores the entries.
	var placeholder: String = (get_script() as Script).resource_path
	for property in ProjectSettings.get_property_list():
		var setting: String = property["name"]
		if AUTOLOAD_PREFIXES.any(func(prefix: String) -> bool: return setting.begins_with(prefix)):
			var value := str(ProjectSettings.get_setting(setting))
			_autoloads[setting] = value
			ProjectSettings.set_setting(setting, ("*" if value.begins_with("*") else "") + placeholder)
	if not _autoloads.is_empty():
		_printing_errors = Engine.print_error_messages
		Engine.print_error_messages = false


func _initialize() -> void:
	_restore_autoloads()
	var logger := CheckLogger.new()
	OS.add_logger(logger)
	for path in OS.get_cmdline_user_args():
		logger.take()
		var resource := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var errors := logger.take()
		print(MARKER + JSON.stringify({"path": path, "loaded": resource is Script, "errors": errors}))
	OS.remove_logger(logger)
	quit()


## Point the autoload settings back at their scripts and scenes, so the GDScript analyzer types singleton names
## from them; Godot resolves `uid://` entries to paths at startup, and the restored entries match that.
func _restore_autoloads() -> void:
	if _autoloads.is_empty():
		return
	for setting in _autoloads:
		var value: String = _autoloads[setting]
		var singleton := value.begins_with("*")
		ProjectSettings.set_setting(setting, ("*" if singleton else "") + ResourceUID.ensure_path(value.trim_prefix("*")))
	Engine.print_error_messages = _printing_errors
