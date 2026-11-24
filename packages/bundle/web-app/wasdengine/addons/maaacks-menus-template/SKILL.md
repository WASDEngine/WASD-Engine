---
name: maaacks-menus-template
description: Maaack's Menus Template 1.7.2 is installed in this project. It has a main menu, options menus for audio, video, and input rebinding whose values are saved and applied at start, a pause menu, credits screens, and an opening screen for logos, all as scenes to instance and restyle, and they run in Web builds. Load before adding a main menu, settings, a pause menu, or credits to a game.
---

# Maaack's Menus Template 1.7.2

`res://addons/maaacks_menus_template/` (MIT; the opening screen's Godot Engine logo is CC BY 4.0). `base/` holds the building blocks and `examples/scenes/` the ready screens, which is where to start. The installation added the autoload `MenusStartUp`, which applies the player's saved settings when the game starts, and left out the add-on's editor wizard, which copies and wires the screens in the Godot editor: wire them as below. The add-on takes the global class names `AppSettings`, `ConfirmationPopupWindowPanel`, `FileLister`, `InputActionsList`, `InputActionsTree`, `InputEventHelper`, `InputIconMapper`, `ListOptionControl`, `MaaacksMenusTemplate`, `MainMenu`, `OptionControl`, `PlayerConfig`, `PopupWindowPanel`, `PopupWindowSceneContainer`, `Vector2ListOptionControl`, and `WindowPanel`: give the game's own classes other names, such as `TitleMenu` for its main menu's script.

All paths below are inside the add-on's folder.

## Wire the game

1. Say where the screens lead, once, in `project.godot`:

```
[maaacks_menus_template]

main_menu_scene_path="res://menus/main_menu.tscn"
game_scene_path="res://levels/level_1.tscn"
ending_scene_path="res://menus/end_credits.tscn"
```

2. Make the game's main menu as a scene that inherits the example and changes what differs, and set it as `run/main_scene`:

```
[gd_scene load_steps=3 format=3]

[ext_resource type="PackedScene" path="res://addons/maaacks_menus_template/examples/scenes/menus/main_menu/main_menu.tscn" id="1"]
[ext_resource type="Texture2D" path="res://menus/title_background.png" id="2"]

[node name="MainMenu" instance=ExtResource("1")]

[node name="BackgroundTextureRect" parent="."]
texture = ExtResource("2")

[node name="SubTitleLabel" parent="MenuContainer/SubTitleMargin/SubTitleContainer"]
text = "A game about lighthouses"
```

The title is the project's name (`application/config/name`), the corner label its `application/config/version`. New Game loads `game_scene_path`; Options and Credits open `examples/scenes/windows/main_menu_options_window.tscn` and `main_menu_credits_window.tscn`; Exit is hidden in Web builds. `BackgroundMusicPlayer` plays its `stream` on the `Music` bus.

3. Pause: in the game's scene, a plain `Node` with the script `base/nodes/utilities/pause_menu_controller.gd` and `pause_menu_packed` set to `examples/scenes/windows/pause_menu.tscn`. `ui_cancel` (Escape, and a pad's Start after step 6) opens the menu and pauses the tree; closing it resumes. The menu offers close, Restart, Options, Main Menu, and Exit. Nodes that must keep running while paused need `process_mode = PROCESS_MODE_ALWAYS`.

4. Credits: `examples/scenes/credits/credits_label.tscn` is the text all credits screens show, a `RichTextLabel` with BBCode. WASD Engine replaced the add-on's placeholder text with a short neutral one that credits Godot, the template, and the Godot Engine logo; write the game's credits into the `text` of that file, the one file of the add-on's folder that is the game's to change, or point its `attribution_file_path` at a Markdown file and set `auto_update = true`, with the licenses and credits of every asset and add-on the game uses (`THIRD_PARTY_NOTICES.md` lists them). Keep the logo's four lines while the opening screen shows that logo: its CC BY 4.0 license asks for them. `examples/scenes/end_credits/end_credits.tscn` scrolls them after the ending and then returns to the main menu; change to it with `get_tree().change_scene_to_file()` when the game is won, or with `WasdLoader.change_scene()` in a game that has `wasd-loading`.

