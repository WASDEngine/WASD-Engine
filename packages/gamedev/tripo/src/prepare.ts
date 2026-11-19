/**
 * What the tools change in a model Tripo made before they save it. Tripo's models face +X; each saved model is turned a
 * quarter turn about +Y to face +Z, glTF's front, which Godot imports as a model's front. The turn is held by a node
 * named {@link FRONT_NODE} put above each part of the model's scenes. In a rigged model the skinned mesh's node stays
 * where it is and the turn goes above the skeleton: glTF skins a mesh by its joints alone, and an importer that also
 * applies the skinned mesh's own node, as three.js does, would otherwise turn the model twice. Tripo's clips can hold a
 * model away from the spot where it stands at rest, even in place, so each clip is moved across the ground: a clip that
 * stays on the spot until its hips' path is centered over the spot where they are at rest, and a clip that travels, its
 * hips ending farther than a tenth of the skeleton's size from where they start, until it starts there. The hips are the
 * highest joint of the first skin whose position the clip changes from its rest, their path is read with their parent
 * placed as the clip starts, and the move is made on the translation of that skin's root joint.
 * @module @deepseek-ai/dsh-tripo/src/prepare
 */
import { clipName, padded, parseGlb, writeGlb } from './glb.ts'

/** A 4×4 matrix in glTF's column-major order. */
type Matrix = readonly number[]

/** A glTF object of the document. */
type Json = Record<string, unknown>

/** The node properties a clip animates that place a node, with the numbers each value holds. */
const WIDTHS = { translation: 3, rotation: 4, scale: 3 } as const

type Path = keyof typeof WIDTHS

/** The values a clip gives the nodes it animates at its start. */
type Pose = ReadonlyMap<number, ReadonlyMap<Path, readonly number[]>>

/** A clip's translation of one node: its channel and sampler, and its values, CUBICSPLINE's tangents beside each one. */
interface Track {
  readonly channel: Json
  readonly sampler: Json
  readonly values: Float32Array
  readonly cubic: boolean
}

/** A skin's joints and its one root joint, with the largest side of the box its joints fill at rest. */
interface Skeleton {
  readonly root: number
  readonly joints: ReadonlySet<number>
  readonly size: number
}

/** The quarter turn about +Y, as a glTF rotation, that takes +X, where Tripo's models face, to +Z. */
export const TURN = [0, -Math.SQRT1_2, 0, Math.SQRT1_2] as const

/** The name of each node that holds the turn. */
export const FRONT_NODE = 'Front'

/** glTF's 32-bit float component type, the only one these changes read and write. */
const FLOAT = 5126

/** The accessor type of each width of value. */
const ACCESSOR_TYPES: Readonly<Record<number, string>> = { 3: 'VEC3', 4: 'VEC4' }

/** A difference smaller than this counts as none. */
const EPSILON = 1e-6

/** A clip that would move less than this, in the model's units, is left as it is. */
const CENTERED = 1e-4

/** A clip whose hips end farther than this share of the skeleton's size from where they start travels. */
const TRAVELS = 0.1

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** The model to save and what changed in it. */
export interface PreparedModel {
  /** The file to save, which is the file as given when nothing changed. */
  readonly data: Uint8Array
  /** Whether the model now faces +Z. */
  readonly turned: boolean
  /** The clips moved over the spot where the model stands at rest. */
  readonly centered: readonly string[]
}

/** The binary chunk, grown by the values the changes add. */
interface Growth {
  readonly parts: Uint8Array[]
  length: number
}

function object(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** A non-negative integer, such as an index into the document's arrays. */
function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** An array of `length` finite numbers. */
function finite(value: unknown, length: number): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined
  const numbers: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return undefined
    numbers.push(item)
  }
  return numbers
}

/** The array the document keeps under a key, made when it has none. */
function arrayIn(owner: Json, key: string): unknown[] {
  const value = owner[key]
  if (Array.isArray(value)) return value
  const made: unknown[] = []
  owner[key] = made
  return made
}

function element(matrix: Matrix, row: number, column: number): number {
  return matrix[column * 4 + row] ?? 0
}

function multiply(a: Matrix, b: Matrix): number[] {
  const product: number[] = []
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += element(a, row, k) * element(b, k, column)
      product.push(sum)
    }
  }
  return product
}

/** The matrix of a translation, a rotation quaternion, and a scale, applied scale first. */
function compose(translation: readonly number[], rotation: readonly number[], scale: readonly number[]): number[] {
  const [x = 0, y = 0, z = 0, w = 1] = rotation
  const [sx = 1, sy = 1, sz = 1] = scale
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    translation[0] ?? 0, translation[1] ?? 0, translation[2] ?? 0, 1,
  ]
}

