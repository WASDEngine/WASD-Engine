/**
 * The 3D view's three.js half, in a chunk the model view loads on first use: reading a model of each listed format,
 * measuring it (bounds, geometry, materials and textures, bones, clips, and morph targets), and the stage that draws
 * one model at a time with orbit controls, room lighting, a ground grid sized to the model, its animations with a
 * seekable clock, its skeleton, and clay or wireframe shading. The stage draws only when something changed: a camera
 * move, a loaded texture, a resize, or a playing animation.
 */
import {
  AnimationMixer, Bone, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, GridHelper, Group, HemisphereLight,
  InstancedMesh, LineBasicMaterial, LoadingManager, Material, Mesh, MeshStandardMaterial, NeutralToneMapping, PerspectiveCamera,
  PMREMGenerator,
  Points, PointsMaterial, PropertyBinding, Scene, SkeletonHelper, SkinnedMesh, SRGBColorSpace, Texture, Timer, Vector3,
  WebGLRenderer, type AnimationAction, type AnimationClip, type Object3D,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js'
import { VOXLoader } from 'three/examples/jsm/loaders/VOXLoader.js'
import type {
  AssetShading, ModelAssetDetails, ModelBoneDetails, ModelClipDetails, ModelMaterialDetails, ModelMorphDetails, ModelTextureDetails,
} from '@deepseek-ai/dsh-game-assets/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ModelDecoder } from '../formats.ts'

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
   * @returns the URL to load.
   */
  readonly related: (reference: string) => string
  /** Called when a texture that loads after the model arrives, so the stage draws it. */
  readonly changed: () => void
}

/** Grid and helper line color, a gray that reads on light and dark backgrounds. */
const GRID_COLOR = 0x888888

/** Color of the bones drawn over a model. */
const BONE_COLOR = 0x3ddc97

/** Color of the selected bone's joint. */
const SELECTED_BONE_COLOR = 0xffb020

