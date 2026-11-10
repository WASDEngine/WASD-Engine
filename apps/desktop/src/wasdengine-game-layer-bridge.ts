/** Preload side of `dshDesktop.gameLayer`, which shows windowless games' layers behind the page on macOS. */
import { ipcRenderer } from 'electron'
import type { DesktopGameLayerBridge } from '@deepseek-ai/dsh-godot/types'
import { GAME_LAYER_IPC } from './wasdengine-game-layer-names.ts'

/**
 * The bridge for the application page.
 * @returns layer operations that expose no IPC or Electron objects.
 */
export function createGameLayerBridge(): DesktopGameLayerBridge {
  return {
    show: (id, placement) => ipcRenderer.invoke(GAME_LAYER_IPC.show, id, placement) as Promise<boolean>,
    hide: (id) => {
      void ipcRenderer.invoke(GAME_LAYER_IPC.hide, id).catch((closing: unknown) => {
        void closing // The main process removes the page's layers itself when the page or the window goes away.
      })
    },
  }
}
