---
description: "游戏开发包组：通过 MCP 为智能体提供无界面的 Blender、GIMP 与 SuperCollider，通过 LibGodot 运行、测试和游玩 Godot 游戏，查找 Poly Haven 的 CC0 素材并下载到项目中，用 ElevenLabs 制作角色配音、音效和音乐，用 Google 的 Nano Banana 2.1 制作游戏美术、界面元素和贴图，在网上为智能体要制作的美术查找参考图像，把精选的 Godot 与 Blender 扩展安装到项目中并提供只有该项目会话可见的使用指南，在设置与「插件」页面的「游戏工具」标签页中列出它们，在「素材」标签页中显示项目的美术素材，通过「音频」标签页和音频工具让用户试听项目的声音、让智能体测量它们，通过 MCP 服务器把它们提供给这台电脑上的其他智能体，通过待办续行让智能体按待办列表把工作做完，并通过新游戏指引在用户为新游戏发出的第一条提示之后加入指引。"
kind: "package-group"
---

# 游戏开发工具

[English](README.md) | 中文

## 概述

`gamedev/` 组为智能体提供制作游戏所需的应用程序，且无需窗口。Blender、GIMP 与 SuperCollider 在 MCP 服务器之后以无界面方式运行。Godot 通过 LibGodot 运行并测试会话中的游戏，并把游戏画面推送到 Game 标签页。Poly Haven 提供 CC0 素材，ElevenLabs 制作音频，Nano Banana 制作图像，美术参考为美术提供网上的参考；游戏扩展安装经过测试的 Godot 与 Blender 扩展。「游戏工具」标签页列出这八个工具，「素材」与「音频」标签页显示美术素材和声音，一个 MCP 服务器把这些工具提供给其他智能体。[游戏工具子系统页面](../../docs/subsystems/gamedev.zh.md)说明各部分如何连接。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

共享的 MCP 运行时为每个应用程序启动并监管一个无界面工作进程；Blender、GIMP 与 SuperCollider 包在其上构建各自的工具，Godot 包负责游戏运行、相应工具与 Game 标签页。Poly Haven 包搜索 Poly Haven 资源库并下载其素材，ElevenLabs 包通过 WASD Engine API 制作语音、音效和音乐，图像生成包同样通过它用 Nano Banana 制作图像，美术参考包在网上为智能体要制作的美术查找参考图像并把选中的保存到项目中，游戏扩展包把目录中的扩展安装到游戏项目中，把其指南列为这些项目会话的技能，并让用户在其“扩展”对话框中关闭的扩展远离智能体。游戏工具标签页包在设置与「插件」页面中展示这八个工具，素材标签页包在 Game 标签页旁显示项目的 2D 与 3D 美术素材，音频标签页包在其旁播放项目的声音，游戏音频包让智能体通过音频标签页的浏览器部分列出并测量这些声音，游戏 MCP 包把它们的工具提供给已登录用户的其他智能体，其浏览器部分在桌面引导的最后与设置中提供设置内容。始终开启的 WASD Engine 插件把 Godot 游戏导出为网页版，并带着分享链接发布到 WASD Engine 网站。智能体反馈包让智能体向 WASD Engine 团队发送关于 WASD Engine 的反馈，并报告它们调用每个游戏工具和所添加 MCP 服务器的频率。待办续行包在 `gamedev` 预设的智能体于当前轮次写下的待办列表仍有未完成项时，让它继续工作；新游戏指引包则在用户为新游戏发出的第一条提示之后，把该预设的指引交给这个智能体。

