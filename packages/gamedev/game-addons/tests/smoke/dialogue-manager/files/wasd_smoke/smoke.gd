extends Node
## Dialogue Manager smoke test: imports a .dialogue file (via the add-on's import plugin),
## walks it twice with DialogueManager.get_next_dialogue_line, and checks lines, the
## variable/condition branch, response conditions, mutations, and the end of the conversation.

const ID := "dialogue-manager"

var _failed := false
var _ended := 0


func _ready() -> void:
	get_tree().create_timer(30.0).timeout.connect(func() -> void: _fail("timed out"))
	_run.call_deferred()


func _fail(reason: String) -> void:
	if _failed:
		return
	_failed = true
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _expect(ok: bool, what: String) -> bool:
	if not ok:
		_fail(what)
	return ok


func _run() -> void:
	var dm: Node = get_tree().root.get_node_or_null(^"DialogueManager")
	if not _expect(dm != null, "DialogueManager autoload missing"): return
	DialogueManager.dialogue_ended.connect(func(_r: DialogueResource) -> void: _ended += 1)

	var res: Resource = load("res://wasd_smoke/test.dialogue")
	if not _expect(res is DialogueResource, "test.dialogue did not import as a DialogueResource: %s" % [res]): return
	var dialogue := res as DialogueResource
	var cues := dialogue.get_cues()
	if not _expect(cues.has("start") and cues.has("left") and cues.has("right"), "cues are %s" % [cues]): return

	# Walk 1: not enough gold before the mutation, no key -> rich branch, left door.
	var state := { "player_name": "Ada", "gold": 7, "has_key": false, "doors_opened": 0 }
	var line: DialogueLine = await DialogueManager.get_next_dialogue_line(dialogue, "start", [state])
	if not _check_line(line, "Guide", "Hello, Ada."): return
	line = await DialogueManager.get_next_dialogue_line(dialogue, line.next_id, [state])
	if not _expect(state.gold == 12, "set gold += 5 gave gold=%s" % state.gold): return
	if not _check_line(line, "Guide", "You have 12 gold. You look rich."): return
	line = await DialogueManager.get_next_dialogue_line(dialogue, line.next_id, [state])
	if not _check_line(line, "Guide", "Pick a door."): return
	if not _expect(line.responses.size() == 3, "expected 3 responses, got %d" % line.responses.size()): return
	var texts := line.responses.map(func(r: DialogueResponse) -> String: return r.text)
	if not _expect(texts == ["Left door", "Right door", "Leave"], "response texts %s" % [texts]): return
	var allowed := line.responses.map(func(r: DialogueResponse) -> bool: return r.is_allowed)
	if not _expect(allowed == [true, false, true], "walk 1 is_allowed %s" % [allowed]): return
	line = await DialogueManager.get_next_dialogue_line(dialogue, line.responses[0].next_id, [state])
	if not _check_line(line, "Guide", "You went left."): return
	line = await DialogueManager.get_next_dialogue_line(dialogue, line.next_id, [state])
	if not _expect(line == null, "walk 1 did not end after the left branch: %s" % [line]): return
	if not _expect(_ended == 1, "dialogue_ended emitted %d times after walk 1" % _ended): return

	# Walk 2 (empty cue = start of the file): little gold -> poor branch; has the key -> the
	# right door's mutation runs.
	state = { "player_name": "Bo", "gold": 1, "has_key": true, "doors_opened": 0 }
	line = await dialogue.get_next_dialogue_line("", [state])
	if not _check_line(line, "Guide", "Hello, Bo."): return
	line = await dialogue.get_next_dialogue_line(line.next_id, [state])
	if not _check_line(line, "Guide", "You have 6 gold. You look poor."): return
	line = await dialogue.get_next_dialogue_line(line.next_id, [state])
	if not _check_line(line, "Guide", "Pick a door."): return
	if not _expect(line.responses[1].is_allowed, "Right door not allowed with has_key=true"): return
	line = await dialogue.get_next_dialogue_line(line.responses[1].next_id, [state])
	if not _check_line(line, "Guide", "The key opens the right door."): return
	if not _expect(state.doors_opened == 1, "doors_opened=%s after the right branch" % state.doors_opened): return
	line = await dialogue.get_next_dialogue_line(line.next_id, [state])
	if not _expect(line == null, "walk 2 did not end: %s" % [line]): return
	if not _expect(_ended == 2, "dialogue_ended emitted %d times after walk 2" % _ended): return

	if _failed:
		return
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)


func _check_line(line: DialogueLine, character: String, text: String) -> bool:
	if line == null:
		_fail("expected '%s: %s', got the end of the dialogue" % [character, text])
		return false
	return _expect(line.character == character and line.text == text,
		"expected '%s: %s', got '%s: %s'" % [character, text, line.character, line.text])
