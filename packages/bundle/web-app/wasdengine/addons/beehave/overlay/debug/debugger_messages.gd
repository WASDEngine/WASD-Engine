# Beehave, Copyright (c) 2023 bitbrain, MIT License. WASD Engine changed can_send_message(); the rest is the add-on's file.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
# persons to whom the Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
# Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
class_name BeehaveDebuggerMessages


static func can_send_message() -> bool:
	# Changed by WASD Engine: its runtime is an editor build without a debugger attached, where sending a message
	# logs "Can't send message. No active debugger" on every tick.
	return not Engine.is_editor_hint() and OS.has_feature("editor") and EngineDebugger.is_active()


static func register_tree(beehave_tree: Dictionary) -> void:
	if can_send_message():
		EngineDebugger.send_message("beehave:register_tree", [beehave_tree])


static func unregister_tree(instance_id: int) -> void:
	if can_send_message():
		EngineDebugger.send_message("beehave:unregister_tree", [instance_id])


static func process_tick(instance_id: int, status: int, blackboard: Dictionary = {}) -> void:
	if can_send_message():
		EngineDebugger.send_message("beehave:process_tick", [instance_id, status, blackboard])

static func process_interrupt(instance_id: int, blackboard: Dictionary = {}) -> void:
	if can_send_message():
		EngineDebugger.send_message("beehave:process_interrupt", [instance_id, blackboard])

static func process_begin(instance_id: int, blackboard: Dictionary = {}) -> void:
	if can_send_message():
		EngineDebugger.send_message("beehave:process_begin", [instance_id, blackboard])


static func process_end(instance_id: int, blackboard: Dictionary = {}) -> void:
	if can_send_message():
		EngineDebugger.send_message("beehave:process_end", [instance_id, blackboard])
