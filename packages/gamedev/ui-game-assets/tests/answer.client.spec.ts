/**
 * An agent's answer fits the Host's limits: the window lists the first entries of every longer list and counts them
 * all, shortens long names, leaves out long paths, and gives frame sizes in whole pixels, so the asset tools accept
 * the details of any asset the Assets tab shows.
 */
import { ANSWER_LIMITS, parseRenderResult } from '@deepseek-ai/dsh-game-assets/src/result.ts'
import type { ImageAssetDetails, ModelAssetDetails, SpriteAnimationDetails } from '@deepseek-ai/dsh-game-assets/types'
import { describe, expect, it } from 'vitest'
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

function assertModel(details: ModelAssetDetails | ImageAssetDetails): asserts details is ModelAssetDetails {
  if (details.kind !== 'model') throw new Error('expected model details')
}

function assertImage(details: ModelAssetDetails | ImageAssetDetails): asserts details is ImageAssetDetails {
  if (details.kind !== 'image') throw new Error('expected image details')
}
