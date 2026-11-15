/**
 * Model files the viewer's specs build byte by byte: binary FBX files of nodes and properties as FBX 7.4 writes them,
 * MagicaVoxel files of models and scene graph nodes, and image headers.
 */
import { deflateSync } from 'node:zlib'

/** One FBX property: a type code and its encoded bytes after the code. */
export interface FbxProperty {
  readonly type: string
  readonly bytes: Uint8Array
}

/** One FBX node: its name, properties, and child nodes. */
export interface FbxNode {
  readonly name: string
  readonly properties?: readonly FbxProperty[]
  readonly children?: readonly FbxNode[]
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** FBX property encoders. */
export const fbx = {
  /** A string property. */
  string: (text: string): FbxProperty => {
    const bytes = new TextEncoder().encode(text)
    return { type: 'S', bytes: concat([u32(bytes.byteLength), bytes]) }
  },
  /** A raw bytes property, as an embedded image's `Content`. */
  raw: (data: Uint8Array): FbxProperty => ({ type: 'R', bytes: concat([u32(data.byteLength), data]) }),
  /** A 64-bit integer property, as an object's id. */
  long: (value: number): FbxProperty => {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigInt64(0, BigInt(value), true)
    return { type: 'L', bytes: out }
  },
  /**
   * A double array property, its values deflated when `compressed` is given.
   * @param length - the number of values the array states.
   * @param values - the values it holds, or the raw data to deflate for a compressed array.
   * @param compressed - the bytes to inflate, which may make more or fewer bytes than the length states.
   */
  doubles: (length: number, values: readonly number[], compressed?: Uint8Array): FbxProperty => {
    if (compressed === undefined) {
      const data = new Uint8Array(new Float64Array(values).buffer)
      return { type: 'd', bytes: concat([u32(length), u32(0), u32(data.byteLength), data]) }
    }
    const deflated = deflateSync(compressed)
    return { type: 'd', bytes: concat([u32(length), u32(1), u32(deflated.byteLength), deflated]) }
  },
}

/** One node record of FBX 7.4, its end offset counted from the file's start. */
function fbxRecord(node: FbxNode, offset: number): Uint8Array {
  const name = new TextEncoder().encode(node.name)
  const properties = concat((node.properties ?? []).map(property => concat([new TextEncoder().encode(property.type), property.bytes])))
  const headerLength = 13 + name.byteLength
  const children: Uint8Array[] = []
  let at = offset + headerLength + properties.byteLength
  for (const child of node.children ?? []) {
    const record = fbxRecord(child, at)
    children.push(record)
    at += record.byteLength
  }
  // A node with children ends its list with an empty record.
  if (children.length > 0) {
    children.push(new Uint8Array(13))
    at += 13
  }
  const header = [u32(at), u32(node.properties?.length ?? 0), u32(properties.byteLength), Uint8Array.of(name.byteLength)]
  return concat([...header, name, properties, ...children])
}

/**
 * A binary FBX 7.4 file of top-level nodes, then the empty record that ends them and a footer of zeros.
 * @param nodes - the top-level nodes.
 * @returns the file.
 */
export function fbxFile(nodes: readonly FbxNode[]): Uint8Array<ArrayBuffer> {
  const header = concat([new TextEncoder().encode('Kaydara FBX Binary  \0'), Uint8Array.of(0x1a, 0), u32(7400)])
  const records: Uint8Array[] = []
  let at = header.byteLength
  for (const node of nodes) {
    const record = fbxRecord(node, at)
    records.push(record)
    at += record.byteLength
  }
  return concat([header, ...records, new Uint8Array(13), new Uint8Array(160)])
}

/** One MagicaVoxel model: its box and its voxels as x, y, z, and color index. */
export interface VoxModel {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly voxels?: readonly (readonly [number, number, number, number])[]
}

/** One MagicaVoxel scene graph node. */
export type VoxNode =
  | { readonly type: 'transform'; readonly id: number; readonly child: number }
  | { readonly type: 'group'; readonly id: number; readonly children: readonly number[] }
  | { readonly type: 'shape'; readonly id: number; readonly models: readonly number[] }

function voxChunk(id: string, content: Uint8Array): Uint8Array {
  return concat([new TextEncoder().encode(id), u32(content.byteLength), u32(0), content])
}

/**
 * A MagicaVoxel file of version 150: each model's `SIZE` and `XYZI` chunks, then the scene graph's nodes, each with an
 * empty attribute dictionary.
 * @param models - the models.
 * @param nodes - the scene graph; none builds no scene.
 * @returns the file.
 */
export function voxFile(models: readonly VoxModel[], nodes: readonly VoxNode[] = []): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  for (const model of models) {
    chunks.push(voxChunk('SIZE', concat([u32(model.x), u32(model.y), u32(model.z)])))
    const voxels = model.voxels ?? []
    chunks.push(voxChunk('XYZI', concat([u32(voxels.length), ...voxels.map(voxel => Uint8Array.from(voxel))])))
  }
  const empty = u32(0)
  for (const node of nodes) {
    if (node.type === 'transform') chunks.push(voxChunk('nTRN', concat([u32(node.id), empty, u32(node.child), u32(0xffffffff), u32(0), u32(1), empty])))
    else if (node.type === 'group') chunks.push(voxChunk('nGRP', concat([u32(node.id), empty, u32(node.children.length), ...node.children.map(u32)])))
    else chunks.push(voxChunk('nSHP', concat([u32(node.id), empty, u32(node.models.length), ...node.models.flatMap(model => [u32(model), empty])])))
  }
  const main = concat(chunks)
  return concat([new TextEncoder().encode('VOX '), u32(150), new TextEncoder().encode('MAIN'), u32(0), u32(main.byteLength), main])
}

/** A PNG signature and IHDR chunk stating a size. */
export function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const size = [width, height].flatMap(value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return Uint8Array.from([...signature, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...size, 8, 6, 0, 0, 0, 0, 0, 0, 0])
}

/** A TGA header stating an uncompressed 32-bit image of a size, followed by its pixels when `pixels` is true. */
export function tgaFile(width: number, height: number, pixels = true): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(18)
  const view = new DataView(header.buffer)
  header[2] = 2
  view.setUint16(12, width, true)
  view.setUint16(14, height, true)
  header[16] = 32
  header[17] = 8
  return pixels ? concat([header, new Uint8Array(width * height * 4).fill(0x80)]) : header
}