/** Color of the clay that `solid` shading draws. */
const CLAY_COLOR = 0xa6a6a6

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
  related: (reference: string) => string,
  signal: AbortSignal,
): Promise<MTLLoader.MaterialCreator | undefined> {
  let response: Response
  try {
    response = await fetch(related(library), { signal, credentials: 'same-origin' })
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

/** Whether an object is a bone. */
function isBone(object: Object3D): object is Bone {
  return object instanceof Bone
}

/** Whether a value is three.js geometry. */
function isGeometry(value: unknown): value is BufferGeometry {
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
function materialsOf(object: Object3D): Material[] {
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

/**
 * Read a model.
 * @param source - the format, the bytes, and how related files resolve.
 * @param signal - cancellation; a model read after it is disposed and the read rejects with the reason.
 * @returns the model.
 * @throws {Error} when the file is not a valid model of its format.
 */
export async function loadModel(source: ModelSource, signal: AbortSignal): Promise<LoadedModel> {
  const manager = new LoadingManager()
  // The names the model stores, by the URL each one loads from, so failures and textures report those names.
  const references = new Map<string, string>()
  const missing: string[] = []
  let outstanding = 0
  const settled = Promise.withResolvers<void>()
  manager.setURLModifier((url) => {
    const resolved = source.related(url)
    references.set(resolved, url)
    return resolved
  })
  manager.addHandler(/\.tga$/iu, new TGALoader(manager))
  manager.onLoad = () => { source.changed() }
  manager.onProgress = () => { source.changed() }
  manager.onError = (url) => {
    const name = fileName(references.get(url) ?? url)
    if (!missing.includes(name)) missing.push(name)
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
  switch (source.decoder) {
    case 'gltf': {
      const gltf = await new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).parseAsync(arrayBufferOf(source.data), '')
      root = gltf.scene
      animations = gltf.animations
      break
    }
    case 'obj': {
      const text = new TextDecoder().decode(source.data)
      const loader = new OBJLoader(manager)
      const library = /^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/mu.exec(text)?.[1]
      const materials = library === undefined ? undefined : await objMaterials(library, manager, source.related, signal)
      if (library !== undefined && materials === undefined) missing.push(fileName(library))
      if (materials !== undefined) loader.setMaterials(materials)
      root = loader.parse(text)
      break
    }
    case 'fbx': {
      root = new FBXLoader(manager).parse(arrayBufferOf(source.data), '')
      animations = root.animations
      break
    }
    case 'dae': {
      const collada = new ColladaLoader(manager).parse(new TextDecoder().decode(source.data), '')
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
    case 'vox':
      root = new VOXLoader().parse(arrayBufferOf(source.data)).scene
      break
    default:
      return assertNever(source.decoder)
  }
  if (signal.aborted) {
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
  return { root, animations, stats: statsOf(root), missing, settled: settled.promise, textureName, dispose: () => { disposeObject(root) } }
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

/**
 * Measure a model for its details.
 * @param model - the loaded model, in its rest pose.
 * @param format - format label.
 * @param bytes - file size.
 * @returns the details the Assets tab shows and the agent reads.
 */
export function describeModel(model: LoadedModel, format: string, bytes: number): ModelAssetDetails {
  const { root } = model
  root.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(root, true)
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
          return typeof measured === 'number' ? measured : 0
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
        ...typeof metalness === 'number' ? { metalness: round(metalness) } : {},
        ...typeof roughness === 'number' ? { roughness: round(roughness) } : {},
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
      seconds: round(clip.duration),
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

/**
 * Light a scene the way the stage does: a room environment for physically based materials, and a sky light and a
 * sun for the Phong and Lambert materials of OBJ and FBX files.
 * @param renderer - the renderer whose environment map the scene uses.
 * @param scene - the scene to light.
 * @returns the environment texture, which the caller disposes.
 */
export function lightScene(renderer: WebGLRenderer, scene: Scene): Texture {
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = NeutralToneMapping
  const generator = new PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const environment = generator.fromScene(room, 0.04).texture
  room.dispose()
  generator.dispose()
  scene.environment = environment
  scene.environmentIntensity = 0.9
  scene.add(new HemisphereLight(0xffffff, 0x60646c, 0.9))
  const sun = new DirectionalLight(0xffffff, 1.4)
  sun.position.set(3, 6, 4)
  scene.add(sun)
  return environment
}

/**
 * A ground grid sized to a model: cells of a power of ten near a fifth of the model, reaching past it on every side.
 * @param bounds - the model's bounds.
 * @returns the grid, at the model's lowest point.
 */
export function gridFor(bounds: Box3): GridHelper {
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const extent = Math.max(size.x, size.z, 1e-6)
  const cell = 10 ** Math.round(Math.log10(extent / 5))
  const half = Math.ceil((extent * 0.8) / cell) * cell
  const grid = new GridHelper(half * 2, Math.round((half * 2) / cell), GRID_COLOR, GRID_COLOR)
  for (const material of materialsOf(grid)) {
    material.transparent = true
    material.opacity = 0.35
    material.depthWrite = false
  }
  grid.position.set(center.x, bounds.min.y, center.z)
  return grid
}

/**
 * Release a helper's geometry and materials.
 * @param helper - a grid, line, or points helper and its children.
 */
export function disposeHelper(helper: Object3D): void {
  helper.traverse((object) => {
    const geometry: unknown = Reflect.get(object, 'geometry')
    if (isGeometry(geometry)) geometry.dispose()
    for (const material of materialsOf(object)) material.dispose()
  })
}

/** The bones of a model drawn over it: lines from each bone to its parent and a point at each joint, never hidden. */
export class SkeletonOverlay {
  /** Add to the scene; remove and dispose with {@link dispose}. */
  readonly object: Object3D
  private readonly lines: SkeletonHelper
  private readonly joints: Points
  private readonly selected: Points
  private readonly bones: readonly Bone[]
  private selection: number | undefined
  private readonly position = new Vector3()

  /**
   * @param root - the model.
   * @param jointSize - size of a joint in pixels.
   */
  constructor(root: Object3D, jointSize = 6) {
    this.bones = bonesOf(root).map(entry => entry.bone)
    this.lines = new SkeletonHelper(root)
    for (const material of materialsOf(this.lines)) {
      if (material instanceof LineBasicMaterial) material.color.set(BONE_COLOR)
      Object.assign(material, { vertexColors: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false })
    }
    this.lines.renderOrder = 998
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(1, this.bones.length) * 3), 3))
    const overlay = { sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false } as const
    this.joints = new Points(geometry, new PointsMaterial({ ...overlay, color: BONE_COLOR, size: jointSize }))
    this.joints.renderOrder = 999
    this.joints.frustumCulled = false
    const one = new BufferGeometry()
    one.setAttribute('position', new BufferAttribute(new Float32Array(3), 3))
    this.selected = new Points(one, new PointsMaterial({ ...overlay, color: SELECTED_BONE_COLOR, size: jointSize * 2 }))
    this.selected.renderOrder = 1000
    this.selected.frustumCulled = false
    this.selected.visible = false
    const group = new Group()
    group.add(this.lines, this.joints, this.selected)
    this.object = group
    this.update()
  }

  /**
   * Mark one bone.
   * @param index - the bone's index in {@link bonesOf} order, or undefined for none.
   */
  select(index: number | undefined): void {
    this.selection = index !== undefined && index >= 0 && index < this.bones.length ? index : undefined
    this.update()
  }

  /** Move the joints to the bones' current positions; call after the pose changes. */
  update(): void {
    const positions = this.joints.geometry.getAttribute('position') as BufferAttribute
    this.bones.forEach((bone, index) => {
      bone.getWorldPosition(this.position)
      positions.setXYZ(index, this.position.x, this.position.y, this.position.z)
    })
    positions.needsUpdate = true
    this.joints.geometry.setDrawRange(0, this.bones.length)
    const bone = this.selection === undefined ? undefined : this.bones[this.selection]
    this.selected.visible = bone !== undefined
    if (bone !== undefined) {
      bone.getWorldPosition(this.position)
      const selected = this.selected.geometry.getAttribute('position') as BufferAttribute
      selected.setXYZ(0, this.position.x, this.position.y, this.position.z)
      selected.needsUpdate = true
    }
  }

  /** Release the overlay's geometry and materials. */
  dispose(): void {
    this.lines.dispose()
    disposeHelper(this.joints)
    disposeHelper(this.selected)
  }
}

/**
 * The clay that `solid` shading draws every surface with; skinning and morphing follow the drawn object.
 * @returns a new material, which the caller disposes.
 */
export function clayMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: CLAY_COLOR, roughness: 0.78, metalness: 0, side: DoubleSide })
}

/**
 * Draw a model's meshes as wireframes or as surfaces.
 * @param root - the model.
 * @param on - whether meshes draw as wireframes.
 */
export function applyWireframe(root: Object3D, on: boolean): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    for (const material of materialsOf(object)) {
      if ('wireframe' in material && typeof material.wireframe === 'boolean') {
        material.wireframe = on
        material.needsUpdate = true
      }
    }
  })
}

