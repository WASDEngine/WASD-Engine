/**
 * WASD Engine's automatic update downloads (fork-owned; `wasdengine/FORK.md` lists the fork changes). Upstream
 * downloads an update only after the user asks for it from the sidebar's update indicator. WASD Engine downloads every
 * update as soon as a check finds it, retries a failed download in the background, and keeps the indicator for the one
 * step left to the user: Restart to Update, which installs the downloaded update after upstream's confirmation.
 */
import type { DesktopUpdateState } from './ipc.ts'
import type { DesktopUpdateCoordinator } from './update-coordinator.ts'
import type { DesktopUpdateScheduleConfig } from './update-schedule.ts'

/**
 * Select the update state that the sidebar indicator and the collapsed sidebar's badge present.
 * @param state - Main-process updater state.
 * @returns `ready` and `installing` unchanged; a failed installation as `ready`, because its dialog has explained the
 *   failure and the downloaded update stays installable; a configuration failure unchanged, because Settings sends the
 *   user to the indicator for its details; every other state as `idle`, which hides the indicator.
 */
export function wasdengineIndicatorUpdate(state: DesktopUpdateState): DesktopUpdateState {
  if (state.phase === 'ready' || state.phase === 'installing') return state
  if (state.phase !== 'error') return { phase: 'idle' }
  if (state.failedOperation === 'configuration') return state
  return state.failedOperation === 'install' && state.version !== undefined
    ? { phase: 'ready', version: state.version }
    : { phase: 'idle' }
}

/**
 * Starts the download of each update that the coordinator publishes as available, and retries a failed download with
 * a fresh feed check: after the check interval, doubled after each further failure up to the maximum backoff. A
 * successful download or a check that finds no update resets the backoff.
 */
export class WasdengineUpdateDownloads {
  private timer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private disposed = false
  private last: DesktopUpdateState | undefined

  /**
   * @param updates - Reads the coordinator that owns each download and publishes its states. It is read only when a
   *   start or retry runs, so the shell can build the coordinator after this object, whose `published` its
   *   publication callback calls.
   * @param config - Validated polling settings, whose interval, maximum backoff, and jitter time the retries.
   * @param allowed - Whether a download may start now; false while the application quits or a mandatory update
   *   policy, whose window offers the download itself, blocks.
   * @param recheck - Explicit feed check through the update schedule. The coordinator holds automatic checks after a
   *   failed download; an explicit one passes that hold, and the `available` state it publishes restarts the download.
   * @param random - Uniform sample in [0, 1) for the jitter.
   */
  constructor(
    private readonly updates: () => Pick<DesktopUpdateCoordinator, 'state' | 'revision' | 'download'>,
    private readonly config: DesktopUpdateScheduleConfig,
    private readonly allowed: () => boolean,
    private readonly recheck: () => Promise<DesktopUpdateState>,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * React to one published state. An available update starts downloading after the current task, once the operation
   * that published it, such as a channel switch, has settled; a failed download schedules its retry. The same state
   * object published again, as the shell does once its main window exists, changes nothing.
   * @param state - State that the coordinator just published.
   */
  published(state: DesktopUpdateState): void {
    if (this.disposed || state === this.last) return
    this.last = state
    if (state.phase === 'available') {
      this.arm(0, () => { this.download() })
    } else if (state.phase === 'error' && state.failedOperation === 'download') {
      this.failures++
      this.arm(this.backoff(), () => { this.retry() })
    } else if (state.phase === 'ready' || state.phase === 'idle') {
      this.failures = 0
      this.clear()
    } else if (state.phase === 'installing' || state.phase === 'error') {
      this.clear()
    }
  }

  /** Cancel a pending start or retry; a download already running stays with the coordinator. */
  dispose(): void {
    this.disposed = true
    this.clear()
  }

  private arm(delay: number, run: () => void): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      run()
    }, delay)
  }

  private clear(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private backoff(): number {
    const { intervalMs, maxBackoffMs, jitter } = this.config
    const delay = Math.min(maxBackoffMs, intervalMs * 2 ** (this.failures - 1))
    const lower = Math.max(1_000, delay * (1 - jitter))
    const upper = Math.min(maxBackoffMs, delay * (1 + jitter))
    return Math.round(lower + (upper - lower) * this.random())
  }

  private download(): void {
    const updates = this.updates()
    const state = updates.state
    if (this.disposed || state.phase !== 'available' || state.version === undefined || !this.allowed()) return
    // The coordinator publishes the download's outcome; it rejects only a target that a newer check replaced.
    void updates.download(state.version, updates.revision).catch((error: unknown) => {
      console.error('desktop update: automatic download did not start', error)
    })
  }

  private retry(): void {
    const state = this.updates().state
    if (this.disposed || state.phase !== 'error' || state.failedOperation !== 'download' || !this.allowed()) return
    void this.recheck().catch((error: unknown) => {
      console.error('desktop update: automatic download retry failed', error)
    })
  }
}
