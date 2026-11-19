/**
 * The model-facing image tool: `image_generate` makes one image with Google's Nano Banana 2.1 from a prompt and up to
 * 14 images to edit or to match, and saves it as a PNG, JPEG, or WebP file in the game project. The image comes from
 * the WASD Engine API, which makes it with Google's Gemini API and charges the signed-in account's plan. One set of
 * definitions serves one {@link ImageToolSurface}: the Session's own agent, or agents connected through WASD Engine's
 * MCP server.
 * @module @deepseek-ai/dsh-image-generation/src/tools
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImageApi } from './api.ts'
import { encodeForSaving, fitForSending, MAX_READ_BYTES, MAX_SENT_TOTAL_BYTES, UnreadableImage } from './files.ts'
import type { ImageAspectRatio, ImageFormat, ImageSize, SentImage } from './types.ts'
import { kilobytes, namedFileSize, reservePath, textBlocks, writeWhole } from '@deepseek-ai/dsh-game-mcp/kit'

/** Nano Banana 2.1's image shapes, width to height. */
export const IMAGE_ASPECT_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1',
] as const satisfies readonly ImageAspectRatio[]

/** Nano Banana 2.1's resolutions. */
export const IMAGE_SIZES = ['1K', '2K', '4K'] as const satisfies readonly ImageSize[]

/** Longest prompt of one call. */
export const MAX_PROMPT_CHARACTERS = 10_000

/** Most images one call sends: Nano Banana 2.1 takes up to 10 of objects and 4 of characters. */
export const MAX_IMAGES = 14

/** The model that makes the images, as results name it. */
const MODEL_NAME = 'Nano Banana 2.1'

/** The file type of each extension a path may end in. */
const FORMATS: Readonly<Record<string, ImageFormat>> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }

/** How one set of tool definitions reaches its callers. */
export interface ImageToolSurface {
  /** How the `path` parameter describes the file a call writes to these callers. */
  readonly pathDescription: string
  /** How the `images` parameter describes the images a call sends to these callers. */
  readonly imagesDescription: string
}

/** What the tool needs from the plugin. */
export interface ImageToolHost {
  /** The WASD Engine image API. */
  readonly api: ImageApi
  /** Time limit of one call in milliseconds. */
  readonly generationTimeoutMs: number
  /**
   * The file one call names.
   * @param requested - the path the call names: absolute, or relative to the calling Session's working directory.
   * @param exec - the call's execution.
   * @returns the absolute path.
   * @throws Error for a network path ({@link isNetworkPath}).
   */
  file(requested: string, exec: ToolRunContext): Promise<string>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true, description: 'Absolute path of the file written.' },
    file: { type: 'string', required: true, description: 'The path as the call named it.' },
    format: { type: 'string', enum: ['png', 'jpeg', 'webp'], required: true },
    width: INTEGER,
    height: INTEGER,
    bytes: INTEGER,
    replaced: { type: 'boolean', required: true },
    images: { type: 'array', required: true, items: { type: 'string' }, description: 'The images sent, as the call named them.' },
    aspectRatio: STRING,
    size: STRING,
  },
} as const

/** The value of `image_generate`. */
type ImageValue = InferValue<typeof IMAGE_SCHEMA>

/**
 * The supported shape closest to an image's.
 * @param width - the image's width.
 * @param height - the image's height.
 * @returns the aspect ratio whose width-to-height ratio is nearest on a logarithmic scale.
 */
export function closestAspectRatio(width: number, height: number): ImageAspectRatio {
  const target = Math.log(width / height)
  const distance = (ratio: ImageAspectRatio): number => {
    const [across, down] = ratio.split(':').map(Number) as [number, number]
    return Math.abs(Math.log(across / down) - target)
  }
  return IMAGE_ASPECT_RATIOS.reduce((best, ratio) => distance(ratio) < distance(best) ? ratio : best)
}

/**
 * The file type of a path, from its extension.
 * @throws Error when the extension is not one the tool writes.
 */
function formatOf(path: string): ImageFormat {
  const format = FORMATS[extname(path).toLowerCase()]
  if (format === undefined) throw new Error('path must end in .png, .jpg, .jpeg, or .webp; it names the file type.')
  return format
}

/**
 * Read the images one call sends and fit each to what the API takes.
 * @throws Error when one is missing, not an image, or they are too large together.
 */
async function readImages(host: ImageToolHost, requested: readonly string[], exec: ToolRunContext): Promise<SentImage[]> {
  if (requested.length > MAX_IMAGES) throw new Error(`images must name at most ${MAX_IMAGES} images.`)
  const images: SentImage[] = []
  let total = 0
  for (const file of requested) {
    const path = await host.file(file, exec)
    const size = await namedFileSize(path, file)
    if (size > MAX_READ_BYTES) throw new Error(`${file} is larger than ${MAX_READ_BYTES / (1024 * 1024)} MB; pass a smaller image.`)
    let image: SentImage
    try {
      image = await fitForSending(await readFile(path))
    } catch (error) {
      if (error instanceof UnreadableImage) throw new Error(`${file} ${error.message}`, { cause: error })
      throw error
    }
    total += image.data.byteLength
    images.push(image)
  }
  if (total > MAX_SENT_TOTAL_BYTES) {
    throw new Error(`The images come to ${kilobytes(total)}, more than the ${MAX_SENT_TOTAL_BYTES / (1024 * 1024)} MB one call sends; pass fewer or smaller images.`)
  }
  return images
}

