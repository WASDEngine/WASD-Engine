/**
 * The model-facing Tripo tools: `tripo_generate` makes a textured 3D model with Tripo's P2 model from a prompt, one
 * image, or two to four views of an object; `tripo_texture` gives such a model a new texture; `tripo_rig` adds a
 * skeleton; `tripo_animate` adds up to five of Tripo's preset animations to a rig; and `tripo_task` waits again for a task
 * that an earlier call stopped waiting for. Each call starts a task through the WASD Engine API, which runs it at Tripo
 * and charges the signed-in account's plan, waits for it, and saves the model it made as a .glb file in the game project,
 * turned to face +Z with its clips over the spot where it stands at rest, as {@link prepareModel} changes it.
 * One set of definitions serves one {@link TripoToolSurface}: the Session's own agent, or agents connected through WASD
 * Engine's MCP server.
 * @module @deepseek-ai/dsh-tripo/src/tools
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { kilobytes, namedFileSize, reservePath, textBlocks, writeWhole, type Reservation } from '@deepseek-ai/dsh-game-mcp/kit'
import { fitForSending, MAX_READ_BYTES, UnreadableImage } from '@deepseek-ai/dsh-image-generation/files'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { RIG_TYPES, TASK_KINDS, type StartRequest, type TaskImage, type TripoApi } from './api.ts'
import { readGlb } from './glb.ts'
import { prepareModel } from './prepare.ts'
import type { RigType, TripoTask, TripoTaskKind, View } from './types.ts'

/** Longest prompt of a model or a texture. */
export const MAX_PROMPT_CHARACTERS = 1024

/** The views of one object a model is made from, in the order Tripo takes them. */
export const VIEWS = ['front', 'left', 'back', 'right'] as const satisfies readonly View[]

/** Tripo's preset animations, by the skeleton they play on; the others have none. */
export const RIG_ANIMATIONS: Readonly<Partial<Record<RigType, readonly string[]>>> = {
  biped: ['idle', 'walk', 'run', 'jump', 'fall', 'climb', 'dive', 'turn', 'slash', 'shoot', 'hurt'],
  quadruped: ['walk'],
  hexapod: ['walk'],
  octopod: ['walk'],
  serpentine: ['march'],
  aquatic: ['march'],
}

/** Every animation name some skeleton takes. */
const ANIMATION_NAMES = [...new Set(Object.values(RIG_ANIMATIONS).flat())]

/** Most animations one tripo_animate call adds. */
export const MAX_ANIMATIONS = 5

/** Most bytes the images of one model may hold together, as the WASD Engine API takes them. */
const MAX_IMAGES_TOTAL_BYTES = 16 * 1024 * 1024

/** The part of a call's time limit kept to download and save the model once Tripo is done. */
const SAVE_RESERVE_MS = 30_000

/** The kinds of task that make a model file. */
const MODEL_KINDS: ReadonlySet<TripoTaskKind> = new Set(['generate', 'texture', 'rig', 'animate'])

/** How one set of tool definitions reaches its callers. */
export interface TripoToolSurface {
  /** How the `path` parameters describe the file a call writes to these callers. */
  readonly pathDescription: string
  /** How the image parameters describe an image a call sends to these callers. */
  readonly imageDescription: string
}

