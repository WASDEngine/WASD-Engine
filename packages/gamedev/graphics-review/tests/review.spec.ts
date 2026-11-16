/**
 * `graphics_review` as the Session's agent calls it through the real tool runtime: the image and the agent's words go
 * to the WASD Engine account's model route with the reviewer's instructions and the add-on catalog, the reply comes
 * back as the review, and failures come back as messages that name no model or provider.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import type { ImageBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import { compose, failedReply, review, text, textReply, type Composition } from './composition.ts'

let current: Composition | undefined

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

/** The WASD Engine API's refusal once the account's AI usage and credits are used up, as `billing.limit_message` words it. */
const LIMIT = 'Usage limit reached: the AI usage that the WASD Engine Free plan includes this month, and your credits, are used up. '
  + 'Your AI usage refreshes on December 3 (UTC). Upgrade your plan or turn on auto recharge on your account page at '
  + 'https://app.wasdengine.com/account for more.'

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
    expect(request).toMatchObject({ provider: 'deepseek-account', model: 'reviewer', maxTokens: 8192, purpose: 'graphics-review', sessionId: current.agent.session.id })
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

  it('picks the route\'s first model that takes images, and leaves the catalog out without the add-on service', async () => {
    current = await compose({}, { addons: false })
    current.models.models = [{ id: 'text-only', images: false }, { id: 'sees', images: true }]
    await png(join(current.work, 'ui.png'), 300, 200)
    expect((await review(current, { image: join(current.work, 'ui.png'), subject: 'the pause menu' })).isError).toBe(false)
    expect(current.models.requests[0]?.model).toBe('sees')
    expect(current.models.requests[0]?.system).not.toContain('game_addons installs')
    const [message] = current.models.requests[0]?.messages ?? []
    expect((message?.content[1] as TextBlock).text).toContain('The look the game is going for: not given; judge it against the style the image itself sets.')
  })

  it('scales a large image down and enlarges small pixel art by whole pixels', async () => {
    current = await compose()
    await png(join(current.work, 'big.png'), 4000, 2000)
    await png(join(current.work, 'knight.png'), 32, 16)
    await review(current, { image: 'big.png', subject: 'a screenshot' })
    await review(current, { image: 'knight.png', subject: 'a pixel art knight' })
    const big = await sharp(current.models.stored[0]?.data).metadata()
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(1568)
    expect(big.width * big.height).toBeLessThanOrEqual(1_150_000)
    const knight = await sharp(current.models.stored[1]?.data).metadata()
    expect([knight.width, knight.height]).toEqual([512, 256])
    const [, second] = current.models.requests
    expect((second?.messages[0]?.content[1] as TextBlock).text).toContain('Image: knight.png, 32x16 px, shown at 512x256 px.')
  })

  it('passes on a used-up account\'s message with the page where the user pays, and names no model on other failures', async () => {
    current = await compose()
    await png(join(current.work, 'a.png'), 200, 200)
    current.models.reply = failedReply('ACCOUNT_QUOTA', LIMIT)
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }))).toContain(
      `${LIMIT} Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.`)
    current.models.reply = failedReply('SERVER', 'DeepSeek Messages request failed (503)')
    const failed = text(await review(current, { image: 'a.png', subject: 'a crate' }))
    expect(failed).toContain('The graphics reviewer could not review this image right now. Try again in a minute.')
    expect(failed).not.toContain('DeepSeek')
    current.models.reply = failedReply('ACCOUNT_TOKEN_INVALID', 'Sign in again.')
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }))).toContain('The graphics reviewer needs WASD Engine to be signed in.')
    current.models.reply = textReply('   ')
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }))).toContain('The graphics reviewer returned no review. Try again.')
    current.models.reply = textReply('**How to make it better:** Model the trees', 'max-tokens')
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }))).toContain('(The review stops here: it reached its length limit.)')
    current.models.models = []
    expect(text(await review(current, { image: 'a.png', subject: 'a crate' }))).toContain('The graphics reviewer needs WASD Engine to be signed in.')
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
