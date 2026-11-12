/**
 * Validation of a window's answer to a render request. The answer comes from a browser, so its details and images are
 * checked field by field, with every list and string bounded, before any of it reaches a tool result.
 * @module @deepseek-ai/dsh-game-assets/src/result
 */
import { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AssetDetails, AssetRenderResult } from './types.ts'

/** Images one answer may carry. */
export const MAX_ANSWER_IMAGES = 4

/** Longest base64 text of one image: 16 MiB of image bytes. */
const MAX_IMAGE_BASE64 = Math.ceil((16 * 1024 * 1024) / 3) * 4

const name = z.string().max(512)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const measure = z.number()
const positive = z.number().int().min(1).max(1_000_000)
const point = z.tuple([measure, measure, measure])

const spriteAnimation = z.strictObject({
  name,
  source: z.enum(['frames', 'sequence', 'godot', 'sheet', 'grid']),
  definedIn: name.exactOptional(),
  frames: count,
  fps: z.number().min(0),
  seconds: z.number().min(0),
  loop: z.boolean(),
  frameWidth: positive.exactOptional(),
  frameHeight: positive.exactOptional(),
})

const imageDetails = z.strictObject({
  kind: z.literal('image'),
  format: z.string().max(32),
  bytes: count,
  width: positive,
  height: positive,
  transparency: z.enum(['opaque', 'cutout', 'translucent']),
  colors: z.number().int().min(0).max(257),
  animations: z.array(spriteAnimation).max(64),
})

const modelDetails = z.strictObject({
  kind: z.literal('model'),
  format: z.string().max(32),
  bytes: count,
  min: point,
  max: point,
  triangles: count,
  vertices: count,
  meshes: count,
  nodes: count,
  materials: z.array(z.strictObject({
    name,
    type: z.string().max(64),
    color: z.string().regex(/^#[0-9a-f]{6}$/u).exactOptional(),
    metalness: measure.exactOptional(),
    roughness: measure.exactOptional(),
    maps: z.array(z.strictObject({ slot: z.string().max(64), texture: name })).max(32),
    transparent: z.boolean(),
    doubleSided: z.boolean(),
    vertexColors: z.boolean(),
  })).max(48),
  materialCount: count,
  textures: z.array(z.strictObject({ name, width: count, height: count })).max(48),
  textureCount: count,
  bones: z.array(z.strictObject({ name, parent: z.number().int().min(0).exactOptional() })).max(256),
  boneCount: count,
  animations: z.array(z.strictObject({
    name,
    seconds: z.number().min(0),
    tracks: count,
    targets: z.array(name).max(24),
    targetCount: count,
  })).max(64),
  morphTargets: z.array(z.strictObject({ mesh: name, targets: z.array(name).max(64) })).max(32),
  missing: z.array(name).max(32),
})

const details = z.discriminatedUnion('kind', [imageDetails, modelDetails])

const answer = z.strictObject({
  details,
  images: z.array(z.strictObject({
    data: z.string().min(1).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
    mediaType: z.enum(['image/png', 'image/jpeg']),
    width: positive,
    height: positive,
    caption: z.string().max(400),
  })).max(MAX_ANSWER_IMAGES),
})

/**
 * Read the details a tool result stores.
 * @param value - the details as the result's JSON holds them.
 * @returns the details, typed.
 * @throws {Error} when the value is not asset details.
 */
export function parseDetails(value: JsonValue): AssetDetails {
  return details.parse(value)
}

/**
 * Check a window's answer.
 * @param value - the answer as it arrived.
 * @returns the answer, typed.
 * @throws {Error} naming the first field that does not fit, when the answer is malformed.
 */
export function parseRenderResult(value: unknown): AssetRenderResult {
  const parsed = answer.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`The WASD Engine window answered with malformed asset details${issue === undefined ? '' : ` at ${issue.path.join('.') || 'the top'}: ${issue.message}`}.`)
  }
  const { details } = parsed.data
  if (details.kind === 'model') {
    // A parent index must name an earlier bone, so the list reads as a tree.
    details.bones.forEach((bone, index) => {
      if (bone.parent !== undefined && bone.parent >= index) throw new Error('The WASD Engine window answered with a bone listed before its parent.')
    })
  }
  return parsed.data
}
