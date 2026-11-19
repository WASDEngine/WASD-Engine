/**
 * The 3D view's three.js half, in a chunk the model view loads on first use: reading a model of each listed format,
 * measuring it (bounds, geometry, materials and textures, bones, clips, and morph targets), and the stage that draws
 * one model at a time with orbit controls, room lighting, a ground grid sized to the model, its animations with a
 * seekable clock, its skeleton, and clay or wireframe shading. The stage draws only when something changed: a camera
 * move, a loaded texture, a resize, or a playing animation. Before a loader allocates what a file asks for, the memory
 * is counted from the file and refused past {@link ModelSource.maxBytes}: a glTF description's own sizes and the files
 * it names, a VOX file's meshes, and an FBX file's arrays; and every texture of every format is checked before it is
 * decoded, its pixels against the viewer's cap and its file and decoded size against the textures' share of that memory.
 */
import {
  Bone, Box3, BufferGeometry, Color, DoubleSide, Group, InstancedMesh, LoaderUtils, LoadingManager, Material, Mesh, MeshStandardMaterial,
  Object3D, Points, PointsMaterial, PropertyBinding, SkinnedMesh, Texture, Vector3, type AnimationClip,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader, type GLTFLoaderPlugin, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js'
import { buildMesh, VOXLoader, type Chunk } from 'three/examples/jsm/loaders/VOXLoader.js'
import type {
  ModelAssetDetails, ModelBoneDetails, ModelClipDetails, ModelMaterialDetails, ModelMorphDetails, ModelTextureDetails,
} from '@deepseek-ai/dsh-game-assets/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ModelDecoder } from '../formats.ts'
import { mtllibOf } from '@deepseek-ai/dsh-game-assets/model-files'
import { fbxBytes } from './fbx.ts'
import { CheckedTextureLoader, CheckedTextures, TextureBudget } from './textures.ts'
import { voxPlan } from './vox.ts'
import {
  colladaImageNames, entryAt, field, gltfDeclaredBytes, gltfFilesBytes, gltfJson, isArrayBuffer, ModelTooLargeError,
} from './model-sizes.ts'

/** Counts shown beside a model. */
export interface ModelStats {
  /** Triangles drawn, instances counted. */
  readonly triangles: number
  /** Vertices of the drawn geometry, instances counted. */
  readonly vertices: number
}

/** One model ready for the stage. */
export interface LoadedModel {
  /** The model's root object. */
  readonly root: Object3D
  /** Its animation clips. */
  readonly animations: readonly AnimationClip[]
  readonly stats: ModelStats
  /** Files the model names that failed to load, by the names the model stores; grows while textures load. */
  readonly missing: readonly string[]
  /** Settles once every file the model names has loaded or failed. */
  readonly settled: Promise<void>
  /**
   * The name of a texture: its own name, or the file name the model stores for it.
   * @param texture - one of the model's textures.
   * @returns the name, empty when the texture has none.
   */
  textureName(texture: Texture): string
  /** Release its geometries, materials, textures, and skeletons. */
  dispose(): void
}

/** What a model is read from. */
export interface ModelSource {
  readonly decoder: ModelDecoder
  /** The model file. */
  readonly data: Uint8Array<ArrayBuffer>
  /**
   * The URL of a file the model names, such as a texture, a glTF buffer, or an OBJ material library.
   * @param reference - the name as the model stores it, relative to the model file.
   * @returns the URL to load, or undefined for a file the viewer does not load, which the model lists as missing.
   */
  readonly related: (reference: string) => string | undefined
  /** Called when a texture that loads after the model arrives, so the stage draws it. */
  readonly changed: () => void
  /**
   * Largest number of bytes a model's loader may allocate beyond the files it is read from, as the file asks for them:
   * a glTF description's accessors without a buffer view, which the loader fills, the Meshopt-compressed buffer views it
   * decodes, and the instance matrices of `EXT_mesh_gpu_instancing` nodes; a VOX file's meshes; and an FBX file's
   * nodes and arrays. A glTF model's file and the buffers and images it names take at most as many bytes together, and
   * the model's textures at most as many again in their files and as many decoded.
   */
  readonly maxBytes: number
  /**
   * Check an image a model names before it is decoded, from its bytes.
   * @param data - the image file, or the bytes of its glTF buffer view.
   * @param name - a name whose extension picks the header to read: the name the model stores for the file, or a URL;
   * empty for an image inside a glTF buffer.
   * @returns the bytes the image takes decoded.
   * @throws {Error} when its header states more pixels than the viewer decodes, or no size the viewer reads; the model
   * then shows without the image and lists it as missing.
   */
  readonly checkImage: (data: Uint8Array, name: string) => number
}

/** Name of the GLTFLoader plugin that checks a model's images before they are decoded. */
const CHECKED_IMAGES = 'wasd_checked_images'

/**
 * A GLTFLoader plugin that checks each image a model names before the loader decodes it, from the bytes of its buffer
 * view or of the file its URI names, which the check fetches through the same URL as the loader, and counts it against
 * the model's texture budget once, however many textures use it. The loader shows the model without an image that
 * fails the check, as without one that does not load.
 * @param parser - the loader's parser of one model.
 * @param budget - the model's texture budget, whose check is {@link ModelSource.checkImage}.
 * @param refused - told the name of each image that fails the check: the file name of its URI, else its own name or
 * its number.
 * @param signal - cancellation of the model's read.
 * @returns the plugin.
 */
function checkedImages(
  parser: GLTFParser,
  budget: TextureBudget,
  refused: (name: string) => void,
  signal: AbortSignal,
): GLTFLoaderPlugin {
  const json: unknown = parser.json
  const images = field(json, 'images')
  const checks = new Map<number, Promise<void>>()
  const checkSource = async (sourceIndex: number): Promise<void> => {
    const image = entryAt(images, sourceIndex)
    const uri = field(image, 'uri')
    const own = field(image, 'name')
    // How the missing files list a refused image: its file's name, else its own name, else its JSON Pointer in the
    // model's description.
    const listed = typeof uri === 'string' && !/^data:/iu.test(uri) ? fileName(uri) : typeof own === 'string' && own !== '' ? own : `#/images/${String(sourceIndex)}`
    const verify = (data: Uint8Array, name: string): void => {
      try {
        budget.take(data, name)
      } catch (error) {
        refused(listed)
        throw error
      }
    }
    const view = field(image, 'bufferView')
    if (view !== undefined) {
      const bytes: unknown = await parser.getDependency('bufferView', Number(view))
      // The loader's buffers may come from another realm, as in a test page, where `instanceof` does not hold.
      if (isArrayBuffer(bytes)) verify(new Uint8Array(bytes), '')
      return
    }
    if (typeof uri !== 'string') return
    const url = parser.options.manager.resolveURL(LoaderUtils.resolveURL(uri, parser.options.path))
    let response: Response
    try {
      response = await fetch(url, { signal, credentials: 'same-origin' })
    } catch {
      // TypeError or AbortError: a file that cannot be fetched fails in the loader's own fetch, which names it.
      return
    }
    if (response.ok) verify(new Uint8Array(await response.arrayBuffer()), uri)
  }
  const loadImageSource = parser.loadImageSource.bind(parser)
  parser.loadImageSource = async (sourceIndex, loader) => {
    let checked = checks.get(sourceIndex)
    if (checked === undefined) {
      checked = checkSource(sourceIndex)
      checks.set(sourceIndex, checked)
    }
    await checked
    return await loadImageSource(sourceIndex, loader)
  }
  return { name: CHECKED_IMAGES }
}

/** Texture slots a material's details list, in order. */
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'lightMap',
] as const

