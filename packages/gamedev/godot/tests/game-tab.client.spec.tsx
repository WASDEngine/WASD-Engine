// @vitest-environment jsdom
/**
 * Game tab body: connection states, runtime install states, the run toolbar,
 * run phases, action failures, the log drawer, the frame view, the layer that
 * the Desktop shell shows instead, and input capture.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PaneId, SidebarRightTabInfo, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { GodotRuntimeView } from '../src/types.ts'
import type { GameFailure } from '../src/client/actions.ts'
import { FRAME_HEADER_BYTES } from '../src/client/frames.ts'
import { GameTab, GameTabTitle, type GameTabProps } from '../src/client/GameTab.tsx'
import { MOUSE_MODE_CAPTURED } from '../src/client/input.ts'
import type { LayerPresentation } from '../src/client/layer.ts'
import { en } from '../src/client/locales.ts'
import type { GameSnapshot, GameState } from '../src/client/source.ts'
import { entry, READY, run } from './client-fixtures.client.ts'

const t = makeTranslate(en)
const unused = (): never => { throw new Error('the Game tab does not call this tab action') }

let drawImage: ReturnType<typeof vi.fn>
let clearRect: ReturnType<typeof vi.fn>
let lockTarget: Element | null
let exitPointerLock: ReturnType<typeof vi.fn>

beforeEach(() => {
  drawImage = vi.fn()
  clearRect = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, clearRect } as never)
  lockTarget = null
  exitPointerLock = vi.fn(() => { lockTarget = null })
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lockTarget })
  Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: exitPointerLock })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'pointerLockElement')
  Reflect.deleteProperty(document, 'exitPointerLock')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function tabInfo(visible: boolean): SidebarRightTabInfo {
  return {
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' as PaneId, isFloating: false },
    tab: {
      id: 'tab-game' as TabId,
      kind: 'godot',
      contentId: 'sidebar://godot',
      title: en['tab.title'],
      visible,
      navigation: { address: 'sidebar://godot', params: undefined, revision: 0 },
      signal: new AbortController().signal,
      actions: { bindCommands: () => () => {}, openResource: unused, openTab: unused, close: unused },
    },
  }
}

function state(overrides: Partial<GameState> = {}): GameState {
  return { run: null, runtime: READY, logs: [], cursor: 0, ...overrides }
}

function tab(initial: GameSnapshot, options: { visible?: boolean; showLayer?: GameTabProps['showLayer'] } = {}) {
  const game = createSnapshotStore<GameSnapshot>(initial)
  const visibility = createSnapshotStore<boolean>(options.visible ?? true)
  const useVisibility = bindSnapshotSelector(visibility)
  const reconnect = vi.fn<() => void>()
  const play = vi.fn<GameTabProps['play']>(async () => undefined)
  const stop = vi.fn<GameTabProps['stop']>(async () => undefined)
  const control = vi.fn<GameTabProps['control']>(async () => undefined)
  const install = vi.fn<GameTabProps['install']>(async () => undefined)
  const input = vi.fn<GameTabProps['input']>(async () => {})
  const openFrames = vi.fn<GameTabProps['openFrames']>(async () => new Response(null, { status: 503 }))
  const releaseKeyboard = vi.fn<() => void>()
  const captureKeyboard = vi.fn<GameTabProps['captureKeyboard']>(() => releaseKeyboard)
  const releaseView = vi.fn<() => void>()
  const holdView = vi.fn<GameTabProps['holdView']>(() => releaseView)
  const props: GameTabProps = {
    useTabInfo: () => tabInfo(useVisibility(current => current)),
    useGame: bindSnapshotSelector(game),
    reconnect, play, stop, control, install, input, openFrames, holdView, captureKeyboard, t,
    ...options.showLayer === undefined ? {} : { showLayer: options.showLayer },
  }
  const view = render(<GameTab {...props} />)
  const set = (next: GameSnapshot): void => { act(() => { game.set(next) }) }
  const show = (shown: boolean): void => { act(() => { visibility.set(shown) }) }
  return {
    view, set, show, reconnect, play, stop, control, install, input, openFrames, holdView, releaseView, captureKeyboard, releaseKeyboard,
  }
}

function live(next: GameState): GameSnapshot {
  return { state: next, disconnected: false }
}

function button(name: string): HTMLButtonElement {
  const found = screen.getByRole('button', { name })
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`)
  return found
}

function viewport(): HTMLElement {
  return screen.getByRole('application', { name: en['viewport.label'] })
}

/** Let action promises and stream readers settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('GameTab connection', () => {
  it('centers a spinner until the first state arrives, then shows the tab', () => {
    const h = tab({ state: null, disconnected: false })
    expect(h.view.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.queryByRole('toolbar')).toBeNull()
    h.set(live(state()))
    expect(screen.getByRole('toolbar', { name: en['toolbar.label'] })).toBeTruthy()
  })

  it('offers a reconnect when the stream is lost, with or without a state', () => {
    const h = tab({ state: null, disconnected: true })
    expect(h.view.container.querySelector('[data-state="ongoing"]')).toBeNull()
    fireEvent.click(button(en['action.retry']))
    expect(h.reconnect).toHaveBeenCalledOnce()
    h.set({ state: state(), disconnected: true })
    expect(within(screen.getByRole('status')).getByText(en['stream.failed'])).toBeTruthy()
    fireEvent.click(button(en['action.retry']))
    expect(h.reconnect).toHaveBeenCalledTimes(2)
    h.set(live(state()))
    expect(screen.queryByRole('button', { name: en['action.retry'] })).toBeNull()
  })
})

describe('GameTab runtime', () => {
  it('offers the install while the runtime is missing and disables Play', async () => {
    const h = tab(live(state({ runtime: { state: 'missing', message: 'no runtime' } })))
    expect(screen.getByText(en['runtime.missing'])).toBeTruthy()
    expect(button(en['action.play']).disabled).toBe(true)
    fireEvent.click(button(en['action.install']))
    expect(h.install).toHaveBeenCalledOnce()
    await settle()
  })

  it('shows the failed install with its message and offers the install again', () => {
    tab(live(state({ runtime: { state: 'failed', message: 'checksum mismatch' } })))
    expect(screen.getByRole('alert').textContent).toBe('Godot could not be installed: checksum mismatch')
    expect(button(en['action.install'])).toBeTruthy()
    cleanup()
    tab(live(state({ runtime: { state: 'failed' } })))
    expect(screen.getByRole('alert').textContent).toBe('Godot could not be installed: ')
  })

  it.each([
    [{ state: 'installing', progress: { phase: 'downloading', completedBytes: 45, totalBytes: 100 } }, 'Downloading Godot… 45%'],
    [{ state: 'installing', progress: { phase: 'downloading', completedBytes: 5, totalBytes: 0 } }, 'Downloading Godot… 0%'],
    [{ state: 'installing', progress: { phase: 'downloading', completedBytes: 200, totalBytes: 100 } }, 'Downloading Godot… 100%'],
    [{ state: 'installing', progress: { phase: 'verifying', completedBytes: 100, totalBytes: 100 } }, en['runtime.verifying']],
    [{ state: 'installing', progress: { phase: 'extracting', completedBytes: 100, totalBytes: 100 } }, en['runtime.extracting']],
    [{ state: 'installing' }, en['runtime.installing']],
  ] satisfies [GodotRuntimeView, string][])('reports install progress %j as %s', (runtime, text) => {
    tab(live(state({ runtime })))
    expect(screen.getAllByText(text)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: en['action.install'] })).toBeNull()
    expect(button(en['action.play']).disabled).toBe(true)
  })
})

describe('GameTab toolbar', () => {
  it('plays the nearest project when no run exists', async () => {
    const h = tab(live(state()))
    expect(screen.getByText(en['empty.title'])).toBeTruthy()
    expect(screen.getByText(en['empty.hint'])).toBeTruthy()
    expect([button(en['action.stop']).disabled, button(en['action.pause']).disabled, button(en['action.step']).disabled]).toEqual([true, true, true])
    fireEvent.click(button(en['action.play']))
    expect(h.play).toHaveBeenCalledExactlyOnceWith({})
    await settle()
  })

  it('restarts, stops, and pauses a running game and shows its status', async () => {
    const h = tab(live(state({ run: run('r1', { fps: 59.6, scene: 'res://levels/main.tscn', renderer: 'metal / forward_plus' }) })))
    const status = screen.getByRole('toolbar')
    expect(within(status).getByText(en['phase.running'])).toBeTruthy()
    expect(within(status).getByText('60 FPS')).toBeTruthy()
    expect(within(status).getByText('main.tscn')).toBeTruthy()
    expect(within(status).getByText('metal / forward_plus')).toBeTruthy()
    expect(button(en['action.step']).disabled).toBe(true)
    fireEvent.click(button(en['action.restart']))
    expect(h.play).toHaveBeenCalledWith({ project: '/work/game' })
    await settle()
    // Restart repeats the scene and window size that the run was started with.
    h.set(live(state({ run: run('r2', { launch: { scene: 'res://levels/two.tscn', width: 800, height: 600 } }) })))
    fireEvent.click(button(en['action.restart']))
    expect(h.play).toHaveBeenLastCalledWith({ project: '/work/game', scene: 'res://levels/two.tscn', width: 800, height: 600 })
    fireEvent.click(button(en['action.stop']))
    expect(h.stop).toHaveBeenCalledOnce()
    fireEvent.click(button(en['action.pause']))
    expect(h.control).toHaveBeenCalledWith({ action: 'pause' })
    await settle()
  })

  it('resumes and steps a paused game', async () => {
    const h = tab(live(state({ run: run('r1', { phase: 'paused' }) })))
    expect(within(screen.getByRole('toolbar')).getByText(en['phase.paused'])).toBeTruthy()
    fireEvent.click(button(en['action.step']))
    expect(h.control).toHaveBeenCalledWith({ action: 'step', frames: 1 })
    await settle()
    fireEvent.click(button(en['action.resume']))
    expect(h.control).toHaveBeenLastCalledWith({ action: 'resume' })
    await settle()
  })

  it('disables an action until its call settles', async () => {
    const h = tab(live(state()))
    const pending = Promise.withResolvers<GameFailure | undefined>()
    h.play.mockReturnValueOnce(pending.promise)
    fireEvent.click(button(en['action.play']))
    expect(button(en['action.play']).disabled).toBe(true)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(button(en['action.play']).disabled).toBe(false)
  })

  it.each([
    [{ issue: 'noProject', message: 'none' }, en['issue.noProject']],
    [{ issue: 'runtimeUnavailable', message: 'set the Godot paths' }, 'Godot is not available: set the Godot paths'],
    [{ issue: 'notRunning', message: 'not running' }, en['issue.notRunning']],
    [{ issue: 'staleRun', message: 'stale' }, en['issue.staleRun']],
    [{ issue: 'tooManyRuns', message: 'limit', limit: 4 }, 'Too many games are running (limit 4). Stop one and try again.'],
    [{ issue: 'lowMemory', message: 'memory is short' }, en['issue.lowMemory']],
    [{ issue: 'sessionInUse', message: 'session "s1" is already owned by an active write handle' }, en['issue.sessionInUse']],
    [{ issue: 'failed', message: 'carrier lost' }, 'The action failed: carrier lost'],
  ] satisfies [GameFailure, string][])('reports the failure %j until it is dismissed', async (failure, text) => {
    const h = tab(live(state()))
    h.play.mockResolvedValueOnce(failure)
    fireEvent.click(button(en['action.play']))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(text)
    fireEvent.click(button(en['action.dismiss']))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports an action whose call rejects', async () => {
    const h = tab(live(state({ run: run('r1') })))
    h.stop.mockRejectedValueOnce(new Error('Remote method is no longer mounted'))
    fireEvent.click(button(en['action.stop']))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('The action failed: Remote method is no longer mounted')
    h.control.mockRejectedValueOnce('refused')
    fireEvent.click(button(en['action.pause']))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('The action failed: refused')
    expect(button(en['action.pause']).disabled).toBe(false)
  })
})

describe('GameTab run phases', () => {
  it.each(['preparing', 'importing', 'starting'] as const)('shows the %s phase with a spinner and allows stopping', (phase) => {
    tab(live(state({ run: run('r1', { phase, startedBy: 'agent' }) })))
    const message = screen.getAllByRole('status').find(node => node.textContent === en[`phase.${phase}`])
    expect(message?.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(button(en['action.restart']).disabled).toBe(false)
    expect(button(en['action.stop']).disabled).toBe(false)
    expect(button(en['action.pause']).disabled).toBe(true)
  })

  it('explains a crash with its code, signal, and output, and plays the main scene again', async () => {
    const h = tab(live(state({
      run: run('r1', { phase: 'crashed', exitCode: 139, signal: 'SIGSEGV', message: 'handle_crash: Program crashed', launch: { scene: 'res://boss.tscn' } }),
    })))
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText(en['ended.crashed'])).toBeTruthy()
    expect(within(alert).getByText('Exit code 139')).toBeTruthy()
    expect(within(alert).getByText('Signal SIGSEGV')).toBeTruthy()
    expect(within(alert).getByText('handle_crash: Program crashed').tagName).toBe('PRE')
    expect(button(en['action.play']).disabled).toBe(false)
    fireEvent.click(button(en['action.play']))
    expect(h.play).toHaveBeenCalledExactlyOnceWith({ project: '/work/game' })
    await settle()
  })

  it('reports an exit and a failed start', () => {
    tab(live(state({ run: run('r1', { phase: 'exited', exitCode: 0, signal: null }) })))
    expect(within(screen.getAllByRole('status').at(-1)!).getByText(en['ended.exited'])).toBeTruthy()
    expect(screen.getByText('Exit code 0')).toBeTruthy()
    cleanup()
    tab(live(state({ run: run('r1', { phase: 'failed', exitCode: null, message: 'main scene missing' }) })))
    expect(within(screen.getByRole('alert')).getByText(en['ended.failed'])).toBeTruthy()
    expect(screen.queryByText(/Exit code/u)).toBeNull()
  })
})

describe('GameTab log drawer', () => {
  it('counts errors and warnings and lists entries newest first with their location', () => {
    const logs = [
      entry(1, 'r1', { message: 'ready' }),
      entry(2, 'r1', { level: 'warning', message: 'unused variable', file: 'res://player.gd' }),
      entry(3, 'r1', { level: 'script_error', message: 'Invalid call', file: 'res://player.gd', line: 12 }),
    ]
    tab(live(state({ run: run('r1', { errorCount: 2, warningCount: 1 }), logs })))
    const header = screen.getByRole('button', { name: /^Logs\s*Errors: 2\s*Warnings: 1$/u })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    const rows = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(rows.map(row => row.getAttribute('data-level'))).toEqual(['script_error', 'warning', 'stdout'])
    expect(rows.map(row => row.textContent)).toEqual(['Invalid callres://player.gd:12', 'unused variableres://player.gd', 'ready'])
    expect(screen.getByRole('img', { name: 'Errors: 2' }).getAttribute('data-active')).toBe('true')
    fireEvent.click(header)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows an empty drawer and zero counts without a run', () => {
    tab(live(state()))
    const header = screen.getByRole('button', { name: /^Logs\s*Errors: 0\s*Warnings: 0$/u })
    expect(screen.getByRole('img', { name: 'Warnings: 0' }).hasAttribute('data-active')).toBe(false)
    fireEvent.click(header)
    expect(screen.getByText(en['logs.empty'])).toBeTruthy()
  })
})

/** A frame response carrying one record, held open until its request aborts. */
function frames(signal: AbortSignal): Response {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + 2)
  const header = new DataView(bytes.buffer)
  header.setUint32(0, 2, true)
  header.setUint16(4, 320, true)
  header.setUint16(6, 180, true)
  header.setUint32(8, 1, true)
  bytes.set([0xff, 0xd8], FRAME_HEADER_BYTES)
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      signal.addEventListener('abort', () => { controller.error(signal.reason) })
    },
  }))
}