/** The inverse of an affine matrix, or undefined when it flattens space. */
function invert(matrix: Matrix): number[] | undefined {
  const e = (row: number, column: number): number => element(matrix, row, column)
  const cofactor = (row: number, column: number): number => {
    const [r0, r1] = [0, 1, 2].filter(r => r !== row)
    const [c0, c1] = [0, 1, 2].filter(c => c !== column)
    const minor = e(r0 ?? 0, c0 ?? 0) * e(r1 ?? 0, c1 ?? 0) - e(r0 ?? 0, c1 ?? 0) * e(r1 ?? 0, c0 ?? 0)
    return (row + column) % 2 === 0 ? minor : -minor
  }
  const determinant = e(0, 0) * cofactor(0, 0) + e(0, 1) * cofactor(0, 1) + e(0, 2) * cofactor(0, 2)
  if (Math.abs(determinant) < EPSILON) return undefined
  const inverse = (row: number, column: number): number => cofactor(column, row) / determinant
  const moved = [0, 1, 2].map(row => -(inverse(row, 0) * e(0, 3) + inverse(row, 1) * e(1, 3) + inverse(row, 2) * e(2, 3)))
  return [
    inverse(0, 0), inverse(1, 0), inverse(2, 0), 0,
    inverse(0, 1), inverse(1, 1), inverse(2, 1), 0,
    inverse(0, 2), inverse(1, 2), inverse(2, 2), 0,
    moved[0] ?? 0, moved[1] ?? 0, moved[2] ?? 0, 1,
  ]
}

/** A direction moved by a matrix, without its translation. */
function direction(matrix: Matrix, vector: ArrayLike<number>): number[] {
  return [0, 1, 2].map(row => [0, 1, 2].reduce((sum, column) => sum + element(matrix, row, column) * (vector[column] ?? 0), 0))
}

/** A point moved by a matrix. */
function point(matrix: Matrix, vector: ArrayLike<number>): number[] {
  return direction(matrix, vector).map((value, row) => value + element(matrix, row, 3))
}

/** The places of a track's values among its elements: every element, or the middle one of each CUBICSPLINE triple. */
function valueElements(track: Track): number[] {
  const elements: number[] = []
  for (let at = track.cubic ? 1 : 0; at * 3 < track.values.length; at += track.cubic ? 3 : 1) elements.push(at)
  return elements
}

/** Whether a matrix only turns and moves: its first three columns are perpendicular unit vectors in a right-handed set. */
function rigid(matrix: Matrix): boolean {
  const columns = [0, 1, 2].map(column => [0, 1, 2].map(row => element(matrix, row, column)))
  const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0)
  const orthonormal = columns.every((a, i) => columns.every((b, j) => Math.abs(dot(a, b) - (i === j ? 1 : 0)) < EPSILON))
  const [x = [], y = [], z = []] = columns
  const at = (vector: readonly number[], i: number): number => vector[i] ?? 0
  const cross = [
    at(x, 1) * at(y, 2) - at(x, 2) * at(y, 1),
    at(x, 2) * at(y, 0) - at(x, 0) * at(y, 2),
    at(x, 0) * at(y, 1) - at(x, 1) * at(y, 0),
  ]
  const affine = [3, 7, 11].every(i => Math.abs(matrix[i] ?? 0) < EPSILON) && Math.abs((matrix[15] ?? 0) - 1) < EPSILON
  return orthonormal && dot(cross, z) > 0 && affine
}

/** A node's own matrix, with the values a clip gives it at its start when a pose is given. */
function localMatrix(node: Json | undefined, at: number, pose: Pose | undefined): Matrix {
  const animated = pose?.get(at)
  const matrix = finite(node?.matrix, 16)
  if (matrix !== undefined && animated === undefined) return matrix
  return compose(
    animated?.get('translation') ?? finite(node?.translation, 3) ?? [0, 0, 0],
    animated?.get('rotation') ?? finite(node?.rotation, 4) ?? [0, 0, 0, 1],
    animated?.get('scale') ?? finite(node?.scale, 3) ?? [1, 1, 1],
  )
}

/** A node and the nodes above it, nearest first. */
function lineage(parents: ReadonlyMap<number, number>, at: number): number[] {
  const chain: number[] = []
  for (let node: number | undefined = at; node !== undefined; node = parents.get(node)) chain.push(node)
  return chain
}

