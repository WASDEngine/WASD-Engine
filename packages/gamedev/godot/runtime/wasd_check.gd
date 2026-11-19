extends SceneTree
# A project may treat GDScript warnings as errors, and a warning in this file would then keep the file from compiling.
# Every warning of the Godot release that WASD Engine runs is off for this file only; the project's own scripts keep
# the project's warning settings.
@warning_ignore_start(
	"unassigned_variable", "unassigned_variable_op_assign", "unused_variable", "unused_local_constant",
	"unused_private_class_variable", "unused_parameter", "unused_signal", "shadowed_variable",
	"shadowed_variable_base_class", "shadowed_global_identifier", "unreachable_code", "unreachable_pattern",
	"standalone_expression", "standalone_ternary", "incompatible_ternary", "untyped_declaration",
	"inferred_declaration", "unsafe_property_access", "unsafe_method_access", "unsafe_cast", "unsafe_call_argument",
	"unsafe_void_return", "return_value_discarded", "static_called_on_instance", "missing_tool",
	"redundant_static_unload", "redundant_await", "missing_await", "assert_always_true", "assert_always_false",
	"integer_division", "narrowing_conversion", "int_as_enum_without_cast", "int_as_enum_without_match",
	"enum_variable_without_default", "empty_file", "deprecated_keyword", "confusable_identifier",
	"confusable_local_declaration", "confusable_local_usage", "confusable_capture_reassignment",
	"confusable_temporary_modification", "inference_on_variant", "native_method_override",
	"get_node_default_without_onready", "onready_with_export", "property_used_as_function", "constant_used_as_function",
	"function_used_as_property"
)
## WASD Engine static script check.
##
## The Host runs `--headless --path <project> --script <this file> -- <res paths...>`, or, for a list too long for a
## command line, `-- --paths-file <file>` with one path per line of the file. For each path the check
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
##
## Before the first script of an add-on folder, the check loads the script that the folder's `plugin.cfg` names, as
## the editor loads an editor plugin before the rest of its add-on. The add-on folder is the first folder below
## `res://addons/` on the script's path that holds `plugin.cfg`, where the editor's plugin search stops; the search
## enters no hidden folder. The errors of that load go on a line of their own before the script's line,
## {"path": <plugin script>, "plugin": true, "loaded": <bool>, "errors": [...]}, so that the Host reports each
## against the file it is in rather than against the script whose check started the load. Add-ons rely on that
## order: a view script that uses its plugin's class, while the plugin preloads the view's scene, loads only after
## the plugin, because loading the view's script first reaches the view's scene while that script is still
## loading, and Godot reports the script as a non-existent resource.

const MARKER := "WASD_CHECK "
const AUTOLOAD_PREFIXES: Array[String] = ["autoload/", "autoload_prepend/"]
const ADDONS := "res://addons/"

## Original values of the project's autoload settings, keyed by setting name, while they point at this script.
var _autoloads := {}
var _printing_errors := true
## Add-on folders whose `plugin.cfg` the check has read, so that each plugin script loads once.
var _plugin_folders := {}


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
	var paths := OS.get_cmdline_user_args()
	# A list too long for a command line comes in a file, one path per line.
	if paths.size() == 2 and paths[0] == "--paths-file":
		paths = FileAccess.get_file_as_string(paths[1]).split("\n", false)
	for path in paths:
		logger.take()
		var plugin := _plugin_to_load(path)
		if not plugin.is_empty():
			var loaded := ResourceLoader.load(plugin)
			print(MARKER + JSON.stringify({"path": plugin, "plugin": true, "loaded": loaded is Script, "errors": logger.take()}))
		var resource := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var errors := logger.take()
		print(MARKER + JSON.stringify({"path": path, "loaded": resource is Script, "errors": errors}))
	OS.remove_logger(logger)
	quit()


## The editor plugin script to load before `path`: the script that `plugin.cfg` names in the add-on folder that holds
## `path`, the first time the check reaches that folder, unless `path` is that plugin script, whose own check loads
## it. Empty when there is none: outside an add-on folder, or when its `plugin.cfg` names no script.
func _plugin_to_load(path: String) -> String:
	var folder := _addon_folder_of(path)
	if folder.is_empty() or _plugin_folders.has(folder):
		return ""
	_plugin_folders[folder] = true
	var config := ConfigFile.new()
	if config.load(folder.path_join("plugin.cfg")) != OK:
		return ""
	var script := str(config.get_value("plugin", "script", ""))
	if script.is_empty():
		return ""
	var plugin := (script if script.begins_with("res://") else folder.path_join(script)).simplify_path()
	return "" if plugin == path else plugin


## The add-on folder that holds `path` as the editor's plugin search finds it: the first folder below `res://addons/`
## on the way to `path` that holds `plugin.cfg`, because the search looks no deeper below such a folder and enters no
## hidden folder. Empty when no folder on the way holds one.
func _addon_folder_of(path: String) -> String:
	if not path.begins_with(ADDONS):
		return ""
	var parts := path.trim_prefix(ADDONS).split("/")
	var folder := ADDONS.trim_suffix("/")
	for index in parts.size() - 1:
		var part: String = parts[index]
		if part.begins_with("."):
			return ""
		folder = folder.path_join(part)
		if FileAccess.file_exists(folder.path_join("plugin.cfg")):
			return folder
	return ""


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
