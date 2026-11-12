# SPDX-License-Identifier: CC0-1.0
# Retargets humanoid models to Godot's SkeletonProfileHumanoid so that the animation clips of this add-on play on
# them. Run it with godot_script and the models' res:// paths (.glb, .gltf, or .fbx files the project has imported) as
# arguments. For each model it reads the skeleton from the file, picks the bone map in bone_maps/ that names the most
# of its bones, saves a copy beside the model as <name>.bone_map.tres, and sets the model's import options: the next
# import renames the skeleton's bones to the profile's names and makes the skeleton the unique node %GeneralSkeleton.
# The argument --map=<res:// path of a BoneMap> uses that map for the models after it. Each model prints one line that
# starts with RETARGETED or RETARGET_FAILED. Running it again on a model sets the same options again.
extends SceneTree

## Import options of the skeleton node besides its bone map.
const OPTIONS := {
	"retarget/bone_renamer/rename_bones": true,
	"retarget/bone_renamer/unique_node/make_unique": true,
	"retarget/bone_renamer/unique_node/skeleton_name": "GeneralSkeleton",
	"retarget/rest_fixer/fix_silhouette/enable": true,
}

var _maps := ""


func _initialize() -> void:
	_maps = (get_script() as Script).resource_path.get_base_dir().path_join("bone_maps")
	var map_path := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--map="):
			map_path = arg.trim_prefix("--map=")
		else:
			print(retarget(arg, map_path))
	quit()


## Retargets one model; returns its report line.
func retarget(path: String, map_path: String) -> String:
	var import_path := path + ".import"
	if not FileAccess.file_exists(import_path):
		return "RETARGET_FAILED %s: there is no %s. Check the path; godot_check or godot_run imports a new model." % [path, import_path.get_file()]
	var model := source_model(path)
	if model == null:
		return "RETARGET_FAILED %s: it is not a .glb, .gltf, or .fbx model that loads." % path
	var found := model.find_children("*", "Skeleton3D", true, false)
	if found.is_empty():
		model.free()
		return "RETARGET_FAILED %s: it has no skeleton." % path
	var skeleton := found[0] as Skeleton3D
	var key := "PATH:%s" % model.get_path_to(skeleton)
	var bones := {}
	for i in skeleton.get_bone_count():
		bones[skeleton.get_bone_name(i)] = true
	model.free()
	var choice := {}
	if map_path.is_empty():
		choice = pick(bones)
		if choice.is_empty():
			var names := PackedStringArray(bones.keys())
			return "RETARGET_FAILED %s: no map in %s names this skeleton's bones (%d: %s). Copy the closest map, set each bone_map/<profile bone> to one of these names, and run again with --map=<its res:// path> before the model." % [path, _maps, names.size(), ", ".join(names.slice(0, 80))]
	else:
		var custom := load(map_path) as BoneMap
		if custom == null:
			return "RETARGET_FAILED %s: %s is not a BoneMap." % [path, map_path]
		var counts := coverage(custom, bones, "")
		if counts[2] > 0:
			return "RETARGET_FAILED %s: %s leaves %d required profile bones without a bone of this skeleton." % [path, map_path, counts[2]]
		choice = {"map": with_prefix(custom, ""), "name": map_path, "found": counts[0], "mapped": counts[1]}
	var map: BoneMap = choice["map"]
	var saved := path.get_basename() + ".bone_map.tres"
	# A copy saved by an earlier run may be loaded already; the new map takes its path over.
	map.take_over_path(saved)
	if ResourceSaver.save(map, saved) != OK:
		return "RETARGET_FAILED %s: %s cannot be written." % [path, saved]
	var config := ConfigFile.new()
	if config.load(import_path) != OK:
		return "RETARGET_FAILED %s: %s cannot be read." % [path, import_path]
	var subresources: Dictionary = config.get_value("params", "_subresources", {})
	var nodes: Dictionary = subresources.get("nodes", {})
	var options: Dictionary = nodes.get(key, {})
	options["retarget/bone_map"] = map
	options.merge(OPTIONS, true)
	nodes[key] = options
	subresources["nodes"] = nodes
	config.set_value("params", "_subresources", subresources)
	if config.save(import_path) != OK:
		return "RETARGET_FAILED %s: %s cannot be written." % [path, import_path]
	return "RETARGETED %s: skeleton %s, bone map %s (%d of its %d bones found), saved as %s. The next import renames the bones; godot_check, godot_script, and godot_run import first." % [path, key.trim_prefix("PATH:"), choice["name"], choice["found"], choice["mapped"], saved]