/** Materials, textures, and bones that one model's details list. */
const LISTED = { materials: 48, textures: 48, bones: 256, targets: 24 } as const

/**
 * Copy bytes into a new buffer of this page's own `ArrayBuffer`, which the loaders test with `instanceof`; bytes from
 * another realm, such as a decoder's, would otherwise read as text.
 * @param bytes - the file.
 * @returns the copy's buffer.
 */
function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/**
 * Read an OBJ file's first material library. Its textures resolve against the library's folder.
 * @param library - the `mtllib` name, relative to the OBJ file.
 * @param manager - the model's loading manager.
 * @param related - resolves the name to a URL.
 * @param signal - cancellation.
 * @returns the materials, or undefined when the library cannot be read, in which case the model shows untextured.
 */
async function objMaterials(
  library: string,
  manager: LoadingManager,
  related: (reference: string) => string | undefined,
  signal: AbortSignal,
): Promise<MTLLoader.MaterialCreator | undefined> {
  const url = related(library)
  if (url === undefined) return undefined
  let response: Response
  try {
    response = await fetch(url, { signal, credentials: 'same-origin' })
  } catch {
    // TypeError or AbortError: a library that cannot be fetched leaves the model untextured, and an abort ends the load
    // at its next check.
    return undefined
  }
  if (!response.ok) return undefined
  const folder = library.replaceAll('\\', '/').slice(0, library.replaceAll('\\', '/').lastIndexOf('/') + 1)
  const materials = new MTLLoader(manager).parse(await response.text(), folder)
  materials.preload()
  return materials
}

