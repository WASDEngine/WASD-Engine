/**
 * The details of an agent's answer, fitted to the limits its request carries: each list keeps its first entries and
 * the details count all of them, a name longer than the limit is shortened (a path is left out instead, since a cut
 * path names another file), and a frame size becomes a whole number of pixels. The Assets tab's own details stay whole.
 */
import type {
  AssetAnswerLimits, AssetDetails, ImageAssetDetails, ModelAssetDetails, SpriteAnimationDetails,
} from '@deepseek-ai/dsh-game-assets/types'

/**
 * A name cut to the limit, ending in an ellipsis when cut.
 * @param name - the name.
 * @param limit - most characters.
 * @returns the name, at most `limit` characters long.
 */
function shortened(name: string, limit: number): string {
  if (name.length <= limit) return name
  let cut = name.slice(0, Math.max(0, limit - 1))
  // A cut through a surrogate pair would leave half a character before the ellipsis.
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1)
  return `${cut}…`
}

/**
 * A size in whole pixels: a Godot region of fractional size covers this many pixels.
 * @param size - the size.
 * @returns the size rounded, at least 1.
 */
function wholePixels(size: number): number {
  return Math.max(1, Math.round(size))
}

function fitAnimation(animation: SpriteAnimationDetails, limits: AssetAnswerLimits): SpriteAnimationDetails {
  const { definedIn, frameWidth, frameHeight, ...rest } = animation
  return {
    ...rest,
    name: shortened(animation.name, limits.name),
    ...definedIn === undefined || definedIn.length > limits.name ? {} : { definedIn },
    ...frameWidth === undefined ? {} : { frameWidth: wholePixels(frameWidth) },
    ...frameHeight === undefined ? {} : { frameHeight: wholePixels(frameHeight) },
  }
}

function fitImage(details: ImageAssetDetails, limits: AssetAnswerLimits): ImageAssetDetails {
  return {
    ...details,
    animations: details.animations.slice(0, limits.animations).map(animation => fitAnimation(animation, limits)),
    animationCount: details.animationCount ?? details.animations.length,
  }
}

function fitModel(details: ModelAssetDetails, limits: AssetAnswerLimits): ModelAssetDetails {
  const name = (value: string): string => shortened(value, limits.name)
  return {
    ...details,
    materials: details.materials.slice(0, limits.materials).map(material => ({
      ...material,
      name: name(material.name),
      maps: material.maps.slice(0, limits.maps).map(map => ({ slot: map.slot, texture: name(map.texture) })),
    })),
    textures: details.textures.slice(0, limits.textures).map(texture => ({ ...texture, name: name(texture.name) })),
    // A prefix of the depth-first list keeps every listed bone's parent in the list.
    bones: details.bones.slice(0, limits.bones).map(bone => ({ ...bone, name: name(bone.name) })),
    animations: details.animations.slice(0, limits.animations).map(clip => ({
      ...clip,
      name: name(clip.name),
      targets: clip.targets.slice(0, limits.clipTargets).map(name),
    })),
    animationCount: details.animationCount ?? details.animations.length,
    morphTargets: details.morphTargets.slice(0, limits.morphMeshes).map(morph => ({
      mesh: name(morph.mesh),
      targets: morph.targets.slice(0, limits.morphTargets).map(name),
      targetCount: morph.targetCount ?? morph.targets.length,
    })),
    morphMeshCount: details.morphMeshCount ?? details.morphTargets.length,
    missing: details.missing.slice(0, limits.missing).filter(path => path.length <= limits.name),
  }
}

/**
 * Fit an asset's details to the limits of an agent's request.
 * @param details - the details as the Assets tab measures them.
 * @param limits - the request's limits.
 * @returns details that the Host accepts, with counts of every list it shortened.
 */
export function fitDetails(details: AssetDetails, limits: AssetAnswerLimits): AssetDetails {
  return details.kind === 'image' ? fitImage(details, limits) : fitModel(details, limits)
}
