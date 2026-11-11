/**
 * The 3D view's three.js half, in a chunk the model view loads on first use: reading a model of each listed format,
 * and the stage that draws one model at a time with orbit controls, room lighting, a ground grid sized to the model,
 * and its animations. The stage draws only when something changed: a camera move, a loaded texture, a resize, or a
 * playing animation.
 */
import {
  AnimationMixer, Box3, BufferGeometry, DirectionalLight, GridHelper, HemisphereLight, InstancedMesh, LoadingManager, Material,
  Mesh, MeshStandardMaterial, NeutralToneMapping, PerspectiveCamera, PMREMGenerator, Points, PointsMaterial, Scene, SkinnedMesh,
  SRGBColorSpace, Texture, Timer, Vector3, WebGLRenderer, type AnimationAction, type AnimationClip, type Object3D,
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

/**
 * Read a model.
 * @param source - the format, the bytes, and how related files resolve.
 * @param signal - cancellation; a model read after it is disposed and the read rejects with the reason.
 * @returns the model.
 * @throws {Error} when the file is not a valid model of its format.
 */
export async function loadModel(source: ModelSource, signal: AbortSignal): Promise<LoadedModel> {
  const manager = new LoadingManager()
  manager.setURLModifier(url => source.related(url))
  manager.addHandler(/\.tga$/iu, new TGALoader(manager))
  manager.onLoad = () => { source.changed() }
  manager.onProgress = () => { source.changed() }
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
  return { root, animations, stats: statsOf(root), dispose: () => { disposeObject(root) } }
}

/** A camera position and the point it orbits. */
interface View {
  readonly position: Vector3
  readonly target: Vector3
}

/** One canvas's 3D stage; one model at a time. */
export class ModelStage {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(40, 1, 0.01, 1000)
  private readonly controls: OrbitControls
  private readonly environment: Texture
  private readonly timer = new Timer()
  private grid: GridHelper | undefined
  private model: LoadedModel | undefined
  private mixer: AnimationMixer | undefined
  private action: AnimationAction | undefined
  private playing = true
  private wireframe = false
  private pending = 0
  private home: View | undefined
  /** Whether the reader moved the camera since the model was framed; until then a resize frames it again. */
  private moved = false
  private disposed = false

  /**
   * @param canvas - the canvas to draw into; the stage sizes its drawing buffer, CSS sizes the element.
   * @throws {Error} when the browser cannot create a WebGL context.
   */
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = NeutralToneMapping
    const generator = new PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.environment = generator.fromScene(room, 0.04).texture
    room.dispose()
    generator.dispose()
    this.scene.environment = this.environment
    this.scene.environmentIntensity = 0.9
    // Lights for materials that ignore the environment, such as the Phong and Lambert materials of OBJ and FBX files.
    this.scene.add(new HemisphereLight(0xffffff, 0x60646c, 0.9))
    const sun = new DirectionalLight(0xffffff, 1.4)
    sun.position.set(3, 6, 4)
    this.scene.add(sun)
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
    this.applyWireframe()
    model.root.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(model.root, true)
    if (bounds.isEmpty()) bounds.set(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5))
    this.placeGrid(bounds)
    if (!keepView || this.home === undefined) this.fit(bounds)
    this.mixer = model.animations.length === 0 ? undefined : new AnimationMixer(model.root)
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
      this.action.reset().play()
      this.timer.update()
    }
    this.requestRender()
  }

  /** @param playing - whether the clip plays or holds its frame. */
  setPlaying(playing: boolean): void {
    this.playing = playing
    if (this.action !== undefined) this.action.paused = !playing
    this.timer.update()
    this.requestRender()
  }

  /** @param on - whether meshes draw as wireframes. */
  setWireframe(on: boolean): void {
    this.wireframe = on
    this.applyWireframe()
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
    this.clearModel()
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
    if (animating) this.mixer?.update(delta)
    this.renderer.render(this.scene, this.camera)
    if (moving || animating) this.requestRender()
  }

  private clearModel(): void {
    this.action?.stop()
    this.action = undefined
    this.mixer?.stopAllAction()
    if (this.model !== undefined) {
      this.mixer?.uncacheRoot(this.model.root)
      this.scene.remove(this.model.root)
      this.model.dispose()
    }
    this.mixer = undefined
    this.model = undefined
  }

  private applyWireframe(): void {
    this.model?.root.traverse((object) => {
      if (!(object instanceof Mesh)) return
      for (const material of materialsOf(object)) {
        if ('wireframe' in material && typeof material.wireframe === 'boolean') {
          material.wireframe = this.wireframe
          material.needsUpdate = true
        }
      }
    })
  }

  private placeGrid(bounds: Box3): void {
    if (this.grid !== undefined) {
      this.scene.remove(this.grid)
      this.grid.geometry.dispose()
      for (const material of materialsOf(this.grid)) material.dispose()
    }
    const size = bounds.getSize(new Vector3())
    const center = bounds.getCenter(new Vector3())
    const extent = Math.max(size.x, size.z, 1e-6)
    // Cells of a power of ten near a fifth of the model; the grid reaches past the model on every side.
    const cell = 10 ** Math.round(Math.log10(extent / 5))
    const half = Math.ceil((extent * 0.8) / cell) * cell
    const grid = new GridHelper(half * 2, Math.round((half * 2) / cell), GRID_COLOR, GRID_COLOR)
    for (const material of materialsOf(grid)) {
      material.transparent = true
      material.opacity = 0.35
      material.depthWrite = false
    }
    grid.position.set(center.x, bounds.min.y, center.z)
    this.scene.add(grid)
    this.grid = grid
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
