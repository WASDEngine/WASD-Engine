---
name: wasd-light
description: WASD Light 1.0.0 is installed in this project. Six nodes put light in the air on every renderer and in Web builds, with shafts and beams, halos round lamps, fog that fills a box, drifting dust, embers, and snow, a flicker for flames and failing lamps, and shade from leaves or bars. Load before adding a beam, a glowing lamp, mist, haze, smoke, fireflies, snowfall, a flickering light, or dappled shade.
---

# WASD Light 1.0.0

`res://addons/wasd_light/` (CC0, written by WASD Engine; global classes, no plugin to enable). Six nodes, each a placed piece with a few properties. They stand in for what Web builds do not draw: volumetric fog and FogVolume, wide glow, light projectors. None casts light: each goes with a real light. They show the same on Forward+ and Compatibility, measured side by side, and a hall with halos, two shafts, a fog bank, and dust runs at 60 fps in a Web build.

Set properties before or after `add_child`. Colors are the light's own color; `energy` values below are for dark scenes, and by day a third is plenty.

## WasdHalo3D: the glow round a lamp

A card that faces the camera, hides behind walls, and fades as the camera comes close. The engine's glow makes only a tight halo in Web builds, and none round a light without a bright surface.

```gdscript
var halo := WasdHalo3D.new()
halo.color = $Torch.light_color
halo.size = 1.8          # meters across the whole glow
halo.energy = 1.2        # 1 a lamp at night, 3 dazzles
$Torch.add_child(halo)   # at the flame, the bulb, the headlight
```

`core` (0.18) is the bright middle's share, `streak` (0 to 1) draws a sideways streak as lenses do, `rays` (0.25) makes the glow uneven and alive, `fade_far` hides it beyond a distance.

## WasdShaft3D: a beam of lit air

Points along the node's -Z from its source. The shader works out, per pixel, how much lit air the line of sight passes: the shaft looks right from every side and from within, and things standing in it cut it.

```gdscript
var beam := WasdShaft3D.new()
add_child(beam)
beam.match_light($CeilingSpot)   # a SpotLight3D's place, direction, reach, cone, and color
beam.energy = 0.3                # 0.3 a lamp's beam, 1 a searchlight
```

By hand: `shape` 0 round (lamps) or 1 square (windows, doors), `length`, `opening` (half the width and height at the source), `spread` (how many times wider at the end), `fade_from` (0.25: where along it the fade starts), `dust` (0.35: drifting unevenness). A window's shaft: `shape = 1`, `opening` half the window's size, `spread` 1.2, at the window's middle, turned with `look_at()` toward where the light lands, with a SpotLight3D or the sun for the patch on the floor. The same light over a wide shaft is fainter, so shafts some meters wide want `energy` 1 to 3. Sun through trees: several round shafts with `global_basis = sun.global_basis`. Keep the node's scale at 1.

## WasdFogBank3D: fog that fills a box

Mist in a valley, haze in a hall, smoke in a room, steam on a lake. Things in it fade by how much fog lies before them; the camera may walk through.

```gdscript
var mist := WasdFogBank3D.new()
mist.size = Vector3(40, 3, 40)   # the node is the box's middle
mist.position.y = 1.5
mist.density = 0.1               # per meter at the floor: 0.02 haze, 0.1 mist, 0.4 thick smoke
mist.color = Color(0.4, 0.43, 0.5)
add_child(mist)
```

`thinning` (3: how fast it thins upward; 0 fills the box), `soft_edges` (0.25), `clouds` (0.6: drifting banks), `cloud_size`, `cloud_drift`. It takes no light, so give it the color of the scene's air: by night a dark blue-gray, by day `look.get_horizon_color()` from WASD Look.

## WasdDust3D: motes in the air

Small glowing cards moved by a shader: no particle system, no cost on the processor.

```gdscript
var dust := WasdDust3D.new()
dust.size = Vector3(4, 6, 4)     # the box of air
dust.amount = 400
dust.gather = 1.0                # keep to the box's upright middle: dust in a lamp's beam
add_child(dust)
```

| For | Set |
|---|---|
| Dust in a beam | defaults, `gather = 1`, box round the beam |
| Pollen, fireflies | `mote_size = 0.05`, `energy = 2`, `twinkle = 1`, `wander = 0.8`, a warm or green `color` |
| Embers | `mote_size = 0.04`, `energy = 2.5`, `wind = Vector3(0.1, 0.6, 0)`, orange |
| Snow | `mote_size = 0.08`, `energy = 1`, `wind = Vector3(0.3, -1.2, 0)`, `wander = 0.4`, `twinkle = 0` |

`follow_camera = true` keeps the box round the camera while every mote keeps its place in the world: one node for a whole level's pollen or embers. For rain and snow that the sky, the wind, and the ground follow, use the `wasd-weather` add-on; with it, `dust.add_to_group("wasd_wind")` (a fog bank likewise) lets the weather's wind carry the motes.

## WasdFlicker: a light that lives

```gdscript
var flicker := WasdFlicker.new()
flicker.style = WasdFlicker.Style.TORCH   # CANDLE, TORCH, FIRE, NEON, FAILING, PULSE
$Torch.add_child(flicker)                 # under the Light3D, or set flicker.light
```

It moves the light's energy round the value the light had when the flicker entered the scene, and every `WasdHalo3D` under that light with it. `amount` (0.5) and `speed` (1). Add the halos before the flicker. To change the light's own brightness later, as `wasd-look`'s `set_shadowed_light()` does, call `flicker.set_base_energy(lamp.light_energy)` after it, or the flicker undoes it.

## WasdGobo3D: shade with holes

A card that is never seen and only throws a shadow. It stands in for light projectors.

```gdscript
var leaves := WasdGobo3D.new()
leaves.size = Vector2(40, 40)
leaves.position.y = 8.0          # level, between the sun and the ground: tree shade
add_child(leaves)
```

`kind` LEAVES, BARS, or GRID; `cover` (0.55: how much light it stops); `pattern_size` in meters (3 for leaves, 0.3 for bars); `sway` and `sway_speed` move it as wind moves leaves. Stood upright in a window or before a lamp, with `kind = WasdGobo3D.Kind.BARS` or `GRID` and `sway = 0.0`, it gives blinds or a grating. The light must cast shadows, and the pattern is only as sharp as the light's shadow map.

## Pitfalls

- A shaft or halo without a real light behind it looks pasted on: the floor under a beam needs its pool of light, the wall by a torch its glow.
- Fog banks and shafts read the depth of what is solid: glass, water, and particles inside them are not cut off or veiled correctly. Keep such things out of them or accept it.
- Several large fog banks or shafts that fill the screen each cost a pass over it. One bank for a valley, not ten.
- In a bright scene a glow looks weaker than in a dark one, as a lamp does by day: raise `energy` there.

## Check it

`godot_run`, then `godot_screenshot` from the side of a beam and from inside the fog: beams are brightest at their source and fade out, nothing ends in a hard edge, and lamps glow without white discs. Run once with `web: true`.
