/**
 * The art formats the Assets tab lists, by lowercase file extension, how the viewer decodes each one, and the model
 * that shows a Blender file: the table and lookups of `@deepseek-ai/dsh-game-assets/formats`, which the agent's asset
 * tools read too and the tab's browser bundle inlines. Images the browser decodes show as they are; TGA, Radiance HDR,
 * and OpenEXR images and every model are decoded by three.js in the viewer's lazily loaded chunk.
 */
export { ASSET_FORMATS, exportOf, extensionOf, formatOf } from '@deepseek-ai/dsh-game-assets/formats'
export type { AssetFormat, AssetKind, ImageDecoder, ModelDecoder } from '@deepseek-ai/dsh-game-assets/formats'
