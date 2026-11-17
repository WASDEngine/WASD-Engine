/**
 * `graphics_review` as the Session's agent calls it through the real tool and model runtimes: the image and the agent's
 * words go to the WASD Engine account's model route with the reviewer's instructions, the add-on catalog, a low
 * reasoning effort, and room for the reasoning; the reply comes back as the review; and failures come back as messages
 * that name no model or provider and ask for a retry only when one can help.
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { LLM_FAILURE_CODES, LlmError, ReasoningEffortId, type ImageBlock, type TextBlock } from '@deepseek-ai/dsh-llm'
import type { Config } from '../src/index.ts'
import { failureMessage } from '../src/review.ts'
import { compose, failedReply, review, text, textReply, type ComposeOptions, type Composition } from './composition.ts'
import { checkerboardDifference, writeCheckerboard } from './pixels.ts'

let current: Composition | undefined

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

/** The WASD Engine API's refusal once the account's AI usage and credits are used up, as `billing.limit_message` words it. */
const LIMIT = 'Usage limit reached: the AI usage that the WASD Engine Free plan includes this month, and your credits, are used up. '
  + 'Your AI usage refreshes on December 3 (UTC). Upgrade your plan or turn on auto recharge on your account page at '
  + 'https://app.wasdengine.com/account for more.'

/** The WASD Engine API's refusal of a waitlisted account, as `accounts.WAITLISTED` words it. */
const WAITLISTED = 'This account is on the WASD Engine waitlist. You can use WASD Engine once it is approved.'

const SIGN_IN = 'The graphics reviewer needs WASD Engine to be signed in. Ask the user to sign in to WASD Engine, then try again.'
const UNAVAILABLE = 'The graphics reviewer is not available in this WASD Engine, and calling it again will not help. Go on without a review and '
  + 'tell the user; updating WASD Engine may bring it back.'
const UPDATE = 'The graphics reviewer needs a newer version of WASD Engine, and calling it again will not help. Ask the user to update WASD '
  + 'Engine, and go on without a review until then.'
const REFUSED = 'The graphics reviewer cannot review this image: its request fails the same way on every try. Send another image, such as a '
  + 'fresh screenshot saved as PNG, or go on without a review and tell the user.'
const TRY_AGAIN = 'The graphics reviewer could not review this image right now. Try again in a minute; if it fails again, go on without a '
  + 'review and tell the user.'

/** Failures that repeat on every try, whose messages must not invite another call. */
const PERMANENT = [
  'CLIENT_UPGRADE_REQUIRED', 'MODEL_UNSUPPORTED', 'INVALID_REQUEST', 'UNSUPPORTED_CONTENT', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED',
  'NO_ADAPTER', 'UNKNOWN_MODEL', 'UNSUPPORTED_REASONING_EFFORT', 'UNSUPPORTED_OPTION', 'INVALID_CONFIG', 'INVALID_MODEL_INFO',
  'INVALID_MODEL_CONTEXT', 'INVALID_MODEL_MAX_TOKENS', 'INVALID_MODEL_REASONING', 'INVALID_PREPARED_CALL',
]

/** A review in the form the reviewer's instructions ask for: notes and the tools and add-ons to consider. */
const NOTES = '**How to make it better:** The trees are cones: model them in Blender.\n**Tools and add-ons to consider:** sapling-tree-gen for the trees.'

async function png(path: string, width: number, height: number, alpha = true): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const channels = alpha ? 4 : 3
  await writeFile(path, await sharp({ create: { width, height, channels, background: alpha ? { r: 200, g: 60, b: 40, alpha: 1 } : '#c83c28' } }).png().toBuffer())
}

