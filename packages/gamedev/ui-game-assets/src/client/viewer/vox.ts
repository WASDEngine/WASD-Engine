/**
 * What three.js's VOXLoader would build of a MagicaVoxel file, counted before it builds anything: the chunks it reads,
 * as it reads them, and the meshes its scene graph builds from them, one for each path from the root node to a shape,
 * since a model that several shapes place is meshed once for each. The loader's mesher allocates a byte for every
 * cell of a model's box and sweeps all of them on each axis, and emits a quad of four vertices for each run of faces
 * it merges; the plan refuses a model larger than MagicaVoxel makes, more cells than one such model holds in all, and
 * the caller refuses more memory than the viewer gives one model, counting a quad for every exposed face, which no
 * merge exceeds. The plan's own work is linear in the file and in the cells of the models it meshes.
 */

/** The longest side of a MagicaVoxel model, in voxels. */
export const VOX_MAX_SIDE = 256

/** Cells the meshes of one file may sweep in all: one model of {@link VOX_MAX_SIDE} on every side. */
export const VOX_MAX_CELLS = VOX_MAX_SIDE ** 3

/**
 * Bytes one quad of a voxel mesh takes while the mesher builds it and once it is geometry: the positions and colors of
 * its four vertices and its six indices as JavaScript numbers, then as typed arrays with the normals three.js computes.
 */
export const VOX_QUAD_BYTES = 384

/** A VOX model whose box is larger than MagicaVoxel makes. */
export class VoxModelTooLargeError extends Error {
  /**
   * @param size - the model's box in voxels, as its `SIZE` chunk states it.
   * @param limit - the longest side the viewer reads.
   */
  constructor(readonly size: { readonly x: number; readonly y: number; readonly z: number }, readonly limit: number) {
    super(`the VOX model is ${String(size.x)} × ${String(size.y)} × ${String(size.z)} voxels, more than ${String(limit)} on a side`)
    this.name = 'VoxModelTooLargeError'
  }
}

/** A VOX file whose meshes would sweep more cells than one model of {@link VOX_MAX_SIDE} on every side holds. */
export class VoxWorkTooLargeError extends Error {
  /**
   * @param cells - the cells the file's meshes sweep, at least; a count too large to hold exactly is Infinity.
   * @param limit - the most the viewer sweeps for one file.
   */
  constructor(readonly cells: number, readonly limit: number) {
    super(`the VOX file's meshes sweep more than the ${String(limit)} cells the viewer sweeps for one file`)
    this.name = 'VoxWorkTooLargeError'
  }
}

/** One model of a VOX file: its box and its voxels. */
interface VoxModel {
  readonly x: number
  readonly y: number
  readonly z: number
  /** The `XYZI` chunk's voxels, four bytes each: x, y, z, and color index. */
  voxels: Uint8Array
}

/** A node of a VOX scene graph, as the loader reads it. */
type VoxNode =
  | { readonly type: 'transform'; readonly child: number }
  | { readonly type: 'group'; readonly children: readonly number[] }
  | { readonly type: 'shape'; readonly models: readonly number[] }

/** What the loader would build of a file. */
export interface VoxPlan {
  /** Cells the meshes sweep, each mesh its model's box. */
  readonly cells: number
  /** Memory the meshes take at most: a byte a cell and {@link VOX_QUAD_BYTES} an exposed face. */
  readonly bytes: number
  /** Whether the file has a scene graph; without one the loader builds no scene, and the viewer meshes each model once. */
  readonly hasScene: boolean
}

/** A reader over a file's bytes that throws where the loader's DataView throws, past the end. */
class Reader {
  private readonly view: DataView
  at = 0

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  u32(): number {
    const value = this.view.getUint32(this.at, true)
    this.at += 4
    return value
  }

  skip(bytes: number): void {
    if (this.at + bytes > this.data.byteLength) throw new RangeError('the VOX file ends inside a chunk')
    this.at += bytes
  }

  /** A STRING: its length, then that many bytes, which the plan skips. */
  string(): void {
    this.skip(this.u32())
  }

  /** A DICT: its count, then that many key and value STRINGs. */
  dict(): void {
    for (let count = this.u32(); count > 0; count--) {
      this.string()
      this.string()
    }
  }
}

