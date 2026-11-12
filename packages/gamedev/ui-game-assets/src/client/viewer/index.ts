/**
 * The viewers' three.js chunk: both views and the agent's pictures import this one module on first use, so the bundle
 * emits all of three.js as one self-contained lazy chunk; the client module loader cannot load a chunk that another
 * lazy chunk requires, so nothing here imports the browser half's other modules.
 */
export { renderModelTiles, type ModelTile, type ModelTilePlan } from './agent.ts'
export { decodeImage, type DecodedImageFormat } from './image.ts'
export {
  bonesOf, describeModel, disposeObject, loadModel, ModelStage, morphTargetsOf, statsOf,
  type ClipClock, type LoadedModel, type ModelSource, type ModelStats, type MorphTargets,
} from './model.ts'