## The model as its file holds it, before any import option renames its nodes or bones; null for another format.
static func source_model(path: String) -> Node:
	var extension := path.get_extension().to_lower()
	var document: GLTFDocument
	var state: GLTFState
	if extension == "glb" or extension == "gltf":
		document = GLTFDocument.new()
		state = GLTFState.new()
	elif extension == "fbx" and ClassDB.class_exists("FBXDocument"):
		document = ClassDB.instantiate("FBXDocument")
		state = ClassDB.instantiate("FBXState")
	else:
		return null
	if document.append_from_file(ProjectSettings.globalize_path(path), state) != OK:
		return null
	return document.generate_scene(state)


## The shipped map that names every required profile bone and the most bones of a skeleton, as a fresh BoneMap with a
## numbered Mixamo prefix applied; empty when none fits.
func pick(bones: Dictionary) -> Dictionary:
	var best := {}
	var files := Array(DirAccess.get_files_at(_maps))
	files.sort()
	for file in files:
		if file.get_extension() != "tres":
			continue
		var map := load(_maps.path_join(file)) as BoneMap
		var prefix := mixamo_prefix(map, bones)
		var counts := coverage(map, bones, prefix)
		if counts[2] == 0 and counts[0] > best.get("found", 0):
			best = {"map": with_prefix(map, prefix), "name": file.get_basename(), "found": counts[0], "mapped": counts[1]}
	return best


## [bones found, bones mapped, required profile bones missing] of a map against a skeleton's bone names.
static func coverage(map: BoneMap, bones: Dictionary, prefix: String) -> Array:
	var profile := SkeletonProfileHumanoid.new()
	var found := 0
	var mapped := 0
	var missing := 0
	for i in profile.bone_size:
		var name := renamed(String(map.get_skeleton_bone_name(profile.get_bone_name(i))), prefix)
		if name.is_empty():
			if profile.is_required(i):
				missing += 1
			continue
		mapped += 1
		if bones.has(name):
			found += 1
		elif profile.is_required(i):
			missing += 1
	return [found, mapped, missing]


## The bone prefix of a Mixamo skeleton such as mixamorig1_, when a map names its bones mixamorig_; empty otherwise.
static func mixamo_prefix(map: BoneMap, bones: Dictionary) -> String:
	var hips := String(map.get_skeleton_bone_name("Hips"))
	if not hips.begins_with("mixamorig_") or bones.has(hips):
		return ""
	var pattern := RegEx.create_from_string("^(mixamorig\\d+_)Hips$")
	for bone in bones:
		var result := pattern.search(bone)
		if result != null:
			return result.get_string(1)
	return ""


static func renamed(name: String, prefix: String) -> String:
	return name if prefix.is_empty() or not name.begins_with("mixamorig_") else prefix + name.trim_prefix("mixamorig_")


## A copy of a map with its Mixamo prefix replaced.
static func with_prefix(map: BoneMap, prefix: String) -> BoneMap:
	var copy := BoneMap.new()
	copy.profile = SkeletonProfileHumanoid.new()
	for i in copy.profile.bone_size:
		var bone := copy.profile.get_bone_name(i)
		var name := String(map.get_skeleton_bone_name(bone))
		if not name.is_empty():
			copy.set_skeleton_bone_name(bone, renamed(name, prefix))
	return copy
