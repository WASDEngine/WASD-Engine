extends ConditionLeaf
## SUCCESS when the actor has no energy left.


func tick(actor: Node, _blackboard: Blackboard) -> int:
	return SUCCESS if actor.energy <= 0 else FAILURE
