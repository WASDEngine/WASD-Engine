---
name: wasd-fx
description: WASD FX 1.0.0 is installed in this project. The autoload WasdFx plays eighteen effects by name in one line each, with explosions, sparks, impacts, muzzle flashes, magic, pickups, splashes, and confetti as bursts and fire, smoke, steam, and embers that keep running, and puts a hit flash, an outline, or a dissolve on any thing, on every renderer and in Web builds. Load before showing a hit, a blast, a shot, a spell, a pickup, a fire, a selection, or a death.
---

# WASD FX 1.0.0

`res://addons/wasd_fx/` (CC0, written by WASD Engine). The installation added the autoload `WasdFx`, so every script can play an effect:

```gdscript
WasdFx.play("explosion", global_position)
WasdFx.play("sparks", hit_position, {"normal": hit_normal})
WasdFx.play("magic", target.global_position, {"color": Color(0.5, 0.3, 1.0), "scale": 1.5})
```

Every effect is a few layers of cards that one shader moves on the graphics card: no particle nodes to set up, no textures to load, and one shader for all eighteen, so a new effect never stalls a frame once the first has played. Effects that are over are kept and used again. They show the same on Forward+ and Compatibility.

## Bursts: play and forget

| Name | Shows | Play it at |
|---|---|---|
| `sparks` | sparks off metal, a flash | the hit, `normal` the surface's |
| `impact` | a puff of dust, bits that fall | a bullet's hit on stone, earth, wood; a landing |
| `explosion` | flash, fireball, smoke, embers, debris, a ring on the ground, a light | the ground under the blast |
| `muzzle_flash` | a star of fire, sparks, a wisp of smoke, a light | the muzzle, `normal` the barrel's direction, `parent` the gun |
| `magic` | a ring, a flash, glints that drift up; white, so `color` sets it | the target or the caster |
| `pickup` | glints that rise, a small ring | a coin, a heal, a key taken |
| `poof` | a puff of pale smoke | where something appears or vanishes |
| `splash` | drops, mist, rings | the water's surface |
| `shockwave` | a ring along the ground, dust | a stomp, a heavy landing |
| `zap` | short jumping streaks, a light | an electric hit, a broken machine |
| `confetti` | paper in every color | above the winner, `normal` up |
| `splatter` | red drops and mist; `color` makes slime, paint, oil | a hit on something that bleeds |

## Effects that keep running

`fire` (a meter across, with embers, smoke, and a flickering light), `torch` (a flame with its light; `scale` 0.3 for a candle), `smoke` (a dark column), `steam`, `sparkle` (glints round something worth taking), `embers` (through some meters of air).

```gdscript
var fire := WasdFx.play("fire", $Campfire.global_position)
...
fire.stop()          # fades out over 0.6 seconds; stop(2.0) takes longer
```

`play()` returns a `WasdFxInstance3D` (a Node3D): move it, or keep it to stop it. Its signal `finished` fires when it is over; the node then waits for a later play of the same effect, which starts without the connections made for this one, so connect for each play. A running effect that is never stopped runs until the game ends, also across scene changes, unless it has a `parent` in the scene.

## Options

`WasdFx.play(name, position, options)`; every option may be left out.

- `normal` (Vector3): the direction the effect's up turns to. Sparks and dust fly off a wall along it; a muzzle flash points along it. Up when left out.
- `scale` (float): 1 is the size in the tables; 0.3 a small hit, 3 a large blast.
- `color` (Color): multiplies the effect's colors.
- `parent` (Node3D): the effect becomes its child and moves with it. Without one, effects stay where they were played.

`WasdFx.light_level` says how brightly smoke and dust are lit, from 0 to 1. Left at -1, a WASD Look node in the scene tells it; without one it is 1, so set about 0.25 for a night scene. `WasdFx.gravity` pulls sparks, debris, and drops. `WasdFx.names()` lists the effects. `WasdFx.wind` (a Vector3 in meters a second) carries smoke, steam, dust, and embers along and leans flames; sparks and debris fly free. A running effect takes a new wind from then on: what is already in the air drifts on from where it is. The `wasd-weather` add-on sets it.

## On things

Three effects on a thing itself, each on every mesh under the node it is given, except what WASD packs draw by their own means: blob shadows, halos, light shafts, gobos, fog banks, water, and ropes. WASD Cloth's sheets take them like any mesh.

```gdscript
WasdFx.flash(enemy)                                  # white for a tenth of a second: a hit that registers
WasdFx.flash(player, Color(1.0, 0.2, 0.2), 0.25)     # another color, longer
WasdFx.outline(chest)                                # a line of 3 pixels round it until WasdFx.clear_outline(chest)
WasdFx.outline(target, Color(0.3, 0.9, 1.0), 5.0)
await WasdFx.dissolve(enemy, 0.8, {"free": true})    # eaten away from the bottom up with a glowing edge, then freed
await WasdFx.appear(ally, 0.8)                       # the other way round, for a thing that is hidden
```

`dissolve` and `appear` take `{"color": Color(0.3, 0.9, 1.0)}` for the edge's glow. For their seconds each mesh wears a plain material in its own color, picture, vertex colors, and cut-out holes with nothing drawn over it, so a surface with a shader of its own looks plainer while it goes; CSG shapes do not dissolve. Their seconds stand still while the game is paused. A `dissolve` or `appear` of a thing before its last one ends takes over: `dissolve` here and `appear` there is a teleport. One of a part under it, such as the sword in a dissolving hand, runs alongside, and every mesh wears its own materials again once the last that reaches it ends. A flash shows over an outline, which comes back after it; the wet and snowy cover of `wasd-weather` waits under all three. The outline wants smooth normals: on a plain box it opens at the corners.

## The first effect

The shader compiles when the first effect is drawn, which can stall that frame, most of all in a Web build. `await WasdFx.warm_up()` draws three tiny effects and a speck of each effect on things before the camera once; call it while a loading screen or a menu is up. The `wasd-loading` add-on calls it by itself.

## Pitfalls

- Effects are not lit by lamps and cast no shadows; smoke only follows `light_level`. Fire, sparks, and flashes carry their own light, without shadows.
- Effects sort among other see-through things by distance, each effect as a whole: a near torch shows over a far blast's smoke. Particles of two effects in one place do not interleave.
- Particles pass through walls and floors: play ground effects at the ground, not below it.
- The lights of `explosion`, `sparks`, `muzzle_flash`, `zap`, `fire`, and `torch` are real lights for a moment; dozens at once cost frames.
- For a mark left behind, such as a scorch or a bullet hole, add it with the `wasd-decals` add-on at the same place.
- `WasdFx.play()` returns null and warns for an unknown name.

## Check it

`godot_run`, trigger the effect, and `godot_screenshot` within a tenth of a second for a flash, half a second for smoke. Bursts are short: to judge one, play it with `scale` 3 against a dark wall.
