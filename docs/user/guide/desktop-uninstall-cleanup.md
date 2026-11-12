# Uninstall WASD Engine

English | [中文](desktop-uninstall-cleanup.zh.md)

Use this guide to uninstall the WASD Engine app on macOS or Windows. Local data cleanup is optional.

## 1. Uninstall the app

Finish any commands using the app's bundled CLI. If you installed the `dsh` command through WASD Engine, first select **Manage dsh Command… → Remove** in the application menu. This removes the app's command registration without uninstalling independent CLI programs.

Quit WASD Engine, then uninstall it using your platform's procedure:

- **macOS:** Delete the app from Applications in Finder.
- **Windows:** Uninstall it through Settings → Apps → Installed apps on Windows 11, or Control Panel → Programs → Programs and Features.

Uninstalling the app neither cancels your plan nor closes your WASD Engine account. Cancel a paid plan on the [WASD Engine website](https://app.wasdengine.com); otherwise it keeps renewing.

## 2. Clean up local data

This step is optional. If you want to clean up local data, select the script for your platform below, then paste and run it in Terminal on macOS or PowerShell on Windows.

The scripts permanently delete the current user's default WASD Engine home, `~/.wasdengine`, and the app data paths listed below, including sessions, credentials, settings, plugins, caches, the game tools' downloads and runtimes, and state shared with the `dsh` command. If you configured `DSH_HOME`, inspect that directory separately before deleting it; the scripts still delete the default `~/.wasdengine`. Isolated development and test data directories are outside this cleanup scope.

On Windows, the uninstaller normally removes the two application-data directories listed in the script but retains the WASD Engine home. The script also handles those directories if uninstallation left files behind or retained app data.

::: code-group

```sh [macOS]
sh -c '
rm -rf -- \
  "$HOME/.wasdengine" \
  "$HOME/Library/Application Support/WASD Engine" \
  "$HOME/Library/Logs/WASD Engine" \
  "$HOME/Library/Preferences/com.wasdengine.desktop.plist" \
  "$HOME/Library/Preferences/ByHost"/com.wasdengine.desktop.ShipIt.*.plist \
  "$HOME/Library/Caches/com.wasdengine.desktop" \
  "$HOME/Library/Caches/com.wasdengine.desktop.ShipIt" \
  "$HOME/Library/HTTPStorages/com.wasdengine.desktop" \
  "$HOME/Library/Caches/wasdengine-desktop-updater" \
  "$(getconf DARWIN_USER_CACHE_DIR)/com.wasdengine.desktop" \
  "$(getconf DARWIN_USER_CACHE_DIR)/com.wasdengine.desktop.helper"
'
```

```powershell [Windows]
$ErrorActionPreference = 'Stop'
@(
    (Join-Path $env:USERPROFILE '.wasdengine'),
    (Join-Path $env:APPDATA 'WASD Engine'),
    (Join-Path $env:LOCALAPPDATA 'wasdengine-desktop-updater')
) | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
        Remove-Item -LiteralPath $_ -Recurse -Force
    }
}
```

:::

The scripts leave your game projects and what WASD Engine shares with other programs. Remove these yourself when you no longer need them:

- Game projects stay where you created them, by default in the `WASD Engine` folder of your Documents folder.
- The built-in Godot uses Godot's own folders, which a Godot editor that you install also uses: `~/Library/Application Support/Godot` and `~/Library/Caches/Godot` on macOS, and `%APPDATA%\Godot` and `%LOCALAPPDATA%\Godot` on Windows. They hold your games' data, such as saves and logs, in `app_userdata`, and Godot's editor settings and caches. If you also use Godot on its own, delete only your games' folders in `app_userdata`.
- On Windows, the SuperCollider tools keep their user folders in `%LOCALAPPDATA%\SuperCollider`, which an installed SuperCollider also uses.
- If you turned on the optional LiveShare plugin, it keeps its share records and relay credential outside the WASD Engine home, in `~/.dsh/liveshare` (`%USERPROFILE%\.dsh\liveshare` on Windows). Other apps that keep their data in `~/.dsh` can use that folder too, so delete it only when none of them uses LiveShare.
- If you set up another agent, such as Claude Code or Codex, with WASD Engine's game tools, its configuration still lists the `wasd-engine` MCP server. Remove it with `claude mcp remove wasd-engine --scope user` for Claude Code, or delete the `[mcp_servers.wasd-engine]` table from `~/.codex/config.toml` for Codex.

## 3. Verify cleanup

If you ran a cleanup script, confirm before reinstalling that the paths listed in it no longer exist. If the script reports an error, resolve it, rerun the script, and check all listed paths again. The Windows script stops at the first error, so later paths may remain.
