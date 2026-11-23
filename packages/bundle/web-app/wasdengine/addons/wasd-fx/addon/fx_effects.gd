# SPDX-License-Identifier: CC0-1.0
# The effects WasdFx knows by name. Each is a few layers of particles, every layer a set of values for the particle
# shader (fx.gdshader names them), and for some a light that flashes or flickers. Sizes and speeds are in meters
# and seconds for an effect of scale 1.
class_name WasdFxEffects
extends RefCounted

## What a layer has when it does not say: 16 soft dots that fly out all round for a second and fade.
const LAYER := {
	"count": 16, "life": 1.0, "delay": 0.0, "spawn_over": 0.0, "shape": 0, "spread": 0.6, "radius": 0.0, "offset": Vector3.ZERO,
	"speed": Vector2(1.0, 3.0), "gravity": 0.0, "rise": 0.0, "drag": 0.0, "wobble": 0.0, "carried": 0.0,
	"size": Vector2(0.1, 0.3), "size_variance": 0.4, "stretch": 0.0, "spin": 0.0, "lies_flat": false, "look": 0,
	"color_start": Color(1, 1, 1, 1), "color_mid": Color(1, 1, 1, 1), "color_end": Color(1, 1, 1, 0), "mid_at": 0.3,
	"energy": 1.0, "rainbow": false, "through": 1.0, "self_lit": 0.0,
}

## Shapes of flight and looks of a card, as the shader numbers them.
enum { ALL_ROUND, CONE, RING, STRAIGHT }
enum { DOT, PUFF, STREAK, CIRCLE, STAR, SQUARE }