/** The matrix that places a node in the scene, at rest or at a clip's start. */
function world(nodes: readonly Json[], parents: ReadonlyMap<number, number>, at: number, pose?: Pose): Matrix {
  return lineage(parents, at).reduceRight<Matrix>((matrix, node) => multiply(matrix, localMatrix(nodes[node], node, pose)), IDENTITY)
}

/** Each node's parent, or undefined when the nodes do not form a forest. */
function parentsOf(nodes: readonly Json[]): Map<number, number> | undefined {
  const parents = new Map<number, number>()
  for (const [at, node] of nodes.entries()) {
    for (const child of list(node.children)) {
      const index = whole(child)
      if (index === undefined || index >= nodes.length || parents.has(index)) return undefined
      parents.set(index, at)
    }
  }
  for (const start of parents.keys()) {
    let steps = 0
    for (let at = parents.get(start); at !== undefined; at = parents.get(at)) {
      if (at === start || ++steps > nodes.length) return undefined
    }
  }
  return parents
}

/** The nodes any clip animates. */
function animatedNodes(gltf: Json): Set<number> {
  const animated = new Set<number>()
  for (const clip of list(gltf.animations)) {
    for (const channel of list(object(clip)?.channels)) {
      const node = whole(object(object(channel)?.target)?.node)
      if (node !== undefined) animated.add(node)
    }
  }
  return animated
}

/**
 * The values of a float accessor in the binary chunk.
 * @returns the values, or undefined when the accessor does not hold `width` 32-bit floats per element in the binary chunk.
 */
function floats(gltf: Json, bin: Uint8Array, accessorIndex: unknown, width: number): Float32Array | undefined {
  const accessor = object(list(gltf.accessors)[whole(accessorIndex) ?? -1])
  const view = object(list(gltf.bufferViews)[whole(accessor?.bufferView) ?? -1])
  const count = whole(accessor?.count)
  const buffer = object(list(gltf.buffers)[0])
  if (accessor === undefined || view === undefined || count === undefined || buffer === undefined || buffer.uri !== undefined
    || whole(view.buffer) !== 0 || accessor.componentType !== FLOAT || accessor.type !== ACCESSOR_TYPES[width]
    || accessor.sparse !== undefined) {
    return undefined
  }
  const stride = whole(view.byteStride) ?? width * 4
  const viewStart = whole(view.byteOffset) ?? 0
  const start = viewStart + (whole(accessor.byteOffset) ?? 0)
  const end = Math.min(viewStart + (whole(view.byteLength) ?? 0), bin.byteLength)
  if (count > 0 && start + stride * (count - 1) + width * 4 > end) return undefined
  const reader = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const values = new Float32Array(count * width)
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < width; c++) values[i * width + c] = reader.getFloat32(start + i * stride + c * 4, true)
  }
  return values
}

/** Add 3-float values to the binary chunk, in a buffer view and accessor of their own. */
function appendVectors(gltf: Json, growth: Growth, values: Float32Array): number {
  const offset = padded(growth.length)
  const bytes = new Uint8Array(offset - growth.length + values.length * 4)
  const writer = new DataView(bytes.buffer)
  values.forEach((value, i) => writer.setFloat32(offset - growth.length + i * 4, value, true))
  growth.parts.push(bytes)
  growth.length += bytes.byteLength
  const views = arrayIn(gltf, 'bufferViews')
  views.push({ buffer: 0, byteOffset: offset, byteLength: values.length * 4 })
  const accessors = arrayIn(gltf, 'accessors')
  accessors.push({ bufferView: views.length - 1, componentType: FLOAT, count: values.length / 3, type: 'VEC3' })
  return accessors.length - 1
}

/** The first skin's skeleton, or undefined when it has no joint or several root joints. */
function skeletonOf(gltf: Json, nodes: readonly Json[], parents: ReadonlyMap<number, number>): Skeleton | undefined {
  const joints = new Set<number>()
  for (const joint of list(object(list(gltf.skins)[0])?.joints)) {
    const at = whole(joint)
    if (at !== undefined && at < nodes.length) joints.add(at)
  }
  const roots = [...joints].filter(joint => !joints.has(parents.get(joint) ?? -1))
  const [root] = roots
  if (roots.length !== 1 || root === undefined) return undefined
  const positions = [...joints].map(joint => point(world(nodes, parents, joint), [0, 0, 0]))
  const sides = [0, 1, 2].map((axis) => {
    const along = positions.map(position => position[axis] ?? 0)
    return Math.max(...along) - Math.min(...along)
  })
  return { root, joints, size: Math.max(...sides) }
}

