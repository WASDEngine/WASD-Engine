/**
 * The Tripo tools as a Session's agent calls them: the real tool runtime and executor run each call against a fake WASD
 * Engine API with the account's token, which starts the task, reports it, and serves its model, and the model lands in
 * the Session's working directory.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGlb, readGlb } from '../src/glb.ts'
import { FRONT_NODE, TURN } from '../src/prepare.ts'
import { callTool, compose, text, TOKEN, type Composition } from './composition.ts'
import { glbFile, RIG_NODES, riggedGlb } from './fixtures.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function composed(config: Parameters<typeof compose>[0] = {}): Promise<Composition> {
  composition = await compose(config)
  return composition
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort()
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

async function image(width: number, height: number, format: 'png' | 'jpeg' | 'gif' = 'png'): Promise<Buffer> {
  return await sharp({ create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } } }).toFormat(format).toBuffer()
}

/** The requests of a composition as method and path. */
function routes(current: Composition): string[] {
  return current.api.requests.map(request => `${request.method} ${request.path}`)
}

/** The WASD Engine API's refusal once the account's AI usage and credits are used up, as `billing.limit_message` words it. */
const LIMIT = 'Usage limit reached: the AI usage that the WASD Engine Free plan includes this month, and your credits, are used up. '
  + 'Your AI usage refreshes on December 3 (UTC). Upgrade your plan or turn on auto recharge on your account page at '
  + 'https://app.wasdengine.com/account for more.'

