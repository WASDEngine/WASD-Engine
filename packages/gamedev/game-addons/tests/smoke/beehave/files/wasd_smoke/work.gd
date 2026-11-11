extends ActionLeaf
## Spends 1 energy and counts finished work on the blackboard.


func tick(actor: Node, blackboard: Blackboard) -> int:
	actor.energy -= 1
	blackboard.set_value("work_done", blackboard.get_value("work_done", 0) + 1)
	return SUCCESS
