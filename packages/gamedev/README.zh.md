---
description: "游戏开发包组：通过 MCP 为智能体提供无界面的 Blender、GIMP 与 SuperCollider，通过 LibGodot 运行、测试和游玩 Godot 游戏，查找 Poly Haven 的 CC0 素材并下载到项目中，用 ElevenLabs 制作角色配音、音效和音乐，把精选的 Godot 与 Blender 扩展安装到项目中并提供只有该项目会话可见的使用指南，在设置与「插件」页面的「游戏工具」标签页中列出它们，在「素材」标签页中显示项目的美术素材，并通过 MCP 服务器把它们提供给这台电脑上的其他智能体。"
kind: "package-group"
---

# 游戏开发工具

[English](README.md) | 中文

## 概述

`gamedev/` 组为智能体提供制作游戏所需的应用程序，且无需窗口。Blender、GIMP 与 SuperCollider 在 MCP 服务器之后以无界面方式运行。Godot 通过 LibGodot 运行并测试会话中的游戏，并把游戏画面推送到 Game 标签页供用户游玩。Poly Haven 提供 CC0 素材，ElevenLabs 制作语音、音效和音乐，游戏扩展安装经过测试的 Godot 与 Blender 扩展。「游戏工具」标签页列出这七个工具，「素材」标签页显示项目的美术素材，一个 MCP 服务器把这些工具提供给其他智能体。[游戏工具子系统页面](../../docs/subsystems/gamedev.zh.md)说明各部分如何连接。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

共享的 MCP 运行时为每个应用程序启动并监管一个无界面工作进程；Blender、GIMP 与 SuperCollider 包在其上构建各自的工具，Godot 包负责游戏运行、相应工具与 Game 标签页。Poly Haven 包搜索 Poly Haven 资源库并下载其素材，ElevenLabs 包通过 WASD Engine API 制作语音、音效和音乐，游戏扩展包把目录中的扩展安装到游戏项目中，并把其指南列为这些项目会话的技能。游戏工具标签页包在设置与「插件」页面中展示这七个工具，素材标签页包在 Game 标签页旁显示项目的 2D 与 3D 美术素材，游戏 MCP 包把它们的工具提供给已登录用户的其他智能体，其浏览器部分在桌面引导的最后与设置中提供设置内容。始终开启的 WASD Engine 插件把 Godot 游戏导出为网页版，并带着分享链接发布到 WASD Engine 网站。

| 包 | 提供的能力 |
|---|---|
| [`app-mcp/`](app-mcp/README.zh.md) | 在 MCP stdio 服务器之后以无界面方式运行应用程序：把工作脚本复制出包外，监管一个 JSON 行协议的工作进程，并向 MCP 管理器注册该服务器；还提供 Blender、GIMP 与 SuperCollider 服务器共用的 Config 字段、应用程序查找与工具辅助函数 |
| [`blender/`](blender/README.zh.md) | 通过 MCP 提供的 Blender 工具，由 `bpy` 模块或以后台模式运行的已安装 Blender 支撑；Desktop 应用为 Apple 芯片 macOS 与 Windows x64 随附 `bpy` |
| [`elevenlabs/`](elevenlabs/README.zh.md) | ElevenLabs 工具：为角色查找声音，或在取得同意后克隆用户自己的声音，并把 Eleven v4 Turbo 制作的语音、SFX v3 制作的音效和 Music v2.5 制作的音乐保存到游戏项目中；音频由 WASD Engine API 制作，费用计入已登录账号的套餐 |
| [`game-mcp/`](game-mcp/README.zh.md) | 供这台电脑上其他智能体使用的 WASD Engine MCP 服务器：通过带令牌的回环 Streamable HTTP 提供游戏工具及其搜索、已连接智能体的游戏所在的会话，以及设置提示词 |
| [`gimp/`](gimp/README.zh.md) | 通过 MCP 提供的 GIMP 3 工具，由 `gimp-console` 支撑 |
| [`godot/`](godot/README.zh.md) | 通过 LibGodot 运行 Godot 游戏：`godot_*` 工具、`godot` Remote、画面路由与 Game 标签页 |
| [`game-addons/`](game-addons/README.zh.md) | 游戏扩展：精选并固定到已测试版本的 Godot 与 Blender 扩展目录、列出该目录的系统提示词部分、搜索目录并在智能体判断游戏需要时把扩展安装到游戏项目中或从中移除的 `game_addons` 工具、只有该项目的会话能以技能形式看到的使用指南，以及会话标题栏中的“扩展”对话框 |
| [`polyhaven/`](polyhaven/README.zh.md) | Poly Haven 工具：搜索 Poly Haven 中 CC0 的 HDRI、纹理和 3D 模型资源库，显示素材的文件与预览图，并把一种格式和分辨率下载到游戏项目中，每个文件的摘要都经过校验 |
| [`supercollider/`](supercollider/README.zh.md) | 通过 MCP 提供的 SuperCollider 工具：用 scsynth 离线渲染由 sclang 代码描述的声音与音乐，并为智能体提供电平、响度以及波形与声谱图图像；Desktop 应用自带不含 GUI 的 SuperCollider |
| [`ui-game-assets/`](ui-game-assets/README.zh.md) | 右侧栏的「素材」标签页：在按项目文件夹归类、带搜索与「全部 / 2D / 3D」筛选的下拉列表中列出游戏项目的图片与模型，提供可缩放的图片视图、带动画的 three.js 模型视图，并通过导出的模型显示 Blender 文件 |
| [`ui-game-mcp/`](ui-game-mcp/README.zh.md) | MCP 服务器的浏览器部分：登录后的「使用其他智能体设置」，作为桌面引导的最后一步与设置中的「其他智能体」分区，包含智能体标志、设置提示词与是否已有智能体连接，以及窗口打开已连接智能体启动游戏所在的会话 |
| [`ui-game-tools/`](ui-game-tools/README.zh.md) | 「设置 › 内置插件」与「插件」页面上的「游戏工具」标签页：列出 Blender、ElevenLabs、游戏扩展、GIMP、Godot、Poly Haven 与 SuperCollider 及其标志与 Loader 状态，并在「插件」页面为每个工具提供开关，在 profile patch 中关闭或开启其所在行 |
| [`wasd-plugins/`](wasd-plugins/README.zh.md) | WASD Engine 插件，即 WASD Engine 自带且始终开启的功能：每个会话和 MCP 服务器都提供的 Web 导出与发布工具，它们把 Godot 游戏作为带分享链接的编号版本发布到 WASD Engine 网站；桌面应用中智能体的 `browser_*` 工具，在右侧边栏的浏览器中搜索和浏览；会话标题栏与新会话页面上的“发布”按钮；以及侧边栏中的“探索游戏” |

-----

<a id="related-documentation"></a>
## 相关文档

- [游戏工具子系统参考](../../docs/subsystems/gamedev.zh.md)：进程模型、工作进程协议、SuperCollider 桥接进程、LibGodot 运行时、Game 标签页、「游戏工具」标签页，以及供其他智能体使用的 MCP 服务器。
- [MCP 包组](../mcp/README.zh.md)：运行 Blender 与 GIMP 服务器的管理器。
- [右侧边栏](../client/ui-sidebar-right/README.zh.md)：承载 Game 标签页的停靠界面。
- [「插件」页面](../client/ui-plugin-manager/README.zh.md)与[「内置插件」设置](../client/ui-settings-plugins/README.zh.md)：承载「游戏工具」标签页的两个页面。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
