/** Model-facing identity of the GIMP MCP server: its name and the instructions that the client adds to the agent's context. */

/**
 * Name of the GIMP MCP server: the MCP manager key, the tool namespace (`mcp__wasd_gimp__<tool>`), and the heading of the
 * instructions in the system prompt. The `wasd_` prefix keeps it apart from a `gimp` server that a user configures.
 */
export const GIMP_SERVER_NAME = 'wasd_gimp'

/** How to use the GIMP tools, at most 6000 characters. */
export const GIMP_INSTRUCTIONS = `GIMP 3 runs headless behind these tools: there is no window. GIMP keeps one session for each conversation: its open images persist between calls until close_image. Refer to an image by the integer id that new_image, open_image, or list_images returns, and to a layer by id or exact name (image_info lists them); call list_images before relying on earlier state. If GIMP restarts after a crash or a timeout, or stops after a long pause in the calls, open images and unsaved changes are lost: save .xcf files at milestones. The first result after a start names the GIMP version.

Paths are absolute. Resolve relative names against your working directory. Write game assets inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Look, change, look again:
- snapshot shows an image as it would export: the visible layers composited, transparent areas as a gray checkerboard, and small images enlarged without smoothing. Look after significant changes and fix what looks wrong before exporting. Snapshots and exports never change the image.
- image_info gives sizes, the layer tree, text layer contents, and the selection.
- layer adds, duplicates, deletes, renames, restacks, and merges layers, and sets opacity, visibility, blend mode, and offset.
- select builds a selection (rectangle, ellipse, by color, grow, shrink, feather, invert). Fill, clear, gradients, and filters then act only inside it; select mode none to act on whole layers again.
- draw fills, clears, paints linear gradients, and adds text layers. Colors are #rrggbb, #rrggbbaa (with alpha), or CSS color names.
- transform scales the image or a layer, resizes the canvas, crops, rotates, and flips. Scale pixel art with interpolation none.
- filters lists GEGL filter operations (blur, noise, distort, light, color, artistic, ...), filter_info shows their properties, ranges, and defaults, and apply_filter applies one to a layer.
- pdb_search, pdb_describe, and pdb_run reach any other GIMP procedure, such as converting to indexed colors, with images and layers passed by id.
- execute_python runs Python with Gimp, Gegl, Gio, and GLib imported and images mapping ids to Gimp.Image objects, for anything the other tools do not cover. Assign result to return data.

Game assets:
- Work at the final pixel size, and keep sizes the engine handles well, such as powers of two for tiling textures.
- export_image writes the composited visible layers by extension (.png, .webp, .jpg, .tga, .bmp, .ico) and creates folders. Use .png or .webp to keep transparency; .jpg and .bmp have none, so transparent areas become white.
- Keep the editable source: save_xcf next to the exported asset, for example art/hero.xcf beside art/hero.png, so layers and text stay editable later.
- make_sprite_sheet packs frame files into one grid sheet and reports each frame's rectangle; make_seamless makes a texture tile without seams by cross-fading it with copies of itself shifted by half its size, which can fade and double distinct shapes, so use it on noise-like textures.

close_image discards unsaved changes, so save first when they matter.`
