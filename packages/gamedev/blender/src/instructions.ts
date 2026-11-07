/** Model-facing identity of the Blender MCP server: its name and the instructions that the client adds to the agent's context. */

/**
 * Name of the Blender MCP server: the MCP manager key, the tool namespace (`mcp__wasd_blender__<tool>`), and the heading
 * of the instructions in the system prompt. The `wasd_` prefix keeps it apart from a `blender` server that a user configures.
 */
export const BLENDER_SERVER_NAME = 'wasd_blender'

/** How to use the Blender tools, at most 6000 characters. */
export const BLENDER_INSTRUCTIONS = `Blender runs headless behind these tools: there is no window, viewport, or screenshot. One Blender session and one open scene serve every conversation and persist between calls until new_scene or open_blend replaces them, so call scene_info before relying on earlier state. If Blender restarts after a crash or a timeout, unsaved work is lost: save .blend files at milestones. The first result after a start names the Blender version; check API names with python_api instead of guessing, since APIs change between versions.

Paths are absolute. Resolve relative names against your working directory. Put game assets inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Inspect, change, look:
- scene_info gives the overview and object_info the details of one object (transforms, bounds, mesh statistics, modifiers, materials).
- execute_python changes the scene. Prefer bpy.data and direct property edits over bpy.ops operators: operators depend on the active object, selection, and mode, and some need a window that background Blender does not have. Create meshes with bmesh or Mesh.from_pydata, link new objects into a collection, and assign result to return data.
- render_preview shows the result without touching the scene's camera or settings: solid for shape and base colors, material for node materials and textures. Look at a preview after significant changes and fix what looks wrong before exporting.
- render makes final images from a scene camera.

Game assets:
- Model in meters at real scale, with -Y as the front and +Z as up in Blender; glTF export converts to +Y up. Apply rotation and scale (bpy.ops.object.transform_apply) and place each origin where the game expects the pivot, such as the feet of a character.
- Use Principled BSDF materials, and paint image textures for every model you make, as Textures below describes, unless the user asks for flat colors: glTF export, and with it the game, keeps image textures but drops procedural shader nodes. Keep the images next to the model or packed into the .blend so export can embed or copy them.
- Keep triangle counts suited to real-time rendering; scene_info reports them per mesh.
- Name objects, meshes, and materials meaningfully: glTF keeps the names. In Godot, an object name ending in -col adds a collision shape, -convcol a convex one, and -colonly keeps only the collision shape.
- export_gltf to a .glb inside the game project. It applies modifiers, exports animations, and never uses Draco compression, which Godot cannot import. Export the whole scene or name the objects in selection.
- Save the editable .blend next to the exported file with save_blend so the asset can be changed later.

Textures:
1. Unwrap UVs: with the object active and selected, run bpy.ops.object.mode_set(mode='EDIT'), bpy.ops.mesh.select_all(action='SELECT'), and bpy.ops.uv.smart_project(island_margin=0.02), then return to mode='OBJECT'.
2. Build the look in the material from procedural nodes that suit the game's art style: Noise, Voronoi, and Wave textures through Color Ramps for color variation, wood grain, or stone; an inverted Ambient Occlusion node as the mask for dirt in creases; a Bump node for surface relief.
3. Bake it into images with Cycles: set scene.render.engine = 'CYCLES', scene.cycles.device = 'CPU', and scene.cycles.samples to about 8. Bake one object at a time, selected alone and active. Add an Image Texture node holding a new image, 512 pixels square for small props and 1024 or 2048 for large or close-up models, and make it the active node of each of the object's materials, then run bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=8). Where the material varies in roughness or relief, also bake type='ROUGHNESS' and type='NORMAL' into images whose colorspace_settings.name is 'Non-Color'. Set the render engine back afterwards.
4. Paint what nodes cannot make, such as stripes, markings, or chipped paint, into the pixels with numpy: image.pixels.foreach_get into an array, change it, foreach_set, then image.update(). To paint on a particular face, read where it lies from its loop UVs in mesh.uv_layers.active.uv: u and v from 0 to 1 span the image's width and height, with pixel row 0 at the bottom.
5. Connect each image to its Principled BSDF input in place of the procedural nodes, a normal image through a Normal Map node, save each as a PNG next to the model (set image.filepath_raw, then image.save()), and look at render_preview in material mode before export_gltf, which embeds the images in the .glb.

Use checkpoint before risky edits and undo to return to it. new_scene and open_blend remove every name that execute_python defined, and after undo, Python references held in variables can be invalid, so look objects up by name again.`
