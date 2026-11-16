/**
 * The image tool as a Session's agent calls it: the real tool runtime and executor run each call against a fake WASD
 * Engine API with the account's token, and the image lands in the Session's working directory.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import * as ImageGeneration from '../src/index.ts'
import { closestAspectRatio } from '../src/tools.ts'
import { callTool, compose, text, TOKEN, type Composition } from './composition.ts'
import { solidImage } from './fixtures.ts'

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

/** One image a request sent, decoded. */
interface Sent {
  readonly type: string
  readonly data: Buffer
  readonly format: string | undefined
  readonly width: number | undefined
}

/** The images a request sent, decoded. */
async function sent(body: Record<string, unknown>): Promise<Sent[]> {
  const images = body.images as Array<{ mime_type: string; data: string }>
  return await Promise.all(images.map(async (image) => {
    const data = Buffer.from(image.data, 'base64')
    const meta = await sharp(data).metadata()
    return { type: image.mime_type, data, format: meta.format, width: meta.width }
  }))
}

/** The WASD Engine API's refusal once the account's AI usage and credits are used up, as `billing.limit_message` words it. */
const LIMIT = 'Usage limit reached: the AI usage that the WASD Engine Free plan includes this month, and your credits, are used up. '
  + 'Your AI usage refreshes on December 3 (UTC). Upgrade your plan or turn on auto recharge on your account page at '
  + 'https://app.wasdengine.com/account for more.'