describe('graphics_review', () => {
  it('sends the image and the agent\'s words to the account\'s model with the reviewer\'s instructions, and returns the review', async () => {
    current = await compose()
    await png(join(current.work, 'shots', 'forest.png'), 800, 450)
    current.models.reply = textReply(NOTES)
    const result = await review(current, {
      image: 'shots/forest.png', subject: 'the forest level at dusk from the player\'s camera', goal: 'cozy low-poly', focus: 'the lighting',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`Graphics review of ${join(current.work, 'shots', 'forest.png')}:\n\n${NOTES}`)

    const [request] = current.models.requests
    expect(request).toMatchObject({ provider: 'deepseek-account', model: 'reviewer', purpose: 'graphics-review', sessionId: current.agent.session.id })
    expect(request?.system).toContain('Review it as a senior game art director and technical artist reviews a teammate\'s work')
    expect(request?.system).toContain('Give no rating of any kind: no score, such as 6/10, no grade, and no verdict, such as pass or fail.')
    expect(request?.system).toContain('  - sky3d (Godot): A 3D game needs a sky that changes with the time of day.')
    expect(request?.system).toContain('  - sapling-tree-gen (Blender): A level needs trees in several variations.')
    const [message] = request?.messages ?? []
    const [image, words] = (message?.content ?? []) as [ImageBlock, TextBlock]
    expect(message?.role).toBe('user')
    expect(image).toMatchObject({ type: 'image', attachment: { attachmentId: 'attachment-1', mediaType: 'image/png', name: 'forest.png' } })
    expect(words.text).toBe([
      'Image: forest.png, 800x450 px.',
      'What it shows: the forest level at dusk from the player\'s camera',
      'The look the game is going for: cozy low-poly',
      'Look most at: the lighting',
    ].join('\n'))
  })

  it('tells the reviewer what changed since the last review of the same work, and which notes the agent left', async () => {
    current = await compose()
    await png(join(current.work, 'hero.png'), 640, 360)
    current.models.reply = textReply(NOTES)
    const previous = 'Warmed the rim light and added hand bones; left the face notes, since the character is a stock MakeHuman model.'
    expect((await review(current, { image: 'hero.png', subject: 'the hero on the balcony', previous: `  ${previous} ` })).isError).toBe(false)
    expect(await review(current, { image: 'hero.png', subject: 'the hero on the balcony', previous: ' ' })).toMatchObject({ isError: false })
    const [first, blank] = current.models.requests.map(request => ((request.messages[0]?.content ?? [])[1] as TextBlock).text)
    expect(first?.split('\n').at(-1)).toBe(`Since the last review of this work: ${previous}`)
    expect(blank).not.toContain('Since the last review')
  })

  it('asks for a low reasoning effort with room for the reasoning and the review, and sets no temperature', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 1280, 720)
    await review(current, { image: 'a.png', subject: 'the title screen' })
    const [request] = current.models.requests
    expect(request).toMatchObject({ reasoningEffort: 'low', maxTokens: 16_384 })
    expect(request).not.toHaveProperty('temperature')
  })

  it('uses the model\'s least effort when it lacks the configured one, and none for a model without efforts', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 1280, 720)
    current.models.reasoning = { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }], defaultEffort: ReasoningEffortId('off') }
    await review(current, { image: 'a.png', subject: 'the title screen' })
    current.models.reasoning = undefined
    await review(current, { image: 'a.png', subject: 'the title screen' })
    const [thinkingOff, noEfforts] = current.models.requests
    expect(thinkingOff?.reasoningEffort).toBe('off')
    expect(noEfforts).not.toHaveProperty('reasoningEffort')
  })

  it('picks the route\'s first model that takes images, and leaves the catalog out without the add-on service', async () => {
    current = await compose({}, { addons: false })
    current.models.models = [{ id: 'text-only', images: false }, { id: 'sees', images: true }]
    await png(join(current.work, 'ui.png'), 600, 600)
    expect((await review(current, { image: join(current.work, 'ui.png'), subject: 'the pause menu' })).isError).toBe(false)
    expect(current.models.requests[0]?.model).toBe('sees')
    expect(current.models.requests[0]?.system).not.toContain('game_addons installs')
    const [message] = current.models.requests[0]?.messages ?? []
    expect((message?.content[1] as TextBlock).text).toContain('The look the game is going for: not given; judge it against the style the image itself sets.')
  })

  it('scales a large image down, and enlarges small pixel art by whole pixels until the route takes it without scaling it up', async () => {
    current = await compose()
    await png(join(current.work, 'big.png'), 4000, 2000)
    await writeCheckerboard(join(current.work, 'knight.png'), 32, 16)
    await review(current, { image: 'big.png', subject: 'a screenshot' })
    await review(current, { image: 'knight.png', subject: 'a pixel art knight' })
    const big = await sharp(current.models.stored[0]?.data).metadata()
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(1568)
    expect(big.width * big.height).toBeLessThanOrEqual(1_150_000)
    // 25 times 32×16 is the smallest whole enlargement of at least 544×544 pixels, the route's floor.
    expect(await checkerboardDifference(current.models.stored[1]!.data, 25)).toEqual({ width: 800, height: 400, differing: 0 })
    const [, second] = current.models.requests
    expect((second?.messages[0]?.content[1] as TextBlock).text).toContain('Image: knight.png, 32x16 px, shown at 800x400 px.')
  })

  it('passes on the account\'s own words where the user acts, and names no model on other failures', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 600, 600)
    const call = async (): Promise<string> => text(await review(current!, { image: 'a.png', subject: 'a crate' }))
    current.models.reply = failedReply('ACCOUNT_QUOTA', LIMIT)
    expect(await call()).toContain(`${LIMIT} Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.`)
    current.models.reply = failedReply('AUTH', WAITLISTED)
    expect(await call()).toContain(`${WAITLISTED} Pass this on to the user, and go on without a review until they have done what it says.`)
    current.models.reply = failedReply('AUTH', 'DeepSeek Messages request failed (403)')
    expect(await call()).toContain(SIGN_IN)
    current.models.reply = failedReply('ACCOUNT_TOKEN_INVALID', 'Sign in again.')
    expect(await call()).toContain(SIGN_IN)
    current.models.reply = failedReply('SERVER', 'DeepSeek Messages request failed (503)')
    expect(await call()).toContain(TRY_AGAIN)
    current.models.reply = failedReply('RATE_LIMIT', 'DeepSeek is busy')
    expect(await call()).toContain('The graphics reviewer is busy. Wait a few seconds, then try again.')
    for (const code of ['INVALID_REQUEST', 'UNSUPPORTED_CONTENT']) {
      current.models.reply = failedReply(code, 'DeepSeek Messages image input requires a vision model')
      const refused = await call()
      expect(refused).toContain(REFUSED)
      expect(refused).not.toContain('DeepSeek')
    }
    current.models.reply = new LlmError('DeepSeek Messages transport failed', 'TRANSPORT')
    expect(await call()).toContain(TRY_AGAIN)
  })

  it('says why a reply holds no review instead of asking for the same call again', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 600, 600)
    const call = async (): Promise<string> => text(await review(current!, { image: 'a.png', subject: 'a crate' }))
    current.models.reply = textReply('', 'max-tokens')
    expect(await call()).toContain('The graphics reviewer reached its length limit before it wrote a review, so the same call would likely stop '
      + 'again. Send a closer view of one part of the image, or a focus that names one thing to look at; if that stops too, go on without a '
      + 'review and tell the user.')
    current.models.reply = textReply('   ')
    expect(await call()).toContain('The graphics reviewer finished without writing a review. Check that the image shows the graphics to review '
      + 'and that subject describes it, then call it once more; if it again writes none, go on without a review and tell the user.')
    current.models.reply = textReply('**How to make it better:** Model the trees', 'max-tokens')
    expect(await call()).toContain('**How to make it better:** Model the trees\n\n(The review stops here: it reached its length limit.)')
  })

  it('tells a missing sign-in apart from a route that offers no reviewer or needs a newer WASD Engine, before any request', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 600, 600)
    const call = async (): Promise<string> => text(await review(current!, { image: 'a.png', subject: 'a crate' }))
    current.models.models = []
    current.account.signedIn = false
    expect(await call()).toContain(SIGN_IN)
    // A sign-in that cannot be read cannot sign the requests either.
    current.account.unreadable = true
    expect(await call()).toContain(SIGN_IN)
    // Signed in, the route can list nothing that takes images, as when its reviewer needs a newer WASD Engine.
    current.account.unreadable = false
    current.account.signedIn = true
    expect(await call()).toContain(UNAVAILABLE)
    current.models.models = [{ id: 'text-only', images: false }]
    expect(await call()).toContain(UNAVAILABLE)
    expect(current.models.requests).toEqual([])
    expect(current.models.stored).toEqual([])
  })

  it('says the reviewer is not available without its route, the attachment store, or, for an empty listing, the account service', async () => {
    const unavailable = async (config: Partial<Config>, options: ComposeOptions, listed: boolean): Promise<string> => {
      const composition = await compose(config, options)
      try {
        if (!listed) composition.models.models = []
        await png(join(composition.work, 'a.png'), 600, 600)
        return text(await review(composition, { image: 'a.png', subject: 'a crate' }))
      } finally {
        await composition.cleanup()
      }
    }
    expect(await unavailable({ provider: 'missing' }, {}, true)).toContain(UNAVAILABLE)
    expect(await unavailable({}, { attachments: false }, true)).toContain(UNAVAILABLE)
    expect(await unavailable({}, { account: false }, false)).toContain(UNAVAILABLE)
  })

  it('asks for one more try when the model service throws, the listing fails, or the reply has no end', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 600, 600)
    const call = async (): Promise<string> => text(await review(current!, { image: 'a.png', subject: 'a crate' }))
    current.models.listFailure = new Error('the listing broke')
    expect(await call()).toContain(TRY_AGAIN)
    current.models.listFailure = undefined
    current.models.reply = textReply('**How to make it better:** Model the trees in Blender.').filter(chunk => chunk.type !== 'finish')
    expect(await call()).toContain(TRY_AGAIN)
    current.models.reply = textReply('**How to make it better:** Model the trees in Blender.')
    current.ctx.on('llm/stream', () => { throw new Error('a stream listener failed') })
    const failed = await call()
    expect(failed).toContain(TRY_AGAIN)
    expect(failed).not.toContain('listener')
  })

  it('needs an absolute path from a call without an Agent, and sends that call without a Session id', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 600, 600)
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }, false))).toContain('Pass image as an absolute path.')
    expect((await review(current, { image: join(current.work, 'a.png'), subject: 'a crate' }, false)).isError).toBe(false)
    expect(current.models.requests).toHaveLength(1)
    expect(current.models.requests[0]).not.toHaveProperty('sessionId')
  })

  it('sends a large image without transparency as JPEG', async () => {
    current = await compose()
    const noise = sharp({ create: { width: 1568, height: 733, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
    await writeFile(join(current.work, 'noise.png'), await noise.png({ compressionLevel: 1 }).toBuffer())
    expect((await review(current, { image: 'noise.png', subject: 'a noisy screenshot' })).isError).toBe(false)
    expect(current.models.stored[0]).toMatchObject({ name: 'noise.png', mediaType: 'image/jpeg' })
    expect(await sharp(current.models.stored[0]?.data).metadata()).toMatchObject({ format: 'jpeg', width: 1568, height: 733 })
  })

  it('refuses a file above the size limit, one that cannot be converted, and a path the system cannot look up', async () => {
    current = await compose({ maxImageBytes: 1024 * 1024 })
    await writeFile(join(current.work, 'huge.png'), Buffer.alloc(1024 * 1024 + 1))
    const whole = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 128, sigma: 30 } } })
      .png().toBuffer()
    await writeFile(join(current.work, 'cut.png'), whole.subarray(0, Math.floor(whole.byteLength / 2)))
    expect(text(await review(current, { image: 'huge.png', subject: 'x' }))).toContain('huge.png is larger than 1 MB; pass a smaller image, such as a screenshot.')
    expect(text(await review(current, { image: 'cut.png', subject: 'x' }))).toContain('cut.png could not be converted for the review; save it as PNG and try again.')
    // Two links to each other fail the lookup with the system's own error; Windows links need privileges.
    if (process.platform !== 'win32') {
      await symlink('b.png', join(current.work, 'a.png'))
      await symlink('a.png', join(current.work, 'b.png'))
      expect(text(await review(current, { image: 'a.png', subject: 'x' }))).toContain('ELOOP')
    }
    expect(current.models.requests).toEqual([])
  })

  it('refuses a configured model that the route holds back for a newer WASD Engine or that takes no images, before any request', async () => {
    current = await compose({ model: 'next-reviewer' })
    await png(join(current.work, 'a.png'), 600, 600)
    current.models.models = [{ id: 'next-reviewer', images: true }]
    current.models.refusals = { 'next-reviewer': 'CLIENT_UPGRADE_REQUIRED' }
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }))).toContain(UPDATE)
    current.models.refusals = {}
    current.models.models = [{ id: 'next-reviewer', images: false }]
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }))).toContain(UNAVAILABLE)
    expect(current.models.requests).toEqual([])
  })

  it('refuses a missing file, a folder, a file that is not an image, and a GIF, before any request', async () => {
    current = await compose()
    await mkdir(join(current.work, 'folder'))
    await writeFile(join(current.work, 'notes.png'), 'not an image')
    await writeFile(join(current.work, 'loop.gif'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).gif().toBuffer())
    expect(text(await review(current, { image: 'gone.png', subject: 'x' }))).toContain('does not exist; pass the path of the image to review.')
    expect(text(await review(current, { image: 'folder', subject: 'x' }))).toContain('is a folder; pass the path of a PNG, JPEG, or WebP image.')
    expect(text(await review(current, { image: 'notes.png', subject: 'x' }))).toContain('is not an image WASD Engine can read')
    expect(text(await review(current, { image: 'loop.gif', subject: 'x' }))).toContain('is a gif file; pass a PNG, JPEG, or WebP image.')
    expect(text(await review(current, { image: 'gone.png', subject: '  ' }))).toContain('Pass subject: what the image shows and what it is for.')
    expect(current.models.requests).toEqual([])
  })
})

