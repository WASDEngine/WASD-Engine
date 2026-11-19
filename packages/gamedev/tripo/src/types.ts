/**
 * Types of the Tripo plugin: the kinds of 3D task, the skeletons Tripo rigs, the views a model is made from, and a task
 * as the WASD Engine API reports it.
 * @module @deepseek-ai/dsh-tripo/src/types
 */

/** The kinds of task the WASD Engine API's 3D routes start: a model, a new texture, a rig check, a rig, or animations. */
export type TripoTaskKind = 'generate' | 'texture' | 'rig_check' | 'rig' | 'animate'

/** The skeletons Tripo rigs. */
export type RigType = 'biped' | 'quadruped' | 'hexapod' | 'octopod' | 'avian' | 'serpentine' | 'aquatic' | 'others'

/** The views of one object that a model is made from. */
export type View = 'front' | 'left' | 'back' | 'right'

/** How a task is going. */
export type TripoTaskStatus = 'queued' | 'running' | 'success' | 'failed'

/** A task as the API reports it. */
export interface TripoTask {
  /** The task's id, which later steps take. */
  readonly taskId: string
  readonly kind: TripoTaskKind
  readonly status: TripoTaskStatus
  /** Tripo's progress, 0 to 100. */
  readonly progress: number
  /** Why a failed task failed. */
  readonly error?: string
  /** Whether a finished rig check found a skeleton that fits. */
  readonly riggable?: boolean
  /** The skeleton a rig check found, or that a rig or its animations have. */
  readonly rigType?: RigType
  /** The animations a finished rig takes. */
  readonly animations?: readonly string[]
}

/** What a model file holds, read from its GLB header and JSON chunk. */
export interface GlbSummary {
  readonly meshes: number
  readonly skins: number
  /** The names of its animation clips, in file order. */
  readonly animations: readonly string[]
}