5. Opening: `examples/scenes/opening/opening.tscn` fades through its `images` (the Godot logo by default; put the game's or studio's logo there) and then loads the main menu. Make it `run/main_scene` to use it.

6. Gamepads: Godot's `ui_accept`, `ui_cancel`, `ui_page_up`, and `ui_page_down` hold keys only, so a pad moves the focus but cannot press a button or pause, and its shoulder buttons do not turn the options tabs. When the game supports pads, write these four under `[input]` in `project.godot`, with Godot's keys and the pad's A, Start, and shoulder buttons; where `[input]` already has one of them, add the `InputEventJoypadButton` to its `events` instead:

```
[input]

ui_accept={
"deadzone": 0.5,
"events": [Object(InputEventKey,"device":-1,"keycode":4194309), Object(InputEventKey,"device":-1,"keycode":4194310), Object(InputEventKey,"device":-1,"keycode":32), Object(InputEventJoypadButton,"device":-1,"button_index":0)]
}
ui_cancel={
"deadzone": 0.5,
"events": [Object(InputEventKey,"device":-1,"keycode":4194305), Object(InputEventJoypadButton,"device":-1,"button_index":6)]
}
ui_page_up={
"deadzone": 0.5,
"events": [Object(InputEventKey,"device":-1,"keycode":4194323), Object(InputEventJoypadButton,"device":-1,"button_index":9)]
}
ui_page_down={
"deadzone": 0.5,
"events": [Object(InputEventKey,"device":-1,"keycode":4194324), Object(InputEventJoypadButton,"device":-1,"button_index":10)]
}
```

## Options

- The options window has tabs: Input (rebinding of every action the game defines under `[input]` in `project.godot`, keyboard and gamepad), Audio (one slider per audio bus and a mute switch), Video (fullscreen, resolution, V-Sync). `examples/scenes/menus/options_menu/mini_options_menu.tscn` is a single small panel with fullscreen, resolution, volume, and mouse and gamepad sensitivity.
- Give the game `Music` and `SFX` audio buses (a `default_bus_layout.tres` at the project root) and route players to them: each bus gets its own slider.
- Name input actions readably (`move_left`, `jump`): the Input tab lists them by name.
- Values are saved in `user://player_config.cfg` and applied at start by `MenusStartUp`. From code: `PlayerConfig.get_config(section, key, default)` and `PlayerConfig.set_config(section, key, value)` with the sections `AppSettings.AUDIO_SECTION`, `VIDEO_SECTION`, `INPUT_SECTION`, `GAME_SECTION`, and `CUSTOM_SECTION`; store the game's own settings, such as difficulty or mouse sensitivity, under `GAME_SECTION`.
- A new option is an instance of `base/nodes/menus/options_menu/option_control/slider_option_control.tscn`, `toggle_option_control.tscn`, or `list_option_control.tscn` with its `option_name` and `option_section` set (or `key` and `section` directly), inside a copy of an options menu; it saves itself and emits `setting_changed(value)`.

## Make it the game's own

The screens use Godot's default gray theme until the game gives them one: set a `Theme` resource with the game's font, colors, and button styles as `gui/theme/custom` in `project.godot`, and it restyles every screen at once. With `wasd-ui`, set its `WasdUi.look` instead and no `gui/theme/custom`, which would override that look. Add a background picture or the game's first level behind the main menu, and music. Do this before judging the menus by a screenshot.

To change a screen's layout or behavior, inherit it as above or copy its `.tscn` and `.gd` into the game's folders; keep the add-on's folder as installed.

## Pitfalls

- A screen that changes the scene frees the scene it is in: keep what must survive in an autoload.
- The game scene captures the mouse itself if it needs to (and in Web builds only after a click); the pause menu shows the cursor while it is open.

## Check it

`godot_run` the main menu and `godot_screenshot`: title, buttons, and background in the game's style. Click New Game with `godot_input`, press `ui_cancel`, and take another: the pause menu over the paused game. Open Options, move the master slider, restart the game, and the slider keeps its value.