/** A camera position and the point it orbits. */
interface View {
  readonly position: Vector3
  readonly target: Vector3
}

/** Where the playing clip stands. */
export interface ClipClock {
  /** Seconds into the clip. */
  readonly time: number
  /** Length of the clip in seconds. */
  readonly duration: number
  readonly playing: boolean
}

/** One canvas's 3D stage; one model at a time. */
export class ModelStage {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(40, 1, 0.01, 1000)
  private readonly controls: OrbitControls
  private readonly environment: Texture
  private readonly timer = new Timer()
  private readonly clay = clayMaterial()
  private grid: GridHelper | undefined
  private model: LoadedModel | undefined
  private mixer: AnimationMixer | undefined
  private action: AnimationAction | undefined
  private skeleton: SkeletonOverlay | undefined
  private playing = true
  private speed = 1
  private shading: AssetShading = 'material'
  private showSkeleton = false
  private selectedBone: number | undefined
  private pending = 0
  private home: View | undefined
  /** Whether the reader moved the camera since the model was framed; until then a resize frames it again. */
  private moved = false
  private disposed = false
  private readonly clockListeners = new Set<(clock: ClipClock) => void>()

  /**
   * @param canvas - the canvas to draw into; the stage sizes its drawing buffer, CSS sizes the element.
   * @throws {Error} when the browser cannot create a WebGL context.
   */
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setClearColor(0x000000, 0)
    this.environment = lightScene(this.renderer, this.scene)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.screenSpacePanning = true
    this.controls.listenToKeyEvents(canvas)
    this.controls.addEventListener('change', () => { this.requestRender() })
    this.controls.addEventListener('start', () => { this.moved = true })
  }

  /**
   * Show a model in place of the current one, which the stage disposes.
   * @param model - the model; the stage owns it from now on.
   * @param keepView - keep the camera, as for a new version of the same file, instead of framing the model.
   */
  show(model: LoadedModel, keepView: boolean): void {
    this.clearModel()
    this.model = model
    this.scene.add(model.root)
    applyWireframe(model.root, this.shading === 'wireframe')
    model.root.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(model.root, true)
    if (bounds.isEmpty()) bounds.set(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5))
    this.placeGrid(bounds)
    if (!keepView || this.home === undefined) this.fit(bounds)
    this.mixer = model.animations.length === 0 ? undefined : new AnimationMixer(model.root)
    this.placeSkeleton()
    this.requestRender()
  }

  /**
   * Play one of the model's clips, or none.
   * @param index - the clip's index, or undefined for the model's rest pose.
   */
  setClip(index: number | undefined): void {
    this.action?.stop()
    this.action = undefined
    const clip = index === undefined ? undefined : this.model?.animations[index]
    if (clip !== undefined && this.mixer !== undefined) {
      this.action = this.mixer.clipAction(clip)
      this.action.paused = !this.playing
      this.action.timeScale = this.speed
      this.action.reset().play()
      this.mixer.update(0)
      this.timer.update()
    }
    // A stopped clip's bindings restore the pose the model was loaded in.
    this.skeleton?.update()
    this.emitClock()
    this.requestRender()
  }

  /**
   * Play or pause the chosen animation clip.
   * @param playing - whether the clip plays or holds its frame.
   */
  setPlaying(playing: boolean): void {
    this.playing = playing
    if (this.action !== undefined) this.action.paused = !playing
    this.timer.update()
    this.emitClock()
    this.requestRender()
  }

  /**
   * Set how fast clips play.
   * @param speed - multiple of normal speed, above 0.
   */
  setSpeed(speed: number): void {
    this.speed = speed
    if (this.action !== undefined) this.action.timeScale = speed
  }

  /**
   * Hold the playing clip at a time.
   * @param seconds - seconds into the clip, clamped to its length.
   */
  seek(seconds: number): void {
    const action = this.action
    if (action === undefined) return
    action.time = Math.min(Math.max(0, seconds), action.getClip().duration)
    this.mixer?.update(0)
    this.skeleton?.update()
    this.emitClock()
    this.requestRender()
  }

  /**
   * Where the playing clip stands.
   * @returns its time, length, and whether it plays, or undefined without a clip.
   */
  clock(): ClipClock | undefined {
    const action = this.action
    if (action === undefined) return undefined
    const duration = action.getClip().duration
    return { time: Math.min(Math.max(action.time, 0), duration), duration, playing: this.playing }
  }

  /**
   * Follow the playing clip's time.
   * @param listener - called after each drawn frame that moved the clip, and after every seek, clip, or play change.
   * @returns stops following.
   */
  onClock(listener: (clock: ClipClock) => void): () => void {
    this.clockListeners.add(listener)
    return () => { this.clockListeners.delete(listener) }
  }

  /**
   * Draw the model's meshes in their materials, as clay, or as wireframes.
   * @param shading - the shading.
   */
  setShading(shading: AssetShading): void {
    this.shading = shading
    if (this.model !== undefined) applyWireframe(this.model.root, shading === 'wireframe')
    this.scene.overrideMaterial = shading === 'solid' ? this.clay : null
    this.requestRender()
  }

  /**
   * Draw the model's meshes as wireframes or as surfaces.
   * @param on - whether meshes draw as wireframes.
   */
  setWireframe(on: boolean): void {
    this.setShading(on ? 'wireframe' : 'material')
  }

  /**
   * Draw the bones over the model, or hide them.
   * @param on - whether the skeleton shows.
   */
  setSkeleton(on: boolean): void {
    this.showSkeleton = on
    this.placeSkeleton()
    this.requestRender()
  }

  /**
   * Mark one bone of the skeleton, showing the skeleton.
   * @param index - the bone's index in {@link bonesOf} order, or undefined for none.
   */
  selectBone(index: number | undefined): void {
    this.selectedBone = index
    this.skeleton?.select(index)
    this.requestRender()
  }

  /**
   * Set one morph target's influence.
   * @param key - the mesh's key from {@link morphTargetsOf}.
   * @param index - the target's index.
   * @param value - influence from 0 to 1.
   */
  setMorph(key: string, index: number, value: number): void {
    this.model?.root.traverse((object) => {
      if (!(object instanceof Mesh) || object.uuid !== key) return
      const influences = object.morphTargetInfluences
      if (influences !== undefined && index < influences.length) influences[index] = Math.min(1, Math.max(0, value))
    })
    this.requestRender()
  }

  /** Return the camera to where the model was framed. */
  resetView(): void {
    if (this.home === undefined) return
    this.camera.position.copy(this.home.position)
    this.controls.target.copy(this.home.target)
    this.controls.update()
    this.moved = false
    this.requestRender()
  }

  /**
   * Match the drawing buffer to the canvas's size; a model the reader has not moved is framed again.
   * @param width - CSS pixels.
   * @param height - CSS pixels.
   * @param pixelRatio - device pixels per CSS pixel.
   */
  resize(width: number, height: number, pixelRatio: number): void {
    if (width <= 0 || height <= 0) return
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (!this.moved && this.model !== undefined) {
      const bounds = new Box3().setFromObject(this.model.root, true)
      if (!bounds.isEmpty()) this.fit(bounds)
    }
    this.requestRender()
  }

  /** Draw at the next animation frame, once however often it is asked. */
  requestRender(): void {
    if (this.pending !== 0 || this.disposed) return
    this.pending = requestAnimationFrame(this.tick)
  }

  /** Stop drawing and release the model, the environment, the controls, and the WebGL context. */
  dispose(): void {
    this.disposed = true
    if (this.pending !== 0) cancelAnimationFrame(this.pending)
    this.pending = 0
    this.clockListeners.clear()
    this.clearModel()
    this.clay.dispose()
    this.controls.dispose()
    this.timer.dispose()
    this.environment.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }

  private readonly tick = (): void => {
    this.pending = 0
    if (this.disposed) return
    // A long pause between frames would jump the animation; it resumes where it stopped.
    this.timer.update()
    const delta = Math.min(this.timer.getDelta(), 0.1)
    const moving = this.controls.update(delta)
    const animating = this.action !== undefined && this.playing
    if (animating) {
      this.mixer?.update(delta)
      this.skeleton?.update()
    }
    this.renderer.render(this.scene, this.camera)
    if (animating) this.emitClock()
    if (moving || animating) this.requestRender()
  }

  private emitClock(): void {
    const clock = this.clock()
    if (clock === undefined) return
    for (const listener of [...this.clockListeners]) listener(clock)
  }

  private placeSkeleton(): void {
    if (this.skeleton !== undefined) {
      this.scene.remove(this.skeleton.object)
      this.skeleton.dispose()
      this.skeleton = undefined
    }
    if (!this.showSkeleton || this.model === undefined || bonesOf(this.model.root).length === 0) return
    this.skeleton = new SkeletonOverlay(this.model.root)
    this.skeleton.select(this.selectedBone)
    this.scene.add(this.skeleton.object)
  }

  private clearModel(): void {
    this.action?.stop()
    this.action = undefined
    this.mixer?.stopAllAction()
    if (this.skeleton !== undefined) {
      this.scene.remove(this.skeleton.object)
      this.skeleton.dispose()
      this.skeleton = undefined
    }
    this.selectedBone = undefined
    if (this.model !== undefined) {
      this.mixer?.uncacheRoot(this.model.root)
      this.scene.remove(this.model.root)
      this.model.dispose()
    }
    this.mixer = undefined
    this.model = undefined
  }

  private placeGrid(bounds: Box3): void {
    if (this.grid !== undefined) {
      this.scene.remove(this.grid)
      disposeHelper(this.grid)
    }
    this.grid = gridFor(bounds)
    this.scene.add(this.grid)
  }

  private fit(bounds: Box3): void {
    const center = bounds.getCenter(new Vector3())
    const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1e-3)
    const vertical = (this.camera.fov * Math.PI) / 360
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect)
    const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.12
    const direction = new Vector3(0.9, 0.55, 1.3).normalize()
    this.camera.position.copy(center).addScaledVector(direction, distance)
    this.camera.near = distance / 500
    this.camera.far = distance * 50
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(center)
    this.controls.minDistance = radius * 0.05
    this.controls.maxDistance = distance * 10
    this.controls.update()
    this.home = { position: this.camera.position.clone(), target: center.clone() }
    this.moved = false
  }
}
