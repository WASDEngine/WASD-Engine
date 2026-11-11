extends ActionLeaf
## Regains 1 energy per tick; RUNNING until energy reaches 2.


func before_run(actor: Node, _blackboard: Blackboard) -> void:
	actor.rest_starts += 1


func tick(actor: Node, _blackboard: Blackboard) -> int:
	actor.energy += 1
	return SUCCESS if actor.energy >= 2 else RUNNING


func after_run(actor: Node, _blackboard: Blackboard) -> void:
	actor.rest_ends += 1
