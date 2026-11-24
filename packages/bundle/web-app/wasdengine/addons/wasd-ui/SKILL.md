---
name: wasd-ui
description: WASD UI 1.0.0 is installed in this project. The autoload WasdUi puts one of six looks on every control of the game, so that no menu ships in Godot's gray, and gives the pieces of a HUD, such as bars, floating damage numbers, toasts, key prompts, a crosshair, a radar, a hurt flash, and fades, drawn in code and sized to the window. Load before building any menu, HUD, or on-screen message.
---

# WASD UI 1.0.0

`res://addons/wasd_ui/` (CC0, written by WASD Engine). The installation adds the autoload `WasdUi`, and from the first frame every control of the game wears the `clean` look instead of Godot's gray. Everything is drawn in code, with no picture and no font file, and holds 60 fps in a Web build.

## Looks

| Look | What it is | For |
|---|---|---|
| `clean` | dark glass, soft corners, no borders | most games |
| `light` | white cards, gray borders, dark text | casual and puzzle games |
| `fantasy` | dark wood in a bevelled gold frame | role-playing and medieval games |
| `scifi` | thin bright lines on dark blue, corners cut off | space and cyberpunk games |
| `playful` | thick dark outlines, round corners, sticker shadows | cartoon and family games |
| `pixel` | square blocks with hard shadows | pixel-art and retro games |

```gdscript
WasdUi.look = "fantasy"
WasdUi.accent = Color(0.9, 0.3, 0.2)          # the game's own color for the buttons that matter, bars, focus, selection
WasdUi.font = load("res://fonts/game.ttf")    # a typeface of the game's own: the strongest single change
```

The look goes into the engine's default theme, so it reaches every control wherever it stands: under a CanvasLayer, in a popup, in another add-on's menus. A Theme of the game's own, on a control or in the project settings, still comes first, so give `maaacks-menus-template`'s screens, which take this look, no `gui/theme/custom`; for a single change use `add_theme_color_override()` and its kin on the control.

Build menus from containers (a `PanelContainer` with a `VBoxContainer` in it): the look gives them their margins and spacing. Name the parts:

- `button.theme_type_variation = "AccentButton"`: the one button a screen is about, filled in the accent. One a screen.
- Labels: `"HeaderLarge"`, `"HeaderMedium"`, `"HeaderSmall"`, `"MutedLabel"` for hints, and `"HudLabel"`, white with a dark outline, for text that stands over the game itself.

Sizes follow the window: where the project stretches its window the scale is 1, and otherwise the window's height over 720, in steps of 0.05. `WasdUi.scale_by` sets it by hand.

## A menu over the game

```gdscript
@onready var pause_menu: Control = $PauseMenu    # a menu of the scene, hidden until it opens

WasdUi.open(pause_menu)          # shows it centered over a dimmed game and HUD; its first button that shows takes the focus
WasdUi.close(pause_menu, true)   # puts it back in its place in the scene, hidden again, for the next time
```

`WasdUi.close(menu)` frees the menu instead, as suits one made in code. While a menu is open it stands under WasdUi, so keep it in a variable: `$PauseMenu`, and the `%` names the scene gives its parts, reach it again once `close(menu, true)` has put it back. A menu still open when the scene it opened in leaves the tree, as on `change_scene_to_file()` or `WasdLoader.change_scene()`, closes with its dim: one that had a parent goes back to it, and one made in code is freed, so a menu that must outlive its scene belongs, hidden, under an autoload. A "Quit to title" button sets `get_tree().paused = false` and changes the scene, with no `close()` first.

While menus are open, a mouse pointer that the game hid or captured shows. `close()` gives the focus back to what had it, and closing the last menu gives the pointer back as it was, except after a change of scene, whose new scene sets its own mouse mode, and in a browser, where a captured pointer stays shown until the game captures it again on a click. Pausing stays the game's: set `get_tree().paused = true` and the menu's `process_mode` to `PROCESS_MODE_ALWAYS`. WasdUi itself runs while the game is paused.

## HUD

```gdscript
var health := WasdUi.bar("HP", Color(0.86, 0.2, 0.22))     # top left; bars in one corner stack
health.max_value = 120.0
health.value = 120.0     # after max_value: value stays between 0 and max_value
health.value -= 25.0     # glides there, shows for a moment what was lost, flashes
health.emptied.connect(_on_player_died)
```

`WasdBar` options: `numbers` ("95 / 120" on the bar), `pieces` (cut into as many, for hearts or ammunition), `low_at` (pulses below that share, 0.25), `length` and `height`. A third argument puts it in another corner, such as `CORNER_BOTTOM_LEFT`. It is a Control: a boss's bar is a `WasdBar.new()` with `length = 600` in a container of the game's own.

| Call | What shows |
|---|---|
| `WasdUi.place(control, CORNER_TOP_RIGHT)` | any control in a corner's stack; a plain Label becomes a `HudLabel` |
| `WasdUi.toast("Checkpoint reached")` | a line at the top that leaves by itself; `{"seconds": 4.0}` |
| `WasdUi.pop("-25", enemy.global_position, Color.YELLOW)` | a number that rises from a place in the 3D or 2D world (or from a node) and fades; `{"size": 1.5}` for a critical hit |
| `WasdUi.prompt("E", "Open")` | a key cap and a word at the bottom; `WasdUi.prompt()` takes it away. The key may be a texture: with `controller-icons`, one that follows the player's device |
| `WasdUi.hurt(0.6)` | a red flash at the screen's edges; a second argument gives another color |
| `await WasdUi.fade(Color.BLACK, 0.4).finished` | the screen covered in a color; `WasdUi.clear(0.4)` uncovers it |

Two more nodes, added like any Control:

```gdscript
var crosshair := WasdCrosshair.new()     # shape: WasdCrosshair.Shape.DOT, CROSS, RING, CROSS_AND_DOT
$Hud.add_child(crosshair)
crosshair.spread = 6.0                   # opens while moving or firing
crosshair.hit()                          # a hit mark; hit(true) for a kill

var radar := WasdRadar.new()
radar.center = player                    # a Node3D or Node2D, such as a WasdCharacter3D
radar.reach = 40.0                       # meters to the rim
WasdUi.place(radar, CORNER_TOP_RIGHT)
radar.track(enemy)                       # a dot, gone when the node is freed
radar.track(goal, Color(1.0, 0.85, 0.3), true)
```

The radar turns so that what lies ahead is at its top: ahead of a WasdCharacter3D's camera, or else where the center faces. Its arrow points where the center faces, for a WasdCharacter3D where its model faces; `radar.turns = false` keeps north at the top.

`WasdUi.values()` gives the look's colors and numbers (`panel`, `text`, `muted`, `accent`, `radius`, `edge`) for widgets of the game's own, and the signal `look_changed` tells when to draw them again.

## Pitfalls

- Text over the game in a look's panel color is unreadable half the time: use `"HudLabel"` or `WasdUi.place()`.
- Set `look` once. Building a look takes some 40 ms in a browser, so do not animate it.
- Looks are built when the game runs: the editor still shows Godot's gray.
- With `wasd-loading`, give its screen the same accent: `WasdLoader.accent = WasdUi.values()["accent"]`.
- The HUD draws above the game's own CanvasLayers below layer 100; a full-screen menu of the game's own belongs in `WasdUi.open()` or on a higher layer.

## Check it

`godot_run`, then `godot_screenshot` of every menu and of the HUD in play: no clipped text, one accent button a screen, HUD text readable over the brightest and the darkest part of the level. Press `ui_down` and `ui_accept` with `godot_input`: the focus ring moves and buttons answer.
