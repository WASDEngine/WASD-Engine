/**
 * What a model's files ask a loader to allocate, read before the loader runs: a glTF description's own sizes and the
 * files it names, and the textures that an OBJ or Collada file names, so that the viewer refuses a model past its
 * memory before three.js allocates it.
 */
import type { ModelSource } from './model.ts'

/** A glTF model whose description gives a count or a byte stride that is not a whole number of items. */
export class ModelUnsizedError extends Error {
  constructor() {
    super('the model\'s description gives a count or a byte stride that is not a whole number')
    this.name = 'ModelUnsizedError'
  }
}

/** A model whose file asks its loader for more memory than {@link ModelSource.maxBytes}. */
export class ModelTooLargeError extends Error {
  /**
   * @param bytes - the bytes the file asks for.
   * @param limit - the most the viewer sets aside.
   */
  constructor(readonly bytes: number, readonly limit: number) {
    super(`the model asks for ${String(bytes)} bytes of memory, more than the ${String(limit)} the viewer sets aside`)
    this.name = 'ModelTooLargeError'
  }
}

/** Components of each glTF accessor type. */
const GLTF_COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

/** Bytes of each glTF component type. */
const GLTF_COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

/** Bytes of one instance matrix, which three.js keeps for each instance of an `EXT_mesh_gpu_instancing` node. */
const INSTANCE_MATRIX_BYTES = 16 * 4

/** Whether a value is an object of a glTF description. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/**
 * Whether a value is an ArrayBuffer of any realm.
 * @param value - the value.
 * @returns true for an ArrayBuffer.
 */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

/**
 * A field of an object of a glTF description, read as the loader reads it.
 * @param value - the object.
 * @param key - the field.
 * @returns the field's value; undefined for a value that is no object.
 */
export function field(value: unknown, key: string): unknown {
  return isObject(value) ? Reflect.get(value, key) : undefined
}

/**
 * An entry of a glTF description's list by the index another entry gives, looked up as the loader looks it up: by the
 * index as a property name, so that `"0"` names the first entry too.
 * @param list - the list.
 * @param index - the index.
 * @returns the entry, or undefined.
 */
export function entryAt(list: unknown, index: unknown): unknown {
  return Array.isArray(list) && (typeof index === 'number' || typeof index === 'string') ? Reflect.get(list, String(index)) : undefined
}

/** The objects of one top-level glTF list. */
function gltfEntries(json: unknown, key: string): object[] {
  const list = field(json, key)
  return Array.isArray(list) ? list.filter(isObject) : []
}

/**
 * A count or byte stride of a glTF description, which the loader multiplies as JavaScript numbers.
 * @param value - the field.
 * @returns the number; undefined when the field is absent.
 * @throws {ModelUnsizedError} when it is present but not a whole number from 0 up, which the loader would still
 * multiply, a numeric text as its number.
 */
function gltfCount(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw new ModelUnsizedError()
}

/** The magic `glTF` that starts a GLB file, and the types of its JSON chunk. */
const GLB_MAGIC = 0x46546c67

const GLB_JSON_CHUNK = 0x4e4f534a

/**
 * The JSON chunk of a GLB file as three.js's GLTFLoader finds it: its chunks in order up to the length the header
 * states, the last JSON chunk among them winning.
 * @param data - the GLB file.
 * @returns the chunk's bytes, or undefined where the loader fails to read the file.
 */
function glbJsonChunk(data: Uint8Array): Uint8Array | undefined {
  if (data.byteLength < 12) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(4, true) < 2) return undefined
  const contents = view.getUint32(8, true) - 12
  let json: Uint8Array | undefined
  for (let index = 0; index < contents;) {
    // Each chunk: its length, its type, then its bytes; reading past the file fails the loader.
    if (12 + index + 8 > data.byteLength) return undefined
    const length = view.getUint32(12 + index, true)
    const type = view.getUint32(16 + index, true)
    const start = 12 + index + 8
    if (type === GLB_JSON_CHUNK) {
      if (start + length > data.byteLength) return undefined
      json = data.subarray(start, start + length)
    }
    index += 8 + length
  }
  return json
}

/**
 * The JSON of a glTF model as three.js's GLTFLoader reads it: a GLB file's JSON chunk, or the whole file's text.
 * @param data - the model file.
 * @returns the parsed JSON, or undefined when the file holds none, which the loader then reports.
 */
export function gltfJson(data: Uint8Array): unknown {
  const glb = data.byteLength >= 4 && new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) === GLB_MAGIC
  const text = glb ? glbJsonChunk(data) : data
  if (text === undefined) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(text))
  } catch {
    // SyntaxError: a file that is not JSON fails in the loader with its own message.
    return undefined
  }
}

/**
 * The bytes the glTF loader sets aside from sizes a description gives alone, before it reads any buffer: an array of
 * `count` items for each accessor without a buffer view, the decoded size of each Meshopt-compressed buffer view, and
 * an instance matrix for each instance of each primitive of an `EXT_mesh_gpu_instancing` node, whose instance count is
 * that of its attributes. A type or component type the loader does not know adds nothing.
 * @param json - the model's JSON.
 * @returns the total in bytes.
 * @throws {ModelUnsizedError} for a count or byte stride that is not a whole number from 0 up.
 */