describe('failureMessage', () => {
  it('names no model, provider, or cost, and asks for another call only when one can help', () => {
    const wrong: string[] = []
    for (const code of [...Object.keys(LLM_FAILURE_CODES), 'HTTP_404']) {
      const message = failureMessage({ code, message: 'DeepSeek model "deepseek-v4-flash" failed for DeepSeek Harness 0.2.0' })
      if (/DeepSeek|deepseek|Harness|LLM|same model/u.test(message)) wrong.push(`${code} names the model: ${message}`)
      if (!['QUOTA', 'ACCOUNT_QUOTA'].includes(code) && /cost|credit|charge|usage|price/iu.test(message)) wrong.push(`${code} names a cost: ${message}`)
      if (PERMANENT.includes(code) && /try again|once more/iu.test(message)) wrong.push(`${code} invites a retry: ${message}`)
    }
    expect(wrong).toEqual([])
    expect(failureMessage({ code: 'CLIENT_UPGRADE_REQUIRED', message: '' })).toBe(UPDATE)
    expect(failureMessage({ code: 'NO_ADAPTER', message: '' })).toBe(UNAVAILABLE)
    expect(failureMessage({ code: 'INVALID_REQUEST', message: '' })).toBe(REFUSED)
    expect(failureMessage({ code: 'TIMEOUT', message: '' })).toBe(TRY_AGAIN)
  })
})