/**
 * Move one clip across the ground: a clip that stays on the spot until its hips' path is centered over the spot where
 * they are at rest, and a clip that travels until it starts there.
 * @returns whether the clip moved; a clip is left as it is when it cannot be read, when it is there already, when no
 * joint's position changes, when it animates a node above the root joint, or when it does not animate the root joint's
 * translation.
 */
function centerClip(
  gltf: Json, bin: Uint8Array, growth: Growth, nodes: readonly Json[], parents: ReadonlyMap<number, number>,
  skeleton: Skeleton, clip: Json,
): boolean {
  const samplers = list(clip.samplers)
  const above = new Set(lineage(parents, skeleton.root).slice(1))
  const pose = new Map<number, Map<Path, readonly number[]>>()
  const translations = new Map<number, Track>()
  for (const value of list(clip.channels)) {
    const channel = object(value)
    const target = object(channel?.target)
    const node = whole(target?.node)
    const path = target?.path
    const sampler = object(samplers[whole(channel?.sampler) ?? -1])
    if (channel === undefined || node === undefined || sampler === undefined || (path !== 'translation' && path !== 'rotation' && path !== 'scale')) continue
    if (above.has(node)) return false
    const width = WIDTHS[path]
    const values = floats(gltf, bin, sampler.output, width)
    const cubic = sampler.interpolation === 'CUBICSPLINE'
    if (values === undefined || values.length < (cubic ? 3 : 1) * width) return false
    const first = cubic ? width : 0
    const posed = pose.get(node) ?? new Map<Path, readonly number[]>()
    posed.set(path, Array.from(values.subarray(first, first + width)))
    pose.set(node, posed)
    if (path === 'translation') translations.set(node, { channel, sampler, values, cubic })
  }
  let hips: number | undefined
  const queue = [skeleton.root]
  for (const at of queue) {
    const started = pose.get(at)?.get('translation')
    const rest = finite(nodes[at]?.translation, 3) ?? [0, 0, 0]
    if (started?.some((value, i) => Math.abs(value - (rest[i] ?? 0)) > EPSILON) === true) {
      hips = at
      break
    }
    for (const child of list(nodes[at]?.children)) {
      const index = whole(child)
      if (index !== undefined && skeleton.joints.has(index)) queue.push(index)
    }
  }
  const hipsTranslation = hips === undefined ? undefined : translations.get(hips)
  const rootTranslation = translations.get(skeleton.root)
  if (hips === undefined || hipsTranslation === undefined || rootTranslation === undefined) return false
  const hipsParent = parents.get(hips)
  const placed = hipsParent === undefined ? IDENTITY : world(nodes, parents, hipsParent, pose)
  const path = valueElements(hipsTranslation).map(at => point(placed, hipsTranslation.values.subarray(at * 3, at * 3 + 3)))
  const [first, last] = [path[0] ?? [0, 0, 0], path.at(-1) ?? [0, 0, 0]]
  const along = (axis: number): readonly number[] => path.map(position => position[axis] ?? 0)
  const travels = Math.hypot((last[0] ?? 0) - (first[0] ?? 0), (last[2] ?? 0) - (first[2] ?? 0)) > TRAVELS * skeleton.size
  const spot = travels
    ? [first[0] ?? 0, first[2] ?? 0]
    : [0, 2].map(axis => (Math.min(...along(axis)) + Math.max(...along(axis))) / 2)
  const rest = point(world(nodes, parents, hips), [0, 0, 0])
  const offset = [(spot[0] ?? 0) - (rest[0] ?? 0), 0, (spot[1] ?? 0) - (rest[2] ?? 0)]
  if (Math.hypot(offset[0] ?? 0, offset[2] ?? 0) < CENTERED) return false
  const rootParent = parents.get(skeleton.root)
  const inverse = invert(rootParent === undefined ? IDENTITY : world(nodes, parents, rootParent))
  if (inverse === undefined) return false
  const shift = direction(inverse, offset)
  const moved = new Float32Array(rootTranslation.values)
  for (const at of valueElements(rootTranslation)) {
    for (let c = 0; c < 3; c++) moved[at * 3 + c] = (moved[at * 3 + c] ?? 0) - (shift[c] ?? 0)
  }
  const sampled = arrayIn(clip, 'samplers')
  sampled.push({ ...rootTranslation.sampler, output: appendVectors(gltf, growth, moved) })
  rootTranslation.channel.sampler = sampled.length - 1
  return true
}