/** What the tools need from the plugin. */
export interface TripoToolHost {
  /** The WASD Engine 3D API. */
  readonly api: TripoApi
  /** Time limit of one call in milliseconds, which waits for Tripo and saves the model. */
  readonly taskTimeoutMs: number
  /**
   * The file one call names.
   * @param requested - the path the call names: absolute, or relative to the calling Session's working directory.
   * @param exec - the call's execution.
   * @returns the absolute path.
   * @throws Error for a network path.
   */
  file(requested: string, exec: ToolRunContext): Promise<string>
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true, description: 'The task, which later steps take as task_id.' },
    kind: { type: 'string', enum: [...TASK_KINDS], required: true },
    path: { type: 'string', description: 'Absolute path of the model file written.' },
    file: { type: 'string', description: 'The path as the call named it.' },
    bytes: { type: 'integer' },
    replaced: { type: 'boolean' },
    meshes: { type: 'integer' },
    skins: { type: 'integer' },
    clips: { type: 'array', items: { type: 'string' }, description: 'The animation clips of the file written.' },
    facing: { type: 'string', enum: ['+Z'], description: 'The axis the saved model faces: +Z, glTF\'s front, which Godot imports as a model\'s front.' },
    riggable: { type: 'boolean', description: 'Whether a rig check found a skeleton that fits.' },
    rigType: { type: 'string', enum: [...RIG_TYPES] },
    animations: { type: 'array', items: { type: 'string' }, description: 'The animations tripo_animate takes for this rig.' },
  },
} as const

/** The value of every Tripo tool. */
type ResultValue = InferValue<typeof RESULT_SCHEMA>

/** A call's model file: its absolute path, the path as the call named it, and the call's hold on it. */
interface Target {
  readonly path: string
  readonly file: string
  readonly reservation: Reservation
}

/** What a call saved. */
interface Saved {
  readonly target: Target
  readonly bytes: number
  readonly meshes: number
  readonly skins: number
  readonly clips: readonly string[]
  /** Whether the saved model was turned to face +Z. */
  readonly turned: boolean
}

const taskIdParameter = (made: string) => ({ type: 'string', required: true, description: `The task_id of ${made}.` }) as const

/**
 * Check a prompt.
 * @returns the trimmed prompt, or undefined for none.
 * @throws Error when it is empty or too long.
 */
function promptOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const prompt = value.trim()
  if (prompt === '') throw new Error('prompt must not be empty.')
  if (prompt.length > MAX_PROMPT_CHARACTERS) throw new Error(`prompt must be at most ${MAX_PROMPT_CHARACTERS} characters; it has ${prompt.length}.`)
  return prompt
}

/**
 * Read one image a call sends, fitted to what the API takes.
 * @throws Error when it is missing, too large, or not an image.
 */
async function sentImage(host: TripoToolHost, requested: string, exec: ToolRunContext): Promise<TaskImage> {
  const path = await host.file(requested, exec)
  if (await namedFileSize(path, requested) > MAX_READ_BYTES) {
    throw new Error(`${requested} is larger than ${MAX_READ_BYTES / (1024 * 1024)} MB; pass a smaller image.`)
  }
  try {
    const fitted = await fitForSending(await readFile(path))
    return { mimeType: fitted.mimeType, data: fitted.data }
  } catch (error) {
    if (error instanceof UnreadableImage) throw new Error(`${requested} ${error.message}`, { cause: error })
    throw error
  }
}

/**
 * Take the model file a call names before the call pays for it.
 * @throws Error when the path does not end in .glb, is a folder, or is a file and `replace` is false.
 */
async function claim(host: TripoToolHost, requested: string, replace: boolean, maker: string, exec: ToolRunContext): Promise<Target> {
  if (extname(requested).toLowerCase() !== '.glb') throw new Error('path must end in .glb: the model is saved as a glTF binary file.')
  const path = await host.file(requested, exec)
  return { path, file: requested, reservation: await reservePath(path, requested, replace, maker) }
}

/** The time by which a call stops waiting for Tripo, keeping time to save the model. */
function waitUntil(host: TripoToolHost): number {
  return Date.now() + host.taskTimeoutMs - Math.min(SAVE_RESERVE_MS, host.taskTimeoutMs / 4)
}

/** A failure after a task started, naming the task so that tripo_task can wait for it again without starting it again. */
function resumable(error: unknown, task: TripoTask, saving: boolean): Error {
  const message = error instanceof Error ? error.message : String(error)
  const next = saving
    ? `Call tripo_task with task_id ${task.taskId} and path to wait for it again and save its model, without starting it again.`
    : `Call tripo_task with task_id ${task.taskId} to wait for it again, without starting it again.`
  return new Error(`${message} ${next}`, { cause: error })
}

