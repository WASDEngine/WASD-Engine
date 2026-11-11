---
description: "WASD Engine 右侧栏中的「素材」标签页：供维护者修改游戏项目的 2D 与 3D 美术素材如何被查找、搜索、按文件夹归类与显示，或排查某个模型或图片无法显示的问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-assets

[English](README.md) | 中文

## 概述

不离开 WASD Engine 即可查看游戏项目的美术素材。右侧栏的**素材**标签页会找出 Session 所在游戏项目中的每张图片和每个 3D 模型，在一个按项目文件夹归类的下拉列表中列出它们，可按名称或路径搜索，并显示所选素材：图片显示在可缩放的视图中，模型显示在可旋转、缩放、平移并播放动画的 3D 视图中。Blender 文件会显示由它导出的模型。agent（智能体）修改文件后，视图会重新加载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开右侧栏，在其引导页上选择**素材**，或从**更多工具**中打开该标签页。标签页顶部的下拉列表显示当前查看的素材；打开它即可搜索，或浏览项目的文件夹。

### 默认组合

fork 的 patch 文件 [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) 在每个 Web 与 Desktop profile 中、「游戏工具」标签页那一行之后插入下面这一行：

```yaml
- id: ui-game-assets
  name: '@deepseek-ai/dsh-client-ui-game-assets'
```