function render(value: ImageValue): string {
  const sent = value.images.length === 0 ? '' : ` Made from ${value.images.length === 1 ? '1 image' : `${value.images.length} images`}: ${value.images.join(', ')}.`
  return `Saved a ${value.width}×${value.height} image (${MODEL_NAME}, ${value.size}, ${value.aspectRatio}) to ${value.file} (${kilobytes(value.bytes)}${value.replaced ? ', replaced' : ''}).${sent}`
}

/**
 * Build the image tool definitions.
 * @param host - plugin operations the tool calls.
 * @param surface - how these definitions reach their callers.
 * @returns the definitions, not registered.
 */
export function imageToolDefinitions(host: ImageToolHost, surface: ImageToolSurface): ToolDefinition[] {
  return [defineTool({
    name: 'image_generate',
    description: `Make an image with Google's ${MODEL_NAME} and save it as a .png, .jpg, or .webp file: game art such as sprites, characters, items, icons, portraits, backgrounds, and tiles; UI art such as buttons, panels, frames, and HUD pieces; screen mockups and concept art; and textures for 3D models. To work from reference images, edit images, or keep a character, object, or art style consistent, pass them in images and say what to take from each or what to change. Describe the subject, art style, view, lighting, colors, and background. Nano Banana makes no transparent backgrounds: for a sprite or a UI piece, ask for a flat background of one color the art does not use, such as pure magenta, then make that color transparent with GIMP, with a little tolerance for JPEG edges. For a texture, ask for a flat, evenly lit, top-down texture without shadows, then make it seamless with GIMP. Look at each result with asset_view before building on it, and make the image again with a better prompt when it falls short.`,
    parameters: {
      prompt: { type: 'string', required: true, description: `What to make, or what to change in the images, at most ${MAX_PROMPT_CHARACTERS} characters.` },
      path: { type: 'string', required: true, description: `${surface.pathDescription} Ends in .png, .jpg, .jpeg, or .webp.` },
      images: { type: 'array', items: { type: 'string' }, description: `${surface.imagesDescription} At most ${MAX_IMAGES}: images to edit, references to work from, or images whose character, object, or art style to match. Default: none.` },
      aspect_ratio: { type: 'string', enum: [...IMAGE_ASPECT_RATIOS], description: 'Shape, width to height. Default: the shape of the first image, or 1:1 without images.' },
      size: { type: 'string', enum: [...IMAGE_SIZES], description: '1K (about 1 megapixel), 2K (about 4), or 4K (about 16). Default: 1K.' },
      replace: { type: 'boolean', description: 'Overwrite the file when it exists. Default: false.' },
    },
    output: {
      schema: IMAGE_SCHEMA,
      render: (_args, value) => textBlocks(render(value)),
    },
    timeoutMs: host.generationTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt === '') throw new Error('prompt must not be empty.')
      if (prompt.length > MAX_PROMPT_CHARACTERS) throw new Error(`prompt must be at most ${MAX_PROMPT_CHARACTERS} characters; it has ${prompt.length}.`)
      const format = formatOf(args.path)
      const size = args.size ?? '1K'
      if (!(IMAGE_SIZES as readonly string[]).includes(size)) throw new Error('size must be 1K, 2K, or 4K.')
      if (args.aspect_ratio !== undefined && !(IMAGE_ASPECT_RATIOS as readonly string[]).includes(args.aspect_ratio)) {
        throw new Error(`aspect_ratio must be one of ${IMAGE_ASPECT_RATIOS.join(', ')}.`)
      }
      const requested = args.images ?? []
      const images = await readImages(host, requested, exec)
      const first = images[0]
      const aspectRatio = args.aspect_ratio ?? (first === undefined ? '1:1' : closestAspectRatio(first.width, first.height))
      const path = await host.file(args.path, exec)
      const reservation = await reservePath(path, args.path, args.replace === true, 'image_generate')
      let saved
      try {
        const image = await host.api.generate({ prompt, images, aspectRatio, size }, exec.signal)
        saved = await encodeForSaving(image, format)
        await writeWhole(path, saved.data)
      } catch (error) {
        await reservation.release()
        throw error
      }
      return {
        path, file: args.path, format, width: saved.width, height: saved.height, bytes: saved.data.byteLength,
        replaced: reservation.replaced, images: [...requested], aspectRatio, size,
      }
    },
  })]
}
