extends Node3D
## Phantom Camera smoke test: a PhantomCameraHost under the real Camera3D/Camera2D must move
## that camera to follow a target (SIMPLE follow mode with an offset) after the target moves,
## and a priority change must make another PhantomCamera3D active and tween the camera to it.

const ID := "phantom-camera"

@onready var camera_3d: Camera3D = $Camera3D
@onready var host_3d: PhantomCameraHost = $Camera3D/PhantomCameraHost
@onready var target_3d: Node3D = $Target3D
@onready var follow_3d: PhantomCamera3D = $FollowCam3D
@onready var overview_3d: PhantomCamera3D = $OverviewCam3D
@onready var camera_2d: Camera2D = $World2D/Camera2D
@onready var target_2d: Node2D = $World2D/Target2D
@onready var follow_2d: PhantomCamera2D = $World2D/FollowCam2D

var _events: Array[String] = []


func _ready() -> void:
	get_tree().create_timer(20.0).timeout.connect(func() -> void: _fail("timed out"))
	overview_3d.became_active.connect(func() -> void: _events.append("overview_active"))
	follow_3d.became_inactive.connect(func() -> void: _events.append("follow_inactive"))
	overview_3d.tween_completed.connect(func() -> void: _events.append("overview_tween_done"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frames(count: int) -> void:
	for _i: int in count:
		await get_tree().process_frame


func _near3(a: Vector3, b: Vector3) -> bool:
	return a.distance_to(b) < 0.01


func _run() -> void:
	if get_tree().root.get_node_or_null(^"PhantomCameraManager") == null:
		return _fail("PhantomCameraManager autoload missing")
	await _frames(5)

	# 3D: the highest-priority PhantomCamera3D drives the Camera3D.
	if host_3d.get_active_pcam() != follow_3d or not follow_3d.is_active():
		return _fail("FollowCam3D is not the active pcam (active: %s)" % [host_3d.get_active_pcam()])
	if not _near3(camera_3d.global_position, Vector3(0, 2, 6)):
		return _fail("Camera3D at %s before the move, expected (0, 2, 6)" % [camera_3d.global_position])
	var before := camera_3d.global_position
	target_3d.global_position = Vector3(5, 0, -3)
	await _frames(3)
	if not _near3(camera_3d.global_position, Vector3(5, 2, 3)):
		return _fail("Camera3D at %s after the target moved, expected (5, 2, 3) (was %s)" % [camera_3d.global_position, before])

	# 2D: the PhantomCamera2D drives the Camera2D position and zoom.
	if not camera_2d.global_position.is_equal_approx(Vector2(0, -40)) or not camera_2d.zoom.is_equal_approx(Vector2(2, 2)):
		return _fail("Camera2D at %s zoom %s, expected (0, -40) zoom (2, 2)" % [camera_2d.global_position, camera_2d.zoom])
	target_2d.global_position = Vector2(300, 100)
	await _frames(3)
	if not camera_2d.global_position.is_equal_approx(Vector2(300, 60)):
		return _fail("Camera2D at %s after the target moved, expected (300, 60)" % [camera_2d.global_position])

	# Raising another PhantomCamera3D's priority switches the active one and tweens the camera.
	overview_3d.priority = 20
	await _frames(2)
	if host_3d.get_active_pcam() != overview_3d:
		return _fail("OverviewCam3D did not become active after priority = 20")
	var mid := camera_3d.global_position
	await get_tree().create_timer(0.5).timeout
	if not _near3(camera_3d.global_position, Vector3(20, 10, 0)):
		return _fail("Camera3D at %s after the tween, expected (20, 10, 0) (mid %s)" % [camera_3d.global_position, mid])
	for event: String in ["overview_active", "follow_inactive", "overview_tween_done"]:
		if not _events.has(event):
			return _fail("missing signal %s (got %s)" % [event, _events])

	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
