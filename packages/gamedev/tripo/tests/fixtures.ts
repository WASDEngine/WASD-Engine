/**
 * A fake WASD Engine API on loopback HTTP for the Tripo specs: the 3D routes, which start tasks, report them as a spec
 * scripts them, and serve the model each one made, or answer with an error status a spec sets. It records each request
 * with its method, path, token, and JSON body. Beside it, the model files the specs serve: a small GLB with one mesh, and
 * a small rigged model laid out as Tripo lays out its rigs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeGlb } from '../src/glb.ts'

/** The nodes of {@link riggedGlb}, by index. */
export const RIG_NODES = { armature: 0, body: 1, root: 2, hips: 3, head: 4 } as const

/** Where {@link riggedGlb}'s root joint is at rest: 0.5 above the ground, the hips on it and the head 0.5 above. */
export const ROOT_REST = [0, 0.5, 0] as const

/** One clip of {@link riggedGlb}. */
export interface RigClip {
  readonly name: string
  /** The time of each key, in seconds. */
  readonly times: readonly number[]
  /** The hips' translation at each key. */
  readonly hips: ReadonlyArray<readonly number[]>
  /** The root joint's translation at each key; default: its rest at every key, as Tripo's clips hold it. */
  readonly root?: ReadonlyArray<readonly number[]>
  /** Keep the root joint's translation as a CUBICSPLINE track, with zero tangents beside each value. */
  readonly cubic?: boolean
  /** Move the scene's top node in the clip too. */
  readonly movesArmature?: boolean
}

/**
 * A small rigged model as Tripo makes one: a scene whose top node, Armature, holds a skinned mesh, Body, and a skeleton of
 * a root joint, the hips, and a head, with clips that move the hips. Every value is a 32-bit float in the binary chunk,
 * each accessor in a buffer view of its own.
 * @param options - the clips, and properties of the Armature node, such as a translation.
 * @returns the file's bytes.
 */
export function riggedGlb(options: { readonly clips?: readonly RigClip[]; readonly armature?: Record<string, unknown> } = {}): Buffer {
  const floats: number[] = []
  const bufferViews: Array<Record<string, unknown>> = []
  const accessors: Array<Record<string, unknown>> = []
  const add = (values: readonly number[], type: 'SCALAR' | 'VEC3', more: Record<string, unknown> = {}): number => {
    bufferViews.push({ buffer: 0, byteOffset: floats.length * 4, byteLength: values.length * 4 })
    floats.push(...values)
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: values.length / (type === 'SCALAR' ? 1 : 3), type, ...more })
    return accessors.length - 1
  }
  const positions = add([0, 0, 0, 0.2, 0, 0, 0, 1, 0], 'VEC3', { min: [0, 0, 0], max: [0.2, 1, 0] })
  const animations = (options.clips ?? []).map((clip) => {
    const input = add(clip.times, 'SCALAR', { min: [clip.times[0]], max: [clip.times.at(-1)] })
    const root = clip.root ?? clip.times.map(() => ROOT_REST)
    const samplers: Array<Record<string, unknown>> = [
      { input, output: add(clip.hips.flat(), 'VEC3') },
      clip.cubic === true
        ? { input, output: add(root.flatMap(value => [0, 0, 0, ...value, 0, 0, 0]), 'VEC3'), interpolation: 'CUBICSPLINE' }
        : { input, output: add(root.flat(), 'VEC3'), interpolation: 'STEP' },
    ]
    const channels: Array<Record<string, unknown>> = [
      { sampler: 0, target: { node: RIG_NODES.hips, path: 'translation' } },
      { sampler: 1, target: { node: RIG_NODES.root, path: 'translation' } },
    ]
    if (clip.movesArmature === true) {
      samplers.push({ input, output: add(clip.times.flatMap(() => [0, 0, 0]), 'VEC3') })
      channels.push({ sampler: 2, target: { node: RIG_NODES.armature, path: 'translation' } })
    }
    return { name: clip.name, samplers, channels }
  })
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [RIG_NODES.armature] }],
    nodes: [
      { name: 'Armature', children: [RIG_NODES.body, RIG_NODES.root], ...options.armature },
      { name: 'Body', mesh: 0, skin: 0 },
      { name: 'Root', translation: [...ROOT_REST], children: [RIG_NODES.hips] },
      { name: 'Hips', children: [RIG_NODES.head] },
      { name: 'Head', translation: [0, 0.5, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: positions } }] }],
    skins: [{ joints: [RIG_NODES.root, RIG_NODES.hips, RIG_NODES.head] }],
    animations,
    accessors,
    bufferViews,
    buffers: [{ byteLength: floats.length * 4 }],
  }
  return Buffer.from(writeGlb({ gltf, bin: new Uint8Array(new Float32Array(floats).buffer) }))
}

/** One request the fake received. */
export interface FakeRequest {
  readonly method: string
  /** Path, such as `/v1/3d/generate`. */
  readonly path: string
  /** The `x-dsh-auth-token` header. */
  readonly token: string | undefined
  /** The parsed JSON body; empty for a request without one. */
  readonly body: Record<string, unknown>
}

/** An error answer: status, the API's error message, and how many requests it answers (every one without). */
export interface FakeFailure {
  readonly status: number
  readonly message?: string
  readonly retryAfter?: number
  times?: number
}

/** How one task goes: the statuses its reports walk through, the last repeating, and what it reports at the end. */
export interface FakeTask {
  readonly id: string
  readonly kind: string
  readonly body: Record<string, unknown>
  /** Statuses still to report, the last repeating: `queued`, `running`, `success`, or `failed`. */
  statuses: string[]
  /** Fields a finished task reports beside its status, such as `rig_type` or `error`. */
  extra: Record<string, unknown>
  /** The model file the task made. */
  model: Buffer
}