/**
 * The meshes of a VOX file without a scene graph, from which the loader builds no scene: one for each model that holds
 * voxels, in file order.
 * @param chunks - the models the loader read.
 * @returns the meshes in one group.
 */
function voxModels(chunks: readonly Chunk[]): Group {
  const group = new Group()
  for (const chunk of chunks) {
    // A model whose size no voxels follow has no data for the mesher, whatever the loader's types say.
    const data: unknown = Reflect.get(chunk, 'data')
    if (data instanceof Uint8Array) group.add(buildMesh(chunk))
  }
  return group
}

/**
 * The object for loose geometry: a mesh with a standard material, vertex colors when the geometry has them, and
 * computed normals when it has none, or points for geometry without faces.
 * @param geometry - the geometry.
 * @param faces - whether the geometry has faces.
 * @returns the object to show.
 */
function objectOf(geometry: BufferGeometry, faces: boolean): Object3D {
  const colors = geometry.hasAttribute('color')
  const color = colors ? 0xffffff : 0xb8b8b8
  if (!faces) return new Points(geometry, new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: colors, color }))
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals()
  return new Mesh(geometry, new MeshStandardMaterial({ vertexColors: colors, color, roughness: 0.7, metalness: 0 }))
}

/** Whether an object draws geometry: a mesh, including skinned and instanced meshes, or points. */
function isDrawn(object: Object3D): object is Mesh | Points {
  return object instanceof Mesh || object instanceof Points
}

/** Whether a value is a three.js material. */
function isMaterial(value: unknown): value is Material {
  return value instanceof Material
}

/** Whether a value is a three.js texture. */
function isTexture(value: unknown): value is Texture {
  return value instanceof Texture
}

/** Whether a value is a three.js object. */
function isObject3D(value: unknown): value is Object3D {
  return value instanceof Object3D
}

/** Whether an object is a bone. */
function isBone(object: Object3D): object is Bone {
  return object instanceof Bone
}

/**
 * Whether a value is three.js geometry.
 * @param value - the value.
 * @returns true for geometry.
 */
export function isGeometry(value: unknown): value is BufferGeometry {
  return value instanceof BufferGeometry
}

/**
 * Count a model's triangles and vertices.
 * @param root - the model.
 * @returns the counts.
 */
export function statsOf(root: Object3D): ModelStats {
  let triangles = 0
  let vertices = 0
  root.traverse((object) => {
    if (!isDrawn(object)) return
    const geometry = object.geometry
    if (!geometry.hasAttribute('position')) return
    const position = geometry.getAttribute('position')
    const instances = object instanceof InstancedMesh ? object.count : 1
    vertices += position.count * instances
    if (object instanceof Mesh) triangles += Math.floor((geometry.index?.count ?? position.count) / 3) * instances
  })
  return { triangles, vertices }
}

