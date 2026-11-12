/**
 * An agent's answer fits the Host's limits: the window lists the first entries of every longer list and counts them
 * all, shortens long names, leaves out long paths, gives frame sizes in whole pixels and leaves out those no image
 * has, and shortens the names in a caption, so the asset tools accept the details and pictures of any asset the
 * Assets tab shows.
 */
import { ANSWER_LIMITS, parseRenderResult } from '@deepseek-ai/dsh-game-assets/src/result.ts'
import type { ImageAssetDetails, ModelAssetDetails, SpriteAnimationDetails } from '@deepseek-ai/dsh-game-assets/types'
import { describe, expect, it } from 'vitest'
import { namingCaption } from '../src/client/agent.ts'
import { fitDetails } from '../src/client/answer.ts'

const names = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`)

/** A model with `clips` clips and `meshes` meshes of `targets` morph targets each. */
function model(clips: number, meshes: number, targets: number): ModelAssetDetails {
  return {
    kind: 'model', format: 'GLB', bytes: 100, min: [0, 0, 0], max: [1, 2, 1], triangles: 10, vertices: 30, meshes, nodes: meshes + 1,
    materials: [], materialCount: 0, textures: [], textureCount: 0, bones: [], boneCount: 0,
    animations: names(clips, 'Clip').map(name => ({ name, seconds: 1, tracks: 2, targets: ['Hips'], targetCount: 1 })),
    morphTargets: names(meshes, 'Face').map(mesh => ({ mesh, targets: names(targets, 'Shape') })),
    missing: [],
  }
}

/** An image with `count` 2D animations. */
function image(count: number, frame: Partial<SpriteAnimationDetails> = {}): ImageAssetDetails {
  return {
    kind: 'image', format: 'PNG', bytes: 10, width: 64, height: 32, transparency: 'cutout', colors: 8,
    animations: names(count, 'run').map(name => ({ name, source: 'godot', frames: 4, fps: 8, seconds: 0.5, loop: true, ...frame })),
  }
}

const accepted = (details: ModelAssetDetails | ImageAssetDetails) => parseRenderResult({ details, images: [] }).details

describe('fitDetails', () => {
  it('keeps details at exactly the limits whole, and the Host accepts them', () => {
    const atLimits = fitDetails(model(ANSWER_LIMITS.animations, ANSWER_LIMITS.morphMeshes, ANSWER_LIMITS.morphTargets), ANSWER_LIMITS)
    assertModel(atLimits)
    expect(atLimits.animations).toHaveLength(ANSWER_LIMITS.animations)
    expect(atLimits.animationCount).toBe(ANSWER_LIMITS.animations)
    expect(atLimits.morphTargets).toHaveLength(ANSWER_LIMITS.morphMeshes)
    expect(atLimits.morphMeshCount).toBe(ANSWER_LIMITS.morphMeshes)
    expect(atLimits.morphTargets[0]).toMatchObject({ targetCount: ANSWER_LIMITS.morphTargets })
    expect(accepted(atLimits)).toEqual(atLimits)
    const sprites = fitDetails(image(ANSWER_LIMITS.animations), ANSWER_LIMITS)
    expect(accepted(sprites)).toMatchObject({ animationCount: ANSWER_LIMITS.animations })
  })

  it('lists the first entries one past each limit and counts all of them, where the Host refuses the whole list', () => {
    const past = model(ANSWER_LIMITS.animations + 1, ANSWER_LIMITS.morphMeshes + 1, ANSWER_LIMITS.morphTargets + 1)
    expect(() => parseRenderResult({ details: past, images: [] })).toThrow('malformed asset details')
    const fitted = fitDetails(past, ANSWER_LIMITS)
    assertModel(fitted)
    expect(fitted.animations.map(clip => clip.name).at(-1)).toBe(`Clip${String(ANSWER_LIMITS.animations - 1)}`)
    expect(fitted).toMatchObject({ animationCount: ANSWER_LIMITS.animations + 1, morphMeshCount: ANSWER_LIMITS.morphMeshes + 1 })
    expect(fitted.morphTargets).toHaveLength(ANSWER_LIMITS.morphMeshes)
    expect(fitted.morphTargets[0]?.targets).toHaveLength(ANSWER_LIMITS.morphTargets)
    expect(fitted.morphTargets[0]?.targetCount).toBe(ANSWER_LIMITS.morphTargets + 1)
    expect(accepted(fitted)).toEqual(fitted)
    const sprites = image(ANSWER_LIMITS.animations + 1)
    expect(() => parseRenderResult({ details: sprites, images: [] })).toThrow('malformed asset details')
    const fittedSprites = fitDetails(sprites, ANSWER_LIMITS)
    expect(accepted(fittedSprites)).toMatchObject({ animationCount: ANSWER_LIMITS.animations + 1 })
    expect(fittedSprites.kind === 'image' && fittedSprites.animations).toHaveLength(ANSWER_LIMITS.animations)
  })

  it('gives fractional Godot frame sizes in whole pixels, shortens long names, and leaves out long paths', () => {
    const long = 'x'.repeat(ANSWER_LIMITS.name + 1)
    const details = image(1, { name: long, frameWidth: 33.333, frameHeight: 0.4, definedIn: `scenes/${long}.tres` })
    expect(() => parseRenderResult({ details, images: [] })).toThrow('malformed asset details')
    const fitted = accepted(fitDetails(details, ANSWER_LIMITS))
    assertImage(fitted)
    const [animation] = fitted.animations
    expect(animation).toMatchObject({ frameWidth: 33, frameHeight: 1 })
    expect(animation?.name).toHaveLength(ANSWER_LIMITS.name)
    expect(animation?.name.endsWith('…')).toBe(true)
    expect(animation?.definedIn).toBeUndefined()
    // A cut never splits a character outside the Basic Multilingual Plane.
    const emoji = fitDetails(image(1, { name: `${'a'.repeat(ANSWER_LIMITS.name - 2)}😀😀` }), ANSWER_LIMITS)
    assertImage(emoji)
    expect(emoji.animations[0]?.name).toBe(`${'a'.repeat(ANSWER_LIMITS.name - 2)}…`)
  })
})

describe('answer limits', () => {
  it('leaves out frame sizes that are not finite or larger than any image the Host accepts', () => {
    for (const frameWidth of [ANSWER_LIMITS.edge + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const details = image(1, { frameWidth, frameHeight: 16 })
      expect(() => parseRenderResult({ details, images: [] })).toThrow('malformed asset details')
      const fitted = accepted(fitDetails(details, ANSWER_LIMITS))
      assertImage(fitted)
      expect(fitted.animations[0]).not.toHaveProperty('frameWidth')
      expect(fitted.animations[0]).not.toHaveProperty('frameHeight')
    }
    const edge = fitDetails(image(1, { frameWidth: ANSWER_LIMITS.edge, frameHeight: 1 }), ANSWER_LIMITS)
    assertImage(edge)
    expect(edge.animations[0]).toMatchObject({ frameWidth: ANSWER_LIMITS.edge, frameHeight: 1 })
  })

  it('shortens a long clip or animation name in a caption, so the Host accepts the picture', () => {
    const name = 'Walk'.repeat(ANSWER_LIMITS.name / 4)
    const build = (shown: string) => `all 16 frames of ${shown} in order, each labeled with its index and duration (12 fps)`
    const picture = (caption: string) => ({ details: image(0), images: [{ data: 'AAAA', mediaType: 'image/png', width: 1, height: 1, caption }] })
    expect(() => parseRenderResult(picture(build(name)))).toThrow('malformed asset details at images.0.caption')
    const caption = namingCaption(name, ANSWER_LIMITS.caption, build)
    expect(caption).toHaveLength(ANSWER_LIMITS.caption)
    expect(caption).toMatch(/^all 16 frames of (?:Walk)+Wa?l?k?… in order, each labeled with its index and duration \(12 fps\)$/u)
    expect(parseRenderResult(picture(caption)).images[0]?.caption).toBe(caption)
    // A short name stays whole.
    expect(namingCaption('Walk', ANSWER_LIMITS.caption, build)).toBe(build('Walk'))
  })
})

function assertModel(details: ModelAssetDetails | ImageAssetDetails): asserts details is ModelAssetDetails {
  if (details.kind !== 'model') throw new Error('expected model details')
}

function assertImage(details: ModelAssetDetails | ImageAssetDetails): asserts details is ImageAssetDetails {
  if (details.kind !== 'image') throw new Error('expected image details')
}
