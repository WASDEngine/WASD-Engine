# SPDX-License-Identifier: CC0-1.0
# Registers the WasdMultiplayer autoload when the plugin is turned on in Project Settings, and removes it when the
# plugin is turned off. WASD Engine's multiplayer setup writes the same autoload into project.godot directly.
@tool
extends EditorPlugin

const AUTOLOAD := "WasdMultiplayer"
const AUTOLOAD_PATH := "res://addons/wasd_multiplayer/wasd_multiplayer.gd"


func _enable_plugin() -> void:
	if not ProjectSettings.has_setting("autoload/" + AUTOLOAD):
		add_autoload_singleton(AUTOLOAD, AUTOLOAD_PATH)


func _disable_plugin() -> void:
	if ProjectSettings.has_setting("autoload/" + AUTOLOAD):
		remove_autoload_singleton(AUTOLOAD)