describe('tripo_generate', () => {
  it('makes a model from a prompt, waits for it, and saves it under the working directory with the account token', async () => {
    const current = await composed()
    const result = await callTool(current, 'tripo_generate', { prompt: '  A stylized knight in a T-pose  ', path: 'models/knight.glb', face_limit: 8000 })
    expect(result.isError, text(result)).toBe(false)
    const [task] = current.api.tasks.values()
    const saved = await readFile(join(current.work, 'models', 'knight.glb'))
    // The model Tripo made, facing +X, is saved turned to face +Z.
    expect(parseGlb(saved).gltf).toMatchObject({
      scenes: [{ nodes: [1] }], nodes: [{ name: 'Model', mesh: 0 }, { name: FRONT_NODE, rotation: [...TURN], children: [0] }],
    })
    expect(text(result)).toBe(`Saved a textured 3D model (Tripo P2) to models/knight.glb (${kilobytes(saved.byteLength)}, facing +Z). `
      + `Its task_id ${task?.id} goes to tripo_rig for a skeleton, or to tripo_texture for a new texture.`)
    expect(result.value).toMatchObject({ taskId: task?.id, kind: 'generate', file: 'models/knight.glb', bytes: saved.byteLength, replaced: false, meshes: 1, skins: 0, clips: [], facing: '+Z' })
    expect(current.api.requests.map(request => [request.method, request.path, request.token, request.body])).toEqual([
      ['POST', '/v1/3d/generate', TOKEN, { prompt: 'A stylized knight in a T-pose', face_limit: 8000 }],
      ['GET', `/v1/3d/tasks/${task?.id}`, TOKEN, {}],
      ['GET', `/v1/3d/tasks/${task?.id}/model`, TOKEN, {}],
    ])
    expect(await files(current.work)).toEqual(['models/knight.glb'])
  })

  it('makes a model from one image or from views of the object, sent in Tripo\'s order', async () => {
    const current = await composed()
    await mkdir(join(current.work, 'art'), { recursive: true })
    await writeFile(join(current.work, 'art', 'front.png'), await image(512, 512))
    await writeFile(join(current.work, 'art', 'back.jpg'), await image(512, 512, 'jpeg'))
    await writeFile(join(current.work, 'art', 'side.gif'), await image(256, 256, 'gif'))
    const one = await callTool(current, 'tripo_generate', { image: 'art/front.png', path: 'models/one.glb', quad: true })
    expect(one.isError, text(one)).toBe(false)
    const views = await callTool(current, 'tripo_generate', { views: { back: 'art/back.jpg', front: 'art/front.png', left: 'art/side.gif' }, path: 'models/views.glb' })
    expect(views.isError, text(views)).toBe(false)
    const starts = current.api.requests.filter(request => request.method === 'POST')
    const sent = (body: Record<string, unknown>) => (body.images as Array<{ view: string; mime_type: string; data: string }>)
      .map(item => [item.view, item.mime_type, Buffer.from(item.data, 'base64').byteLength > 0])
    expect(starts[0]?.body.quad).toBe(true)
    expect(sent(starts[0]?.body ?? {})).toEqual([['front', 'image/png', true]])
    // The GIF is converted to a type the API takes.
    expect(sent(starts[1]?.body ?? {})).toEqual([
      ['front', 'image/png', true], ['left', expect.stringMatching(/^image\/(png|jpeg)$/u), true], ['back', 'image/jpeg', true],
    ])
    expect(await files(current.work)).toEqual(['art/back.jpg', 'art/front.png', 'art/side.gif', 'models/one.glb', 'models/views.glb'])
  })

  it('refuses a call it cannot make before any task starts', async () => {
    const current = await composed()
    await writeFile(join(current.work, 'taken.glb'), glbFile())
    await writeFile(join(current.work, 'front.png'), await image(64, 64))
    for (const [args, message] of [
      [{ path: 'a.glb' }, 'Pass prompt, image, or views: exactly one of them.'],
      [{ prompt: 'a crate', image: 'front.png', path: 'a.glb' }, 'Pass prompt, image, or views: exactly one of them.'],
      [{ image: 'front.png', views: { front: 'front.png', back: 'front.png' }, path: 'a.glb' }, 'Pass image or views, not both.'],
      [{ views: { front: 'front.png' }, path: 'a.glb' }, 'views must name at least two views'],
      [{ prompt: '   ', path: 'a.glb' }, 'prompt must not be empty.'],
      [{ prompt: 'x'.repeat(1025), path: 'a.glb' }, 'prompt must be at most 1024 characters'],
      [{ prompt: 'a crate', path: 'a.fbx' }, 'path must end in .glb'],
      [{ prompt: 'a crate', path: 'a.glb', face_limit: 10 }, 'face_limit must be 48 to 50000.'],
      [{ prompt: 'a crate', path: 'a.glb', face_limit: 30_000, quad: true }, 'face_limit must be 48 to 25000 with quad.'],
      [{ image: 'missing.png', path: 'a.glb' }, 'missing.png does not exist.'],
      [{ prompt: 'a crate', path: 'taken.glb' }, 'taken.glb already exists. Pass replace: true to overwrite it'],
    ] as const) {
      const result = await callTool(current, 'tripo_generate', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result), JSON.stringify(args)).toContain(message)
    }
    expect(current.api.requests).toEqual([])
    expect(await files(current.work)).toEqual(['front.png', 'taken.glb'])
  })

  it('waits while Tripo works, then saves the model', async () => {
    const current = await composed()
    current.api.plans.set('generate', { statuses: ['queued', 'running', 'success'] })
    const result = await callTool(current, 'tripo_generate', { prompt: 'a lantern', path: 'lantern.glb' })
    expect(result.isError, text(result)).toBe(false)
    expect(routes(current).filter(route => route.startsWith('GET')).length).toBe(4)
  }, 20_000)

  it('names the task when it stops waiting, and tripo_task waits for it again and saves the model without starting it again', async () => {
    const current = await composed({ taskTimeoutMs: 4_000 })
    current.api.plans.set('generate', { statuses: ['running'] })
    const stopped = await callTool(current, 'tripo_generate', { prompt: 'a lantern', path: 'lantern.glb' })
    expect(stopped.isError).toBe(true)
    const [task] = current.api.tasks.values()
    expect(text(stopped)).toBe(`Error: Tripo is still working on task ${task?.id} (42% done). Call tripo_task with task_id ${task?.id} and path to wait for it again and save its model, without starting it again.`)
    expect(await files(current.work)).toEqual([])
    if (task !== undefined) task.statuses = ['success']
    const resumed = await callTool(current, 'tripo_task', { task_id: task?.id, path: 'lantern.glb' })
    expect(resumed.isError, text(resumed)).toBe(false)
    expect(text(resumed)).toContain('Saved a textured 3D model (Tripo P2) to lantern.glb')
    expect(routes(current).filter(route => route.startsWith('POST'))).toEqual(['POST /v1/3d/generate'])
    expect(await files(current.work)).toEqual(['lantern.glb'])
  })

  it('reports a failed task with Tripo\'s reason and leaves no file behind', async () => {
    const current = await composed()
    current.api.plans.set('generate', { statuses: ['failed'], extra: { error: 'Tripo\'s content policy refused this request. Change the prompt or the images.' } })
    const result = await callTool(current, 'tripo_generate', { prompt: 'a lamp', path: 'props/lamp.glb' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Tripo\'s content policy refused this request. Change the prompt or the images.')
    expect(await files(current.work)).toEqual([])
  })

  it('refuses a model that is not a complete GLB file, naming the task to save it again', async () => {
    const current = await composed()
    current.api.plans.set('generate', { statuses: ['success'], model: Buffer.from('<html>not a model</html>') })
    const result = await callTool(current, 'tripo_generate', { prompt: 'a lamp', path: 'lamp.glb' })
    expect(result.isError).toBe(true)
    const [task] = current.api.tasks.values()
    expect(text(result)).toBe(`Error: The model Tripo made is not a complete GLB file. Call tripo_task with task_id ${task?.id} and path to wait for it again and save its model, without starting it again.`)
    expect(await files(current.work)).toEqual([])
  })

  it('tries a busy start again, and passes on a used-up plan and a signed-out app', async () => {
    const current = await composed()
    current.api.failures.set('/v1/3d/generate', { status: 429, message: 'The 3D service is busy. Retry shortly.', retryAfter: 1, times: 1 })
    const busy = await callTool(current, 'tripo_generate', { prompt: 'a lamp', path: 'lamp.glb' })
    expect(busy.isError, text(busy)).toBe(false)
    expect(routes(current).filter(route => route.startsWith('POST'))).toEqual(['POST /v1/3d/generate', 'POST /v1/3d/generate'])

    current.api.failures.set('/v1/3d/generate', { status: 402, message: LIMIT })
    const limited = await callTool(current, 'tripo_generate', { prompt: 'a chair', path: 'chair.glb' })
    expect(limited.isError).toBe(true)
    expect(text(limited)).toBe(`Error: ${LIMIT} Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.`)

    current.api.failures.set('/v1/3d/generate', { status: 401, message: 'Missing, invalid, expired or revoked WASD Engine token. Sign in again.' })
    const expired = await callTool(current, 'tripo_generate', { prompt: 'a chair', path: 'chair.glb' })
    expect(text(expired)).toBe('Error: The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then try again.')
    expect(current.account.rejected).toEqual([TOKEN])

    current.account.signedIn = false
    const requests = current.api.requests.length
    const signedOut = await callTool(current, 'tripo_generate', { prompt: 'a chair', path: 'chair.glb' })
    expect(text(signedOut)).toContain('WASD Engine is signed out')
    expect(current.api.requests.length).toBe(requests)
    expect(await files(current.work)).toEqual(['lamp.glb'])
  })

  it('waits its turn while the account runs as many tasks as it may, until the call\'s time runs out', async () => {
    const atLimit = 'This account is already running its limit of 2 3D tasks at once. Wait for one to finish, then try again.'
    const current = await composed()
    current.api.failures.set('/v1/3d/generate', { status: 429, message: atLimit, retryAfter: 0.01, times: 9 })
    const waited = await callTool(current, 'tripo_generate', { prompt: 'a lamp', path: 'lamp.glb' })
    expect(waited.isError, text(waited)).toBe(false)
    expect(routes(current).filter(route => route.startsWith('POST')).length).toBe(10)

    const hurried = await composed({ taskTimeoutMs: 2_000 })
    hurried.api.failures.set('/v1/3d/generate', { status: 429, message: atLimit, retryAfter: 0.2 })
    const gaveUp = await callTool(hurried, 'tripo_generate', { prompt: 'a lamp', path: 'lamp.glb' })
    expect(gaveUp.isError).toBe(true)
    expect(text(gaveUp)).toBe(`Error: ${atLimit}`)
    expect(hurried.api.tasks.size).toBe(0)
    expect(await files(hurried.work)).toEqual([])
  })
})

