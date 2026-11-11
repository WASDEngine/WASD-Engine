# 卸载 WASD Engine

[English](desktop-uninstall-cleanup.md) | 中文

本指南介绍如何在 macOS 或 Windows 上卸载 WASD Engine 应用。清理本地数据是可选操作。

## 1. 卸载应用

先结束使用应用内置 CLI（命令行界面）的命令。如果曾通过 WASD Engine 安装 `dsh` 命令，请先在应用菜单中选择 **管理 dsh 命令… → 移除**。此操作移除应用的命令注册，不卸载独立安装的 CLI 程序。

退出 WASD Engine，然后按所在平台的方式卸载：

- **macOS：** 在 Finder 的“应用程序”中删除应用。
- **Windows：** 在 Windows 11 的“设置 → 应用 → 已安装的应用”，或“控制面板 → 程序 → 程序和功能”中卸载。

卸载应用既不会取消你的套餐，也不会注销你的 WASD Engine 账号。付费套餐请在 [WASD Engine 网站](https://app.wasdengine.com)上取消，否则会继续续订。

## 2. 清理本地数据

此步骤为可选操作。如果需要清理本地数据，请选择下方对应平台的脚本，在 macOS 的终端或 Windows 的 PowerShell 中粘贴运行。

脚本会永久删除当前用户默认的 WASD Engine 主目录 `~/.wasdengine` 及下方列出的应用数据路径，包括会话、凭据、设置、插件、缓存、游戏工具下载的文件和运行时，以及与 `dsh` 命令共用的状态。如果配置了 `DSH_HOME`，删除前请单独检查该目录；脚本仍会删除默认的 `~/.wasdengine`。隔离的开发和测试数据目录不在此清理范围内。

Windows 卸载程序通常会删除脚本中列出的两个应用数据目录，但保留 WASD Engine 主目录。若卸载时有文件残留或保留了应用数据，脚本也会清理这些目录。

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

脚本不会删除你的游戏项目，也不会删除 WASD Engine 与其他程序共用的内容。不再需要时，请自行删除：

- 游戏项目保留在你创建时选择的位置，默认位于“文稿”（Windows 上为“文档”）文件夹下的 `WASD Engine` 文件夹中。
- 内置的 Godot 使用 Godot 自己的文件夹，你另行安装的 Godot 编辑器也使用这些文件夹：macOS 上为 `~/Library/Application Support/Godot` 和 `~/Library/Caches/Godot`，Windows 上为 `%APPDATA%\Godot` 和 `%LOCALAPPDATA%\Godot`。其中 `app_userdata` 保存你的游戏数据（如存档和日志），其余为 Godot 编辑器的设置和缓存。如果你还单独使用 Godot，只删除 `app_userdata` 中你的游戏文件夹。
- 在 Windows 上，SuperCollider 工具把用户文件夹放在 `%LOCALAPPDATA%\SuperCollider`，你另行安装的 SuperCollider 也使用该文件夹。
- 如果开启过可选的 LiveShare 插件，它会把共享记录和中继凭据保存在 `~/.dsh/liveshare`（Windows 上为 `%USERPROFILE%\.dsh\liveshare`）：WASD Engine 基于 DeepSeek Harness 构建，该插件沿用 DeepSeek Harness 的文件夹。除非某个 DeepSeek Harness 安装仍在使用 LiveShare，否则请删除该文件夹。
- 如果为 Claude Code、Codex 等其他 agent（智能体）设置过 WASD Engine 的游戏工具，它们的配置中仍列有 `wasd-engine` MCP 服务器。对于 Claude Code，运行 `claude mcp remove wasd-engine --scope user` 移除；对于 Codex，删除 `~/.codex/config.toml` 中的 `[mcp_servers.wasd-engine]` 表。

## 3. 验证清理结果

如果运行了清理脚本，请在重新安装前确认脚本中列出的路径已不存在。如果脚本报错，请解决错误后重跑脚本，再次检查所有列出的路径。Windows 脚本会在首次报错时停止，后续路径可能仍未清理。