| 包 | 提供的能力 |
|---|---|
| [`agent-feedback/`](agent-feedback/README.zh.md) | 智能体反馈：每个会话和 MCP 服务器都提供 `feedback_send` 工具，向 WASD Engine 团队发送关于 WASD Engine 的反馈；用量报告统计智能体调用每个游戏工具和用户添加的每个 MCP 服务器的频率；两者都以已登录账号的身份发送到 WASD Engine 网站 |
| [`app-mcp/`](app-mcp/README.zh.md) | 在 MCP stdio 服务器之后以无界面方式运行应用程序：把工作脚本复制出包外，监管一个 JSON 行协议的工作进程，并向 MCP 管理器注册该服务器；还提供 Blender、GIMP 与 SuperCollider 服务器共用的 Config 字段、应用程序查找与工具辅助函数 |
| [`art-references/`](art-references/README.zh.md) | 面向智能体与已连接智能体的参考工具：`reference_search` 在网上为智能体即将制作的美术查找参考图像、动画和视频封面，并在一张联系表上编号；`reference_save` 把选中的参考连同来源保存到游戏项目的 `references/` 文件夹，Godot 不会把它纳入游戏；一个系统提示词段落让智能体在制作美术前收集参考，并在参考不一致时询问用户想要哪个方向 |
| [`graphics-review/`](graphics-review/README.zh.md) | 面向智能体与已连接智能体的画面审查：`graphics_review` 把游戏画面的图片（例如 `godot_screenshot` 保存的截图）发给审查者，由它像游戏美术总监和技术美术那样点评，给出让画面更好看的改进意见以及可以考虑使用的 WASD Engine 工具和扩展，从不打分；审查者是 WASD Engine 账号的模型路由，由账号付费；一个系统提示词段落要求对 agent 自己制作的每项画面审查一到三次，不审查下载的素材 |
| [`blender/`](blender/README.zh.md) | 通过 MCP 提供的 Blender 工具，由 `bpy` 模块或以后台模式运行的已安装 Blender 支撑；Desktop 应用为 Apple 芯片 macOS 与 Windows x64 随附 `bpy` |
| [`elevenlabs/`](elevenlabs/README.zh.md) | ElevenLabs 工具：为角色查找声音，或在取得同意后克隆用户自己的声音，并把 Eleven v4 Turbo 制作的语音、SFX v3 制作的音效和 Music v2.5 制作的音乐保存到游戏项目中；音频由 WASD Engine API 制作，费用计入已登录账号的套餐 |
| [`game-assets/`](game-assets/README.zh.md) | 面向智能体与已连接智能体的素材工具：`asset_search` 列出游戏项目中的图片与模型，`asset_view` 让 WASD Engine 窗口像「素材」标签页那样绘制其中一个（可从任意方向，含骨架、动画片段与 2D 动画），并给出修改它所需的详细信息 |
| [`game-audio/`](game-audio/README.zh.md) | 面向智能体与已连接智能体的音频工具：`audio_search` 列出项目的音效、对白和音乐及其类型、格式和时长，`audio_review` 按「音频」标签页播放的方式测量一个声音，给出响度、峰值、静音、循环衔接、立体声、Godot 导入设置，并可按需给出波形与频谱图；另提供「音频」标签页与 SuperCollider 共用的浏览器安全格式、文件头探测、测量和图像 |
| [`game-mcp/`](game-mcp/README.zh.md) | 供这台电脑上其他智能体使用的 WASD Engine MCP 服务器：通过带令牌的回环 Streamable HTTP 提供游戏工具及其搜索、已连接智能体的游戏所在的会话，以及设置提示词 |
| [`gimp/`](gimp/README.zh.md) | 通过 MCP 提供的 GIMP 3 工具，由 `gimp-console` 支撑 |
| [`godot/`](godot/README.zh.md) | 通过 LibGodot 运行 Godot 游戏：`godot_*` 工具、`godot` Remote、画面路由与 Game 标签页 |
| [`godot-protocol/`](godot-protocol/README.zh.md) | Godot 插件的 Host 请 WASD Engine 窗口把录制编码为视频的 `godot/record` 请求及窗口的答复，与 Remote 事件列表共用 |
| [`game-addons/`](game-addons/README.zh.md) | 游戏扩展：精选并固定到已测试版本的 Godot 与 Blender 扩展目录、列出该目录的系统提示词部分、搜索目录并在智能体判断游戏需要时把扩展安装到游戏项目中或从中移除的 `game_addons` 工具、只有该项目的会话能以技能形式看到的使用指南，以及会话标题栏中的“扩展”对话框 |
| [`image-generation/`](image-generation/README.zh.md) | 图像生成工具：用 Google 的 Nano Banana 2.1 根据提示词和最多 14 张用于编辑或参照的图像制作游戏美术、界面元素、概念图和贴图，以 PNG、JPEG 或 WebP 保存到游戏项目中；图像由 WASD Engine API 制作，费用计入已登录账号的套餐 |
| [`new-game-guidance/`](new-game-guidance/README.zh.md) | 新游戏指引：当顶层 Session 中用户的第一条提示进入一个步骤、而项目文件夹只含隐藏条目和系统文件时，配置的指引会作为一条单独记录的消息紧随其后，WASD Engine 插件的浏览器部分不会在 Chat 中显示它 |
| [`polyhaven/`](polyhaven/README.zh.md) | Poly Haven 工具：搜索 Poly Haven 中 CC0 的 HDRI、纹理和 3D 模型资源库，显示素材的文件与预览图，并把一种格式和分辨率下载到游戏项目中，每个文件的摘要都经过校验 |
| [`supercollider/`](supercollider/README.zh.md) | 通过 MCP 提供的 SuperCollider 工具：用 scsynth 离线渲染由 sclang 代码描述的声音与音乐，并为智能体提供电平、响度，以及按需提供的波形与声谱图图像；Desktop 应用自带不含 GUI 的 SuperCollider |
| [`tripo/`](tripo/README.zh.md) | Tripo 工具：用 Tripo 的 P2 模型根据提示词、图像或物体的多个视图制作带贴图的 3D 模型，为其重新制作贴图、绑定骨骼并添加动画，并以 `.glb` 文件保存到游戏项目中，费用计入 WASD Engine 套餐；也通过游戏 MCP 服务器提供给连接的智能体 |
| [`todo-continuation/`](todo-continuation/README.zh.md) | 待办续行：当模型以一条回复结束轮次，而它在该轮次写下的待办列表仍有待处理或进行中的项时，一条列出这些项的提醒会让轮次继续；每个不同的列表最多提醒一次，每个轮次的提醒数不超过配置的上限 |
| [`ui-game-assets/`](ui-game-assets/README.zh.md) | 右侧栏的「素材」标签页：在按项目文件夹归类、带搜索与「全部 / 2D / 3D」筛选的下拉列表中列出游戏项目的图片与模型，提供可播放 2D 动画的可缩放图片视图、带动画片段时间轴、骨架以及白模和线框显示的 three.js 模型视图、详细信息面板，并通过导出的模型显示 Blender 文件；它也为智能体的素材工具绘制素材 |
| [`ui-game-audio/`](ui-game-audio/README.zh.md) | 右侧栏的「音频」标签页：按文件夹分组并显示时长地列出项目的音效、对白和音乐，带搜索与「全部 / 音效 / 对白 / 音乐」筛选，播放时提供可拖动的波形、无缝循环、音量，以及格式、响度和峰值等详细信息；也负责 `audio_review` 背后的解码与测量 |
| [`ui-game-mcp/`](ui-game-mcp/README.zh.md) | MCP 服务器的浏览器部分：登录后的「使用其他智能体设置」，作为桌面引导的最后一步与设置中的「其他智能体」分区，包含智能体标志、设置提示词与是否已有智能体连接，以及窗口打开已连接智能体启动游戏所在的会话 |
| [`ui-game-tools/`](ui-game-tools/README.zh.md) | 「设置 › 内置插件」与「插件」页面上的「游戏工具」标签页：列出 Blender、ElevenLabs、游戏扩展、GIMP、Godot、Nano Banana、Poly Haven 与 SuperCollider 及其标志与 Loader 状态，并在「插件」页面为每个工具提供开关，在 profile patch 中关闭或开启其所在行 |
| [`wasd-plugins/`](wasd-plugins/README.zh.md) | WASD Engine 插件，即 WASD Engine 自带且始终开启的功能：每个会话和 MCP 服务器都提供的 Web、桌面版与移动端导出及发布工具，它们把 Godot 游戏作为带分享链接的编号版本发布到 WASD Engine 网站，可公开在探索页上或设为私密，并可附带 Windows 与 macOS 下载；桌面应用中智能体的 `browser_*` 工具，在右侧边栏的浏览器中搜索和浏览；会话标题栏与新会话页面上的“导出 / 分享”按钮；以及侧边栏中的“探索游戏” |

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