class FakeBitmap implements ImageBitmap {
  readonly close = vi.fn()
  constructor(readonly width: number, readonly height: number) {}
}

describe('GameTab game view', () => {
  it('draws streamed frames while visible and running and stops streaming when hidden or ended', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => new FakeBitmap(320, 180)))
    const h = tab(live(state({ run: run('r1') })), { visible: false })
    h.openFrames.mockImplementation(async (_runId, signal) => frames(signal))
    expect(h.openFrames).not.toHaveBeenCalled()
    h.show(true)
    await vi.waitFor(() => { expect(h.openFrames).toHaveBeenCalledWith('r1', expect.any(AbortSignal)) })
    await vi.waitFor(() => { expect(drawImage).toHaveBeenCalled() })
    const canvas = viewport().querySelector('canvas')
    expect([canvas?.width, canvas?.height]).toEqual([320, 180])
    const signal = h.openFrames.mock.lastCall![1]
    h.show(false)
    expect(signal.aborted).toBe(true)
    h.show(true)
    await vi.waitFor(() => { expect(h.openFrames).toHaveBeenCalledTimes(2) })
    const clears = clearRect.mock.calls.length
    h.set(live(state({ run: run('r2') })))
    expect(clearRect.mock.calls.length).toBe(clears + 1)
    await vi.waitFor(() => { expect(h.openFrames).toHaveBeenLastCalledWith('r2', expect.any(AbortSignal)) })
    h.set(live(state({ run: run('r2', { phase: 'exited', exitCode: 0 }) })))
    expect(h.openFrames.mock.lastCall![1].aborted).toBe(true)
  })

  it('holds a view of the run while its picture shows, and releases it when hidden or ended', () => {
    const h = tab(live(state({ run: run('r1') })), { visible: false })
    expect(h.holdView).not.toHaveBeenCalled()
    h.show(true)
    expect(h.holdView).toHaveBeenCalledExactlyOnceWith('r1')
    h.show(false)
    expect(h.releaseView).toHaveBeenCalledOnce()
    h.show(true)
    h.set(live(state({ run: run('r2') })))
    expect(h.releaseView).toHaveBeenCalledTimes(2)
    expect(h.holdView).toHaveBeenLastCalledWith('r2')
    h.set(live(state({ run: run('r2', { phase: 'exited', exitCode: 0 }) })))
    expect(h.releaseView).toHaveBeenCalledTimes(3)
    expect(h.holdView).toHaveBeenCalledTimes(3)
  })

  it('takes keys while focused, hints until then, and sends them to the run', async () => {
    const h = tab(live(state({ run: run('r1', { width: 1280, height: 720 }) })))
    expect(screen.getByText(en['viewport.hint'])).toBeTruthy()
    const view = viewport()
    expect(h.captureKeyboard).not.toHaveBeenCalled()
    act(() => { view.focus() })
    expect(view.hasAttribute('data-focused')).toBe(true)
    expect(h.captureKeyboard).toHaveBeenCalledOnce()
    expect(screen.queryByText(en['viewport.hint'])).toBeNull()
    const press = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    view.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    await vi.waitFor(() => { expect(h.input).toHaveBeenCalledWith('r1', [{ kind: 'key', key: 'Space', pressed: true, unicode: 32 }]) })
    act(() => { view.blur() })
    await vi.waitFor(() => { expect(h.input).toHaveBeenLastCalledWith('r1', [{ kind: 'key', key: 'Space', pressed: false }]) })
    expect(h.releaseKeyboard).toHaveBeenCalledOnce()
    expect(screen.getByText(en['viewport.hint'])).toBeTruthy()
  })

  it('tells how to release the keyboard and gives it back on Shift+Escape', () => {
    const h = tab(live(state({ run: run('r1', { width: 1280, height: 720 }) })))
    const view = viewport()
    const description = document.getElementById(view.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe(en['viewport.release'])
    expect(screen.getAllByText(en['viewport.release'])).toEqual([description])
    act(() => { view.focus() })
    const shown = screen.getAllByText(en['viewport.release']).find(node => node !== description)
    expect(shown?.getAttribute('aria-hidden')).toBe('true')
    expect(shown?.hasAttribute('data-transient')).toBe(true)
    const chord = new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', shiftKey: true, bubbles: true, cancelable: true })
    act(() => { view.dispatchEvent(chord) })
    expect(chord.defaultPrevented).toBe(true)
    expect(document.activeElement).not.toBe(view)
    expect(h.releaseKeyboard).toHaveBeenCalledOnce()
    expect(view.hasAttribute('data-focused')).toBe(false)
    expect(screen.getAllByText(en['viewport.release'])).toEqual([description])
    expect(h.input).not.toHaveBeenCalled()
  })

  it('stops streaming frames and taking input while the follow stream is stopped', async () => {
    const h = tab({ state: state({ run: run('r1') }), disconnected: true })
    const view = viewport()
    expect(view.hasAttribute('aria-describedby')).toBe(false)
    expect(screen.queryByText(en['viewport.hint'])).toBeNull()
    act(() => { view.focus() })
    const press = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true })
    view.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(false)
    await settle()
    expect(h.openFrames).not.toHaveBeenCalled()
    expect(h.captureKeyboard).not.toHaveBeenCalled()
    h.set(live(state({ run: run('r1') })))
    await vi.waitFor(() => { expect(h.openFrames).toHaveBeenCalledWith('r1', expect.any(AbortSignal)) })
    expect(h.captureKeyboard).toHaveBeenCalledOnce()
  })

  it('maps pointer input against the window size, or the drawn frame before the game reports one', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => new FakeBitmap(320, 180)))
    const h = tab(live(state({ run: run('r1') })), { visible: false })
    h.openFrames.mockImplementation(async (_runId, signal) => frames(signal))
    const canvas = viewport().querySelector('canvas')!
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 180))
    h.show(true)
    fireEvent.mouseMove(canvas, { clientX: 160, clientY: 90 })
    await vi.waitFor(() => { expect(drawImage).toHaveBeenCalled() })
    fireEvent.mouseMove(canvas, { clientX: 80, clientY: 90 })
    await vi.waitFor(() => { expect(h.input).toHaveBeenCalledWith('r1', [{ kind: 'mouse_motion', x: 80, y: 90, dx: 80, dy: 90 }]) })
    h.set(live(state({ run: run('r1', { width: 640, height: 360 }) })))
    fireEvent.mouseMove(canvas, { clientX: 160, clientY: 90 })
    await vi.waitFor(() => { expect(h.input).toHaveBeenLastCalledWith('r1', [{ kind: 'mouse_motion', x: 320, y: 180, dx: 240, dy: 90 }]) })
  })

  it('releases the pointer lock when the game frees the mouse', () => {
    const h = tab(live(state({ run: run('r1', { mouseMode: MOUSE_MODE_CAPTURED }) })))
    lockTarget = viewport().querySelector('canvas')
    h.set(live(state({ run: run('r1', { mouseMode: MOUSE_MODE_CAPTURED, fps: 30 }) })))
    expect(exitPointerLock).not.toHaveBeenCalled()
    h.set(live(state({ run: run('r1', { mouseMode: 0 }) })))
    expect(exitPointerLock).toHaveBeenCalledOnce()
    h.set(live(state({ run: run('r1', { mouseMode: 1 }) })))
    expect(exitPointerLock).toHaveBeenCalledOnce()
  })
})