/**
 * Wait for a started task to end.
 * @returns the task once it succeeded.
 * @throws Error naming the task when the wait ends first, and with Tripo's reason when it failed.
 */
async function succeeded(host: TripoToolHost, task: TripoTask, until: number, saving: boolean, exec: ToolRunContext): Promise<TripoTask> {
  let done
  try {
    done = await host.api.wait(task.taskId, until, exec.signal)
  } catch (error) {
    exec.signal.throwIfAborted()
    throw resumable(error, task, saving)
  }
  if (done.status === 'failed') throw new Error(done.error ?? 'Tripo could not finish this task. Try again, or change the request.')
  return done
}

/**
 * Download a finished task's model, check it, turn it to face +Z, move its clips over the spot where it stands at rest,
 * and write it at the call's path.
 * @throws Error naming the task when the download fails or the file is not a complete GLB.
 */
async function save(host: TripoToolHost, task: TripoTask, target: Target, exec: ToolRunContext): Promise<Saved> {
  let prepared
  let summary
  try {
    const data = await host.api.model(task.taskId, exec.signal)
    try {
      prepared = prepareModel(data)
      summary = readGlb(prepared.data)
    } catch (error) {
      throw new Error(`The model Tripo made ${(error as Error).message}.`, { cause: error })
    }
  } catch (error) {
    exec.signal.throwIfAborted()
    throw resumable(error, task, true)
  }
  await writeWhole(target.path, prepared.data)
  return {
    target, bytes: prepared.data.byteLength, meshes: summary.meshes, skins: summary.skins, clips: summary.animations,
    turned: prepared.turned,
  }
}

/**
 * Start a task, wait for it, and save its model at the call's path; the path is given up again when the call fails.
 * @param host - plugin operations.
 * @param target - the call's model file.
 * @param request - what the task starts from, given the time by which the call stops waiting; it may run a task of its
 * own first, as tripo_rig runs a rig check.
 * @param exec - the call's execution.
 * @returns the call's value.
 */
async function make(
  host: TripoToolHost, target: Target, request: (until: number) => Promise<StartRequest>, exec: ToolRunContext,
): Promise<ResultValue> {
  const until = waitUntil(host)
  try {
    const started = await host.api.start(await request(until), exec.signal)
    const done = await succeeded(host, started, until, true, exec)
    return valueOf(done, await save(host, done, target, exec))
  } catch (error) {
    await target.reservation.release()
    throw error
  }
}

function valueOf(task: TripoTask, saved: Saved | undefined): ResultValue {
  return {
    taskId: task.taskId,
    kind: task.kind,
    ...saved === undefined
      ? {}
      : {
        path: saved.target.path, file: saved.target.file, bytes: saved.bytes, replaced: saved.target.reservation.replaced,
        meshes: saved.meshes, skins: saved.skins, clips: [...saved.clips], ...saved.turned ? { facing: '+Z' as const } : {},
      },
    ...task.riggable === undefined ? {} : { riggable: task.riggable },
    ...task.rigType === undefined ? {} : { rigType: task.rigType },
    ...task.animations === undefined ? {} : { animations: [...task.animations] },
  }
}

const MADE: Readonly<Record<TripoTaskKind, string>> = {
  generate: 'a textured 3D model',
  texture: 'a new texture',
  rig_check: 'a rig check',
  rig: 'a rig',
  animate: 'animations',
}