export function gltfDeclaredBytes(json: unknown): number {
  let total = 0
  const accessors = field(json, 'accessors')
  for (const accessor of gltfEntries(json, 'accessors')) {
    const count = gltfCount(Reflect.get(accessor, 'count'))
    gltfCount(field(Reflect.get(accessor, 'sparse'), 'count'))
    if (Reflect.get(accessor, 'bufferView') !== undefined || count === undefined) continue
    // The loader looks both up as property names.
    const type = String(Reflect.get(accessor, 'type'))
    const componentType = String(Reflect.get(accessor, 'componentType'))
    const components = Object.hasOwn(GLTF_COMPONENTS, type) ? GLTF_COMPONENTS[type] : undefined
    const bytes = Object.hasOwn(GLTF_COMPONENT_BYTES, componentType) ? GLTF_COMPONENT_BYTES[Number(componentType)] : undefined
    if (components === undefined || bytes === undefined) continue
    total += count * components * bytes
  }
  for (const bufferView of gltfEntries(json, 'bufferViews')) {
    const meshopt = field(Reflect.get(bufferView, 'extensions'), 'EXT_meshopt_compression')
    if (!isObject(meshopt)) continue
    const count = gltfCount(Reflect.get(meshopt, 'count'))
    const stride = gltfCount(Reflect.get(meshopt, 'byteStride'))
    if (count !== undefined && stride !== undefined) total += count * stride
  }
  const meshes = field(json, 'meshes')
  for (const node of gltfEntries(json, 'nodes')) {
    const attributes = field(field(Reflect.get(node, 'extensions'), 'EXT_mesh_gpu_instancing'), 'attributes')
    if (!isObject(attributes)) continue
    // The loader counts instances by one attribute; the largest of them bounds that count.
    let instances = 0
    for (const index of Object.values(attributes)) instances = Math.max(instances, gltfCount(field(entryAt(accessors, index), 'count')) ?? 0)
    const primitives = field(entryAt(meshes, Reflect.get(node, 'mesh')), 'primitives')
    total += (Array.isArray(primitives) ? primitives.length : 0) * instances * INSTANCE_MATRIX_BYTES
  }
  return total
}

/** Most distinct files one glTF model may name for the viewer to load with it, as the asset tools count them. */
const MAX_GLTF_FILES = 1024

/** Files whose sizes are asked for at once. */
const SIZE_CONCURRENCY = 16

/**
 * The total size of the files a glTF model names, its buffers and images outside its own file, as the server states
 * each file's size before any of them is read; a file that does not load counts nothing.
 * @param json - the model's JSON.
 * @param related - resolves a name to the URL the loader fetches it from.
 * @param signal - cancellation.
 * @returns the total in bytes.
 * @throws {Error} when the model names more than {@link MAX_GLTF_FILES} distinct files.
 */
export async function gltfFilesBytes(json: unknown, related: ModelSource['related'], signal: AbortSignal): Promise<number> {
  const urls = new Set<string>()
  for (const key of ['buffers', 'images']) {
    for (const entry of gltfEntries(json, key)) {
      const uri: unknown = Reflect.get(entry, 'uri')
      const url = typeof uri === 'string' && !/^data:/iu.test(uri) ? related(uri) : undefined
      if (url !== undefined) urls.add(url)
    }
  }
  if (urls.size > MAX_GLTF_FILES) throw new Error(`the glTF model names ${String(urls.size)} files, more than the ${String(MAX_GLTF_FILES)} the viewer loads with one model`)
  const size = async (url: string): Promise<number> => {
    let response: Response
    try {
      response = await fetch(url, { method: 'HEAD', signal, credentials: 'same-origin' })
    } catch {
      // TypeError or AbortError: the loader's own fetch reports a file that does not load, and an abort ends the read.
      return 0
    }
    const stated = Number(response.headers.get('X-Asset-Size') ?? response.headers.get('Content-Length'))
    return response.ok && Number.isSafeInteger(stated) && stated > 0 ? stated : 0
  }
  const list = [...urls]
  let total = 0
  for (let start = 0; start < list.length; start += SIZE_CONCURRENCY) {
    for (const bytes of await Promise.all(list.slice(start, start + SIZE_CONCURRENCY).map(size))) total += bytes
    signal.throwIfAborted()
  }
  return total
}

/** The child elements of an XML node with a name, as the Collada loader finds them: direct children only. */
function childrenNamed(node: Node, name: string): Node[] {
  return [...node.childNodes].filter(child => child.nodeName === name)
}

/**
 * The file names of a Collada file's images, as its loader reads them: the text of the first `init_from` of each image
 * of each `library_images` of the `COLLADA` element.
 * @param text - the file's text.
 * @returns the names, in file order; none for a file without images or that is not XML.
 */
export function colladaImageNames(text: string): string[] {
  // Most files hold no images; they are not parsed twice.
  if (!text.includes('library_images')) return []
  const document = new DOMParser().parseFromString(text, 'application/xml')
  const names: string[] = []
  for (const collada of childrenNamed(document, 'COLLADA').slice(0, 1)) {
    for (const library of childrenNamed(collada, 'library_images')) {
      for (const image of childrenNamed(library, 'image')) {
        const name = childrenNamed(image, 'init_from')[0]?.textContent
        if (name !== undefined && name !== null) names.push(name)
      }
    }
  }
  return names
}