const EFFECTS := {
	## Sparks off metal: a sword on a shield, a bullet on steel, a grinding wheel.
	"sparks": {
		"layers": [
			{"count": 24, "life": 0.55, "shape": CONE, "spread": 0.6, "speed": Vector2(3.0, 9.0), "gravity": 1.0, "drag": 1.5, "size": Vector2(0.05, 0.015), "stretch": 1.2, "look": STREAK,
				"color_start": Color(1.0, 0.95, 0.7, 1), "color_mid": Color(1.0, 0.6, 0.2, 1), "color_end": Color(0.8, 0.2, 0.05, 0), "energy": 6.0},
			{"count": 1, "life": 0.12, "shape": STRAIGHT, "speed": Vector2.ZERO, "size": Vector2(0.5, 0.9), "size_variance": 0.0, "color_start": Color(1.0, 0.85, 0.6, 1), "color_mid": Color(1.0, 0.8, 0.5, 0.6), "energy": 4.0},
		],
		"light": {"color": Color(1.0, 0.8, 0.5), "energy": 2.0, "range": 3.0, "seconds": 0.15},
	},
	## A hit on stone, earth, or wood: a puff of dust and bits that fall. Also a landing or a footstep in dust.
	"impact": {
		"layers": [
			{"count": 8, "carried": 0.7, "life": 0.9, "shape": CONE, "spread": 0.7, "speed": Vector2(0.6, 2.2), "rise": 0.2, "drag": 3.0, "size": Vector2(0.25, 0.9), "look": PUFF,
				"color_start": Color(0.75, 0.72, 0.68, 0.7), "color_mid": Color(0.75, 0.72, 0.68, 0.5), "color_end": Color(0.75, 0.72, 0.68, 0), "through": 0.0},
			{"count": 10, "life": 0.8, "shape": CONE, "spread": 0.8, "speed": Vector2(2.0, 5.0), "gravity": 1.0, "size": Vector2(0.045, 0.03), "spin": 9.0, "look": SQUARE,
				"color_start": Color(0.3, 0.28, 0.25, 1), "color_mid": Color(0.3, 0.28, 0.25, 1), "color_end": Color(0.3, 0.28, 0.25, 0), "mid_at": 0.7, "through": 0.0},
		],
	},
	## An explosion some meters across: flash, fireball, smoke, embers, debris, and a ring along the ground.
	"explosion": {
		"layers": [
			{"count": 1, "life": 0.18, "shape": STRAIGHT, "speed": Vector2.ZERO, "size": Vector2(2.0, 6.0), "size_variance": 0.0, "color_start": Color(1.0, 0.95, 0.8, 1), "color_mid": Color(1.0, 0.85, 0.55, 0.7), "energy": 10.0},
			{"count": 16, "carried": 0.3, "life": 0.8, "spawn_over": 0.08, "shape": CONE, "spread": 1.0, "speed": Vector2(2.0, 6.5), "rise": 2.5, "drag": 3.0, "size": Vector2(1.2, 3.4), "look": PUFF,
				"color_start": Color(1.0, 0.97, 0.85, 1), "color_mid": Color(1.0, 0.55, 0.1, 0.9), "color_end": Color(0.3, 0.05, 0.02, 0), "mid_at": 0.3, "energy": 8.0},
			{"count": 14, "carried": 0.6, "life": 1.1, "shape": RING, "radius": 0.8, "speed": Vector2(4.0, 9.0), "drag": 3.5, "rise": 0.3, "size": Vector2(0.8, 2.6), "look": PUFF,
				"color_start": Color(0.6, 0.5, 0.42, 0.6), "color_mid": Color(0.5, 0.46, 0.42, 0.4), "color_end": Color(0.5, 0.46, 0.42, 0), "through": 0.0, "self_lit": 0.25},
			{"count": 1, "life": 0.5, "shape": STRAIGHT, "speed": Vector2.ZERO, "offset": Vector3(0, 0.04, 0), "size": Vector2(9.0, 11.0), "size_variance": 0.0, "lies_flat": true,
				"color_start": Color(1.0, 0.7, 0.35, 0.6), "color_mid": Color(1.0, 0.6, 0.25, 0.35), "energy": 1.5},
			{"count": 14, "carried": 1.0, "life": 2.6, "delay": 0.3, "spawn_over": 0.3, "shape": CONE, "spread": 1.0, "radius": 1.0, "speed": Vector2(0.6, 2.0), "rise": 1.2, "drag": 1.8, "size": Vector2(2.2, 5.0), "look": PUFF,
				"color_start": Color(0.3, 0.18, 0.1, 0), "color_mid": Color(0.09, 0.085, 0.08, 0.9), "color_end": Color(0.14, 0.13, 0.13, 0), "mid_at": 0.2, "through": 0.0, "self_lit": 0.2},
			{"count": 32, "life": 1.1, "speed": Vector2(5.0, 14.0), "gravity": 1.0, "drag": 1.2, "size": Vector2(0.07, 0.025), "stretch": 0.25, "look": STREAK,
				"color_start": Color(1.0, 0.9, 0.6, 1), "color_mid": Color(1.0, 0.5, 0.15, 1), "color_end": Color(0.7, 0.15, 0.03, 0), "energy": 7.0},
			{"count": 8, "life": 1.6, "shape": CONE, "spread": 0.9, "speed": Vector2(4.0, 11.0), "gravity": 1.0, "size": Vector2(0.2, 0.16), "size_variance": 0.7, "spin": 8.0, "look": SQUARE,
				"color_start": Color(1.0, 0.55, 0.2, 1), "color_mid": Color(0.2, 0.14, 0.11, 1), "color_end": Color(0.14, 0.12, 0.11, 0), "mid_at": 0.35, "through": 0.0, "self_lit": 1.0},
			{"count": 1, "life": 0.45, "shape": STRAIGHT, "speed": Vector2.ZERO, "offset": Vector3(0, 0.05, 0), "size": Vector2(1.0, 12.0), "size_variance": 0.0, "lies_flat": true, "look": CIRCLE,
				"color_start": Color(1.0, 0.9, 0.8, 0.5), "color_mid": Color(1.0, 0.9, 0.8, 0.3), "energy": 2.0},
		],
		"light": {"color": Color(1.0, 0.7, 0.35), "energy": 14.0, "range": 16.0, "seconds": 0.5},
	},
	## The flash at a gun's muzzle: along the effect's direction.
	"muzzle_flash": {
		"layers": [
			{"count": 1, "life": 0.09, "shape": STRAIGHT, "speed": Vector2.ZERO, "size": Vector2(0.6, 1.0), "size_variance": 0.0, "look": STAR, "color_start": Color(1.0, 0.85, 0.5, 1), "color_mid": Color(1.0, 0.8, 0.45, 0.8), "energy": 8.0},
			{"count": 6, "life": 0.12, "shape": CONE, "spread": 0.25, "speed": Vector2(6.0, 14.0), "size": Vector2(0.04, 0.012), "stretch": 0.3, "look": STREAK, "color_start": Color(1.0, 0.9, 0.6, 1), "color_mid": Color(1.0, 0.6, 0.2, 1), "energy": 6.0},
			{"count": 3, "carried": 0.7, "life": 0.5, "shape": CONE, "spread": 0.2, "speed": Vector2(0.5, 1.5), "drag": 2.0, "size": Vector2(0.15, 0.5), "look": PUFF,
				"color_start": Color(0.6, 0.6, 0.6, 0.35), "color_mid": Color(0.6, 0.6, 0.6, 0.25), "color_end": Color(0.6, 0.6, 0.6, 0), "through": 0.0},
		],
		"light": {"color": Color(1.0, 0.8, 0.5), "energy": 3.0, "range": 5.0, "seconds": 0.07},
	},
	## A burst of magic: a ring, a flash, and glints that drift up. White, to take any `color`.
	"magic": {
		"layers": [
			{"count": 1, "life": 0.5, "shape": STRAIGHT, "speed": Vector2.ZERO, "offset": Vector3(0, 0.05, 0), "size": Vector2(0.4, 3.5), "size_variance": 0.0, "lies_flat": true, "look": CIRCLE, "color_mid": Color(1, 1, 1, 0.7), "energy": 3.0},
			{"count": 24, "life": 0.9, "speed": Vector2(1.0, 3.5), "rise": 0.8, "drag": 2.5, "wobble": 0.3, "size": Vector2(0.3, 0.04), "size_variance": 0.6, "look": STAR, "color_mid": Color(1, 1, 1, 0.9), "energy": 5.0},
			{"count": 1, "life": 0.4, "shape": STRAIGHT, "speed": Vector2.ZERO, "size": Vector2(0.3, 2.6), "size_variance": 0.0, "look": CIRCLE, "color_mid": Color(1, 1, 1, 0.6), "energy": 3.0},
			{"count": 1, "life": 0.2, "shape": STRAIGHT, "speed": Vector2.ZERO, "size": Vector2(1.0, 2.2), "size_variance": 0.0, "color_mid": Color(1, 1, 1, 0.6), "energy": 4.0},
			{"count": 12, "life": 0.3, "shape": RING, "radius": 0.2, "speed": Vector2(3.0, 7.0), "drag": 4.0, "size": Vector2(0.05, 0.02), "stretch": 1.0, "look": STREAK, "color_mid": Color(1, 1, 1, 0.9), "energy": 5.0},
		],
		"light": {"color": Color(1, 1, 1), "energy": 5.0, "range": 7.0, "seconds": 0.4},
	},
	## Something picked up, a heal, a coin: glints that rise and a small ring.
	"pickup": {
		"layers": [
			{"count": 14, "life": 0.8, "shape": RING, "radius": 0.35, "speed": Vector2(0.1, 0.4), "rise": 2.2, "wobble": 0.2, "size": Vector2(0.12, 0.02), "look": STAR,
				"color_start": Color(1.0, 0.95, 0.6, 1), "color_mid": Color(1.0, 0.95, 0.6, 0.9), "color_end": Color(1.0, 0.9, 0.5, 0), "energy": 4.0},
			{"count": 1, "life": 0.35, "shape": STRAIGHT, "speed": Vector2.ZERO, "offset": Vector3(0, 0.05, 0), "size": Vector2(0.3, 1.4), "size_variance": 0.0, "lies_flat": true, "look": CIRCLE, "color_start": Color(1.0, 0.95, 0.7, 0.8), "color_mid": Color(1.0, 0.95, 0.7, 0.5), "energy": 2.0},
		],
	},
	## A puff of smoke where something appears or vanishes.
	"poof": {
		"layers": [
			{"count": 10, "carried": 0.7, "life": 0.8, "speed": Vector2(0.8, 2.2), "rise": 0.6, "drag": 2.5, "size": Vector2(0.5, 1.4), "look": PUFF,
				"color_start": Color(0.9, 0.9, 0.92, 0.75), "color_mid": Color(0.9, 0.9, 0.92, 0.5), "color_end": Color(0.9, 0.9, 0.92, 0), "through": 0.0},
			{"count": 6, "life": 0.4, "speed": Vector2(1.0, 2.5), "drag": 3.0, "size": Vector2(0.1, 0.02), "look": STAR, "energy": 3.0},
		],
	},
	## Something falls into water: drops fly up, mist, and rings on the surface.
	"splash": {
		"layers": [
			{"count": 20, "life": 0.8, "shape": CONE, "spread": 0.5, "speed": Vector2(2.5, 6.0), "gravity": 1.0, "size": Vector2(0.05, 0.03), "stretch": 0.05, "look": STREAK,
				"color_start": Color(0.85, 0.93, 1.0, 0.9), "color_mid": Color(0.85, 0.93, 1.0, 0.8), "color_end": Color(0.85, 0.93, 1.0, 0), "mid_at": 0.7, "through": 0.3, "energy": 1.2},
			{"count": 6, "life": 0.6, "shape": CONE, "spread": 0.6, "speed": Vector2(0.5, 1.5), "drag": 2.0, "size": Vector2(0.3, 0.9), "look": PUFF,
				"color_start": Color(0.9, 0.95, 1.0, 0.4), "color_mid": Color(0.9, 0.95, 1.0, 0.25), "color_end": Color(0.9, 0.95, 1.0, 0), "through": 0.0},
			{"count": 2, "life": 0.9, "spawn_over": 0.25, "shape": STRAIGHT, "speed": Vector2.ZERO, "offset": Vector3(0, 0.02, 0), "size": Vector2(0.3, 2.2), "size_variance": 0.0, "lies_flat": true, "look": CIRCLE,
				"color_start": Color(1, 1, 1, 0.5), "color_mid": Color(1, 1, 1, 0.35), "through": 0.2},
		],
	},
	## A ring that runs out along the ground: a stomp, a landing, a blast wave.
	"shockwave": {
		"layers": [
			{"count": 1, "life": 0.5, "shape": STRAIGHT, "speed": Vector2.ZERO, "offset": Vector3(0, 0.05, 0), "size": Vector2(0.5, 9.0), "size_variance": 0.0, "lies_flat": true, "look": CIRCLE, "color_start": Color(1, 1, 1, 0.7), "color_mid": Color(1, 1, 1, 0.45), "energy": 2.5},
			{"count": 12, "carried": 0.5, "life": 0.7, "shape": RING, "radius": 0.4, "speed": Vector2(3.0, 6.0), "drag": 3.5, "rise": 0.3, "size": Vector2(0.3, 1.0), "look": PUFF,
				"color_start": Color(0.75, 0.72, 0.68, 0.5), "color_mid": Color(0.75, 0.72, 0.68, 0.3), "color_end": Color(0.75, 0.72, 0.68, 0), "through": 0.0},
		],
	},
	## Electricity: short bright streaks that jump about for a moment.
	"zap": {
		"layers": [
			{"count": 18, "life": 0.22, "spawn_over": 0.15, "speed": Vector2(2.0, 7.0), "drag": 6.0, "size": Vector2(0.09, 0.03), "stretch": 0.5, "look": STREAK, "color_start": Color(0.85, 0.95, 1.0, 1), "color_mid": Color(0.6, 0.85, 1.0, 1), "color_end": Color(0.4, 0.6, 1.0, 0), "energy": 8.0},
			{"count": 1, "life": 0.1, "shape": STRAIGHT, "speed": Vector2.ZERO, "size": Vector2(0.4, 1.0), "size_variance": 0.0, "color_start": Color(0.8, 0.92, 1.0, 1), "color_mid": Color(0.7, 0.88, 1.0, 0.6), "energy": 5.0},
		],
		"light": {"color": Color(0.7, 0.85, 1.0), "energy": 3.0, "range": 4.0, "seconds": 0.15},
	},
	## Paper in every color that tumbles down: a win, a level cleared.
	"confetti": {
		"layers": [
			{"count": 48, "carried": 0.5, "life": 2.6, "shape": CONE, "spread": 0.6, "speed": Vector2(4.0, 9.0), "gravity": 0.35, "drag": 1.6, "wobble": 0.6, "size": Vector2(0.07, 0.07), "spin": 6.0, "look": SQUARE,
				"color_mid": Color(1, 1, 1, 1), "mid_at": 0.8, "rainbow": true, "through": 0.0},
		],
	},
	## Drops and a mist of a liquid: red as given, or slime, paint, oil by `color`.
	"splatter": {
		"layers": [
			{"count": 18, "life": 0.6, "shape": CONE, "spread": 0.7, "speed": Vector2(2.0, 6.0), "gravity": 1.0, "size": Vector2(0.06, 0.04), "stretch": 0.05, "look": STREAK,
				"color_start": Color(0.6, 0.02, 0.02, 1), "color_mid": Color(0.6, 0.02, 0.02, 1), "color_end": Color(0.5, 0.02, 0.02, 0), "mid_at": 0.7, "through": 0.0},
			{"count": 5, "life": 0.4, "shape": CONE, "spread": 0.7, "speed": Vector2(0.5, 1.5), "drag": 2.0, "size": Vector2(0.2, 0.6), "look": PUFF,
				"color_start": Color(0.5, 0.03, 0.03, 0.5), "color_mid": Color(0.5, 0.03, 0.03, 0.3), "color_end": Color(0.5, 0.03, 0.03, 0), "through": 0.0},
		],
	},
	## A fire a meter across that burns on: flames, embers, smoke, and a light that flickers.
	"fire": {
		"looping": true,
		"layers": [
			{"count": 24, "carried": 0.35, "life": 0.95, "shape": CONE, "spread": 0.3, "radius": 0.24, "speed": Vector2(0.8, 2.0), "rise": 1.1, "drag": 0.8, "wobble": 0.1, "size": Vector2(0.7, 0.14), "size_variance": 0.5, "stretch": 0.45, "look": PUFF,
				"color_start": Color(1.0, 0.97, 0.85, 0.95), "color_mid": Color(1.0, 0.55, 0.1, 0.85), "color_end": Color(0.45, 0.06, 0.0, 0), "energy": 6.0},
			{"count": 1, "life": 1.0, "shape": STRAIGHT, "speed": Vector2.ZERO, "offset": Vector3(0, 0.03, 0), "size": Vector2(3.4, 3.4), "size_variance": 0.0, "lies_flat": true,
				"color_start": Color(1.0, 0.6, 0.25, 0.45), "color_mid": Color(1.0, 0.6, 0.25, 0.45), "color_end": Color(1.0, 0.6, 0.25, 0.45), "energy": 1.0},
			{"count": 10, "carried": 0.7, "life": 1.8, "shape": CONE, "spread": 0.35, "speed": Vector2(0.8, 2.2), "rise": 0.8, "wobble": 0.35, "size": Vector2(0.035, 0.012), "color_start": Color(1.0, 0.8, 0.4, 1), "color_mid": Color(1.0, 0.5, 0.15, 1), "color_end": Color(0.8, 0.2, 0.05, 0), "energy": 6.0},
			{"count": 12, "carried": 1.0, "life": 4.0, "shape": CONE, "spread": 0.2, "offset": Vector3(0, 0.7, 0), "speed": Vector2(0.6, 1.2), "rise": 0.5, "wobble": 0.2, "size": Vector2(0.5, 2.2), "look": PUFF,
				"color_start": Color(0.4, 0.22, 0.12, 0), "color_mid": Color(0.11, 0.1, 0.1, 0.6), "color_end": Color(0.16, 0.15, 0.15, 0), "through": 0.0, "self_lit": 0.25},
		],
		"light": {"color": Color(1.0, 0.6, 0.3), "energy": 4.0, "range": 9.0, "height": 0.5},
	},
	## A torch's or a candle's flame (scale 0.3 for a candle), with its light.
	"torch": {
		"looping": true,
		"layers": [
			{"count": 12, "carried": 0.25, "life": 0.6, "shape": CONE, "spread": 0.2, "radius": 0.04, "speed": Vector2(0.5, 1.0), "rise": 0.8, "drag": 0.8, "wobble": 0.03, "size": Vector2(0.3, 0.07), "size_variance": 0.5, "stretch": 0.6, "look": PUFF,
				"color_start": Color(1.0, 0.97, 0.85, 0.9), "color_mid": Color(1.0, 0.55, 0.1, 0.8), "color_end": Color(0.4, 0.05, 0.0, 0), "energy": 6.0},
			{"count": 5, "carried": 1.0, "life": 1.8, "shape": CONE, "spread": 0.15, "offset": Vector3(0, 0.3, 0), "speed": Vector2(0.4, 0.8), "rise": 0.4, "wobble": 0.1, "size": Vector2(0.12, 0.6), "look": PUFF,
				"color_start": Color(0.35, 0.2, 0.12, 0), "color_mid": Color(0.12, 0.11, 0.11, 0.4), "color_end": Color(0.16, 0.15, 0.15, 0), "through": 0.0, "self_lit": 0.25},
			{"count": 4, "carried": 0.6, "life": 1.2, "shape": CONE, "spread": 0.3, "speed": Vector2(0.5, 1.2), "rise": 0.6, "wobble": 0.2, "size": Vector2(0.025, 0.01), "color_start": Color(1.0, 0.8, 0.4, 1), "color_mid": Color(1.0, 0.5, 0.15, 1), "color_end": Color(0.8, 0.2, 0.05, 0), "energy": 6.0},
		],
		"light": {"color": Color(1.0, 0.62, 0.32), "energy": 2.4, "range": 6.0, "height": 0.15},
	},
	## A column of dark smoke: a chimney, a wreck, a burnt field.
	"smoke": {
		"looping": true,
		"layers": [
			{"count": 14, "carried": 1.0, "life": 4.5, "shape": CONE, "spread": 0.15, "speed": Vector2(0.8, 1.6), "rise": 0.6, "wobble": 0.25, "size": Vector2(0.6, 2.8), "look": PUFF,
				"color_start": Color(0.12, 0.12, 0.12, 0), "color_mid": Color(0.17, 0.16, 0.16, 0.6), "color_end": Color(0.24, 0.23, 0.22, 0), "mid_at": 0.15, "through": 0.0},
		],
	},
	## White steam: a kettle, a vent, a hot spring.
	"steam": {
		"looping": true,
		"layers": [
			{"count": 10, "carried": 1.0, "life": 2.0, "shape": CONE, "spread": 0.3, "speed": Vector2(0.5, 1.2), "rise": 0.8, "wobble": 0.15, "size": Vector2(0.3, 1.2), "look": PUFF,
				"color_start": Color(0.95, 0.96, 0.98, 0), "color_mid": Color(0.95, 0.96, 0.98, 0.35), "color_end": Color(0.95, 0.96, 0.98, 0), "mid_at": 0.2, "through": 0.0},
		],
	},
	## Glints that hang round something worth taking: a coin, a key, a chest.
	"sparkle": {
		"looping": true,
		"layers": [
			{"count": 10, "life": 1.2, "radius": 0.35, "speed": Vector2(0.05, 0.25), "rise": 0.2, "size": Vector2(0.12, 0.0), "look": STAR,
				"color_start": Color(1.0, 0.95, 0.7, 0), "color_mid": Color(1.0, 0.95, 0.7, 1), "color_end": Color(1.0, 0.9, 0.5, 0), "energy": 4.0},
		],
	},
	## Embers that drift up through some meters of air: over a fire, a forge, a burning town.
	"embers": {
		"looping": true,
		"layers": [
			{"count": 24, "carried": 0.8, "life": 3.5, "radius": 2.0, "speed": Vector2(0.1, 0.5), "rise": 0.5, "wobble": 0.8, "size": Vector2(0.045, 0.012),
				"color_start": Color(1.0, 0.75, 0.35, 0), "color_mid": Color(1.0, 0.5, 0.15, 1), "color_end": Color(0.8, 0.2, 0.05, 0), "mid_at": 0.15, "energy": 5.0},
		],
	},
}


## The names of the effects.
static func names() -> PackedStringArray:
	return PackedStringArray(EFFECTS.keys())
