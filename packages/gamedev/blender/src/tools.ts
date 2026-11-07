/**
 * Blender MCP tools. Each tool validates the agent's arguments, sends one request to the worker
 * method of the same name, validates the worker's reply, and returns compact text plus images.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_EDGE, WorkerReplyError, defineAppTool, executePythonTool, formatBytes, replyParser, withSetupNotes,
} from '@deepseek-ai/dsh-app-mcp'
import type { AppTool, AppToolDependencies, JsonObject } from '@deepseek-ai/dsh-app-mcp'

/** Longest edge of a final render requested through tool arguments. */
export const RENDER_MAX_EDGE = 2048

/** Most object names one tool call accepts. */
export const OBJECT_LIST_LIMIT = 300

const NAME_MAX = 255
const PATH_MAX = 4096
const IDENTIFIER_MAX = 300
const LISTED_NAMES = 50

const parseReply = replyParser('Blender')

function absolutePath(description: string): z.ZodString {
  return z.string().min(1).max(PATH_MAX).refine(value => isAbsolute(value), 'must be an absolute path').describe(description)
}

function objectNames(description: string): z.ZodArray<z.ZodString> {
  return z.array(z.string().min(1).max(NAME_MAX)).min(1).max(OBJECT_LIST_LIMIT).describe(description)
}

function listNames(names: readonly string[], total: number): string {
  const shown = names.slice(0, LISTED_NAMES)
  const more = total - shown.length
  return shown.join(', ') + (more > 0 ? ` and ${String(more)} more` : '')
}

/** The sentence that names the `execute_python` names a scene replacement removed, or nothing when there were none. */
function clearedNames(names: readonly string[], total: number): string {
  return total === 0 ? '' : ` The names that execute_python had defined are gone: ${listNames(names, total)}.`
}

function formatVector(values: readonly (number | null)[]): string {
  return `(${values.map(value => value === null ? 'n/a' : String(value)).join(', ')})`
}

const Vector3 = z.array(z.number().nullable()).length(3)

const WorkerImage = z.object({
  path: z.string(),
  mime_type: z.enum(['image/png', 'image/jpeg']),
  width: z.int(),
  height: z.int(),
})

const ClearedNames = { cleared: z.array(z.string()), cleared_count: z.int() }

const NewSceneReply = z.object({ empty: z.boolean(), objects: z.array(z.string()), ...ClearedNames })

const OpenReply = z.object({
  file: z.string(), scene: z.string(), scenes: z.array(z.string()), objects: z.array(z.string()), object_count: z.int(), ...ClearedNames,
})

const SaveReply = z.object({ path: z.string(), bytes: z.int() })

const ImportReply = z.object({ objects: z.array(z.string()), count: z.int(), omitted: z.int() })

const ExportGltfReply = z.object({
  path: z.string(), format: z.enum(['GLB', 'GLTF_SEPARATE']), bytes: z.int(), objects: z.int(), files: z.array(z.string()),
  applied_modifiers: z.boolean(), shape_keys_dropped: z.array(z.string()),
})

/**
 * Seconds of a render budget that Cycles may spend sampling. The rest covers scene synchronization, denoising, and
 * saving the images, which the time limit does not count.
 * @param budgetMs - the render request's budget.
 * @returns whole seconds, at least 1.
 */
export function renderSamplingSeconds(budgetMs: number): number {
  const budget = budgetMs / 1000
  return Math.max(1, Math.floor(budget - Math.min(60, budget / 4)))
}

const ExportFileReply = z.object({ path: z.string(), format: z.string(), bytes: z.int() })

const PreviewReply = z.object({
  width: z.int(),
  height: z.int(),
  view: z.string(),
  shading: z.string(),
  objects: z.int(),
  framing: z.object({ min: Vector3, max: Vector3, size: Vector3 }),
  image: WorkerImage,
  note: z.string().optional(),
})

const RenderReply = z.object({
  path: z.string(),
  width: z.int(),
  height: z.int(),
  engine: z.string(),
  camera: z.string(),
  seconds: z.number().nullable(),
  image: WorkerImage,
})

const ApiReply = z.object({ text: z.string() })

const CheckpointReply = z.object({ checkpoint: z.int() })