/** A chunk id as the little-endian number of its four characters. */
function chunkId(name: string): number {
  return name.charCodeAt(0) | name.charCodeAt(1) << 8 | name.charCodeAt(2) << 16 | name.charCodeAt(3) << 24
}

/** The magic `VOX ` that starts every file, and the chunks the loader reads. */
const VOX_MAGIC = chunkId('VOX ')
const SIZE = chunkId('SIZE')
const XYZI = chunkId('XYZI')
const RGBA = chunkId('RGBA')
const TRANSFORM = chunkId('nTRN')
const GROUP = chunkId('nGRP')
const SHAPE = chunkId('nSHP')

/**
 * Read the chunks of a VOX file as the loader reads them.
 * @returns the models in file order and the scene graph's nodes by id.
 * @throws {Error} where the loader fails: no `VOX ` header of version 150 or 200, a chunk past the end of the file, or
 * voxels without a size before them.
 */
function readVox(data: Uint8Array): { models: VoxModel[]; nodes: Map<number, VoxNode> } {
  const reader = new Reader(data)
  if (data.byteLength < 8 || (reader.u32() | 0) !== VOX_MAGIC) throw new Error('not a VOX file')
  const version = reader.u32()
  if (version !== 150 && version !== 200) throw new Error(`a VOX file of version ${String(version)}, which the viewer does not read`)
  const models: VoxModel[] = []
  const nodes = new Map<number, VoxNode>()
  while (reader.at < data.byteLength) {
    const id = reader.u32() | 0
    const chunkSize = reader.u32()
    reader.u32()
    if (id === SIZE) {
      models.push({ x: reader.u32(), y: reader.u32(), z: reader.u32(), voxels: new Uint8Array(0) })
      // A size below 12 steps back as the loader steps back, at most to the end of the chunk's header.
      reader.skip(chunkSize - 12)
    } else if (id === XYZI) {
      const model = models.at(-1)
      if (model === undefined) throw new Error('voxels without a size before them')
      const count = reader.u32()
      const start = reader.at
      reader.skip(count * 4)
      model.voxels = data.subarray(start, start + count * 4)
    } else if (id === RGBA) {
      reader.skip(256 * 4)
    } else if (id === TRANSFORM) {
      const node = reader.u32()
      reader.dict()
      const child = reader.u32()
      reader.skip(8)
      for (let frames = reader.u32(); frames > 0; frames--) reader.dict()
      nodes.set(node, { type: 'transform', child })
    } else if (id === GROUP) {
      const node = reader.u32()
      reader.dict()
      const children: number[] = []
      for (let count = reader.u32(); count > 0; count--) children.push(reader.u32())
      nodes.set(node, { type: 'group', children })
    } else if (id === SHAPE) {
      const node = reader.u32()
      reader.dict()
      const shapes: number[] = []
      for (let count = reader.u32(); count > 0; count--) {
        shapes.push(reader.u32())
        reader.dict()
      }
      nodes.set(node, { type: 'shape', models: shapes })
    } else {
      reader.skip(chunkSize)
    }
  }
  return { models, nodes }
}

/**
 * The models one build of a node meshes, in the order the loader builds them, by their index: a transform over a shape
 * of one model meshes that model, any other transform builds its child, a group each child, and a shape each of its
 * models.
 */
function meshedBy(
  node: VoxNode,
  nodes: ReadonlyMap<number, VoxNode>,
): { readonly models: readonly number[]; readonly children: readonly number[] } {
  if (node.type === 'transform') {
    const child = nodes.get(node.child)
    return child?.type === 'shape' && child.models.length === 1 ? { models: child.models, children: [] } : { models: [], children: [node.child] }
  }
  if (node.type === 'group') return { models: [], children: node.children }
  return { models: node.models, children: [] }
}

/**
 * Sum a value over the meshes the loader builds from node 0, each mesh adding its model's value, without building
 * any: each node's sum is the sum of what it meshes itself and of its children's sums, so a node that several paths
 * reach is summed once, and a sum too large to hold becomes Infinity.
 * @param nodes - the scene graph.
 * @param value - one mesh's value, by the index of its model.
 * @returns the sum.
 * @throws {Error} where the loader fails: a node that does not exist, or a graph that leads back into itself, which the
 * loader would follow until its stack runs out.
 */