/**
 * Put a node that turns the model to face +Z above each part of its scenes: a scene's top node, or, for a node above a
 * skinned mesh, each node below it that holds no skinned mesh.
 * @returns whether the model was turned; it is left as it is when its scenes name no node, when a node above a skinned
 * mesh shows something of its own, or when a part's parent moves in a clip or would stretch the turn.
 */
function turn(gltf: Json, nodes: readonly Json[], parents: ReadonlyMap<number, number>, animated: ReadonlySet<number>): boolean {
  const roots = new Set<number>()
  for (const scene of list(gltf.scenes)) {
    for (const root of list(object(scene)?.nodes)) {
      const at = whole(root)
      if (at !== undefined && at < nodes.length && !parents.has(at)) roots.add(at)
    }
  }
  const children = (at: number): number[] => list(nodes[at]?.children).flatMap(child => whole(child) ?? [])
  const skinned = (at: number): boolean => whole(nodes[at]?.skin) !== undefined
  const holdsSkinned = (at: number): boolean => skinned(at) || children(at).some(holdsSkinned)
  const parts: number[] = []
  const collect = (at: number): boolean => {
    if (!holdsSkinned(at)) {
      parts.push(at)
      return true
    }
    const node = nodes[at]
    if (!skinned(at) && (node?.mesh !== undefined || node?.camera !== undefined || node?.extensions !== undefined)) return false
    return children(at).every(collect)
  }
  if (roots.size === 0 || ![...roots].every(collect)) return false
  const turning = compose([0, 0, 0], TURN, [1, 1, 1])
  const fronts: Array<{ readonly part: number; readonly front: Json }> = []
  for (const part of parts) {
    const parent = parents.get(part)
    if (parent !== undefined && lineage(parents, parent).some(at => animated.has(at))) return false
    const placed = parent === undefined ? IDENTITY : world(nodes, parents, parent)
    const inverse = invert(placed)
    if (inverse === undefined) return false
    const local = multiply(multiply(inverse, turning), placed)
    if (!rigid(local)) return false
    const plain = local.every((value, i) => Math.abs(value - (turning[i] ?? 0)) < EPSILON)
    fronts.push({ part, front: { name: FRONT_NODE, ...plain ? { rotation: [...TURN] } : { matrix: local }, children: [part] } })
  }
  const all = arrayIn(gltf, 'nodes')
  for (const { part, front } of fronts) {
    const at = all.length
    all.push(front)
    const parent = parents.get(part)
    const owners = parent === undefined ? list(gltf.scenes).map(scene => object(scene)?.nodes) : [nodes[parent]?.children]
    for (const owner of owners) {
      if (!Array.isArray(owner)) continue
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] === part) owner[i] = at
      }
    }
  }
  return true
}

/**
 * Turn a model Tripo made to face +Z, and move each of its clips to start over the spot where the model stands at rest.
 * @param data - the GLB file Tripo made.
 * @returns the file to save and what changed in it; a model whose nodes do not form a forest is saved as it is.
 * @throws Error when the file is not a complete glTF 2.0 binary whose first chunk is JSON holding a glTF document.
 */
export function prepareModel(data: Uint8Array): PreparedModel {
  const { gltf, bin } = parseGlb(data)
  const nodes = list(gltf.nodes).map(object)
  const parents = nodes.every((node): node is Json => node !== undefined) ? parentsOf(nodes) : undefined
  if (parents === undefined) return { data, turned: false, centered: [] }
  const known = nodes.filter((node): node is Json => node !== undefined)
  const growth: Growth = { parts: [bin], length: bin.byteLength }
  const skeleton = skeletonOf(gltf, known, parents)
  const centered = skeleton === undefined
    ? []
    : list(gltf.animations).flatMap((clip, index) => {
      const value = object(clip)
      return value !== undefined && centerClip(gltf, bin, growth, known, parents, skeleton, value) ? [clipName(clip, index)] : []
    })
  const turned = turn(gltf, known, parents, animatedNodes(gltf))
  if (!turned && centered.length === 0) return { data, turned, centered }
  if (growth.parts.length > 1) {
    const buffer = object(list(gltf.buffers)[0])
    if (buffer !== undefined) buffer.byteLength = growth.length
  }
  const grown = new Uint8Array(growth.length)
  let offset = 0
  for (const part of growth.parts) {
    grown.set(part, offset)
    offset += part.byteLength
  }
  return { data: writeGlb({ gltf, bin: grown }), turned, centered }
}