/**
 * The materials of an object.
 * @param object - a mesh, points, or line.
 * @returns its materials, none for an object without any.
 */
export function materialsOf(object: Object3D): Material[] {
  const material: unknown = Reflect.get(object, 'material')
  if (isMaterial(material)) return [material]
  if (Array.isArray(material)) return material.filter(isMaterial)
  return []
}

/**
 * Release a model's GPU resources.
 * @param root - the model.
 */
export function disposeObject(root: Object3D): void {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  root.traverse((object) => {
    const geometry: unknown = Reflect.get(object, 'geometry')
    if (isGeometry(geometry)) geometries.add(geometry)
    for (const material of materialsOf(object)) materials.add(material)
    if (object instanceof SkinnedMesh) object.skeleton.dispose()
  })
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) value.dispose()
    material.dispose()
  }
  for (const geometry of geometries) geometry.dispose()
}

/** The last segment of a `/`- or `\`-separated name. */
function fileName(reference: string): string {
  const normalized = reference.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Whether every corner of a box is a finite number. */
function isFiniteBox(box: Box3): boolean {
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite)
}

/**
 * The world bounds of a model in its current pose, as three.js measures them precisely, leaving out vertices whose
 * position is not a finite number and instanced meshes whose bounds are not, so that a damaged vertex leaves the
 * rest measured.
 * @param root - the model.
 * @returns the bounds; empty when no vertex has a finite position.
 */
export function finiteBounds(root: Object3D): Box3 {
  const bounds = new Box3()
  const point = new Vector3()
  const part = new Box3()
  root.updateMatrixWorld(true)
  root.traverse((object) => {
    const geometry: unknown = Reflect.get(object, 'geometry')
    if (!isGeometry(geometry)) return
    if (!geometry.hasAttribute('position')) return
    const position = geometry.getAttribute('position')
    if (object instanceof InstancedMesh) {
      // Instanced meshes are measured by their bounding box over every instance, as three.js measures them.
      if (object.boundingBox === null) object.computeBoundingBox()
      if (object.boundingBox === null) return
      part.copy(object.boundingBox).applyMatrix4(object.matrixWorld)
      if (!part.isEmpty() && isFiniteBox(part)) bounds.union(part)
      return
    }
    for (let index = 0; index < position.count; index += 1) {
      if (object instanceof Mesh) object.getVertexPosition(index, point)
      else point.fromBufferAttribute(position, index)
      point.applyMatrix4(object.matrixWorld)
      if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) bounds.expandByPoint(point)
    }
  })
  return bounds
}

/** How the missing files list a texture embedded in the model that failed. */
const EMBEDDED = '(embedded)'

/**
 * Read a model.
 * @param source - the format, the bytes, and how related files resolve.
 * @param signal - cancellation; a model read after it is disposed and the read rejects with the reason.
 * @returns the model.
 * @throws {ModelTooLargeError} when the file asks its loader for more than {@link ModelSource.maxBytes};
 * {@link ModelUnsizedError} for a glTF description whose sizes are not whole numbers; `VoxModelTooLargeError` and
 * `VoxWorkTooLargeError` for a VOX file larger than MagicaVoxel makes; {Error} when the file is not a valid model of
 * its format, an FBX array whose compressed data inflates past its stated length among them.
 */