function sumOverMeshes(nodes: ReadonlyMap<number, VoxNode>, value: (model: number) => number): number {
  const sums = new Map<number, number>()
  // Depth-first without recursion: a node is summed once all of its children are.
  const open = new Set<number>()
  const stack: number[] = [0]
  while (stack.length > 0) {
    const id = stack.at(-1) as number
    if (sums.has(id)) {
      stack.pop()
      continue
    }
    const node = nodes.get(id)
    if (node === undefined) throw new Error(`the VOX scene names node ${String(id)}, which the file does not hold`)
    const { models, children } = meshedBy(node, nodes)
    if (!open.has(id)) {
      open.add(id)
      for (const child of children) {
        if (open.has(child) && !sums.has(child)) throw new Error('the VOX scene graph leads back into itself')
        if (!sums.has(child)) stack.push(child)
      }
      continue
    }
    let sum = 0
    for (const model of models) sum += value(model)
    for (const child of children) sum += sums.get(child) as number
    sums.set(id, sum)
    stack.pop()
  }
  return sums.get(0) as number
}

/**
 * The faces of a model that border no other voxel of it, as the mesher finds them: its voxels set into its box as the
 * mesher sets them, where a voxel outside the box may land in another cell or nowhere, then the faces of each filled
 * cell toward an empty cell or the box's edge.
 */
function exposedFaces(model: VoxModel): number {
  const { x: sx, y: sy, z: sz, voxels } = model
  if (voxels.length < 4) return 0
  const volume = new Uint8Array(sx * sy * sz)
  for (let at = 0; at + 3 < voxels.length; at += 4) {
    const index = (voxels[at] ?? 0) + (voxels[at + 1] ?? 0) * sx + (voxels[at + 2] ?? 0) * sx * sy
    if (index < volume.length) volume[index] = voxels[at + 3] ?? 0
  }
  let faces = 0
  const layer = sx * sy
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0, index = z * layer + y * sx; x < sx; x++, index++) {
        if (volume[index] === 0) continue
        if (x === 0 || volume[index - 1] === 0) faces++
        if (x === sx - 1 || volume[index + 1] === 0) faces++
        if (y === 0 || volume[index - sx] === 0) faces++
        if (y === sy - 1 || volume[index + sx] === 0) faces++
        if (z === 0 || volume[index - layer] === 0) faces++
        if (z === sz - 1 || volume[index + layer] === 0) faces++
      }
    }
  }
  return faces
}

/**
 * Plan what the loader would build of a VOX file, before it builds anything.
 * @param data - the file.
 * @returns the cells its meshes sweep and the memory they take.
 * @throws {VoxModelTooLargeError} for a model larger than {@link VOX_MAX_SIDE} on a side that the loader meshes;
 * {@link VoxWorkTooLargeError} when its meshes sweep more than {@link VOX_MAX_CELLS} cells in all; {Error} where the
 * loader fails to read the file.
 */
export function voxPlan(data: Uint8Array): VoxPlan {
  const { models, nodes } = readVox(data)
  const hasScene = nodes.size > 0
  const model = (index: number): VoxModel => {
    const found = models[index]
    if (found === undefined) throw new Error(`the VOX scene names model ${String(index)}, which the file does not hold`)
    if (Math.max(found.x, found.y, found.z) > VOX_MAX_SIDE) throw new VoxModelTooLargeError(found, VOX_MAX_SIDE)
    return found
  }
  const cellsOf = (index: number): number => {
    const { x, y, z } = model(index)
    return x * y * z
  }
  // Without a scene graph the viewer meshes each model once.
  const sum = (value: (index: number) => number): number => (hasScene
    ? sumOverMeshes(nodes, value)
    : models.reduce((total, _, index) => total + value(index), 0))
  const cells = sum(cellsOf)
  if (cells > VOX_MAX_CELLS) throw new VoxWorkTooLargeError(cells, VOX_MAX_CELLS)
  // Every model meshed is meshed at least once, so the boxes searched for faces hold at most the cells counted.
  const faces = new Map<number, number>()
  const facesOf = (index: number): number => {
    let known = faces.get(index)
    if (known === undefined) {
      known = exposedFaces(model(index))
      faces.set(index, known)
    }
    return known
  }
  return { cells, bytes: cells + sum(index => facesOf(index) * VOX_QUAD_BYTES), hasScene }
}
