/**
 * The viewers' three.js chunk: both views import this one module on first use, so the bundle emits all of three.js as
 * one self-contained lazy chunk; the client module loader cannot load a chunk that another lazy chunk requires.
 */
export { decodeImage, type DecodedImageFormat } from './image.ts'
export { disposeObject, loadModel, ModelStage, statsOf, type LoadedModel, type ModelSource, type ModelStats } from './model.ts'