export async function loadModel(source: ModelSource, signal: AbortSignal): Promise<LoadedModel> {
  const manager = new LoadingManager()
  // The names the model stores, by the URL each one loads from, so failures and textures report those names.
  const references = new Map<string, string>()
  const missing: string[] = []
  const listMissing = (name: string): void => {
    if (!missing.includes(name)) missing.push(name)
  }
  let outstanding = 0
  const settled = Promise.withResolvers<void>()
  const budget = new TextureBudget(source.maxBytes, source.checkImage)
  const textures = new CheckedTextures(budget, signal)
  void settled.promise.then(() => { textures.dispose() })
  // A file the viewer does not load gets a `data:` URL without a comma, which fetches and images refuse without any
  // request; each is its own URL, also beside another model's in the loaders' shared request table, so its failure
  // names its own file.
  const refusals = `refused-${Math.random().toString(36).slice(2)}-`
  let refused = 0
  // Where a name the model stores loads from: the related file, or for a Collada file the checked bytes of its image.
  let redirect = (url: string): string | undefined => source.related(url)
  manager.setURLModifier((url) => {
    const resolved = redirect(url) ?? `data:${refusals}${String(++refused)}`
    references.set(resolved, url)
    return resolved
  })
  manager.onLoad = () => { source.changed() }
  manager.onProgress = () => { source.changed() }
  manager.onError = (url) => {
    const reference = references.get(url) ?? url
    listMissing(/^(?:blob|data):/iu.test(reference) ? EMBEDDED : fileName(reference))
  }
  const itemStart = manager.itemStart.bind(manager)
  const itemEnd = manager.itemEnd.bind(manager)
  manager.itemStart = (url) => {
    outstanding += 1
    itemStart(url)
  }
  manager.itemEnd = (url) => {
    itemEnd(url)
    outstanding -= 1
    if (outstanding === 0) settled.resolve()
  }
  let root: Object3D
  let animations: readonly AnimationClip[] = []
  // OBJ material libraries and FBX files ask the manager for a texture loader by each texture's name; every texture
  // gets the checked one, a TGA name the one that reads TGA.
  const checkTextures = (): void => {
    manager.addHandler(/\.tga$/iu, new CheckedTextureLoader(manager, textures, 'tga'))
    manager.addHandler(/(?:)/u, new CheckedTextureLoader(manager, textures, 'image'))
  }
  try {
    switch (source.decoder) {
      case 'gltf': {
        // The loader allocates these arrays from the description's sizes alone, so a small file could ask for gigabytes.
        const json = gltfJson(source.data)
        const declared = gltfDeclaredBytes(json)
        if (declared > source.maxBytes) throw new ModelTooLargeError(declared, source.maxBytes)
        // The loader reads every buffer and image it names whole; together with the model they fit what one file may take.
        const files = source.data.byteLength + await gltfFilesBytes(json, source.related, signal)
        if (files > source.maxBytes) throw new ModelTooLargeError(files, source.maxBytes)
        manager.addHandler(/\.tga$/iu, new TGALoader(manager))
        const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder)
        loader.register(parser => checkedImages(parser, budget, listMissing, signal))
        const gltf = await loader.parseAsync(arrayBufferOf(source.data), '')
        root = gltf.scene
        animations = gltf.animations
        break
      }
      case 'obj': {
        checkTextures()
        const text = new TextDecoder().decode(source.data)
        const loader = new OBJLoader(manager)
        const library = mtllibOf(text)
        const materials = library === undefined ? undefined : await objMaterials(library, manager, source.related, signal)
        if (library !== undefined && materials === undefined) listMissing(fileName(library))
        if (materials !== undefined) loader.setMaterials(materials)
        root = loader.parse(text)
        break
      }
      case 'fbx': {
        // The loader inflates each compressed array whole and makes JavaScript numbers of every value it reads.
        const bytes = fbxBytes(source.data, source.maxBytes)
        if (bytes > source.maxBytes) throw new ModelTooLargeError(bytes, source.maxBytes)
        checkTextures()
        root = new FBXLoader(manager).parse(arrayBufferOf(source.data), '')
        animations = root.animations
        break
      }
      case 'dae': {
        // The loader decodes images with loaders of its own, from the checked bytes of each.
        const text = new TextDecoder().decode(source.data)
        await textures.prefetch(colladaImageNames(text), source.related, listMissing)
        redirect = url => textures.checked(url)
        const collada = new ColladaLoader(manager).parse(text, '')
        if (collada === null) throw new Error('not a Collada file')
        root = collada.scene
        animations = collada.scene.animations
        break
      }
      case 'stl':
        root = objectOf(new STLLoader().parse(arrayBufferOf(source.data)), true)
        break
      case 'ply': {
        // A PLY file with faces has an index; without one it is a point cloud.
        const geometry = new PLYLoader().parse(arrayBufferOf(source.data))
        root = objectOf(geometry, geometry.index !== null)
        break
      }
      case 'vox': {
        // The mesher sweeps every cell of each model's box, as many times as the scene places the model.
        const plan = voxPlan(source.data)
        if (plan.bytes > source.maxBytes) throw new ModelTooLargeError(plan.bytes, source.maxBytes)
        const parsed = new VOXLoader().parse(arrayBufferOf(source.data))
        // The loader's types promise a scene, but it builds none for a file without a scene graph.
        const scene: unknown = Reflect.get(parsed, 'scene')
        root = isObject3D(scene) ? scene : voxModels(parsed.chunks)
        break
      }
      default:
        return assertNever(source.decoder)
    }
  } catch (error) {
    textures.dispose()
    throw error
  }
  if (signal.aborted) {
    textures.dispose()
    disposeObject(root)
    throw signal.reason
  }
  if (outstanding === 0) settled.resolve()
  const textureName = (texture: Texture): string => {
    if (texture.name !== '') return fileName(texture.name)
    const image: unknown = texture.image
    const src = typeof image === 'object' && image !== null && 'src' in image && typeof image.src === 'string' ? image.src : undefined
    return src === undefined ? '' : fileName(references.get(src) ?? '')
  }
  const dispose = (): void => {
    textures.dispose()
    disposeObject(root)
  }
  return { root, animations, stats: statsOf(root), missing, settled: settled.promise, textureName, dispose }
}

