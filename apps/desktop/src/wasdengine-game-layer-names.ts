/** Names that the main process, the preload, and the module build share for `dshDesktop.gameLayer`. */

/** File name of the Node-API module next to the main bundle (`lib/main.js`). */
export const GAME_LAYER_MODULE = 'wasdengine-game-layer.node'

/** IPC channels of `dshDesktop.gameLayer`; `wasdengine-game-layer.ts` serves them. */
export const GAME_LAYER_IPC = {
  show: 'wasd-desktop:game-layer-show',
  hide: 'wasd-desktop:game-layer-hide',
} as const
