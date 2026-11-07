/**
 * GIMP MCP tools. Each tool validates the agent's arguments, sends one request to the worker
 * method of the same name, validates the worker's reply, and returns compact text plus images.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_EDGE, WorkerReplyError, defineAppTool, executePythonTool, formatBytes, replyParser,
  withSetupNotes, workerParams,
} from '@deepseek-ai/dsh-app-mcp'
import type { AppTool, AppToolDependencies, JsonObject } from '@deepseek-ai/dsh-app-mcp'

/** Longest image or layer side a tool call creates; the common GPU texture limit. */
export const IMAGE_MAX_SIDE = 8192

/** Most frame files one sprite sheet packs. */
export const SPRITE_SHEET_MAX_FRAMES = 256

/** Largest absolute coordinate, offset, or selection extent a tool call accepts, in pixels. */
export const COORDINATE_MAX = 65_536

const NAME_MAX = 200
const PATH_MAX = 4096
const TEXT_MAX = 10_000
const QUERY_MAX = 200
const COLOR_MAX = 100
const POSITION_MAX = 10_000
const ARGUMENTS_MAX = 100

const parseReply = replyParser('GIMP')

function absolutePath(description: string): z.ZodString {
  return z.string().min(1).max(PATH_MAX).refine(value => isAbsolute(value), 'must be an absolute path').describe(description)
}

const imageId = z.int().min(1).describe('Image id from new_image, open_image, or list_images.')

function layerRef(description: string): z.ZodUnion<readonly [z.ZodInt, z.ZodString]> {
  return z.union([z.int().min(1), z.string().min(1).max(NAME_MAX)]).describe(description)
}

function color(description: string): z.ZodString {
  return z.string().min(1).max(COLOR_MAX).describe(description)
}

function coordinate(description: string): z.ZodNumber {
  return z.number().min(-COORDINATE_MAX).max(COORDINATE_MAX).describe(description)
}

function offset(description: string): z.ZodInt {
  return z.int().min(-COORDINATE_MAX).max(COORDINATE_MAX).describe(description)
}

function side(description: string): z.ZodInt {
  return z.int().min(1).max(IMAGE_MAX_SIDE).describe(description)
}

/** One filter property or procedure argument: a number, string, boolean, id, or a flat array of them. */
const ArgumentValue = z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean()])),
])

function argumentsRecord(description: string): z.ZodRecord<z.ZodString, typeof ArgumentValue> {
  return z.record(z.string().min(1).max(QUERY_MAX), ArgumentValue)
    .refine(value => Object.keys(value).length <= ARGUMENTS_MAX, `must have at most ${String(ARGUMENTS_MAX)} entries`)
    .describe(description)
}

function omittedNote(omitted: number | undefined): string {
  return omitted === undefined ? '' : `\n(${String(omitted)} more not shown; narrow the query.)`
}

const ImageSize = z.object({ id: z.int(), width: z.int(), height: z.int() })

const Bounds = z.object({ x: z.int(), y: z.int(), width: z.int(), height: z.int() })

const LayerInfo = z.object({
  id: z.int(),
  name: z.string(),
  kind: z.enum(['layer', 'text', 'group']),
  x: z.int(),
  y: z.int(),
  width: z.int(),
  height: z.int(),
})

const ImageInfo = z.object({
  id: z.int(),
  width: z.int(),
  height: z.int(),
  layers: z.array(LayerInfo),
  also_open_as: z.array(z.int()).optional(),
})

const SnapshotReply = z.object({
  path: z.string(),
  mime_type: z.enum(['image/png', 'image/jpeg']),
  width: z.int(),
  height: z.int(),
  image: ImageSize,
  scale: z.number(),
  transparency: z.enum(['none', 'checkerboard']),
})

const ExportReply = z.object({
  path: z.string(), bytes: z.int(), format: z.string(), width: z.int(), height: z.int(), flattened: z.boolean(),
})

const SaveReply = z.object({ path: z.string(), bytes: z.int(), image: z.int() })

const CloseReply = z.object({ closed: z.int(), discarded_unsaved_changes: z.boolean() })