function render(value: ResultValue): string {
  const id = value.taskId
  if (value.kind === 'rig_check') {
    return value.riggable === true && value.rigType !== undefined
      ? `Task ${id}, a rig check, found a ${value.rigType} skeleton: pass rig_type ${value.rigType} to tripo_rig.`
      : `Task ${id}, a rig check, found no skeleton that fits the model.`
  }
  if (value.file === undefined) return `Task ${id} made ${MADE[value.kind]}. Call tripo_task with this task_id and path to save its model.`
  const where = `to ${value.file} (${kilobytes(value.bytes ?? 0)}${value.replaced === true ? ', replaced' : ''}${value.facing === undefined ? '' : `, facing ${value.facing}`})`
  switch (value.kind) {
    case 'generate':
      return `Saved a textured 3D model (Tripo P2) ${where}. Its task_id ${id} goes to tripo_rig for a skeleton, or to tripo_texture for a new texture.`
    case 'texture':
      return `Saved the model with its new texture ${where}. Its task_id ${id} goes to tripo_rig for a skeleton.`
    case 'rig': {
      const animations = value.animations ?? []
      const next = animations.length === 0
        ? `Tripo has no animations for a ${value.rigType ?? 'this'} rig: animate it in Blender or Godot.`
        : `Its task_id ${id} goes to tripo_animate with up to ${MAX_ANIMATIONS} of: ${animations.join(', ')}.`
      return `Saved the model with a ${value.rigType ?? ''} skeleton ${where}. ${next}`
    }
    case 'animate': {
      const clips = value.clips ?? []
      return `Saved the model with ${clips.length === 1 ? '1 animation clip' : `${clips.length} animation clips`} (${clips.join(', ')}) ${where}; Godot imports them as clips of its AnimationPlayer. task_id ${id}.`
    }
  }
}

const OUTPUT = { schema: RESULT_SCHEMA, render: (_args: unknown, value: ResultValue) => textBlocks(render(value)) }

/**
 * Build the Tripo tool definitions.
 * @param host - plugin operations the tools call.
 * @param surface - how these definitions reach their callers.
 * @returns the definitions, not registered.
 */
