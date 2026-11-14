/** IPC channels that the main process and the preload share for `dshDesktop.wasdLinks`. */
export const WASD_LINKS_IPC = {
  take: 'wasd-desktop:links-take',
  changed: 'wasd-desktop:links-changed',
} as const