/** Paths the worker may write for the agent-visible copy of an image. */
function agentImagePaths(stem: string): readonly string[] {
  return [`${stem}.png`, `${stem}.jpg`]
}

async function readAgentImage(image: z.infer<typeof WorkerImage>, allowed: readonly string[]): Promise<{ data: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }> {
  if (!allowed.includes(image.path)) throw new WorkerReplyError(`The Blender worker returned an image outside the requested files: ${image.path}`)
  return { data: await readFile(image.path), mimeType: image.mime_type }
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => { await rm(path, { force: true }) }))
}

function renderStamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

/**
 * Build the Blender tool set.
 * @param dependencies - worker access, setup notes, data directory, and timeout budgets.
 * @returns the tools in the order the server lists them.
 */
export function blenderTools(dependencies: AppToolDependencies): readonly AppTool<z.ZodRawShape>[] {
  const { call, dataRoot, requestTimeoutMs } = dependencies
  const previews = join(dataRoot, 'previews')
  // The same bounds as execute_python's timeout_seconds.
  const defaultTimeoutSeconds = Math.round(requestTimeoutMs / 1000)
  const maxTimeoutSeconds = Math.max(1, Math.floor(dependencies.maxTimeoutMs / 1000))
  return [
    defineAppTool({
      name: 'scene_info',
      title: 'Scene summary',
      description: 'Summarize the open Blender scene as JSON: file path and unsaved changes, frame range, render settings, units, '
        + 'the collection tree, and up to 300 objects with location, rotation (radians), scale, dimensions, data, materials, '
        + 'modifiers, visibility, and evaluated triangle counts for meshes.',
      input: {},
      async run(_args, signal) {
        return withSetupNotes(dependencies, { text: JSON.stringify(await call('scene_info', {}, { signal })) })
      },
    }),
    defineAppTool({
      name: 'object_info',
      title: 'Object details',
      description: 'Describe one object as JSON: local and world transforms, world bounding box, mesh statistics (vertices, faces, '
        + 'triangles before and after modifiers, UV maps, vertex groups, shape keys), modifiers with their settings, materials with '
        + 'node types, Principled BSDF inputs, and image textures, constraints, custom properties, and animation.',
      input: { name: z.string().min(1).max(NAME_MAX).describe('Exact object name.') },
      async run(args, signal) {
        return withSetupNotes(dependencies, { text: JSON.stringify(await call('object_info', { name: args.name }, { signal })) })
      },
    }),
    executePythonTool(dependencies, {
      app: 'Blender',
      title: 'Run Blender Python',
      description: 'Run Python in the Blender session. bpy, bmesh, mathutils, math, and json are imported, and names you define '
        + 'persist between calls until new_scene or open_blend replaces the scene. Assign `result` to return a value as JSON (vectors '
        + 'become lists, datablocks become {type, name}, integers beyond ±(2^53 − 1) strings of digits, other objects their repr). Printed '
        + 'output is returned, up to 20000 characters. An exception makes the call fail and returns its traceback. When the timeout '
        + 'expires, Blender restarts and unsaved changes are lost.',
    }),
    defineAppTool({
      name: 'new_scene',
      title: 'New scene',
      description: 'Replace the open scene with a new one, discarding unsaved changes, checkpoints, and the names that execute_python defined.',
      input: {
        empty: z.boolean().optional().describe('true (default) starts with no objects; false starts with Blender\'s default cube, camera, and light.'),
      },
      async run(args, signal) {
        const reply = parseReply(NewSceneReply, 'new_scene', await call('new_scene', { empty: args.empty ?? true }, { signal }))
        const text = reply.objects.length === 0
          ? 'Started a new empty scene.'
          : `Started a new scene with ${listNames(reply.objects, reply.objects.length)}.`
        return withSetupNotes(dependencies, { text: text + clearedNames(reply.cleared, reply.cleared_count) })
      },
    }),
    defineAppTool({
      name: 'open_blend',
      title: 'Open .blend file',
      description: 'Open a .blend file, replacing the open scene and discarding unsaved changes, checkpoints, and the names that execute_python '
        + 'defined. Scripts stored in the file do not run.',
      input: { path: absolutePath('Absolute path of the .blend file.') },
      async run(args, signal) {
        const reply = parseReply(OpenReply, 'open_blend', await call('open_blend', { path: args.path }, { signal }))
        const scenes = reply.scenes.length > 1 ? ` (scenes: ${reply.scenes.join(', ')})` : ''
        return withSetupNotes(dependencies, {
          text: `Opened ${reply.file}. Scene "${reply.scene}"${scenes} has ${String(reply.object_count)} objects: ${listNames(reply.objects, reply.object_count)}.`
            + clearedNames(reply.cleared, reply.cleared_count),
        })
      },
    }),
    defineAppTool({
      name: 'save_blend',
      title: 'Save .blend file',
      description: 'Save the scene as a .blend file. With path, save under that name (creating missing folders) and keep using it; '
        + 'without path, save the current file.',
      input: { path: absolutePath('Absolute path ending in .blend; omit to save the current file.').optional() },
      async run(args, signal) {
        const reply = parseReply(SaveReply, 'save_blend', await call('save_blend', args.path === undefined ? {} : { path: args.path }, { signal }))
        return withSetupNotes(dependencies, { text: `Saved ${reply.path} (${formatBytes(reply.bytes)}).` })
      },
    }),
    defineAppTool({
      name: 'import_file',
      title: 'Import file',
      description: 'Import a file into the open scene by its extension: .glb or .gltf, .fbx, .obj, .stl, .ply, .usd, .usda, .usdc, '
        + '.usdz, .abc, .svg, or .blend (appends every object). Returns the names of the new objects.',
      input: { path: absolutePath('Absolute path of the file to import.') },
      async run(args, signal) {
        const reply = parseReply(ImportReply, 'import_file', await call('import_file', { path: args.path }, { signal }))
        const text = reply.count === 0
          ? `Imported ${args.path}, which added no objects.`
          : `Imported ${String(reply.count)} objects: ${listNames(reply.objects, reply.count)}.`
        return withSetupNotes(dependencies, { text })
      },
    }),
    defineAppTool({
      name: 'export_gltf',
      title: 'Export glTF',
      description: 'Export glTF 2.0 for a game engine: .glb (one file) or .gltf (with .bin and texture files). Exports the current '
        + 'scene, or only the selection objects and their children, hidden ones included. Output is +Y up and never Draco-compressed; '
        + 'missing folders are created, and a file already at path is deleted first, so a failed export leaves none.',
      input: {
        path: absolutePath('Absolute output path ending in .glb or .gltf.'),
        selection: objectNames('Objects to export with their children; omit to export the whole scene.').optional(),
        apply_modifiers: z.boolean().optional().describe('Apply modifiers to exported meshes. Default: true when an exported '
          + 'object has a modifier other than Armature. Applying drops the shape keys of every mesh that has a modifier, '
          + 'Armature included.'),
        animations: z.boolean().optional().describe('Export animations (default true).'),
        format: z.enum(['GLB', 'GLTF_SEPARATE']).optional().describe('GLB for .glb paths (default), GLTF_SEPARATE for .gltf paths.'),
      },
      async run(args, signal) {
        const params: JsonObject = {
          path: args.path,
          animations: args.animations ?? true,
          format: args.format ?? (args.path.toLowerCase().endsWith('.glb') ? 'GLB' : 'GLTF_SEPARATE'),
        }
        if (args.apply_modifiers !== undefined) params.apply_modifiers = args.apply_modifiers
        if (args.selection !== undefined) params.selection = args.selection
        const reply = parseReply(ExportGltfReply, 'export_gltf', await call('export_gltf', params, { signal }))
        const files = reply.files.length > 1 ? ` Files: ${reply.files.join(', ')}.` : ''
        const dropped = reply.shape_keys_dropped.length === 0 ? '' : ' Applying modifiers dropped the shape keys of '
          + `${listNames(reply.shape_keys_dropped, reply.shape_keys_dropped.length)}; export with apply_modifiers false to keep them.`
        return withSetupNotes(dependencies, {
          text: `Exported ${String(reply.objects)} objects to ${reply.path} (${reply.format}, ${formatBytes(reply.bytes)}).${files}${dropped}`,
        })
      },
    }),
    defineAppTool({
      name: 'export_file',
      title: 'Export file',
      description: 'Export the scene, or only the selection objects and their children, hidden ones included, as FBX (.fbx), OBJ '
        + '(.obj), STL (.stl), or USD (.usd, .usda, .usdc, .usdz). Missing folders are created, and a file already at path is deleted '
        + 'first, so a failed export leaves none. Use export_gltf for game-engine assets.',
      input: {
        path: absolutePath('Absolute output path with the extension of the format.'),
        format: z.enum(['fbx', 'obj', 'stl', 'usd']).describe('Output format.'),
        selection: objectNames('Objects to export with their children; omit to export the whole scene.').optional(),
      },
      async run(args, signal) {
        const params: JsonObject = { path: args.path, format: args.format }
        if (args.selection !== undefined) params.selection = args.selection
        const reply = parseReply(ExportFileReply, 'export_file', await call('export_file', params, { signal }))
        return withSetupNotes(dependencies, { text: `Exported ${reply.format.toUpperCase()} to ${reply.path} (${formatBytes(reply.bytes)}).` })
      },
    }),
    defineAppTool({
      name: 'render_preview',
      title: 'Preview render',
      description: 'Look at the scene: render an image from an orthographic camera framed on every renderable object, or on the '
        + 'listed objects and their children with other geometry hidden. solid (default) is fast flat shading with outlines in '
        + 'material base colors; material renders node materials and textures with EEVEE, lit by the scene lights (or a temporary '
        + 'sun when there are none). The scene, its camera, and its render settings are left unchanged.',
      input: {
        width: z.int().min(64).max(AGENT_IMAGE_MAX_EDGE).optional().describe('Image width in pixels (default 768).'),
        height: z.int().min(64).max(AGENT_IMAGE_MAX_EDGE).optional().describe('Image height in pixels (default 768).'),
        view: z.enum(['iso', 'front', 'back', 'left', 'right', 'top']).optional()
          .describe('Viewing direction (default iso, from front-right-above). front looks along +Y; top looks down -Z.'),
        objects: objectNames('Objects to frame and show with their children; omit for the whole scene.').optional(),
        shading: z.enum(['solid', 'material']).optional().describe('solid (default) or material.'),
      },
      async run(args, signal) {
        const id = randomUUID()
        const path = join(previews, `${id}.png`)
        const stem = join(previews, `${id}-agent`)
        const params: JsonObject = {
          path,
          width: args.width ?? 768,
          height: args.height ?? 768,
          view: args.view ?? 'iso',
          shading: args.shading ?? 'solid',
          agent_image: { stem, max_edge: AGENT_IMAGE_MAX_EDGE, max_bytes: AGENT_IMAGE_MAX_BYTES },
        }
        if (args.objects !== undefined) params.objects = args.objects
        try {
          const reply = parseReply(PreviewReply, 'render_preview', await call('render_preview', params, { signal }))
          const image = await readAgentImage(reply.image, [path, ...agentImagePaths(stem)])
          const { min, max, size } = reply.framing
          const text = `Rendered a ${String(reply.width)}x${String(reply.height)} ${reply.shading} preview (${reply.view} view) of `
            + `${String(reply.objects)} objects. World bounds ${formatVector(min)} to ${formatVector(max)}, size ${formatVector(size)}.`
            + (reply.note === undefined ? '' : ` ${reply.note}`)
          return withSetupNotes(dependencies, { text, images: [image] })
        } finally {
          await removeFiles([path, ...agentImagePaths(stem)])
        }
      },
    }),
    defineAppTool({
      name: 'render',
      title: 'Render',
      description: 'Render the scene from its camera, or from the named camera object, to a PNG file and show the image. Width, '
        + 'height, engine, and samples apply to this render only; omitted ones use the scene settings. Fails when the scene has '
        + 'no camera; use render_preview to look at a scene without one.',
      input: {
        path: absolutePath('Absolute output path ending in .png; default: a new file under the Blender data folder.').optional(),
        width: z.int().min(16).max(RENDER_MAX_EDGE).optional().describe('Output width in pixels.'),
        height: z.int().min(16).max(RENDER_MAX_EDGE).optional().describe('Output height in pixels.'),
        engine: z.enum(['EEVEE', 'CYCLES', 'WORKBENCH']).optional().describe('Render engine.'),
        samples: z.int().min(1).max(4096).optional().describe('Samples for EEVEE or CYCLES.'),
        camera: z.string().min(1).max(NAME_MAX).optional().describe('Camera object to render from instead of the scene camera.'),
        timeout_seconds: z.int().min(1).max(maxTimeoutSeconds).optional().describe('Seconds before Blender is stopped and '
          + `restarted, losing unsaved changes (default ${String(defaultTimeoutSeconds)}). CYCLES stops sampling early to finish in time.`),
      },
      async run(args, signal) {
        const stem = join(previews, `${randomUUID()}-agent`)
        const path = args.path ?? join(dataRoot, 'renders', `${renderStamp()}.png`)
        const budgetMs = args.timeout_seconds === undefined ? requestTimeoutMs : args.timeout_seconds * 1000
        const params: JsonObject = {
          path,
          time_limit: renderSamplingSeconds(budgetMs),
          agent_image: { stem, max_edge: AGENT_IMAGE_MAX_EDGE, max_bytes: AGENT_IMAGE_MAX_BYTES },
        }
        for (const key of ['width', 'height', 'engine', 'samples', 'camera'] as const) {
          const value = args[key]
          if (value !== undefined) params[key] = value
        }
        try {
          const reply = parseReply(RenderReply, 'render', await call('render', params, { signal, timeoutMs: budgetMs }))
          const image = await readAgentImage(reply.image, [path, ...agentImagePaths(stem)])
          const seconds = reply.seconds === null ? '' : ` in ${String(reply.seconds)} s`
          const scaled = reply.image.path === path ? '' : ` The image shown is a ${String(reply.image.width)}x${String(reply.image.height)} copy.`
          return withSetupNotes(dependencies, {
            text: `Rendered ${String(reply.width)}x${String(reply.height)} with ${reply.engine} from camera "${reply.camera}"${seconds} and saved ${reply.path}.${scaled}`,
            images: [image],
          })
        } finally {
          await removeFiles(agentImagePaths(stem))
        }
      },
    }),
    defineAppTool({
      name: 'python_api',
      title: 'Blender Python API',
      description: 'Read Blender Python API documentation from the running Blender: a type (bpy.types.Object), a property or '
        + 'function (bpy.types.Object.location), an operator (bpy.ops.mesh.primitive_cube_add) or operator module (bpy.ops.mesh), '
        + 'bpy.data and bpy.context members, or mathutils, bmesh, and bpy_extras names. Shows types, defaults, ranges, enum '
        + 'items, parameters, and descriptions for this Blender version.',
      input: { identifier: z.string().min(1).max(IDENTIFIER_MAX).describe('Dotted API name, for example bpy.types.Mesh.from_pydata.') },
      async run(args, signal) {
        const reply = parseReply(ApiReply, 'python_api', await call('python_api', { identifier: args.identifier }, { signal }))
        return withSetupNotes(dependencies, { text: reply.text })
      },
    }),
    defineAppTool({
      name: 'checkpoint',
      title: 'Checkpoint',
      description: 'Remember the current scene state so undo can return to it. new_scene and open_blend clear checkpoints.',
      input: {},
      async run(_args, signal) {
        const reply = parseReply(CheckpointReply, 'checkpoint', await call('checkpoint', {}, { signal }))
        return withSetupNotes(dependencies, { text: `Saved checkpoint ${String(reply.checkpoint)}; undo returns the scene to this state.` })
      },
    }),
    defineAppTool({
      name: 'undo',
      title: 'Undo',
      description: 'Return the scene to the latest checkpoint, discarding changes made since. Calling undo again right away goes '
        + 'back one more checkpoint, down to the scene as it was opened or created; Blender keeps only its 32 most recent undo steps, '
        + 'so older checkpoints expire.',
      input: {},
      async run(_args, signal) {
        const reply = parseReply(CheckpointReply, 'undo', await call('undo', {}, { signal }))
        const state = reply.checkpoint === 0 ? 'the state it was opened or created in' : `checkpoint ${String(reply.checkpoint)}`
        return withSetupNotes(dependencies, { text: `Restored the scene to ${state}. Look objects up by name again; Python references from before the undo may be invalid.` })
      },
    }),
  ]
}