export function tripoToolDefinitions(host: TripoToolHost, surface: TripoToolSurface): ToolDefinition[] {
  const path = { type: 'string', required: true, description: `${surface.pathDescription} Ends in .glb.` } as const
  const replace = { type: 'boolean', description: 'Overwrite the file when it exists. Default: false.' } as const
  const prompt = (what: string) => ({ type: 'string', description: `${what}, at most ${MAX_PROMPT_CHARACTERS} characters.` }) as const
  const common = { output: OUTPUT, timeoutMs: host.taskTimeoutMs, isConcurrencySafe: () => true }
  const view = (side: View) => ({ type: 'string', description: `${surface.imageDescription} The object seen from the ${side}.` }) as const
  return [
    defineTool({
      name: 'tripo_generate',
      description: 'Make a textured 3D model with Tripo\'s P2 model and save it as a .glb file: characters, creatures, props, weapons, vehicles, buildings, and other objects the player sees. '
        + 'Prefer it to modeling them in Blender or building them from primitives in code; use Blender to adjust, combine, or clean up what it makes, and for exact or modular shapes such as level pieces. '
        + 'The best results come from image: one image of the whole object, centered on a plain background, in the game\'s art style, such as a concept made with image_generate; draw a character standing in a T-pose or A-pose so that tripo_rig can rig it. '
        + 'views takes two to four views of one object, and a prompt alone also works. Every model has PBR textures (base color, metallic, roughness, and normal maps). '
        + 'The call waits for Tripo, often a minute, then saves the model and returns its task_id, which tripo_texture and tripo_rig take. '
        + 'Every saved model faces +Z, glTF\'s front: look at it with asset_view, then scale it and turn it to the game\'s forward direction in Godot or Blender.',
      parameters: {
        prompt: prompt('What to model, without image or views: the object, its shape and parts, its materials and colors, and the art style'),
        image: { type: 'string', description: `${surface.imageDescription} One image of the object to model, without prompt or views.` },
        views: {
          type: 'object',
          additionalProperties: false,
          description: 'Two to four views of one object, without prompt or image; front is required.',
          properties: { front: { ...view('front'), required: true }, left: view('left'), back: view('back'), right: view('right') },
        },
        path,
        face_limit: { type: 'integer', description: 'Most faces the model may have, 48 to 50000 (25000 with quad), to keep it light for real-time rendering. Default: Tripo picks for the object.' },
        quad: { type: 'boolean', description: 'Make the mesh of quads, easier to edit in Blender, instead of triangles. Default: false.' },
        replace,
      },
      ...common,
      async execute(args, exec) {
        const text = promptOf(args.prompt)
        const named: Array<readonly [View, string]> = args.views === undefined
          ? args.image === undefined ? [] : [['front', args.image]]
          : VIEWS.flatMap(side => args.views?.[side] === undefined ? [] : [[side, args.views[side]] as const])
        if (args.image !== undefined && args.views !== undefined) throw new Error('Pass image or views, not both.')
        if ((text === undefined) === (named.length === 0)) throw new Error('Pass prompt, image, or views: exactly one of them.')
        if (args.views !== undefined && named.length < 2) throw new Error('views must name at least two views, front among them; pass one image as image.')
        const faces = args.face_limit
        if (faces !== undefined && (faces < 48 || faces > (args.quad === true ? 25_000 : 50_000))) {
          throw new Error(`face_limit must be 48 to ${args.quad === true ? '25000 with quad' : '50000'}.`)
        }
        const images: Array<TaskImage & { readonly view: View }> = []
        for (const [side, file] of named) images.push({ view: side, ...await sentImage(host, file, exec) })
        const total = images.reduce((sum, image) => sum + image.data.byteLength, 0)
        if (total > MAX_IMAGES_TOTAL_BYTES) throw new Error(`The images come to ${kilobytes(total)}, more than the 16 MB one model takes; pass smaller images.`)
        const target = await claim(host, args.path, args.replace === true, 'tripo_generate', exec)
        return await make(host, target, () => Promise.resolve({
          kind: 'generate',
          ...text === undefined ? { images } : { prompt: text },
          ...faces === undefined ? {} : { faceLimit: faces },
          quad: args.quad === true,
        }), exec)
      },
    }),
    defineTool({
      name: 'tripo_texture',
      description: 'Give a model that tripo_generate made a new texture, at the same quality, keeping its shape, and save the retextured model as a .glb file. '
        + 'Describe the new look in prompt, pass image to paint it from a reference image, or both, when the image sets the style and the prompt says what to paint. '
        + 'Use it when a model\'s shape is right but its colors or materials are not. Returns a task_id that tripo_rig takes.',
      parameters: {
        task_id: taskIdParameter('a tripo_generate call'),
        prompt: prompt('The new look'),
        image: { type: 'string', description: `${surface.imageDescription} The texture's reference: its style with prompt, or what to paint without it.` },
        path,
        replace,
      },
      ...common,
      async execute(args, exec) {
        const text = promptOf(args.prompt)
        if (text === undefined && args.image === undefined) throw new Error('Pass prompt, image, or both.')
        const image = args.image === undefined ? undefined : await sentImage(host, args.image, exec)
        const target = await claim(host, args.path, args.replace === true, 'tripo_texture', exec)
        return await make(host, target, () => Promise.resolve({
          kind: 'texture', taskId: args.task_id, ...text === undefined ? {} : { prompt: text }, ...image === undefined ? {} : { image },
        }), exec)
      },
    }),
    defineTool({
      name: 'tripo_rig',
      description: 'Add a skeleton to a model that tripo_generate or tripo_texture made, and save the rigged model as a .glb file. '
        + `rig_type names the skeleton: biped for humanoids, or ${RIG_TYPES.slice(1, -1).join(', ')}, or others; without it, Tripo checks the model and picks one, or says it cannot rig it. Rig characters made standing in a T-pose or A-pose. `
        + 'Tripo\'s animations exist for biped rigs (idle, walk, run, jump, fall, climb, dive, turn, slash, shoot, hurt), for quadruped, hexapod, and octopod rigs (walk), and for serpentine and aquatic rigs (march). '
        + 'Returns a task_id that tripo_animate takes.',
      parameters: {
        task_id: taskIdParameter('a tripo_generate or tripo_texture call'),
        rig_type: { type: 'string', enum: [...RIG_TYPES], description: 'The skeleton. Default: the one Tripo finds for the model.' },
        path,
        replace,
      },
      ...common,
      async execute(args, exec) {
        const target = await claim(host, args.path, args.replace === true, 'tripo_rig', exec)
        return await make(host, target, async (until) => {
          let rigType: RigType | undefined = args.rig_type
          if (rigType === undefined) {
            const checked = await succeeded(host, await host.api.start({ kind: 'rig_check', taskId: args.task_id }, exec.signal), until, false, exec)
            if (checked.riggable !== true || checked.rigType === undefined) {
              throw new Error('Tripo found no skeleton that fits this model. Pass rig_type to rig it with the skeleton you name, or rig it in Blender.')
            }
            rigType = checked.rigType
          }
          return { kind: 'rig', taskId: args.task_id, rigType }
        }, exec)
      },
    }),
    defineTool({
      name: 'tripo_animate',
      description: `Animate a model that tripo_rig rigged with up to ${MAX_ANIMATIONS} of Tripo's preset animations, and save it as one .glb file whose animations Godot imports as clips of its AnimationPlayer, named as in animations. `
        + 'A biped takes idle, walk, run, jump, fall, climb, dive, turn, slash, shoot, and hurt; a quadruped, hexapod, or octopod walk; a serpentine or aquatic rig march. '
        + 'in_place, the default, keeps the character on the spot where it stands at rest, for a game that moves it in code; without it, a clip that travels starts there. '
        + `For more than ${MAX_ANIMATIONS}, call it again with the same task_id and another path, and load the clips of both files into one AnimationLibrary in Godot. Look at the animations with asset_view.`,
      parameters: {
        task_id: taskIdParameter('a tripo_rig call'),
        animations: {
          type: 'array', required: true, items: { type: 'string', enum: ANIMATION_NAMES },
          description: `One to ${MAX_ANIMATIONS} of the rig's animations, each once.`,
        },
        in_place: { type: 'boolean', description: 'Keep the root on the spot instead of moving it. Default: true.' },
        path,
        replace,
      },
      ...common,
      async execute(args, exec) {
        const animations = args.animations
        if (animations.length === 0 || animations.length > MAX_ANIMATIONS) throw new Error(`animations must name 1 to ${MAX_ANIMATIONS} animations.`)
        if (new Set(animations).size !== animations.length) throw new Error('animations must name each animation once.')
        const target = await claim(host, args.path, args.replace === true, 'tripo_animate', exec)
        return await make(host, target, () => Promise.resolve({
          kind: 'animate', taskId: args.task_id, animations, inPlace: args.in_place !== false,
        }), exec)
      },
    }),
    defineTool({
      name: 'tripo_task',
      description: 'Wait for a task that an earlier tripo_* call stopped waiting for, without starting it again, and save the model it made at path: pass the task_id that call\'s error named. Without path, it says how the task ended.',
      parameters: {
        task_id: taskIdParameter('the task to wait for'),
        path: { type: 'string', description: `${surface.pathDescription} Ends in .glb. Default: none, and nothing is saved.` },
        replace,
      },
      ...common,
      async execute(args, exec) {
        const until = waitUntil(host)
        const done = await succeeded(host, await host.api.task(args.task_id, exec.signal), until, args.path !== undefined, exec)
        if (args.path === undefined || !MODEL_KINDS.has(done.kind)) return valueOf(done, undefined)
        const target = await claim(host, args.path, args.replace === true, 'tripo_task', exec)
        try {
          return valueOf(done, await save(host, done, target, exec))
        } catch (error) {
          await target.reservation.release()
          throw error
        }
      },
    }),
  ]
}