describe('tripo_texture, tripo_rig, and tripo_animate', () => {
  it('build on earlier tasks, and the animated model holds its clips', async () => {
    const current = await composed()
    await writeFile(join(current.work, 'style.png'), await image(256, 256))
    const model = await callTool(current, 'tripo_generate', { prompt: 'a knight', path: 'knight.glb' })
    const modelId = (model.value as { taskId: string }).taskId

    const textured = await callTool(current, 'tripo_texture', { task_id: modelId, prompt: 'gold armor', image: 'style.png', path: 'knight_gold.glb' })
    expect(textured.isError, text(textured)).toBe(false)
    const textureBody = current.api.requests.find(request => request.path === '/v1/3d/texture')?.body
    expect(Object.keys(textureBody ?? {})).toEqual(['task_id', 'prompt', 'image'])
    expect(textureBody).toMatchObject({ task_id: modelId, prompt: 'gold armor', image: { mime_type: 'image/png' } })

    // Without rig_type, Tripo checks the model first and rigs it with the skeleton it finds.
    const rig = await callTool(current, 'tripo_rig', { task_id: modelId, path: 'knight_rigged.glb' })
    expect(rig.isError, text(rig)).toBe(false)
    expect(current.api.requests.filter(request => request.method === 'POST').slice(-2).map(request => [request.path, request.body])).toEqual([
      ['/v1/3d/rig-check', { task_id: modelId }],
      ['/v1/3d/rig', { task_id: modelId, rig_type: 'biped' }],
    ])
    const rigId = (rig.value as { taskId: string }).taskId
    expect(text(rig)).toContain('Saved the model with a biped skeleton to knight_rigged.glb')
    expect(text(rig)).toContain(`Its task_id ${rigId} goes to tripo_animate with up to 5 of: idle, walk, run, jump, fall, climb, dive, turn, slash, shoot, hurt.`)

    // Tripo's in-place run holds the hips 0.4 ahead of where they are at rest; the saved run is moved back over that spot.
    const made = riggedGlb({ clips: [
      { name: 'idle', times: [0, 1], hips: [[0, 0, 0], [0, 0, 0]] },
      { name: 'run', times: [0, 1], hips: [[0.4, 0, 0], [0.4, 0, 0]] },
    ] })
    current.api.plans.set('animate', { statuses: ['success'], model: made })
    const animated = await callTool(current, 'tripo_animate', { task_id: rigId, animations: ['idle', 'run'], path: 'knight_animated.glb' })
    expect(animated.isError, text(animated)).toBe(false)
    expect(current.api.requests.find(request => request.path === '/v1/3d/animate')?.body).toEqual({ task_id: rigId, animations: ['idle', 'run'], in_place: true })
    expect(text(animated)).toContain('Saved the model with 2 animation clips (idle, run) to knight_animated.glb')
    expect(text(animated)).toContain(', facing +Z); Godot imports them as clips of its AnimationPlayer.')
    expect(animated.value).toMatchObject({ clips: ['idle', 'run'], skins: 1, rigType: 'biped', facing: '+Z' })
    const saved = parseGlb(await readFile(join(current.work, 'knight_animated.glb')))
    expect(readGlb(await readFile(join(current.work, 'knight_animated.glb'))).animations).toEqual(['idle', 'run'])
    const run = (saved.gltf.animations as Array<{ samplers: unknown[]; channels: Array<{ sampler: number; target: { node: number } }> }>)[1]
    expect(run?.samplers).toHaveLength(3)
    expect(run?.channels.find(channel => channel.target.node === RIG_NODES.root)?.sampler).toBe(2)
  })

  it('rigs with the skeleton the call names, without a check, and refuses a model Tripo finds no skeleton for', async () => {
    const current = await composed()
    const named = await callTool(current, 'tripo_rig', { task_id: 'model-1', rig_type: 'quadruped', path: 'wolf.glb' })
    expect(named.isError, text(named)).toBe(false)
    expect(routes(current).filter(route => route.startsWith('POST'))).toEqual(['POST /v1/3d/rig'])
    current.api.plans.set('rig_check', { statuses: ['success'], extra: { riggable: false } })
    const refused = await callTool(current, 'tripo_rig', { task_id: 'model-1', path: 'sword.glb' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe('Error: Tripo found no skeleton that fits this model. Pass rig_type to rig it with the skeleton you name, or rig it in Blender.')
    expect(routes(current).filter(route => route.startsWith('POST'))).toEqual(['POST /v1/3d/rig', 'POST /v1/3d/rig-check'])
    expect(await files(current.work)).toEqual(['wolf.glb'])
  })

  it('passes on what the API refuses, such as another account\'s task or an animation the rig lacks', async () => {
    const current = await composed()
    current.api.failures.set('/v1/3d/animate', { status: 400, message: 'animations: idle not among the quadruped rig\'s animations: walk' })
    const refused = await callTool(current, 'tripo_animate', { task_id: 'rig-1', animations: ['idle'], in_place: false, path: 'wolf.glb' })
    expect(text(refused)).toBe('Error: animations: idle not among the quadruped rig\'s animations: walk')
    const repeated = await callTool(current, 'tripo_animate', { task_id: 'rig-1', animations: ['walk', 'walk'], path: 'wolf.glb' })
    expect(text(repeated)).toContain('animations must name each animation once.')
    const unknown = await callTool(current, 'tripo_task', { task_id: 'nobody' })
    expect(text(unknown)).toBe('Error: There is no 3D task nobody on this account.')
    expect(await files(current.work)).toEqual([])
  })
})
