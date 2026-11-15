/** Preload side of `dshDesktop.wasdLinks`, the WASD Engine game links the app was asked to open, with their sources. */
import { ipcRenderer } from 'electron'
import type { DesktopWasdLink, DesktopWasdLinksBridge } from '@deepseek-ai/dsh-wasd-plugins/types'
import { WASD_LINKS_IPC } from './wasdengine-links-names.ts'

/**
 * The bridge for the application page.
 * @returns link operations that expose no IPC or Electron objects.
 */
export function createWasdLinksBridge(): DesktopWasdLinksBridge {
  return {
    take: () => ipcRenderer.invoke(WASD_LINKS_IPC.take) as Promise<DesktopWasdLink[]>,
    subscribe(listener) {
      const handle = (): void => { listener() }
      ipcRenderer.on(WASD_LINKS_IPC.changed, handle)
      return () => { ipcRenderer.off(WASD_LINKS_IPC.changed, handle) }
    },
  }
}