/** A shell that shows layers: each presentation it receives, and the end of each. */
function layerShell() {
  const presentations: LayerPresentation[] = []
  const ends: ReturnType<typeof vi.fn<() => void>>[] = []
  const showLayer = vi.fn<NonNullable<GameTabProps['showLayer']>>((presentation) => {
    presentations.push(presentation)
    const end = vi.fn<() => void>()
    ends.push(end)
    return end
  })
  return { showLayer, presentations, ends }
}

function layerFrame(): HTMLElement | null {
  return document.body.querySelector('[data-godot-layer-frame]')
}

describe('GameTab game layer', () => {
  const layered = (runId: string, context: number, overrides: Parameters<typeof run>[1] = {}) =>
    run(runId, { width: 1600, height: 900, layer: { context, scale: 2 }, ...overrides })

  it('shows the run’s layer instead of its frames while visible and running, with the hints and focus ring above it', async () => {
    const shell = layerShell()
    const h = tab(live(state({ run: layered('r1', 7) })), { showLayer: shell.showLayer })
    expect(shell.showLayer).toHaveBeenCalledOnce()
    const [presentation] = shell.presentations
    expect(presentation).toMatchObject({ view: viewport(), layer: { context: 7, scale: 2 }, window: { width: 1600, height: 900 } })
    expect(presentation?.id).toEqual(expect.any(String))
    await settle()
    expect(h.openFrames).not.toHaveBeenCalled()
    expect(layerFrame()).toBeNull()
    act(() => { presentation?.onBox({ x: 10, y: 20, width: 300, height: 200 }) })
    const frame = layerFrame()!
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual(['10px', '20px', '300px', '200px'])
    expect(frame.getAttribute('aria-hidden')).toBe('true')
    expect(within(frame).getByText(en['viewport.hint'])).toBeTruthy()
    const view = viewport()
    expect(within(view).getByText(en['viewport.hint']).className).toContain('visuallyHidden')
    act(() => { view.focus() })
    expect(view.hasAttribute('data-focused')).toBe(false)
    expect(frame.hasAttribute('data-focused')).toBe(true)
    expect(within(frame).getByText(en['viewport.release']).hasAttribute('data-transient')).toBe(true)
    expect(h.captureKeyboard).toHaveBeenCalledOnce()
    // A status update keeps the layer; the window size maps pointer input, since no frame is drawn.
    h.set(live(state({ run: layered('r1', 7, { fps: 120 }) })))
    expect(shell.showLayer).toHaveBeenCalledOnce()
    const canvas = view.querySelector('canvas')!
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 180))
    fireEvent.mouseMove(canvas, { clientX: 160, clientY: 90 })
    await vi.waitFor(() => { expect(h.input).toHaveBeenCalledWith('r1', [{ kind: 'mouse_motion', x: 800, y: 450, dx: 800, dy: 450 }]) })
    h.show(false)
    expect(shell.ends[0]).toHaveBeenCalledOnce()
    expect(layerFrame()).toBeNull()
    h.show(true)
    expect(shell.showLayer).toHaveBeenCalledTimes(2)
    h.set(live(state({ run: layered('r2', 8) })))
    expect(shell.ends[1]).toHaveBeenCalledOnce()
    expect(shell.presentations[2]?.layer.context).toBe(8)
    h.set(live(state({ run: layered('r2', 8, { phase: 'exited', exitCode: 0 }) })))
    expect(shell.ends[2]).toHaveBeenCalledOnce()
    expect(h.openFrames).not.toHaveBeenCalled()
  })

  it('streams the frames of a run whose layer the shell refused, and offers the next run’s layer again', async () => {
    const shell = layerShell()
    const h = tab(live(state({ run: layered('r1', 7) })), { showLayer: shell.showLayer })
    act(() => { shell.presentations[0]?.onFailed() })
    await vi.waitFor(() => { expect(h.openFrames).toHaveBeenCalledWith('r1', expect.any(AbortSignal)) })
    h.show(false)
    h.show(true)
    expect(shell.showLayer).toHaveBeenCalledOnce()
    h.set(live(state({ run: layered('r2', 9) })))
    expect(shell.showLayer).toHaveBeenCalledTimes(2)
    expect(shell.presentations[1]?.layer.context).toBe(9)
  })

  it('streams frames for a run without a layer, or before the game reports its window', async () => {
    const shell = layerShell()
    const h = tab(live(state({ run: run('r1', { layer: { context: 7, scale: 2 } }) })), { showLayer: shell.showLayer })
    await vi.waitFor(() => { expect(h.openFrames).toHaveBeenCalledWith('r1', expect.any(AbortSignal)) })
    h.set(live(state({ run: run('r2', { width: 640, height: 360 }) })))
    await vi.waitFor(() => { expect(h.openFrames).toHaveBeenLastCalledWith('r2', expect.any(AbortSignal)) })
    expect(shell.showLayer).not.toHaveBeenCalled()
  })
})

it('titles the tab with the game controller and its name', () => {
  const view = render(<GameTabTitle t={t} />)
  expect(view.container.querySelector('svg')).not.toBeNull()
  expect(view.container.textContent).toBe(en['tab.title'])
})

it('keeps the previous run’s frame stream closed when the tab body unmounts', async () => {
  const h = tab(live(state({ run: run('r1') })))
  await vi.waitFor(() => { expect(h.openFrames).toHaveBeenCalled() })
  const signal = h.openFrames.mock.lastCall![1]
  h.view.unmount()
  expect(signal.aborted).toBe(true)
})

it('keeps the status free of a frame rate while the game is not running', () => {
  tab(live(state({ run: run('r1', { phase: 'starting', fps: 0 }) })))
  expect(within(screen.getByRole('toolbar')).queryByText('0 FPS')).toBeNull()
})