/** A running fake API. */
export interface FakeTripoApi {
  /** Origin of the fake, such as `http://127.0.0.1:1234`. */
  readonly origin: string
  /** Every request, in order. */
  readonly requests: FakeRequest[]
  /** Every task started, by id. */
  readonly tasks: Map<string, FakeTask>
  /** An error answer for requests to a path. */
  readonly failures: Map<string, FakeFailure>
  /** How each new task of a kind goes; a kind without one succeeds at its first report. */
  readonly plans: Map<string, { statuses: string[]; extra?: Record<string, unknown>; model?: Buffer }>
  /** Stop listening. */
  close(): Promise<void>
}

/**
 * A small GLB file: its header, then one JSON chunk, whose scene holds one node with a mesh.
 * @param options - the animation clips and skins the file holds.
 * @returns the file's bytes.
 */
export function glbFile(options: { readonly animations?: readonly string[]; readonly skins?: number } = {}): Buffer {
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Model', mesh: 0 }],
    meshes: [{ primitives: [] }],
    skins: Array.from({ length: options.skins ?? 0 }, () => ({ joints: [] })),
    animations: (options.animations ?? []).map(name => ({ name, channels: [], samplers: [] })),
  }
  let json = Buffer.from(JSON.stringify(gltf))
  json = Buffer.concat([json, Buffer.alloc((4 - json.byteLength % 4) % 4, 0x20)])
  const header = Buffer.alloc(20)
  header.write('glTF', 0, 'latin1')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + json.byteLength, 8)
  header.writeUInt32LE(json.byteLength, 12)
  header.write('JSON', 16, 'latin1')
  return Buffer.concat([header, json])
}

/** What a finished task of each kind reports by default. */
const FINISHED: Readonly<Record<string, Record<string, unknown>>> = {
  rig_check: { riggable: true, rig_type: 'biped' },
  rig: { rig_type: 'biped', animations: ['idle', 'walk', 'run', 'jump', 'fall', 'climb', 'dive', 'turn', 'slash', 'shoot', 'hurt'] },
  animate: { rig_type: 'biped' },
}

const START_KINDS: Readonly<Record<string, string>> = {
  '/v1/3d/generate': 'generate',
  '/v1/3d/texture': 'texture',
  '/v1/3d/rig-check': 'rig_check',
  '/v1/3d/rig': 'rig',
  '/v1/3d/animate': 'animate',
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

function report(task: FakeTask): Record<string, unknown> {
  const status = task.statuses.length > 1 ? task.statuses.shift() as string : task.statuses[0] as string
  const done = status === 'success' || status === 'failed'
  return {
    task_id: task.id, kind: task.kind, status, progress: done ? 100 : status === 'running' ? 42 : 0,
    ...done ? task.extra : {},
  }
}

function answer(fake: FakeTripoApi, request: FakeRequest, response: ServerResponse): void {
  const failure = fake.failures.get(request.path)
  if (failure !== undefined && (failure.times === undefined || failure.times > 0)) {
    if (failure.times !== undefined) failure.times -= 1
    const headers: Record<string, string> = failure.retryAfter === undefined ? {} : { 'retry-after': String(failure.retryAfter) }
    if (failure.message === undefined) {
      response.writeHead(failure.status, { 'content-type': 'text/plain', ...headers })
      response.end('oops')
    } else {
      json(response, failure.status, { type: 'error', error: { type: 'api_error', message: failure.message } }, headers)
    }
    return
  }
  const kind = START_KINDS[request.path]
  if (request.method === 'POST' && kind !== undefined) {
    const id = `00000000-0000-4000-8000-${String(fake.tasks.size + 1).padStart(12, '0')}`
    const plan = fake.plans.get(kind)
    fake.tasks.set(id, {
      id, kind, body: request.body, statuses: [...plan?.statuses ?? ['success']],
      extra: plan?.extra ?? FINISHED[kind] ?? {}, model: plan?.model ?? glbFile(),
    })
    json(response, 202, { task_id: id, kind, status: 'queued', progress: 0 })
    return
  }
  const match = /^\/v1\/3d\/tasks\/([^/]+)(\/model)?$/u.exec(request.path)
  const task = match === null ? undefined : fake.tasks.get(decodeURIComponent(match[1] as string))
  if (request.method === 'GET' && task !== undefined) {
    if (match?.[2] === undefined) {
      json(response, 200, report(task))
      return
    }
    response.writeHead(200, { 'content-type': 'model/gltf-binary', 'content-length': String(task.model.byteLength) })
    response.end(task.model)
    return
  }
  json(response, 404, { type: 'error', error: { type: 'not_found_error', message: `There is no 3D task ${match?.[1] ?? ''} on this account.` } })
}

/**
 * Start a fake API on a free loopback port.
 * @returns the running fake; close it in teardown.
 */
export async function startFakeTripoApi(): Promise<FakeTripoApi> {
  const fake: FakeTripoApi = {
    origin: '',
    requests: [],
    tasks: new Map(),
    failures: new Map(),
    plans: new Map(),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const token = request.headers['x-dsh-auth-token']
      const recorded: FakeRequest = {
        method: request.method ?? 'GET',
        path: new URL(request.url ?? '/', 'http://fake').pathname,
        token: typeof token === 'string' ? token : undefined,
        body: await readBody(request),
      }
      fake.requests.push(recorded)
      answer(fake, recorded, response)
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return Object.assign(fake, { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
}