describe('image_generate', () => {
  it('makes an image from a prompt and saves it under the working directory with the account token', async () => {
    const current = await composed()
    const result = await callTool(current, 'image_generate', { prompt: '  A red health potion, flat magenta background  ', path: 'art/items/potion.png' })
    expect(result.isError).toBe(false)
    const saved = await readFile(join(current.work, 'art', 'items', 'potion.png'))
    expect(saved).toEqual(current.api.image.data)
    expect(text(result)).toBe(`Saved a 1024×1024 image (Nano Banana 2.1, 1K, 1:1) to art/items/potion.png (${kilobytes(saved.byteLength)}).`)
    expect(result.value).toMatchObject({ format: 'png', width: 1024, height: 1024, replaced: false, images: [], aspectRatio: '1:1', size: '1K' })
    expect(current.api.requests).toEqual([{
      method: 'POST', path: '/v1/images/generate', token: TOKEN,
      body: { prompt: 'A red health potion, flat magenta background', images: [], aspect_ratio: '1:1', size: '1K' },
    }])
    expect(current.account.resolved).toEqual([`${current.api.origin}/v1/images/generate`])
    expect(await files(current.work)).toEqual(['art/items/potion.png'])
  })

  it('writes the file type its extension names, converting the image the API returned', async () => {
    const current = await composed()
    current.api.image = { data: await solidImage(1376, 768), type: 'image/png', width: 1376, height: 768 }
    for (const [path, format] of [['ui/title.jpg', 'jpeg'], ['ui/title.JPEG', 'jpeg'], ['ui/title.webp', 'webp']] as const) {
      const result = await callTool(current, 'image_generate', { prompt: 'A title screen mockup', path, aspect_ratio: '16:9', size: '2K' })
      expect(result.isError, path).toBe(false)
      const meta = await sharp(await readFile(join(current.work, path))).metadata()
      expect([meta.format, meta.width, meta.height], path).toEqual([format, 1376, 768])
      expect(result.value, path).toMatchObject({ format, aspectRatio: '16:9', size: '2K' })
    }
    expect(current.api.requests.map(request => [request.body.aspect_ratio, request.body.size])).toEqual([['16:9', '2K'], ['16:9', '2K'], ['16:9', '2K']])
  })

  it('sends the images to edit or match, unchanged when the API takes them, and keeps the first image\'s shape', async () => {
    const current = await composed()
    await mkdir(join(current.work, 'art'), { recursive: true })
    const wide = await solidImage(1600, 900)
    await writeFile(join(current.work, 'art', 'scene.png'), wide)
    await writeFile(join(current.work, 'art', 'photo.jpg'), await solidImage(3000, 1500, 'jpeg'))
    await writeFile(join(current.work, 'art', 'anim.gif'), await solidImage(64, 32, 'gif'))
    await writeFile(join(current.work, 'art', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#8e63ff"/></svg>')
    const result = await callTool(current, 'image_generate', {
      prompt: 'Repaint the scene at night, keeping the logo',
      path: 'art/scene_night.png',
      images: ['art/scene.png', 'art/photo.jpg', 'art/anim.gif', join(current.work, 'art', 'logo.svg')],
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(`Made from 4 images: art/scene.png, art/photo.jpg, art/anim.gif, ${join(current.work, 'art', 'logo.svg')}.`)
    const body = current.api.requests[0]?.body ?? {}
    expect(body.aspect_ratio).toBe('16:9')
    const [scene, photo, gif, svg] = await sent(body)
    expect(scene).toMatchObject({ type: 'image/png', data: wide })
    expect(photo).toMatchObject({ type: 'image/jpeg', format: 'jpeg', width: 2048 })
    // A GIF is converted; whether it keeps an alpha channel, and so becomes PNG, is libvips' call.
    expect(gif?.type === 'image/png' || gif?.type === 'image/jpeg').toBe(true)
    expect(gif?.width).toBe(64)
    expect(svg).toMatchObject({ type: 'image/png', format: 'png', width: 1024 })
  })

  it('checks every argument and file before the paid request', async () => {
    const current = await composed()
    await mkdir(join(current.work, 'art', 'folder.png'), { recursive: true })
    await writeFile(join(current.work, 'art', 'taken.png'), 'old')
    await writeFile(join(current.work, 'art', 'notes.png'), 'not an image')
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ prompt: 'a coin', path: 'art/coin.gif' }, 'path must end in .png, .jpg, .jpeg, or .webp'],
      [{ prompt: '   ', path: 'art/coin.png' }, 'prompt must not be empty.'],
      [{ prompt: 'x'.repeat(10_001), path: 'art/coin.png' }, 'prompt must be at most 10000 characters'],
      [{ prompt: 'a coin', path: 'art/taken.png' }, 'art/taken.png already exists. Pass replace: true to overwrite it'],
      [{ prompt: 'a coin', path: 'art/folder.png', replace: true }, 'art/folder.png is a folder'],
      [{ prompt: 'a coin', path: 'art/coin.png', images: ['art/missing.png'] }, 'art/missing.png does not exist.'],
      [{ prompt: 'a coin', path: 'art/coin.png', images: ['art/notes.png'] }, 'art/notes.png is not an image file WASD Engine can read'],
      [{ prompt: 'a coin', path: 'art/coin.png', images: Array.from({ length: 15 }, () => 'art/taken.png') }, 'images must name at most 14 images.'],
    ]
    for (const [args, message] of cases) {
      const result = await callTool(current, 'image_generate', args)
      expect(result.isError, JSON.stringify(args).slice(0, 80)).toBe(true)
      expect(text(result)).toContain(message)
    }
    expect(current.api.requests).toEqual([])
    expect(await readFile(join(current.work, 'art', 'taken.png'), 'utf8')).toBe('old')
  })

  it('gives a path to one of two parallel calls, so the other is refused before it is charged', async () => {
    const current = await composed()
    const results = await Promise.all([1, 2].map(() => callTool(current, 'image_generate', { prompt: 'a coin', path: 'art/coin.png' })))
    expect(results.map(result => result.isError).sort()).toEqual([false, true])
    const refused = results.find(result => result.isError) as (typeof results)[number]
    expect(text(refused)).toMatch(/art\/coin\.png already exists/u)
    expect(current.api.requests).toHaveLength(1)
    expect(await readFile(join(current.work, 'art', 'coin.png'))).toEqual(current.api.image.data)
  })

  it('refuses network paths, which Windows would open on another computer, before any request', async () => {
    const current = await composed()
    await mkdir(join(current.work, 'art'), { recursive: true })
    await writeFile(join(current.work, 'art', 'ok.png'), await solidImage(64, 64))
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ prompt: 'a coin', path: '\\\\attacker.example\\share\\coin.png' }, 'is a network path; pass a path on this computer.'],
      [{ prompt: 'a coin', path: '//attacker.example/share/coin.png' }, 'is a network path'],
      [{ prompt: 'a coin', path: 'art/coin.png', images: ['\\\\?\\UNC\\attacker.example\\share\\ref.png'] }, 'is a network path'],
      [{ prompt: 'a coin', path: 'art/coin.png', images: ['art/ok.png', '//attacker.example/share/ref.png'] }, 'is a network path'],
    ]
    for (const [args, message] of cases) {
      const result = await callTool(current, 'image_generate', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toContain(message)
    }
    expect(current.api.requests).toEqual([])
    expect(await files(current.work)).toEqual(['art/ok.png'])
  })

  it('leaves no file or folder behind when the image is not made', async () => {
    const current = await composed()
    current.api.failures.set('/v1/images/generate', { status: 503, message: 'The image service is temporarily unavailable. Try again later.' })
    const result = await callTool(current, 'image_generate', { prompt: 'a coin', path: 'art/items/new/coin.png' })
    expect(result.isError).toBe(true)
    expect(await readdir(current.work)).toEqual([])
  })

  it('replaces a file only when asked', async () => {
    const current = await composed()
    await mkdir(join(current.work, 'art'), { recursive: true })
    await writeFile(join(current.work, 'art', 'coin.png'), 'old')
    const result = await callTool(current, 'image_generate', { prompt: 'a coin', path: 'art/coin.png', replace: true })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(', replaced).')
    expect(await readFile(join(current.work, 'art', 'coin.png'))).toEqual(current.api.image.data)
  })

  it('asks the user to sign in while WASD Engine is signed out, without a request', async () => {
    const current = await composed()
    current.account.signedIn = false
    const result = await callTool(current, 'image_generate', { prompt: 'a coin', path: 'coin.png' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('WASD Engine is signed out, and images are made through the signed-in account. Ask the user to sign in to WASD Engine, then try again.')
    expect(current.api.requests).toEqual([])
  })

  it('words the API\'s refusals for the agent and writes nothing', async () => {
    const current = await composed()
    const path = '/v1/images/generate'
    const cases: Array<[number, string | undefined, string]> = [
      // The API's message names the account page where the user pays; the agent passes it on.
      [402, LIMIT, `${LIMIT} Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.`],
      [422, 'Google\'s safety filters blocked this image (IMAGE_SAFETY). Change the prompt or the images.', 'Nano Banana could not make this image: Google\'s safety filters blocked this image (IMAGE_SAFETY). Change the prompt or the images.'],
      [429, 'Too many image generations for this account at once. Retry shortly.', 'Image generation is busy. Wait a few seconds, then try again.'],
      [503, 'The image service is temporarily unavailable. Try again later.', 'WASD Engine could not make this image (HTTP 503): The image service is temporarily unavailable. Try again later.'],
      [502, undefined, 'WASD Engine could not make this image (HTTP 502). Try again later.'],
      [401, 'Invalid token.', 'The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then try again.'],
    ]
    for (const [status, message, expected] of cases) {
      current.api.failures.set(path, { status, ...message === undefined ? {} : { message } })
      const result = await callTool(current, 'image_generate', { prompt: 'a coin', path: 'coin.png' })
      expect(result.isError, String(status)).toBe(true)
      expect(text(result), String(status)).toContain(expected)
    }
    expect(current.account.rejected).toEqual([TOKEN])
    expect(await files(current.work)).toEqual([])
  })

  it('registers the tool for the plugin\'s lifetime', async () => {
    const current = await composed()
    expect(current.ctx.tools.get('image_generate')).toBeDefined()
    await current.unload()
    expect(current.ctx.tools.get('image_generate')).toBeUndefined()
  })

  it('refuses an API origin with a path or another scheme when it loads', async () => {
    const ctx = new Context()
    expect(() => { ImageGeneration.apply(ctx, ImageGeneration.Config({ apiOrigin: 'https://api.example/v1' })) })
      .toThrow('Image generation plugin: apiOrigin must be an HTTP or HTTPS origin without a path, got "https://api.example/v1".')
    for (const apiOrigin of ['ftp://api.example', 'not a url']) expect(() => ImageGeneration.Config({ apiOrigin }), apiOrigin).toThrow()
    expect(ImageGeneration.Config({})).toEqual({ apiOrigin: 'https://api.wasdengine.com', generationTimeoutMs: 330_000 })
  })
})

describe('closestAspectRatio', () => {
  it('picks the supported shape nearest an image\'s', () => {
    expect([
      closestAspectRatio(1000, 1000), closestAspectRatio(1600, 900), closestAspectRatio(900, 1600), closestAspectRatio(1200, 1000),
      closestAspectRatio(2400, 1000), closestAspectRatio(4000, 1000), closestAspectRatio(64, 600), closestAspectRatio(3, 2),
    ]).toEqual(['1:1', '16:9', '9:16', '5:4', '21:9', '4:1', '1:8', '3:2'])
  })
})
