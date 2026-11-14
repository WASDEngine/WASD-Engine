# SPDX-License-Identifier: CC0-1.0
# The two files a WASD game server shares with the WASD host agent: status.json, which the server writes, and
# control.json, which the agent writes to warn players or stop the server. Both are replaced by an atomic rename.
extends RefCounted

const Tokens := preload("tokens.gd")

## Where the status file goes ($WASD_STATUS_FILE), or "" to write none.
var status_path := ""
## Where commands arrive ($WASD_CONTROL_FILE), or "" to read none.
var control_path := ""

var _last_seq := -1


func _init(p_status_path: String, p_control_path: String, started_at: float) -> void:
	status_path = p_status_path
	control_path = p_control_path
	# A control file left from an earlier run of this server must not stop or warn the new one.
	if control_path != "" and FileAccess.file_exists(control_path):
		if float(FileAccess.get_modified_time(control_path)) < started_at - 1.0:
			var old := _read()
			_last_seq = int(old.get("seq", -1))


## Replaces the status file with [param data] as JSON.
func write_status(data: Dictionary) -> void:
	if status_path == "":
		return
	var folder := status_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(folder):
		DirAccess.make_dir_recursive_absolute(folder)
	var temporary := status_path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		push_warning("WASD Multiplayer: the status file could not be written (error %d)." % FileAccess.get_open_error())
		return
	file.store_string(JSON.stringify(data))
	file.close()
	var error := DirAccess.rename_absolute(temporary, status_path)
	if error != OK:
		push_warning("WASD Multiplayer: the status file could not be replaced (error %d)." % error)


## The newest command when it has a higher "seq" than the last one returned, else {}.
func next_command() -> Dictionary:
	if control_path == "" or not FileAccess.file_exists(control_path):
		return {}
	var command := _read()
	var seq := int(command.get("seq", -1))
	if command.is_empty() or seq <= _last_seq:
		return {}
	_last_seq = seq
	return command


func _read() -> Dictionary:
	var parsed: Variant = Tokens.parse_json(FileAccess.get_file_as_string(control_path))
	return parsed if parsed is Dictionary else {}
