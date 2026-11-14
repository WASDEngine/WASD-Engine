/** WASD Engine game links wait in the main process until the application page takes them. */
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { gameLink, registerWasdengineLinks, WasdLinkInbox } from '../src/wasdengine-links.ts'
import { WASD_LINKS_IPC } from '../src/wasdengine-links-names.ts'

describe('gameLink', () => {
  it('accepts the site\'s game links and refuses everything else', () => {
    expect(gameLink('wasdengine://games/sky-keep-1?install=1&v=2', 'wasdengine')).toBe('wasdengine://games/sky-keep-1?install=1&v=2')
    expect(gameLink('WASDENGINE://games/sky-keep', 'wasdengine')).toBe('wasdengine://games/sky-keep')
    for (const other of [
      'wasdengine://open', 'wasdengine://games/', 'wasdengine://games/Sky_Keep', 'wasdengine://games/a/b',
      'https://wasdengine.com/games/sky-keep', 'other://games/sky-keep', `wasdengine://games/${'a'.repeat(81)}`, 42, undefined,
    ]) expect(gameLink(other, 'wasdengine'), String(other)).toBeUndefined()
  })
})

describe('WasdLinkInbox', () => {
  it('keeps links until the page takes them, and tells the page once it listens', () => {
    const inbox = new WasdLinkInbox('wasdengine')
    expect(inbox.deliver('wasdengine://games/sky-keep?install=1')).toBe(true)
    expect(inbox.deliver('wasdengine://open')).toBe(false)
    const notify = vi.fn()
    inbox.listen(notify)
    expect(notify).toHaveBeenCalledOnce()
    expect(inbox.deliverArguments(['WASD Engine.exe', '--flag', 'wasdengine://games/moon-run'])).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(inbox.take()).toEqual(['wasdengine://games/sky-keep?install=1', 'wasdengine://games/moon-run'])
    expect(inbox.take()).toEqual([])
    expect(inbox.deliverArguments(undefined)).toBe(false)
  })

  it('keeps only the newest sixteen links while no page takes them', () => {
    const inbox = new WasdLinkInbox('wasdengine')
    for (let index = 0; index < 20; index++) inbox.deliver(`wasdengine://games/game-${String(index)}`)
    const taken = inbox.take()
    expect(taken).toHaveLength(16)
    expect(taken[0]).toBe('wasdengine://games/game-4')
  })

  it('serves the page\'s take only to the product sender', () => {
    const inbox = new WasdLinkInbox('wasdengine')
    inbox.deliver('wasdengine://games/sky-keep')
    const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
    const assertProductSender = vi.fn((event: IpcMainInvokeEvent) => {
      if (event.sender !== 'owner' as never) throw new Error('rejected')
    })
    registerWasdengineLinks({ handle: (channel, handler) => { handlers.set(channel, handler as never) } }, inbox, assertProductSender)
    const take = handlers.get(WASD_LINKS_IPC.take)!
    expect(() => take({ sender: 'stranger' } as never)).toThrow('rejected')
    expect(take({ sender: 'owner' } as never)).toEqual(['wasdengine://games/sky-keep'])
  })
})