/**
 * The bones of a model in depth-first order, each with the index of its nearest bone ancestor.
 * @param root - the model.
 * @returns the bones and their parents.
 */
export function bonesOf(root: Object3D): { readonly bone: Bone; readonly parent?: number }[] {
  const bones: { bone: Bone; parent?: number }[] = []
  const index = new Map<Object3D, number>()
  root.traverse((object) => {
    if (!isBone(object)) return
    let ancestor = object.parent
    while (ancestor !== null && !index.has(ancestor)) ancestor = ancestor.parent
    const parent = ancestor === null ? undefined : index.get(ancestor)
    index.set(object, bones.length)
    bones.push(parent === undefined ? { bone: object } : { bone: object, parent })
  })
  return bones
}

/** The morph targets of one mesh, keyed for the stage's sliders. */
export interface MorphTargets {
  /** Stable key of the mesh within the model. */
  readonly key: string
  readonly mesh: string
  readonly targets: readonly string[]
}

/**
 * The meshes of a model that have morph targets, with the targets' names in influence order.
 * @param root - the model.
 * @returns one entry per mesh.
 */
export function morphTargetsOf(root: Object3D): MorphTargets[] {
  const entries: MorphTargets[] = []
  root.traverse((object) => {
    if (!(object instanceof Mesh) || object.morphTargetInfluences === undefined || object.morphTargetInfluences.length === 0) return
    const names: string[] = Array.from({ length: object.morphTargetInfluences.length }, (_, index) => `#${index}`)
    for (const [name, index] of Object.entries(object.morphTargetDictionary ?? {})) if (index < names.length) names[index] = name
    entries.push({ key: object.uuid, mesh: object.name, targets: names })
  })
  return entries
}

function round(value: number): number {
  return Number(value.toPrecision(6))
}

/** Whether a value is a finite number, which the details can carry. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Measure a model for its details.
 * @param model - the loaded model, in its rest pose.
 * @param format - format label.
 * @param bytes - file size.
 * @returns the details the Assets tab shows and the agent reads.
 */