该行的 Host 半区什么也不做：这一行的存在只是为了让 Host 提供浏览器半区。浏览器半区需要右侧栏（[`ui-sidebar-right`](../../client/ui-sidebar-right/README.zh.md)）、[`dsh-api-workspace-files`](../../api/workspace-files/README.zh.md) 的 `workspaceFiles` Remote 及其 `file` 资源，以及 Session Controller 的 sessions 服务。带 `disabled: true` 的 profile patch 条目 `- id: ui-game-assets` 会移除该标签页。设置 `config` 的 patch 可修改以下上限：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxFolders` | `2000` | 一次扫描在停止并提示列表不完整之前列出的文件夹数，包括项目文件夹本身 |
| `maxAssets` | `5000` | 一次扫描在停止并提示列表不完整之前收集的素材数 |
| `maxPreviewBytes` | `268435456`（256 MiB） | 查看器读取的最大文件；更大的素材改为显示提示 |

### 标签页列出的内容

标签页按扩展名列出文件。图片：由浏览器解码的 PNG、JPEG、WebP、GIF、BMP、SVG、AVIF 与 ICO，以及由 three.js 解码的 TGA、Radiance HDR（`.hdr`）与 OpenEXR（`.exr`）。模型：glTF（`.gltf`、`.glb`）、OBJ、FBX、Collada（`.dae`）、STL、PLY、MagicaVoxel（`.vox`）与 Blender（`.blend`）。扫描会遍历 Session 的工作区，跳过隐藏文件夹（如 `.godot` 与 `.git`）和 `node_modules`；通过链接到达的已列出文件夹只列出一次。

### 选择素材

下拉列表显示项目中含有素材的文件夹，文件夹在文件之前，名称按阅读顺序排列（`tree2` 在 `tree10` 之前），并显示每个文件夹的素材数；项目文件夹自身的子文件夹一开始就是展开的。只含一个文件夹的文件夹与它共用一行（`ui/icons`）。**全部**、**2D** 与 **3D** 可把列表缩小到一种类型。输入文字后，文件夹会被替换为名称或路径包含该文字的素材，最佳匹配在前；若没有素材包含该文字，则按字母先后顺序匹配，因此像 `arcbl` 这样的缩写仍能找到 `archer.blend`。搜索框保持键盘焦点时，方向键在各行之间移动，Enter 展开或收起文件夹或选择素材，左右方向键展开和收起文件夹，Escape 关闭下拉列表。打开下拉列表时会显示所选素材所在的行。

标签页在显示时以及打开下拉列表时扫描项目，除非上一次扫描刚刚完成：两秒内，或该次扫描耗时的十倍时间内。刷新按钮会立即扫描，并重新读取当前查看的文件。扫描进行期间以及扫描失败后，屏幕上保留上一次的列表；扫描失败时会显示带**重试**的提示。

### 图片

在读者缩放之前，图片会留出边距适应舞台大小；透明像素显示为棋盘格。滚轮与双指捏合以指针为中心缩放，拖动可平移，双击在适应视图与实际大小之间切换；底栏的按钮可缩小、在适应与实际大小之间切换以及放大，范围为 1% 到 6400%。从实际大小的两倍起，像素按方块绘制，适合像素画。舞台获得焦点时，`+` 与 `-` 缩放，`0` 适应视图，`1` 显示实际大小，方向键平移。HDR 与 EXR 图片在曝光为 1 时用 ACES filmic 曲线做色调映射后显示。底栏显示格式、像素尺寸与文件大小。

### 模型

模型从右前方稍高处取景，放在按其大小设置的网格上，由房间环境光、天空光与太阳光照明。拖动可旋转相机，右键拖动或按住 Shift 拖动可平移，滚轮缩放，视图获得焦点时方向键平移。底栏显示格式、三角形数与文件大小，并提供线框开关和**重置视图**，后者会回到初始取景。带动画的模型会播放第一个片段；底栏的动画菜单可选择其他片段或**无动画**，另有按钮可暂停和继续。同一文件的新版本会保留相机、线框开关以及同名的动画片段。

模型引用的文件从模型旁加载：glTF 的缓冲区与图片、OBJ 的材质库及其纹理，以及 FBX 与 Collada 的纹理。模型以绝对路径（例如创作该模型的计算机上的路径）保存的文件名，会按文件名从模型所在文件夹加载。

### Blender 文件

查看器无法读取 `.blend` 文件。它会改为显示项目中同名的模型：依次在 Blender 文件所在文件夹、其上层文件夹、其下层文件夹以及任意位置查找，优先选择 GLB，其次 glTF，再次其他格式，并显示一条说明该模型的提示和**打开该模型**按钮，后者会选中该模型。没有这样的模型的 Blender 文件会显示一条提示，请用户导出 glTF。

### 失败

文件已不存在、大于 `maxPreviewBytes`，或在分块读取大文件期间不断变化时，视图位置会显示提示；读取失败时提供**重试**。加载器无法读取的文件会提示该文件可能已损坏，或使用了查看器不支持的功能。浏览器不支持 WebGL 时会提示 3D 模型需要 WebGL。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器插件在右侧栏的标签页注册表中注册 `assets` 页面类型，带一个顺序为 45 的引导项（位于「游戏」标签页的引导项之后），并以该类型的 id 在 `sidebar.right.pane.tab` 座位中注册其主体与标签标题。每个 Session 的状态是一个 `AssetsSource`，它在两个快照存储中保存扫描结果与读者的选择，主体以 `useScan` 与 `useView` 读取；它在主体第一次取得 face 时创建，并随 Session 的作用域或插件一起释放。主体不会保持挂载，因此隐藏的标签页会释放其 WebGL 上下文，标签页回来时状态会再次显示。

扫描通过 `workspaceFiles.list` 以广度优先方式遍历工作区，同时最多列出六个文件夹。它记录 Host 报告的文件夹路径集合，这些路径指向链接解析到的文件夹，因此指向已列出文件夹的链接或循环只会列出一次。以 `workspace-file/not-found` 失败的列出属于遍历期间被删除的文件夹；其他失败计为无法读取的文件夹。

当前查看的文件通过 `workspaceFiles.readBytes` 读取：一次完整读取，或在 Host 的整文件上限拒绝后改为连续的字节窗口；若某个窗口的版本与第一个窗口不同，读取会重新开始一次。主体跟随该文件的 `file` 资源，每有新版本就重新读取。模型引用的文件通过已认证的 `/api/file` 路由按 URL 加载，加载器经由 `LoadingManager` 的 URL 修改器到达该路由，修改器会把每个名称相对于当前文件的绝对路径解析。

three.js 及其加载器位于一个延迟加载的分块 `client.viewer.js` 中，两个视图都在首次使用时导入它；客户端模块加载器无法加载被另一个延迟分块依赖的分块，因此第二个入口会让共享代码无法被加载。3D 舞台按需绘制：相机移动、迟到的纹理、尺寸变化或正在播放的动画会请求下一帧。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Loader 行的空 Host `apply` |
| [`src/client/index.ts`](src/client/index.ts) | `Config`、标签页类型、其座位、文案，以及每个 Session 的状态与 face |
| [`src/client/formats.ts`](src/client/formats.ts) | 列出的扩展名、其类型与解码器 |
| [`src/client/scan.ts`](src/client/scan.ts) | 项目遍历与名称排序 |
| [`src/client/tree.ts`](src/client/tree.ts) | 文件夹树、其行、要展开的文件夹与搜索 |
| [`src/client/source.ts`](src/client/source.ts) | 单个 Session 的扫描与选择 |
| [`src/client/read.ts`](src/client/read.ts) | 完整读取与分块读取，以及相关文件的 URL |
| [`src/client/AssetsTab.tsx`](src/client/AssetsTab.tsx)、[`src/client/AssetPicker.tsx`](src/client/AssetPicker.tsx) | 主体、其状态与下拉列表 |
| [`src/client/AssetViewer.tsx`](src/client/AssetViewer.tsx) | 读取、重新加载、Blender 导出与读取失败 |
| [`src/client/ImageView.tsx`](src/client/ImageView.tsx)、[`src/client/ModelView.tsx`](src/client/ModelView.tsx) | 2D 与 3D 视图 |
| [`src/client/viewer/`](src/client/viewer/) | 延迟加载的 three.js 分块：图片解码器、模型加载器与舞台 |
| [`src/client/icon.tsx`](src/client/icon.tsx) | 标签页图标与 3D 模型文件图标 |
| [`src/client/locales.ts`](src/client/locales.ts) | 八种语言的 `gameAssets` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍容纳该标签页的侧栏及其读取的服务。

- [游戏工具子系统页面](../../../docs/subsystems/gamedev.zh.md#assets-tab) —— 该标签页与制作美术素材的游戏工具之间的关系。
- [ui-sidebar-right](../../client/ui-sidebar-right/README.zh.md) —— 右侧栏、其标签页注册表与引导页。
- [dsh-api-workspace-files](../../api/workspace-files/README.zh.md) —— 该标签页使用的列出、字节读取与 `file` 资源。
- [ui-sidebar-files](../../client/ui-sidebar-files/README.zh.md) —— 工作区文件树，它列出所有文件而不只是美术素材。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器端的项目文件视图，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供商请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制决定了该标签页显示什么以及何时显示；它们是本包当前的约束。

- **列表不实时更新** —— 只有在标签页显示、打开下拉列表或使用刷新按钮时，列表才会跟随项目变化；当前查看的文件本身会随修改重新加载，但模型引用的文件不会。
- **不渲染 Blender 文件** —— Blender 文件只显示由它导出的模型；标签页不会启动 Blender 来转换。
- **不支持压缩纹理** —— 需要 Draco 或 KTX2 解码器的 glTF 模型，以及 DDS 或 KTX 图片无法显示；Meshopt 压缩可以显示。
- **相关文件来自 `/api/file`** —— 模型引用的纹理与缓冲区通过已认证的文件路由加载，因此该路由的字节上限（附件的 `maxImageBytes`）也限制其中每个文件。
- **每个模型视图一个 WebGL 上下文** —— 每次选择模型都会重新创建 3D 舞台，在较慢的 GPU 上需要片刻。
- **固定的跳过规则** —— 扫描总是跳过隐藏文件夹与 `node_modules`；放在隐藏文件夹中的美术素材不会显示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
