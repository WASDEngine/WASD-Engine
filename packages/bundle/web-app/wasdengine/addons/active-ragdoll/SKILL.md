---
name: active-ragdoll
description: Active Ragdoll 0.2.0 is installed in this project. ActiveRagdoll gives a humanoid Skeleton3D physical bones whose muscles follow the animation, so the character flinches from hits (hit), staggers (stagger), is knocked down or killed (knock), lies hurt (writhe), and gets up along a clip (get_up); puppet mode keeps the body physical all the time. The skeleton must use Godot's humanoid bone names. Load before adding hit reactions, stumbles, or knock-downs.
---

# Active Ragdoll 0.2.0

`res://addons/active_ragdoll/` (MIT; the classes are global and the plugin needs no enabling): `ActiveRagdoll` (a Node under the skeleton), `RagdollProfile` (the bodies), and modifiers it adds itself. It works on Jolt and on Godot Physics.

The skeleton must use the bone names of `SkeletonProfileHumanoid`: Hips, Spine, Chest, UpperChest, Neck, Head, Left/Right UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot, Toes. A model imported with a BoneMap has them, as the models that `retarget.gd` of universal-animation-library prepares do.

## Create it

```gdscript
var ragdoll: ActiveRagdoll

func _ready() -> void:
	var skeleton := $Model.find_children("*", "Skeleton3D", true, false)[0] as Skeleton3D
	ragdoll = ActiveRagdoll.create(skeleton, RagdollProfile.humanoid())   # 15 bodies, 75 kg
	ragdoll.collision_layer = 1 << 9    # a layer of its own, which the mask leaves out
	ragdoll.collision_mask = 1          # the world
```

`RagdollProfile.humanoid()` sizes capsules for an adult mannequin. Each entry of `profile.bones` has `to` (the bone the capsule reaches, or a length), `radius`, `mass`, `joint`, `limits`, and `group` (spine, head, arms, legs): change the radii to fit another body before `create`. If knees or elbows bend the wrong way, flip `profile.knee_sign` or `profile.elbow_sign`.

## Reactions on plain animation

```gdscript
ragdoll.hit(&"LeftUpperArm", direction * 7.0)      # the upper body reacts, the legs keep animating; true when it started
ragdoll.stagger(&"UpperChest", direction * 12.0)   # a blow that may knock over
if ragdoll.staggering():
	velocity = ragdoll.stagger_velocity()          # step where the body leans
```

## Knocked down, hurt, getting up

```gdscript
ragdoll.knock(&"UpperChest", direction * 150.0, "fall", velocity)   # alive: arms reach for the ground
ragdoll.knock(&"Head", direction * 20.0, "die", velocity)           # dead: the legs give out first
ragdoll.settled.connect(func() -> void: ragdoll.writhe())           # moves and holds the wound

func stand_up(player: AnimationPlayer, skeleton: Skeleton3D) -> void:
	var clip := player.get_animation("GetUp")
	global_transform = ragdoll.get_up_transform(self, ActiveRagdoll.clip_pose(skeleton, clip, "Hips"))
	player.play("GetUp")
	ragdoll.get_up(clip.length)     # the body follows the clip from where it lies
```

`start(velocity)` turns the whole body into a ragdoll without a blow and `stop()` ends it; `collapse()` and `fall()` after `start` are the dead and the alive fall. `lying_on_back()`, `lying_face_down()`, and `roll_over()` choose the get-up clip.

## Puppet mode

```gdscript
ragdoll.puppet(true)                                   # the body is always physical; the animation is its target
ragdoll.puppet_hit(&"LeftUpperArm", direction * 12.0)  # pushes the struck part; heavy blows make it stumble
ragdoll.balance_lost.connect(func() -> void: ragdoll.release("fall"))
if ragdoll.stumbling():
	velocity = ragdoll.stumble_velocity()              # move the character so its feet catch it
```

Puppet mode costs the most: `puppet(false)` for characters far away.

## More

- Signals: `settled`, `balance_lost`, `recovered`. State: `is_running()`, `hitting()`, `staggering()`, `stumbling()`, `writhing()`, `is_puppet()`, `hips_speed()`.
- `ragdoll.bones` maps each bone name to its `PhysicalBone3D`; `ragdoll.simulator` is the `PhysicalBoneSimulator3D`.
- `add_crawl_modifier()` returns a `CrawlModifier` (`weight`, `speed`, `limp_leg`) for a procedural crawl.
- Tuning is exported on the node: muscle `frequency` and `damping_ratio`, `hit_stiffness`, `stagger_*`, `stumble_*`, `pin_weights`, `writhe_time`, `self_collision`.

## Pitfalls

- A skeleton without the humanoid names gets no bodies: check `ragdoll.bones.size() == 15` after `create`.
- Use it or drop-in-ragdoll on one skeleton, not both.
- The profile fits an adult mannequin: fit each `radius` to another body's mesh.
- While it staggers or stumbles, move the character at `stagger_velocity()` or `stumble_velocity()`, so that its steps catch it.

## Check it

`godot_run`, strike the character, and take two screenshots a quarter second apart: the struck part gives way and the body leans, then recovers or falls with arms out. After a knock-down, `godot_eval` of the ragdoll's `hips_speed()` falls to near zero once it settled.
