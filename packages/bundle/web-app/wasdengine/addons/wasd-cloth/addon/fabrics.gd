# SPDX-License-Identifier: CC0-1.0
# Fabric presets of WASD Cloth, measured on Godot 4.7 with Jolt Physics at 60 physics ticks per second.
class_name WasdClothFabrics
extends RefCounted

## Fabric names, lightest first.
const NAMES: PackedStringArray = ["silk", "cotton", "canvas", "denim", "leather", "rubber"]

## Soft-body settings per fabric for WasdClothSheet3D: areal density in kg/m², Jolt linear stiffness (1.0 can make
## the solver explode), velocity damping, and solver iterations per physics tick. Light fabrics need more iterations:
## with these, a flag or curtain in a 6 m/s gust keeps 95% of its edges within about 4% of their length.
const SHEET := {
	"silk": {"density": 0.08, "stiffness": 0.9, "damping": 0.01, "precision": 30},
	"cotton": {"density": 0.15, "stiffness": 0.9, "damping": 0.02, "precision": 20},
	"canvas": {"density": 0.3, "stiffness": 0.9, "damping": 0.03, "precision": 15},
	"denim": {"density": 0.45, "stiffness": 0.9, "damping": 0.05, "precision": 12},
	"leather": {"density": 0.9, "stiffness": 0.9, "damping": 0.08, "precision": 10},
	"rubber": {"density": 1.2, "stiffness": 0.35, "damping": 0.05, "precision": 8},
}

## Spring-bone settings per fabric for WasdClothChains3D: how strongly a chain returns to its rest shape, how much of
## its motion it loses per frame, and how hard gravity pulls it.
const CHAIN := {
	"silk": {"stiffness": 0.15, "drag": 0.15, "gravity": 0.8},
	"cotton": {"stiffness": 0.3, "drag": 0.25, "gravity": 1.0},
	"canvas": {"stiffness": 0.5, "drag": 0.3, "gravity": 1.0},
	"denim": {"stiffness": 0.7, "drag": 0.35, "gravity": 1.2},
	"leather": {"stiffness": 1.0, "drag": 0.45, "gravity": 1.4},
	"rubber": {"stiffness": 1.6, "drag": 0.2, "gravity": 0.8},
}


## The sheet settings of `fabric`, or cotton's with a warning when the name is unknown.
static func sheet(fabric: String) -> Dictionary:
	if SHEET.has(fabric):
		return SHEET[fabric]
	push_warning("WASD Cloth: unknown fabric \"%s\"; using cotton. Fabrics: %s." % [fabric, ", ".join(NAMES)])
	return SHEET["cotton"]


## The spring-bone settings of `fabric`, or cotton's with a warning when the name is unknown.
static func chain(fabric: String) -> Dictionary:
	if CHAIN.has(fabric):
		return CHAIN[fabric]
	push_warning("WASD Cloth: unknown fabric \"%s\"; using cotton. Fabrics: %s." % [fabric, ", ".join(NAMES)])
	return CHAIN["cotton"]