const LayerReply = z.object({
  image: ImageSize,
  layer: LayerInfo.nullable(),
  layers: z.array(z.json()),
  layer_count: z.int(),
  layers_omitted: z.int().optional(),
})

const SelectReply = z.object({ image: ImageSize, selection: Bounds.nullable() })

const TransformReply = z.object({ image: ImageSize, layer: LayerInfo.nullable() })

const DrawReply = z.object({ image: ImageSize, layer: LayerInfo, selection: Bounds.nullable() })

const FiltersReply = z.object({
  filters: z.array(z.object({ name: z.string(), title: z.string(), categories: z.string() })),
  count: z.int(),
  omitted: z.int().optional(),
})

const ApplyFilterReply = z.object({
  image: ImageSize, layer: LayerInfo, operation: z.string(), properties: z.record(z.string(), z.json()), selection: Bounds.nullable(),
})

const PdbSearchReply = z.object({
  procedures: z.array(z.object({ name: z.string(), summary: z.string() })),
  count: z.int(),
  omitted: z.int().optional(),
})

const PdbRunReply = z.object({ procedure: z.string(), values: z.union([z.record(z.string(), z.json()), z.string()]) })

const SpriteSheetReply = z.object({
  image: z.int(),
  output: z.string(),
  bytes: z.int(),
  width: z.int(),
  height: z.int(),
  columns: z.int(),
  rows: z.int(),
  frame_width: z.int(),
  frame_height: z.int(),
  cell_width: z.int(),
  cell_height: z.int(),
  padding: z.int(),
  frames: z.array(z.object({ index: z.int(), file: z.string(), x: z.int(), y: z.int(), width: z.int(), height: z.int() })),
})

const SeamlessReply = z.object({ image: ImageSize, layer: LayerInfo })

function describeLayer(layer: z.infer<typeof LayerInfo>): string {
  return `${layer.kind === 'text' ? 'text layer' : layer.kind} "${layer.name}" (id ${String(layer.id)})`
}

function describeBounds(bounds: z.infer<typeof Bounds>): string {
  return `${String(bounds.width)}x${String(bounds.height)} at ${String(bounds.x)},${String(bounds.y)}`
}

function withinSelection(selection: z.infer<typeof Bounds> | null): string {
  return selection === null ? '' : ` within the selection (${describeBounds(selection)})`
}

const LAYER_ACTIONS = ['add', 'duplicate', 'delete', 'rename', 'set', 'move', 'merge_down', 'merge_visible', 'flatten'] as const
const TRANSFORM_ACTIONS = ['scale_image', 'resize_canvas', 'crop', 'rotate', 'flip', 'scale_layer'] as const
const DRAW_ACTIONS = ['fill', 'gradient', 'text', 'clear'] as const

/** What each layer action did, for the result text; delete reports no layer. */
const LAYER_VERBS: Readonly<Record<(typeof LAYER_ACTIONS)[number], string>> = {
  add: 'Added', duplicate: 'Duplicated the layer as', delete: 'Deleted', rename: 'Renamed the layer to', set: 'Updated',
  move: 'Moved', merge_down: 'Merged down into', merge_visible: 'Merged the visible layers into', flatten: 'Flattened the image into',
}

/** What each transform action did, for the result text. */
const TRANSFORM_VERBS: Readonly<Record<(typeof TRANSFORM_ACTIONS)[number], string>> = {
  scale_image: 'Scaled the image', resize_canvas: 'Resized the canvas', crop: 'Cropped the image', rotate: 'Rotated',
  flip: 'Flipped', scale_layer: 'Scaled',
}

/** What each draw action did, for the result text. */
const DRAW_VERBS: Readonly<Record<(typeof DRAW_ACTIONS)[number], string>> = {
  fill: 'Filled', gradient: 'Painted a gradient on', text: 'Added', clear: 'Cleared',
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => { await rm(path, { force: true }) }))
}

/**
 * Build the GIMP tool set.
 * @param dependencies - worker access, setup notes, data directory, and timeout budgets.
 * @returns the tools in the order the server lists them.
 */
