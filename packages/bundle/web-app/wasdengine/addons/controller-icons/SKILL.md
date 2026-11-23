---
name: controller-icons
description: Controller Icons 3.1.8 is installed in this project. Its autoload ControllerIcons and the texture ControllerIconTexture give the picture of the key, mouse button, or gamepad button of any input action, and the picture switches by itself between keyboard and Xbox, PlayStation, Switch, or Steam Deck art when the player changes device. Load before showing button prompts, tutorial hints, or a controls screen.
---

# Controller Icons 3.1.8

`res://addons/controller_icons/` (MIT, by Ricardo Subtil; the button art is Xelu's CC0 prompts; the editor panels are left out, and one function is changed so that a Web build prints no error). The installation adds the autoload `ControllerIcons`, which watches the player's input: a key or a mouse move switches every picture to the keyboard's, a gamepad button or stick to that pad's art, chosen by the pad's name. It adds 2.3 MB of pictures to the game.

## A picture for an action

`ControllerIconTexture` is a `Texture2D` that redraws itself when the device changes. Give it to anything that takes a texture:

```gdscript
var icon := ControllerIconTexture.new()
icon.path = "jump"                       # an input action of the project
$Hint/Icon.texture = icon                # a TextureRect, a Sprite2D, a Sprite3D, a Button's icon
```

`path` is one of three kinds:

| Path | Shows |
|---|---|
| an input action, such as `"jump"` or `"interact"` | the action's key or mouse button while the keyboard is in use, its gamepad button on a pad. Rebinding the action at runtime changes the picture: call `ControllerIcons.refresh()` after it |
| `"joypad/a"`, `"joypad/lt"`, `"joypad/l_stick"`, `"joypad/dpad_up"`, `"joypad/start"` | that button in the connected pad's art, named as on an Xbox pad: `joypad/a` is the Cross on a PlayStation pad and B on a Switch |
| `"key/e"`, `"key/space"`, `"key/shift"`, `"mouse/left"`, `"xboxseries/a"`, `"ps5/cross"` | always that picture: a file under `assets/` without its extension |

The action must have both a key or mouse event and a gamepad event for both kinds of players to see a picture; an action with no gamepad event shows nothing on a pad. Godot's own `ui_accept` holds keys only, so give a menu's hints an action of the game's own.

A picture is 100 by 100 pixels. Size it through its node: on a `TextureRect` set `expand_mode = TextureRect.EXPAND_IGNORE_SIZE` and a `custom_minimum_size`.

- `icon.show_mode`: `ControllerIconTexture.ShowMode.KEYBOARD_MOUSE` or `CONTROLLER` draws it only for that kind of device, for a hint that concerns one of them.
- `icon.force_type`: `ControllerIconTexture.ForceType.KEYBOARD_MOUSE` or `CONTROLLER` always draws that device's picture: a controls screen with two columns.
- `icon.force_controller_icon_style = ControllerSettings.Devices.PS5`: always that pad's art.

## Nodes and code

`ControllerTextureRect`, `ControllerButton`, `ControllerSprite2D`, and `ControllerSprite3D` are the plain nodes with a `path` property, for a scene file.

```gdscript
var texture: Texture2D = ControllerIcons.parse_path("interact")     # the picture now; it does not follow the device
ControllerIcons.input_type_changed.connect(_on_device_changed)       # (input_type, controller): 0 is keyboard and mouse, 1 a gamepad
var on_pad: bool = ControllerIcons.get_last_input_type() == ControllerIcons.InputType.CONTROLLER
```

In text, a `RichTextLabel` takes the texture: `label.add_image(icon, 28, 28)` between `append_text()` calls gives "Press [picture] to jump".

With `wasd-ui`, the prompt takes the texture in place of a letter: `WasdUi.prompt(icon, "Open")`.

## Pitfalls

- The pictures follow the last device used, also for a player who rests a hand on the mouse: set `allow_mouse_remap = false` in `res://addons/controller_icons/settings.tres` when mouse movement should not switch a gamepad player's hints back.
- A pad that the add-on does not know by name gets Xbox 360 art (`joypad_fallback` in the same file).
- In a browser a gamepad is seen only after the player presses a button on it, so a Web build starts with keyboard pictures.
- Use action paths, not `key/…`, for anything the player can rebind.

## Check it

`godot_run`, then `godot_screenshot` of a screen with prompts. Send a gamepad button with `godot_input` and take another: the action pictures have changed, the fixed ones have not.
