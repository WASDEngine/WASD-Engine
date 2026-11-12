/**
 * Browser-safe types of the asset tools: what an `asset_view` call asks a WASD Engine window to draw, the details and
 * images the window answers with, and the two forwarded events, the `game-assets/render` request and the
 * `game-assets/reveal` notification that opens an asset in the window's Assets tab.
 * @module @deepseek-ai/dsh-game-assets/types
 */
import type {} from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AssetKind } from './formats.ts'

/** A direction a model is drawn from: `iso` looks from the front right and above, `front` along the model's -Z. */
export type AssetViewDirection = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'

/** How a model's surfaces are drawn: its own materials, a uniform clay, or the edges of its triangles. */
export type AssetShading = 'material' | 'solid' | 'wireframe'

/** A rectangle of an image, in pixels from its top left corner. */
export interface AssetRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A sprite sheet grid: frames left to right, then top to bottom. */
export interface AssetGrid {
  readonly columns: number
  readonly rows: number
  /** Frames the sheet holds when its last row is not full; every cell by default. */
  readonly count?: number
}

/** What one call asks to see of an asset. Only the fields of the asset's kind apply. */
export interface AssetDrawOptions {
  /** Model: directions to draw, each a tile of the image. */
  readonly views: readonly AssetViewDirection[]
  /** Model: how surfaces are drawn. */
  readonly shading: AssetShading
  /** Model: draw the bones over the model. */
  readonly skeleton: boolean
  /** A model's clip or an image's animation, by the name its details list, to draw frames across. */
  readonly animation?: string
  /** Frames drawn across the animation. */
  readonly frames?: number
  /** Model: seconds into the animation for one pose, instead of frames across it. */
  readonly time?: number
  /** Image: read the image as a sprite sheet of this grid. */
  readonly grid?: AssetGrid
  /** Image: frames per second of a grid, sequence, or sheet without its own timing. */
  readonly fps?: number
  /** Image: the rectangle to draw instead of the whole image. */
  readonly region?: AssetRegion
  /** Longest edge of the returned image in pixels. */
  readonly size: number
}

/** One render request as the Host forwards it to a window: JSON fields only. */
export interface AssetRenderRequest {
  /**
   * Workspace path of the asset to draw, never a Blender file: `/`-separated and relative to the folder in the
   * Session's header, against which the window resolves the Session's paths, or absolute for a file outside it.
   */
  readonly path: string
  /** Whether the asset is a picture or a model. */
  readonly kind: AssetKind
  /** What to draw. */
  readonly draw: AssetDrawOptions
  /** Whether to draw images; false asks for the details alone, as for a model that does not accept images. */
  readonly images: boolean
  /** Size in bytes, when the call looked, of the file and of the buffers and images a glTF file names. */
  readonly bytes: number
  /** Largest file the window reads, in bytes. */
  readonly maxBytes: number
  /** Largest area of one returned image, in pixels. */
  readonly maxPixels: number
}

/** The `game-assets/render` request on the Host: the JSON fields, the calling Agent, and the call's cancellation. */
export interface AssetRenderEvent extends AssetRenderRequest {
  /** The Agent whose Session's workspace holds the asset; the scope of the request. */
  agent?: Agent
  /** Ends the request when the call ends. */
  signal?: AbortSignal
}

/** One image a window drew. */
export interface AssetRenderedImage {
  /** Base64 of the encoded image. */
  readonly data: string
  readonly mediaType: 'image/png' | 'image/jpeg'
  readonly width: number
  readonly height: number
  /** What the image shows, such as `iso and front views, materials`. */
  readonly caption: string
}

/** How an image's pixels use transparency. */
export type AssetTransparency = 'opaque' | 'cutout' | 'translucent'

/** Where a 2D animation comes from. */
export type SpriteAnimationSource = 'frames' | 'sequence' | 'godot' | 'sheet' | 'grid'

/** One 2D animation that an image plays or takes part in. */
export interface SpriteAnimationDetails {
  /** Name to pass as `animation`; unique among the image's animations. */
  readonly name: string
  /**
   * `frames`: the image's own frames (animated GIF, WebP, or PNG); `sequence`: numbered images beside it; `godot`: a
   * Godot SpriteFrames animation or Sprite2D frame grid that uses it; `sheet`: a sprite sheet JSON file beside it;
   * `grid`: the grid the call or the reader gave.
   */
  readonly source: SpriteAnimationSource
  /** Workspace path of the file that defines the animation: the Godot scene or resource, or the sheet JSON. */
  readonly definedIn?: string
  readonly frames: number
  /** Frames per second at normal speed; frames with their own durations report their average. */
  readonly fps: number
  /** Length of one pass in seconds. */
  readonly seconds: number
  readonly loop: boolean
  /** Size of one frame in pixels, when every frame has the same size. */
  readonly frameWidth?: number
  readonly frameHeight?: number
}