export function gimpTools(dependencies: AppToolDependencies): readonly AppTool<z.ZodRawShape>[] {
  const { call, dataRoot } = dependencies
  const snapshots = join(dataRoot, 'snapshots')
  return [
    defineAppTool({
      name: 'list_images',
      title: 'Open images',
      description: 'List the open images as JSON: id, name, file, size, color mode, precision, layer count, and whether they have unsaved changes.',
      input: {},
      async run(_args, signal) {
        return withSetupNotes(dependencies, { text: JSON.stringify(await call('list_images', {}, { signal })) })
      },
    }),
    defineAppTool({
      name: 'open_image',
      title: 'Open image',
      description: 'Open an image file in any format GIMP reads (.xcf with all layers, .png, .jpg, .webp, .psd, .tga, ...) and return its id with the image details as JSON.',
      input: { path: absolutePath('Absolute path of the image file.') },
      async run(args, signal) {
        const raw = await call('open_image', { path: args.path }, { signal })
        const info = parseReply(ImageInfo, 'open_image', raw)
        const also = info.also_open_as === undefined ? '' : ` The file is also open as image ${info.also_open_as.join(', ')}.`
        return withSetupNotes(dependencies, { text: `Opened ${args.path} as image ${String(info.id)}.${also}\n${JSON.stringify(raw)}` })
      },
    }),
    defineAppTool({
      name: 'new_image',
      title: 'New image',
      description: 'Create an RGB image with one layer named Background, filled with a color or transparent, and return its id.',
      input: {
        width: side('Width in pixels.'),
        height: side('Height in pixels.'),
        fill: color('transparent (default), white, black, or a color such as #336699, #33669980 (with alpha), or a CSS color name.').optional(),
        name: z.string().min(1).max(NAME_MAX).optional()
          .describe('Name that list_images and image_info show for the image until save_xcf saves it; they then show the .xcf file name.'),
      },
      async run(args, signal) {
        const info = parseReply(ImageInfo, 'new_image', await call('new_image', workerParams(args), { signal }))
        const layer = info.layers[0]
        const layerText = layer === undefined ? '' : ` with ${describeLayer(layer)}`
        return withSetupNotes(dependencies, {
          text: `Created image ${String(info.id)}, ${String(info.width)}x${String(info.height)}${layerText}, filled ${args.fill ?? 'transparent'}.`,
        })
      },
    }),
    defineAppTool({
      name: 'image_info',
      title: 'Image details',
      description: 'Describe an image as JSON: file, size, color mode, unsaved changes, the layer tree from the top (id, name, kind, '
        + 'type, visibility, opacity, blend mode, offset, size, alpha, and text, font, and color of text layers), the selected '
        + 'layers, and the selection bounds.',
      input: { image: imageId },
      async run(args, signal) {
        return withSetupNotes(dependencies, { text: JSON.stringify(await call('image_info', { image: args.image }, { signal })) })
      },
    }),
    defineAppTool({
      name: 'snapshot',
      title: 'Snapshot',
      description: 'Look at an image: show its visible layers composited as an image, scaled to fit max_size. Transparent areas '
        + 'show as a gray checkerboard, and images smaller than 256 pixels are enlarged by a whole factor without smoothing so '
        + 'pixels stay sharp. The image is not changed.',
      input: {
        image: imageId,
        max_size: z.int().min(16).max(AGENT_IMAGE_MAX_EDGE).optional().describe('Longest edge of the shown image in pixels (default 1024).'),
      },
      async run(args, signal) {
        const stem = join(snapshots, randomUUID())
        const files = [`${stem}.png`, `${stem}.jpg`]
        try {
          const params: JsonObject = { image: args.image, max_size: args.max_size ?? 1024, stem, max_bytes: AGENT_IMAGE_MAX_BYTES }
          const reply = parseReply(SnapshotReply, 'snapshot', await call('snapshot', params, { signal }))
          if (!files.includes(reply.path)) throw new WorkerReplyError(`The GIMP worker returned a snapshot outside the requested files: ${reply.path}`)
          const data = await readFile(reply.path)
          const source = reply.image
          const scale = reply.scale > 1 ? ` (enlarged ${String(reply.scale)}x without smoothing)` : reply.scale < 1 ? ' (reduced)' : ''
          const checkerboard = reply.transparency === 'checkerboard' ? ' Transparent areas show as a gray checkerboard.' : ''
          return withSetupNotes(dependencies, {
            text: `Image ${String(source.id)} (${String(source.width)}x${String(source.height)}) shown at ${String(reply.width)}x${String(reply.height)}${scale}.${checkerboard}`,
            images: [{ data, mimeType: reply.mime_type }],
          })
        } finally {
          await removeFiles(files)
        }
      },
    }),
    defineAppTool({
      name: 'export_image',
      title: 'Export image',
      description: 'Write the visible layers of an image, composited, to a file chosen by extension: .png, .webp, .jpg or .jpeg, '
        + '.tga, .bmp, .ico, or .xcf (all layers). .jpg and .bmp have no transparency, so transparent areas become white. Missing '
        + 'folders are created and the file is replaced in one step. The image itself is not changed.',
      input: {
        image: imageId,
        path: absolutePath('Absolute output path; its extension selects the format.'),
        quality: z.number().min(0).max(100).optional().describe('Quality 0-100 for .jpg, .jpeg, and .webp; without it, GIMP exports at 90.'),
      },
      async run(args, signal) {
        const reply = parseReply(ExportReply, 'export_image', await call('export_image', workerParams(args), { signal }))
        const flattened = reply.flattened ? '; transparent areas became white' : ''
        return withSetupNotes(dependencies, {
          text: `Exported image ${String(args.image)} to ${reply.path} (${reply.format.toUpperCase()}, ${String(reply.width)}x${String(reply.height)}, ${formatBytes(reply.bytes)}${flattened}).`,
        })
      },
    }),
    defineAppTool({
      name: 'save_xcf',
      title: 'Save .xcf file',
      description: 'Save an image with all its layers as a GIMP .xcf file. With path, save under that name (creating missing '
        + 'folders) and keep using it; without path, save to the .xcf file the image was opened from or last saved to.',
      input: {
        image: imageId,
        path: absolutePath('Absolute path ending in .xcf; omit to save to the image\'s current .xcf file.').optional(),
      },
      async run(args, signal) {
        const reply = parseReply(SaveReply, 'save_xcf', await call('save_xcf', workerParams(args), { signal }))
        return withSetupNotes(dependencies, { text: `Saved image ${String(reply.image)} with all layers to ${reply.path} (${formatBytes(reply.bytes)}).` })
      },
    }),
    defineAppTool({
      name: 'close_image',
      title: 'Close image',
      description: 'Close an image without saving; unsaved changes are discarded.',
      input: { image: imageId },
      async run(args, signal) {
        const reply = parseReply(CloseReply, 'close_image', await call('close_image', { image: args.image }, { signal }))
        const discarded = reply.discarded_unsaved_changes ? ' Its unsaved changes were discarded.' : ''
        return withSetupNotes(dependencies, { text: `Closed image ${String(reply.closed)}.${discarded}` })
      },
    }),
    defineAppTool({
      name: 'layer',
      title: 'Edit layers',
      description: 'Change the layers of an image and return its layer tree (top first) as JSON. add: new transparent layer of '
        + 'the image size (name, position, and the set properties). duplicate: copy above the source. delete, rename, set '
        + '(opacity, visible, mode, offset_x, offset_y, name), move (to position). merge_down: merge into the layer below. '
        + 'merge_visible: merge all visible layers. flatten: merge everything onto one opaque layer.',
      input: {
        image: imageId,
        action: z.enum(LAYER_ACTIONS).describe('What to do.'),
        layer: layerRef('Layer id or exact name; default: the selected layer. Required for delete, rename, set, and move.').optional(),
        name: z.string().min(1).max(NAME_MAX).optional().describe('Layer name for add, duplicate, rename, and set.'),
        opacity: z.number().min(0).max(100).optional().describe('Opacity 0-100 for add and set.'),
        visible: z.boolean().optional().describe('Visibility for add and set.'),
        mode: z.string().min(1).max(NAME_MAX).optional()
          .describe('Blend mode for add and set, such as normal, multiply, screen, overlay, addition, subtract, darken-only, lighten-only, or erase.'),
        offset_x: offset('Left edge of the layer in image pixels, for add and set.').optional(),
        offset_y: offset('Top edge of the layer in image pixels, for add and set.').optional(),
        position: z.int().min(0).max(POSITION_MAX).optional().describe('Stack position among sibling layers, 0 being the top; for add and move.'),
      },
      async run(args, signal) {
        const reply = parseReply(LayerReply, 'layer', await call('layer', workerParams(args), { signal }))
        const done = reply.layer === null ? 'Deleted the layer.' : `${LAYER_VERBS[args.action]} ${describeLayer(reply.layer)}.`
        const omitted = reply.layers_omitted === undefined ? '' : ` (${String(reply.layers_omitted)} more not shown)`
        return withSetupNotes(dependencies, {
          text: `${done} Image ${String(reply.image.id)} has ${String(reply.layer_count)} layers${omitted}:\n${JSON.stringify(reply.layers)}`,
        })
      },
    }),
    defineAppTool({
      name: 'select',
      title: 'Select',
      description: 'Change the selection of an image. Fill, clear, gradients, and filters then act only inside it; select none to '
        + 'act on whole layers again. rect and ellipse take x, y, width, and height; color selects pixels within threshold of '
        + 'color on a layer; grow, shrink, and feather take amount in pixels; all, none, and invert take nothing else.',
      input: {
        image: imageId,
        mode: z.enum(['all', 'none', 'invert', 'rect', 'ellipse', 'color', 'grow', 'shrink', 'feather']).describe('Selection operation.'),
        x: coordinate('Left edge for rect and ellipse (default 0).').optional(),
        y: coordinate('Top edge for rect and ellipse (default 0).').optional(),
        width: z.number().min(1).max(COORDINATE_MAX).optional().describe('Width for rect and ellipse.'),
        height: z.number().min(1).max(COORDINATE_MAX).optional().describe('Height for rect and ellipse.'),
        color: color('Color to select for color mode, such as #ff0000.').optional(),
        threshold: z.number().min(0).max(255).optional().describe('Color difference 0-255 still selected in color mode (default 15).'),
        layer: layerRef('Layer to sample in color mode; default: the selected layer.').optional(),
        amount: z.number().min(0).max(IMAGE_MAX_SIDE).optional().describe('Pixels for grow, shrink, and feather.'),
        operation: z.enum(['replace', 'add', 'subtract', 'intersect']).optional()
          .describe('How rect, ellipse, and color combine with the current selection (default replace).'),
      },
      async run(args, signal) {
        const reply = parseReply(SelectReply, 'select', await call('select', workerParams(args), { signal }))
        const id = String(reply.image.id)
        return withSetupNotes(dependencies, {
          text: reply.selection === null
            ? `Nothing is selected in image ${id}; edits apply to whole layers.`
            : `The selection of image ${id} spans ${describeBounds(reply.selection)} (bounding box).`,
        })
      },
    }),
    defineAppTool({
      name: 'transform',
      title: 'Transform',
      description: 'Change image or layer geometry. scale_image: resample the whole image to width and/or height (the missing one '
        + 'keeps the aspect ratio). resize_canvas: change the canvas to width x height, moving the content by x, y; then each layer '
        + 'that is neither a text layer nor a group, including the layers inside groups, takes the canvas size, and text layers '
        + 'keep theirs. crop: keep the width x height rectangle at x, y. rotate: the '
        + 'whole image by 90, 180, or 270 degrees clockwise, or with layer one layer by any angle. flip: horizontal or vertical '
        + 'axis, the image or one layer. '
        + 'scale_layer: resample one layer to width and/or height, optionally placing it at x, y.',
      input: {
        image: imageId,
        action: z.enum(TRANSFORM_ACTIONS).describe('Transformation.'),
        width: side('New width in pixels for scale_image, resize_canvas, crop, and scale_layer.').optional(),
        height: side('New height in pixels for scale_image, resize_canvas, crop, and scale_layer.').optional(),
        x: offset('Content offset for resize_canvas, crop origin for crop, or new left edge for scale_layer.').optional(),
        y: offset('Content offset for resize_canvas, crop origin for crop, or new top edge for scale_layer.').optional(),
        angle: z.number().min(-360).max(360).optional().describe('Clockwise degrees for rotate.'),
        axis: z.enum(['horizontal', 'vertical']).optional().describe('Mirror axis for flip: horizontal swaps left and right.'),
        layer: layerRef('Layer for rotate and flip (omit to rotate or flip the whole image) and for scale_layer (default: the selected layer).').optional(),
        interpolation: z.enum(['none', 'linear', 'cubic', 'nohalo', 'lohalo']).optional()
          .describe('Resampling for scaling and rotation (default cubic); none keeps pixel art sharp.'),
      },
      async run(args, signal) {
        const reply = parseReply(TransformReply, 'transform', await call('transform', workerParams(args), { signal }))
        const verb = TRANSFORM_VERBS[args.action]
        const size = `${String(reply.image.width)}x${String(reply.image.height)}`
        const text = reply.layer === null
          ? `${verb}; image ${String(reply.image.id)} is now ${size}.`
          : `${verb} ${describeLayer(reply.layer)}; it is now ${describeBounds(reply.layer)} in image ${String(reply.image.id)} (${size}).`
        return withSetupNotes(dependencies, { text })
      },
    }),
    defineAppTool({
      name: 'draw',
      title: 'Draw',
      description: 'Paint on a layer. fill: fill the selection, or the whole layer, with color (its alpha sets the opacity). '
        + 'clear: make the selection, or the whole layer, transparent. gradient: linear gradient from color at x, y to color2 at '
        + 'x2, y2 (default: across the layer from left to right), within the selection. text: new text layer with text in '
        + 'font at size pixels, top-left corner at x, y, above layer or at the top.',
      input: {
        image: imageId,
        action: z.enum(DRAW_ACTIONS).describe('What to paint.'),
        layer: layerRef('Layer to paint on (default: the selected layer); for text, the layer to put the text above.').optional(),
        color: color('Fill color, gradient start color, or text color (#rrggbb, #rrggbbaa, or a CSS color name).').optional(),
        color2: color('Gradient end color.').optional(),
        x: coordinate('Gradient start or text left edge, in image pixels.').optional(),
        y: coordinate('Gradient start or text top edge, in image pixels.').optional(),
        x2: coordinate('Gradient end, in image pixels.').optional(),
        y2: coordinate('Gradient end, in image pixels.').optional(),
        text: z.string().min(1).max(TEXT_MAX).optional().describe('Text for the text action.'),
        font: z.string().min(1).max(NAME_MAX).optional().describe('Font name such as "Sans-serif" (default), "Serif Bold", or "Monospace".'),
        size: z.number().min(1).max(2000).optional().describe('Font size in pixels (default 32).'),
      },
      async run(args, signal) {
        const reply = parseReply(DrawReply, 'draw', await call('draw', workerParams(args), { signal }))
        const where = args.action === 'text' ? `, ${describeBounds(reply.layer)}` : withinSelection(reply.selection)
        return withSetupNotes(dependencies, {
          text: `${DRAW_VERBS[args.action]} ${describeLayer(reply.layer)} of image ${String(reply.image.id)}${where}.`,
        })
      },
    }),
    defineAppTool({
      name: 'filters',
      title: 'Filter list',
      description: 'List the filter operations apply_filter can use (blur, noise, distort, light, color, artistic, edge, and '
        + 'more) whose name, title, or category contains query, with titles and categories.',
      input: { query: z.string().max(QUERY_MAX).optional().describe('Case-insensitive text to look for, such as blur, noise, or outline.') },
      async run(args, signal) {
        const reply = parseReply(FiltersReply, 'filters', await call('filters', workerParams(args), { signal }))
        const scope = args.query === undefined || args.query === '' ? '' : ` match "${args.query}"`
        const lines = reply.filters.map(filter => `${filter.name}: ${filter.title} (${filter.categories})`)
        return withSetupNotes(dependencies, { text: `${String(reply.count)} filter operations${scope}.\n${lines.join('\n')}${omittedNote(reply.omitted)}`.trimEnd() })
      },
    }),
    defineAppTool({
      name: 'filter_info',
      title: 'Filter details',
      description: 'Describe a filter operation as JSON: title, description, and each property with its type, range, default, '
        + 'and choices, which apply_filter accepts by name.',
      input: { operation: z.string().min(1).max(QUERY_MAX).describe('Operation name from filters, such as gegl:gaussian-blur.') },
      async run(args, signal) {
        return withSetupNotes(dependencies, { text: JSON.stringify(await call('filter_info', { operation: args.operation }, { signal })) })
      },
    }),
    defineAppTool({
      name: 'apply_filter',
      title: 'Apply filter',
      description: 'Apply a filter operation to a layer, within the selection when there is one, and keep the result. '
        + 'Properties not given keep their defaults; filter_info lists them.',
      input: {
        image: imageId,
        layer: layerRef('Layer id or exact name; default: the selected layer.').optional(),
        operation: z.string().min(1).max(QUERY_MAX).describe('Operation name, such as gegl:gaussian-blur or gegl:pixelize.'),
        properties: argumentsRecord('Property values by name, such as {"std-dev-x": 3, "std-dev-y": 3}; colors as "#rrggbb".').optional(),
      },
      async run(args, signal) {
        const reply = parseReply(ApplyFilterReply, 'apply_filter', await call('apply_filter', workerParams(args), { signal }))
        const properties = Object.keys(reply.properties).length === 0 ? '' : ` with ${JSON.stringify(reply.properties)}`
        return withSetupNotes(dependencies, {
          text: `Applied ${reply.operation}${properties} to ${describeLayer(reply.layer)} of image ${String(reply.image.id)}${withinSelection(reply.selection)}.`,
        })
      },
    }),
    defineAppTool({
      name: 'pdb_search',
      title: 'Find GIMP procedures',
      description: 'Search GIMP\'s procedure database, the operations pdb_run can call, by name or summary. Procedure names '
        + 'use hyphens, such as gimp-image-convert-indexed. Image effects are mostly filters: use the filters tool for those.',
      input: { query: z.string().min(1).max(QUERY_MAX).describe('Case-insensitive text, such as indexed, guide, or layer-mask.') },
      async run(args, signal) {
        const reply = parseReply(PdbSearchReply, 'pdb_search', await call('pdb_search', { query: args.query }, { signal }))
        if (reply.count === 0) return withSetupNotes(dependencies, { text: `No procedures match "${args.query}". For image effects, try the filters tool.` })
        const lines = reply.procedures.map(procedure => `${procedure.name}: ${procedure.summary}`)
        return withSetupNotes(dependencies, { text: `${String(reply.count)} procedures match "${args.query}".\n${lines.join('\n')}${omittedNote(reply.omitted)}` })
      },
    }),
    defineAppTool({
      name: 'pdb_describe',
      title: 'Describe GIMP procedure',
      description: 'Describe a procedure as JSON: summary, help, and its arguments and return values with types, ranges, '
        + 'defaults, and choices.',
      input: { procedure: z.string().min(1).max(QUERY_MAX).describe('Procedure name, such as gimp-image-convert-indexed.') },
      async run(args, signal) {
        return withSetupNotes(dependencies, { text: JSON.stringify(await call('pdb_describe', { procedure: args.procedure }, { signal })) })
      },
    }),
    defineAppTool({
      name: 'pdb_run',
      title: 'Run GIMP procedure',
      description: 'Run a procedure without dialogs and return its return values as JSON. Give arguments by name: images and '
        + 'layers as ids, files as absolute paths, colors as "#rrggbb", choices and enums by name, units as pixel, inch, or '
        + 'mm, and arrays as JSON arrays. Arguments not given keep the defaults pdb_describe lists; give a value for each one whose '
        + 'default is null, such as an empty string for an unused name. run-mode is always non-interactive.',
      input: {
        procedure: z.string().min(1).max(QUERY_MAX).describe('Procedure name from pdb_search.'),
        arguments: argumentsRecord('Arguments by name, such as {"image": 1, "new-width": 64, "new-height": 64}.').optional(),
      },
      async run(args, signal) {
        const reply = parseReply(PdbRunReply, 'pdb_run', await call('pdb_run', workerParams(args), { signal }))
        const values = typeof reply.values === 'string' || Object.keys(reply.values).length > 0
          ? ` Return values: ${JSON.stringify(reply.values)}`
          : ''
        return withSetupNotes(dependencies, { text: `Ran ${reply.procedure}.${values}` })
      },
    }),
    executePythonTool(dependencies, {
      app: 'GIMP',
      title: 'Run GIMP Python',
      description: 'Run Python in the GIMP session. Gimp, Gegl, Gio, GLib, and GObject are imported, images maps each open '
        + 'image id to its Gimp.Image, and names you define persist between calls. Assign `result` to return a value as JSON '
        + '(images become {image}, layers {item, name}, colors hex strings, other objects their repr). Printed output is '
        + 'returned, up to 20000 characters. An exception makes the call fail and returns its traceback. When the timeout '
        + 'expires, GIMP restarts and open images and unsaved changes are lost.',
    }),
    defineAppTool({
      name: 'make_sprite_sheet',
      title: 'Make sprite sheet',
      description: 'Pack image files into one sprite sheet: frames fill a grid row by row, each centered in a cell of the largest '
        + 'frame size plus padding on every side. The sheet is exported to output by extension, stays open as a new image, and '
        + 'the result lists each frame\'s rectangle for the game engine.',
      input: {
        paths: z.array(absolutePath('Absolute path of a frame image.')).min(1).max(SPRITE_SHEET_MAX_FRAMES).describe('Frame files in order.'),
        columns: z.int().min(1).max(SPRITE_SHEET_MAX_FRAMES).describe('Frames per row.'),
        output: absolutePath('Absolute output path, such as .png or .webp.'),
        padding: z.int().min(0).max(1024).optional().describe('Transparent pixels around each frame (default 0).'),
      },
      async run(args, signal) {
        const reply = parseReply(SpriteSheetReply, 'make_sprite_sheet', await call('make_sprite_sheet', workerParams(args), { signal }))
        return withSetupNotes(dependencies, {
          text: `Packed ${String(reply.frames.length)} frames into ${reply.output} (${String(reply.width)}x${String(reply.height)}, `
            + `${formatBytes(reply.bytes)}): ${String(reply.columns)} columns x ${String(reply.rows)} rows of ${String(reply.cell_width)}x`
            + `${String(reply.cell_height)} cells (frames up to ${String(reply.frame_width)}x${String(reply.frame_height)}, padding `
            + `${String(reply.padding)}). The sheet is open as image ${String(reply.image)}.\nFrames: ${JSON.stringify(reply.frames)}`,
        })
      },
    }),
    defineAppTool({
      name: 'make_seamless',
      title: 'Make seamless texture',
      description: 'Make a layer tile seamlessly, for repeating textures: cross-fade it with a copy of itself shifted by half its '
        + 'width, then with a copy shifted by half its height, so that each edge continues the opposite one. The middle keeps the '
        + 'original pixels and the edges show the shifted copy, so a distinct shape can appear twice, faded; noise-like textures '
        + 'such as grass, stone, or sand suit it best. Acts on the whole layer regardless of the selection.',
      input: {
        image: imageId,
        layer: layerRef('Layer id or exact name; default: the selected layer.').optional(),
      },
      async run(args, signal) {
        const reply = parseReply(SeamlessReply, 'make_seamless', await call('make_seamless', workerParams(args), { signal }))
        return withSetupNotes(dependencies, { text: `Made ${describeLayer(reply.layer)} of image ${String(reply.image.id)} tile seamlessly.` })
      },
    }),
  ]
}
