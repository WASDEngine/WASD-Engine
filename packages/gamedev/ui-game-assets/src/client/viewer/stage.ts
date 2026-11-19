/**
 * The stage of the 3D view: it draws one model at a time with orbit controls, room lighting, a ground grid sized to the
 * model, its animations with a seekable clock, its skeleton, and clay or wireframe shading, and draws only when
 * something changed: a camera move, a loaded texture, a resize, or a playing animation.
 */
import type { AssetShading } from '@deepseek-ai/dsh-game-assets/types'
import {
  AnimationMixer, Bone, Box3, BufferAttribute, BufferGeometry, DirectionalLight, DoubleSide, GridHelper, Group, HemisphereLight,
  LineBasicMaterial, Mesh, MeshStandardMaterial, NeutralToneMapping, Object3D, PerspectiveCamera, PMREMGenerator, Points, PointsMaterial,
  Scene, SkeletonHelper, SRGBColorSpace, Texture, Timer, Vector3, WebGLRenderer, type AnimationAction,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { bonesOf, finiteBounds, isGeometry, materialsOf, type LoadedModel } from './model.ts'

/** Grid and helper line color, a gray that reads on light and dark backgrounds. */
const GRID_COLOR = 0x888888

/** Color of the bones drawn over a model. */
const BONE_COLOR = 0x3ddc97

/** Color of the selected bone's joint. */
const SELECTED_BONE_COLOR = 0xffb020

/** Color of the clay that `solid` shading draws. */
const CLAY_COLOR = 0xa6a6a6

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
  /** Whether the canvas is on screen; while it is not, the stage draws nothing. */
  private visible = true
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
    const bounds = finiteBounds(model.root)
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
      const bounds = finiteBounds(this.model.root)
      if (!bounds.isEmpty()) this.fit(bounds)
    }
    this.requestRender()
  }

  /**
   * Draw while the canvas is on screen, or stop drawing while it is not: a hidden stage asks for no frames, and its
   * playing clip waits where it stands until the stage shows again.
   * @param visible - whether the canvas is on screen.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (visible) {
      // The time spent hidden does not move the clip.
      this.timer.update()
      this.requestRender()
    }
  }

  /** Draw at the next animation frame, once however often it is asked, unless the stage is hidden. */
  requestRender(): void {
    if (this.pending !== 0 || this.disposed || !this.visible) return
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