/** What a window found in an image. */
export interface ImageAssetDetails {
  readonly kind: 'image'
  /** Format label, such as PNG. */
  readonly format: string
  /** File size in bytes. */
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly transparency: AssetTransparency
  /** Distinct colors of the first frame, counted up to 257; 257 means more than 256. */
  readonly colors: number
  readonly animations: readonly SpriteAnimationDetails[]
}

/** One material of a model. */
export interface ModelMaterialDetails {
  readonly name: string
  /** three.js material type, such as `MeshStandardMaterial`. */
  readonly type: string
  /** Base color as `#rrggbb`. */
  readonly color?: string
  readonly metalness?: number
  readonly roughness?: number
  /** Texture slots with the texture's name, such as `map` → `body.png`. */
  readonly maps: readonly { readonly slot: string; readonly texture: string }[]
  readonly transparent: boolean
  readonly doubleSided: boolean
  readonly vertexColors: boolean
}

/** One texture of a model. */
export interface ModelTextureDetails {
  readonly name: string
  readonly width: number
  readonly height: number
}

/** One bone of a model's skeletons. */
export interface ModelBoneDetails {
  readonly name: string
  /** Index of the parent bone in the bone list; absent for a root. */
  readonly parent?: number
}

/** One animation clip of a model. */
export interface ModelClipDetails {
  readonly name: string
  readonly seconds: number
  /** Animated properties. */
  readonly tracks: number
  /** Names of the animated bones and nodes, at most 24. */
  readonly targets: readonly string[]
  /** Animated bones and nodes in all. */
  readonly targetCount: number
}

/** The morph targets (shape keys) of one mesh. */
export interface ModelMorphDetails {
  readonly mesh: string
  readonly targets: readonly string[]
}

/** What a window found in a model. */
export interface ModelAssetDetails {
  readonly kind: 'model'
  readonly format: string
  readonly bytes: number
  /** Axis-aligned bounds in the model's units, x, y, z, in its rest pose. */
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
  readonly triangles: number
  readonly vertices: number
  readonly meshes: number
  readonly nodes: number
  /** Materials, at most 48; `materialCount` counts all. */
  readonly materials: readonly ModelMaterialDetails[]
  readonly materialCount: number
  /** Textures, at most 48; `textureCount` counts all. */
  readonly textures: readonly ModelTextureDetails[]
  readonly textureCount: number
  /** Bones in depth-first order, at most 256; `boneCount` counts all. */
  readonly bones: readonly ModelBoneDetails[]
  readonly boneCount: number
  readonly animations: readonly ModelClipDetails[]
  readonly morphTargets: readonly ModelMorphDetails[]
  /** Files the model names that could not be loaded, such as missing textures. */
  readonly missing: readonly string[]
}

/** What a window found in an asset. */
export type AssetDetails = ImageAssetDetails | ModelAssetDetails

/** A window's answer to a render request. */
export interface AssetRenderResult {
  readonly details: AssetDetails
  /** The drawn images, none when the request asked for details alone. */
  readonly images: readonly AssetRenderedImage[]
}

/** The `game-assets/reveal` notification: open one asset in a Session's Assets tab. */
export interface AssetReveal {
  /** The Session whose Assets tab opens: the calling agent's, or the root of its subagent tree. */
  readonly sessionId: SessionId
  /** Workspace path of the asset, as {@link AssetRenderRequest.path} names it for this Session. */
  readonly path: string
  /** The clip or 2D animation to play, by name. */
  readonly animation?: string
  /** The sprite grid to read the image as. */
  readonly grid?: AssetGrid
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask the windows that may read a Session to draw one asset of its workspace as the Assets tab draws it. Return the
     * details and images to claim the request, or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - the asset, what to draw, the bounds, the calling Agent, and the call's cancellation.
     * @mode waterfall
     */
    'game-assets/render'(
      this: Scoped<Agent>,
      request: AssetRenderEvent,
      next: () => Promise<AssetRenderResult>,
    ): Promise<AssetRenderResult>
    /**
     * An agent asked to show an asset to the user; the windows that may read the Session open it in the Session's
     * Assets tab.
     * @mode emit
     * @param reveal - the Session, the asset, and the animation to play.
     */
    'game-assets/reveal'(reveal: AssetReveal): void
  }
}
