/**
 * The model files the tools save: glTF 2.0 binaries (GLB), read into the glTF document of their JSON chunk and the bytes
 * of their binary chunk, written back from them, and summarized by the meshes, skins, and animation clips the document
 * names.
 * @module @deepseek-ai/dsh-tripo/src/glb
 */
import type { GlbSummary } from './types.ts'

/** `glTF`, `JSON`, and `BIN` as the little-endian 32-bit numbers a GLB stores. */
const GLB_MAGIC = 0x46_54_6c_67
const JSON_CHUNK = 0x4e_4f_53_4a
const BIN_CHUNK = 0x00_4e_49_42

/** A GLB file's glTF document, and the bytes of its binary chunk, which buffer 0 of the document names. */
export interface Glb {
  readonly gltf: Record<string, unknown>
  /** The binary chunk; empty when the file has none. */
  readonly bin: Uint8Array
}

/** A JSON chunk's array, or none. */
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Pad a length to the 4-byte boundary that GLB chunks and the binary data they hold start on.
 * @param length - bytes.
 * @returns the least multiple of 4 that is at least `length`.
 */
export function padded(length: number): number {
  return Math.ceil(length / 4) * 4
}

/**
 * Name an animation clip.
 * @param clip - the clip, as the glTF document holds it.
 * @param index - its place among the document's clips, from 0.
 * @returns its name, or `animation N` for a clip without one, N counting from 1.
 */
export function clipName(clip: unknown, index: number): string {
  const name = typeof clip === 'object' && clip !== null ? (clip as { readonly name?: unknown }).name : undefined
  return typeof name === 'string' && name !== '' ? name : `animation ${index + 1}`
}

/**
 * Read a GLB file's chunks.
 * @param data - the file.
 * @returns its glTF document and binary chunk; a chunk of another type after the JSON chunk is left out.
 * @throws Error when the file is not a complete glTF 2.0 binary whose first chunk is JSON holding a glTF document.
 */
export function parseGlb(data: Uint8Array): Glb {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const complete = data.byteLength >= 20 && view.getUint32(0, true) === GLB_MAGIC && view.getUint32(4, true) === 2
    && view.getUint32(8, true) === data.byteLength
  const jsonLength = complete ? view.getUint32(12, true) : 0
  if (!complete || view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > data.byteLength) {
    throw new Error('is not a complete GLB file')
  }
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + jsonLength)))
  } catch (error) {
    throw new Error('is a GLB file whose JSON does not parse', { cause: error })
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('is a GLB file whose JSON is not a glTF document')
  }
  const at = 20 + jsonLength
  let bin: Uint8Array = new Uint8Array(0)
  if (at + 8 <= data.byteLength && view.getUint32(at + 4, true) === BIN_CHUNK) {
    const binLength = view.getUint32(at, true)
    if (at + 8 + binLength > data.byteLength) throw new Error('is a GLB file whose binary chunk is cut short')
    bin = data.subarray(at + 8, at + 8 + binLength)
  }
  return { gltf: document as Record<string, unknown>, bin }
}

/**
 * Write a GLB file.
 * @param glb - its glTF document and binary chunk.
 * @returns the file: its header, the JSON chunk padded with spaces, and the binary chunk, unless empty, padded with zeros.
 */
export function writeGlb(glb: Glb): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(glb.gltf))
  const jsonLength = padded(json.byteLength)
  const binLength = padded(glb.bin.byteLength)
  const total = 20 + jsonLength + (binLength === 0 ? 0 : 8 + binLength)
  const data = new Uint8Array(total)
  const view = new DataView(data.buffer)
  view.setUint32(0, GLB_MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, JSON_CHUNK, true)
  data.set(json, 20)
  data.fill(0x20, 20 + json.byteLength, 20 + jsonLength)
  if (binLength !== 0) {
    const at = 20 + jsonLength
    view.setUint32(at, binLength, true)
    view.setUint32(at + 4, BIN_CHUNK, true)
    data.set(glb.bin, at + 8)
  }
  return data
}

/**
 * Read what a GLB file holds.
 * @param data - the file.
 * @returns its meshes, skins, and animation clip names; a clip without a name is named by its place.
 * @throws Error when the file is not a complete glTF 2.0 binary whose first chunk is JSON holding a glTF document.
 */
export function readGlb(data: Uint8Array): GlbSummary {
  const { gltf } = parseGlb(data)
  return {
    meshes: list(gltf.meshes).length,
    skins: list(gltf.skins).length,
    animations: list(gltf.animations).map(clipName),
  }
}