export function describeModel(model: LoadedModel, format: string, bytes: number): ModelAssetDetails {
  const { root } = model
  const bounds = finiteBounds(root)
  const empty = bounds.isEmpty()
  let meshes = 0
  let nodes = 0
  const materials = new Set<Material>()
  root.traverse((object) => {
    nodes += 1
    if (isDrawn(object)) {
      meshes += 1
      for (const material of materialsOf(object)) materials.add(material)
    }
  })
  const textures = new Map<Texture, ModelTextureDetails>()
  const materialDetails: ModelMaterialDetails[] = []
  for (const material of materials) {
    const maps: { slot: string; texture: string }[] = []
    for (const slot of TEXTURE_SLOTS) {
      const value: unknown = Reflect.get(material, slot)
      if (!isTexture(value)) continue
      const name = model.textureName(value)
      maps.push({ slot, texture: name === '' ? '(embedded)' : name })
      if (!textures.has(value)) {
        const image: unknown = value.image
        const size = (key: 'width' | 'height'): number => {
          if (typeof image !== 'object' || image === null || !(key in image)) return 0
          const measured: unknown = Reflect.get(image, key)
          return isFiniteNumber(measured) && measured > 0 ? Math.round(measured) : 0
        }
        textures.set(value, { name: name === '' ? '(embedded)' : name, width: size('width'), height: size('height') })
      }
    }
    const color: unknown = Reflect.get(material, 'color')
    const metalness: unknown = Reflect.get(material, 'metalness')
    const roughness: unknown = Reflect.get(material, 'roughness')
    if (materialDetails.length < LISTED.materials) {
      materialDetails.push({
        name: material.name,
        type: material.type,
        ...color instanceof Color ? { color: `#${color.getHexString()}` } : {},
        ...isFiniteNumber(metalness) ? { metalness: round(metalness) } : {},
        ...isFiniteNumber(roughness) ? { roughness: round(roughness) } : {},
        maps,
        transparent: material.transparent,
        doubleSided: material.side === DoubleSide,
        vertexColors: material.vertexColors,
      })
    }
  }
  const bones = bonesOf(root)
  const boneDetails: ModelBoneDetails[] = bones.slice(0, LISTED.bones)
    .map(({ bone, parent }) => (parent === undefined ? { name: bone.name } : { name: bone.name, parent }))
  const clips: ModelClipDetails[] = model.animations.map((clip) => {
    const targets = new Set<string>()
    for (const track of clip.tracks) {
      try {
        targets.add(PropertyBinding.parseTrackName(track.name).nodeName)
      } catch {
        // Error: a track name three.js cannot parse names no target to list.
      }
    }
    return {
      name: clip.name,
      // A clip whose key times are not numbers has no length to give.
      seconds: isFiniteNumber(clip.duration) && clip.duration > 0 ? round(clip.duration) : 0,
      tracks: clip.tracks.length,
      targets: [...targets].slice(0, LISTED.targets),
      targetCount: targets.size,
    }
  })
  const morphTargets: ModelMorphDetails[] = morphTargetsOf(root).map(entry => ({ mesh: entry.mesh, targets: [...entry.targets] }))
  return {
    kind: 'model',
    format,
    bytes,
    min: empty ? [0, 0, 0] : [round(bounds.min.x), round(bounds.min.y), round(bounds.min.z)],
    max: empty ? [0, 0, 0] : [round(bounds.max.x), round(bounds.max.y), round(bounds.max.z)],
    triangles: model.stats.triangles,
    vertices: model.stats.vertices,
    meshes,
    nodes,
    materials: materialDetails,
    materialCount: materials.size,
    textures: [...textures.values()].slice(0, LISTED.textures),
    textureCount: textures.size,
    bones: boneDetails,
    boneCount: bones.length,
    animations: clips,
    morphTargets,
    missing: [...model.missing].slice(0, 32),
  }
}
