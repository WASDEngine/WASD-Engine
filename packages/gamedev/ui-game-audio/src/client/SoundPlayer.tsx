/**
 * The selected sound's player: it reads the file, again whenever the `file` resource reports a new version, decodes it
 * at its own sample rate, and shows its waveform with the playhead, which a click or drag moves, the play, repeat, and
 * volume controls, and the details the agent's `audio_review` also reports: kind, format, length, size, loudness, and
 * peak, with notes on clipping, silence before the sound, a click where it repeats, and stereo that holds one sound.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { LATE_START_SECONDS, probeAudio, seamClicks, type AudioCategory, type AudioProbe } from '@deepseek-ai/dsh-game-audio/audio'
import type { AudioMeasurements } from '@deepseek-ai/dsh-game-audio/types'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import { Button, fileSizeText, IconPauseOutlineRegular, IconPlayOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError, type RemoteFailure, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { decodeSound, measureSound, SoundError } from './decode.ts'
import { clockText, decibelText, kilohertzText, lengthValue } from './format.ts'
import { AudioGlyph, RepeatGlyph } from './icon.tsx'
import type { NS } from './locales.ts'
import { waveformPath, waveformPeaks } from './peaks.ts'
import type { PlaybackState } from './playback.ts'
import { memoryReader, type SoundFile } from './read.ts'
import type { SoundItem } from './rows.ts'
import css from './SoundPlayer.module.css'

/** Columns the waveform is drawn with, whatever its width on screen. */
const WAVE_COLUMNS = 480

/** The window player's operations a tab calls, each for the key it loaded a sound under. */
export interface PlaybackControls {
  readonly load: (key: string, buffer: AudioBuffer) => void
  readonly play: (key: string) => void
  readonly pause: (key: string) => void
  readonly seek: (key: string, seconds: number) => void
  readonly position: (key: string) => number
  readonly setLoop: (loop: boolean) => void
  readonly setVolume: (volume: number) => void
  readonly release: (key: string) => void
}

/** A request to play a sound once its player has loaded it. */
export interface PlayRequest {
  readonly path: string
  /** Distinguishes requests for the same sound. */
  readonly token: number
}

/** Props of {@link SoundPlayer}. */
export interface SoundPlayerProps extends PropsLocale<typeof NS> {
  readonly item: SoundItem
  /** Prefix of the player keys, unique to the tab's Session. */
  readonly keyPrefix: string
  readonly useResource: PropsRuntime<'sidebar.right.pane.tab'>['useResource']
  /**
   * Read the sound completely.
   * @param path - workspace path.
   * @param signal - cancellation.
   * @returns the file, or the failure to show.
   */
  readonly read: (path: string, signal: AbortSignal) => Promise<RemoteResult<SoundFile>>
  /**
   * The `file` resource address of a sound, which reports its version as it changes.
   * @param path - workspace path.
   * @returns the address.
   */
  readonly fileAddress: (path: string) => string
  readonly playback: PlaybackControls
  readonly usePlayback: SnapshotSelectorHook<PlaybackState>
  /** The pending request to play, if any. */
  readonly playRequest: PlayRequest | undefined
  /** Clears the pending request once this player has started it. */
  readonly onPlayed: (token: number) => void
  /** Longest stretch the details measure, in seconds. */
  readonly maxMeasuredSeconds: number
  /** Longest sound the player decodes, in seconds. */
  readonly maxDecodedSeconds: number
}

/** Where loading the selected sound stands. */
type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }
  | { readonly kind: 'undecodable'; readonly tooLong?: number }
  | { readonly kind: 'ready'; readonly buffer: AudioBuffer; readonly probe: AudioProbe | undefined; readonly bytes: number; readonly version: string }

function failureText(failure: RemoteFailure, t: SoundPlayerProps['t']): { readonly text: string; readonly retry: boolean } {
  switch (failure.code) {
    case 'workspace-file/not-found':
      return { text: t('player.notFound'), retry: false }
    case 'workspace-file/too-large':
      return { text: t('player.tooLarge', { limit: fileSizeText(failure.details.limit) }), retry: false }
    case 'game-audio/changed':
      return { text: t('player.changed'), retry: true }
    default:
      return { text: t('player.failed'), retry: true }
  }
}

/**
 * Render the selected sound's player.
 * @param props - the sound, its reads, the window player, and copy.
 * @returns the player.
 */
export function SoundPlayer(props: SoundPlayerProps): ReactNode {
  const { item, useResource, read, fileAddress, maxDecodedSeconds, t } = props
  const { path, format } = item.entry
  const resource = useResource<'file'>(fileAddress(path))
  const version = resource.status === 'live' ? resource.value?.version : undefined
  // A read waits for the resource's first frame, so selecting a sound reads it once, not before and after its version.
  const waiting = resource.status === 'loading'
  const gone = resource.status === 'failed' && resource.failure?.code === 'workspace-file/not-found'
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const current = useRef<{ readonly version: string; readonly attempt: number }>()
  useEffect(() => {
    if (waiting || gone) return
    const shown = current.current
    if (shown !== undefined && shown.attempt === attempt && (version === undefined || shown.version === version)) return
    const controller = new AbortController()
    // A newer version replaces the shown one once it decodes; until then the shown one stays.
    setLoad(previous => previous.kind === 'ready' ? previous : { kind: 'loading' })
    const run = async (): Promise<Load> => {
      const file = await read(path, controller.signal)
      if (!file.ok) return { kind: 'failed', failure: file.error }
      const probe = await probeAudio(memoryReader(file.value.data), file.value.data.byteLength)
      if (probe?.seconds !== undefined && probe.seconds > maxDecodedSeconds) return { kind: 'undecodable', tooLong: maxDecodedSeconds }
      try {
        const buffer = await decodeSound(file.value.data, format, probe?.sampleRate)
        return { kind: 'ready', buffer, probe, bytes: file.value.data.byteLength, version: file.value.version }
      } catch (error) {
        if (!(error instanceof SoundError)) throw error
        return { kind: 'undecodable' }
      }
    }
    void run().then((next) => {
      if (controller.signal.aborted) return
      current.current = next.kind === 'ready' ? { version: next.version, attempt } : undefined
      setLoad(next)
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      current.current = undefined
      setLoad({ kind: 'failed', failure: new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) })
    })
    return () => { controller.abort() }
  }, [path, format, version, waiting, gone, attempt, read, maxDecodedSeconds])

  const header = (
    <div className={css.header}>
      <span className={css.name} title={item.entry.name}>{item.entry.name}</span>
      {item.entry.folder !== '' && <span className={css.folder} title={item.entry.folder}>{item.entry.folder}</span>}
    </div>
  )
  if (gone) return <div className={css.root}>{header}<p className={css.message} role="alert">{t('player.notFound')}</p></div>
  if (load.kind === 'loading') {
    return (
      <div className={css.root}>
        {header}
        <div className={css.waiting} role="status" aria-label={t('player.loading', { name: item.entry.name })}><StateDot state="ongoing" /></div>
      </div>
    )
  }
  if (load.kind !== 'ready') {
    const { text, retry } = load.kind === 'failed'
      ? failureText(load.failure, t)
      : { text: load.tooLong === undefined ? t('player.unreadable') : t('player.tooLarge', { limit: t('unit.seconds', { value: String(load.tooLong) }) }), retry: false }
    return (
      <div className={css.root}>
        {header}
        <div className={css.notice} role="alert">
          <span className={css.message}>{text}</span>
          {retry && <Button size="sm" variant="outline" onClick={() => { setAttempt(count => count + 1) }}>{t('action.retry')}</Button>}
        </div>
      </div>
    )
  }
  return (
    <div className={css.root}>
      {header}
      <LoadedSound {...props} buffer={load.buffer} probe={load.probe} bytes={load.bytes} version={load.version} />
    </div>
  )
}

/** Props of a decoded sound's player. */
interface LoadedSoundProps extends SoundPlayerProps {
  readonly buffer: AudioBuffer
  readonly probe: AudioProbe | undefined
  readonly bytes: number
  readonly version: string
}

/** The decoded sound's waveform, controls, and details. */
function LoadedSound(props: LoadedSoundProps): ReactNode {
  const { item, keyPrefix, buffer, probe, bytes, version, playback, usePlayback, playRequest, onPlayed, maxMeasuredSeconds, t } = props
  const key = `${keyPrefix}\n${item.entry.path}\n${version}`
  const shape = useMemo(() => waveformPath(waveformPeaks(buffer, WAVE_COLUMNS)), [buffer])
  const [measured, setMeasured] = useState<AudioMeasurements>()
  useEffect(() => {
    setMeasured(undefined)
    // The waveform shows first; measuring a long sound takes a moment.
    const timer = setTimeout(() => { setMeasured(measureSound(buffer, 0, undefined, maxMeasuredSeconds).measurements) }, 0)
    return () => { clearTimeout(timer) }
  }, [buffer, maxMeasuredSeconds])
  // Leaving the sound stops it, whether another sound was chosen, the file changed, or the tab closed.
  useEffect(() => () => { playback.release(key) }, [playback, key])
  useEffect(() => {
    if (playRequest === undefined || playRequest.path !== item.entry.path) return
    onPlayed(playRequest.token)
    playback.load(key, buffer)
    playback.play(key)
  }, [playRequest, item.entry.path, onPlayed, playback, key, buffer])
  const loop = usePlayback(state => state.loop)
  return (
    <>
      <Transport
        name={item.entry.name}
        playbackKey={key}
        buffer={buffer}
        shape={shape}
        playback={playback}
        usePlayback={usePlayback}
        t={t}
      />
      <Details
        kind={item.kind}
        format={item.entry.format.label}
        probe={probe}
        bytes={bytes}
        measured={measured}
        loop={loop}
        maxMeasuredSeconds={maxMeasuredSeconds}
        t={t}
      />
    </>
  )
}

/** Props of {@link Transport}. */
interface TransportProps extends PropsLocale<typeof NS> {
  readonly name: string
  readonly playbackKey: string
  readonly buffer: AudioBuffer
  /** The waveform's path over the view box `0 -1 <columns> 2`. */
  readonly shape: string
  readonly playback: PlaybackControls
  readonly usePlayback: SnapshotSelectorHook<PlaybackState>
}

/** The waveform with the playhead and the play, repeat, and volume controls. */
function Transport({ name, playbackKey, buffer, shape, playback, usePlayback, t }: TransportProps): ReactNode {
  const mine = usePlayback(state => state.key === playbackKey)
  const playing = usePlayback(state => state.key === playbackKey && state.playing)
  const loop = usePlayback(state => state.loop)
  const volume = usePlayback(state => state.volume)
  const length = buffer.length / buffer.sampleRate
  const [position, setPosition] = useState(() => playback.position(playbackKey))
  useEffect(() => {
    setPosition(playback.position(playbackKey))
    if (!playing) return
    let frame = requestAnimationFrame(function follow() {
      setPosition(playback.position(playbackKey))
      frame = requestAnimationFrame(follow)
    })
    return () => { cancelAnimationFrame(frame) }
  }, [playing, mine, playback, playbackKey])
  const scrubbing = useRef(false)
  const seek = (seconds: number): void => {
    const at = Math.min(Math.max(0, seconds), length)
    if (!mine) playback.load(playbackKey, buffer)
    playback.seek(playbackKey, at)
    setPosition(at)
  }
  const toggle = (): void => {
    if (playing) {
      playback.pause(playbackKey)
      return
    }
    if (!mine) playback.load(playbackKey, buffer)
    playback.play(playbackKey)
  }
  const seekAt = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width > 0) seek((event.clientX - box.left) / box.width * length)
  }
  const onWaveKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = Math.max(0.1, length / 50)
    const moves: Readonly<Record<string, number>> = {
      ArrowLeft: position - step, ArrowDown: position - step, ArrowRight: position + step, ArrowUp: position + step,
      PageDown: position - length / 10, PageUp: position + length / 10, Home: 0, End: length,
    }
    const target = moves[event.key]
    if (target !== undefined) {
      event.preventDefault()
      seek(target)
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      toggle()
    }
  }
  const played = length > 0 ? Math.min(1, position / length) : 0
  const clock = t('player.clock', { position: clockText(position), length: clockText(length) })
  return (
    <div className={css.transport}>
      <div
        className={css.wave}
        role="slider"
        tabIndex={0}
        aria-label={t('player.position', { name })}
        aria-valuemin={0}
        aria-valuemax={Number(length.toFixed(3))}
        aria-valuenow={Number(position.toFixed(3))}
        aria-valuetext={clock}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          scrubbing.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          seekAt(event)
        }}
        onPointerMove={(event) => { if (scrubbing.current) seekAt(event) }}
        onPointerUp={() => { scrubbing.current = false }}
        onPointerCancel={() => { scrubbing.current = false }}
        onKeyDown={onWaveKey}
      >
        <svg className={css.waveRest} viewBox={`0 -1 ${String(WAVE_COLUMNS)} 2`} preserveAspectRatio="none" aria-hidden="true">
          <path d={shape} />
        </svg>
        <svg
          className={css.wavePlayed}
          viewBox={`0 -1 ${String(WAVE_COLUMNS)} 2`}
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ clipPath: `inset(0 ${String((1 - played) * 100)}% 0 0)` }}
        >
          <path d={shape} />
        </svg>
        <span className={css.playhead} style={{ left: `${String(played * 100)}%` }} aria-hidden="true" />
      </div>
      <div className={css.controls}>
        <Tooltip label={playing ? t('player.pause') : t('player.play')} side="bottom" delayMs={500}>
          <button type="button" className={css.play} aria-label={playing ? t('player.pause') : t('player.play')} onClick={toggle}>
            {playing ? <IconPauseOutlineRegular size={16} /> : <IconPlayOutlineRegular size={16} />}
          </button>
        </Tooltip>
        <span className={css.clock}>{clock}</span>
        <Tooltip label={t('player.loop')} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('player.loop')} aria-pressed={loop} onClick={() => { playback.setLoop(!loop) }}>
            <RepeatGlyph />
          </button>
        </Tooltip>
        <label className={css.volume}>
          <AudioGlyph className={css.volumeGlyph} />
          <input
            className={css.volumeRange}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label={t('player.volume')}
            onChange={(event) => { playback.setVolume(Number(event.target.value)) }}
          />
        </label>
      </div>
    </div>
  )
}

/** Props of {@link Details}. */
interface DetailsProps extends PropsLocale<typeof NS> {
  readonly kind: AudioCategory
  readonly format: string
  readonly probe: AudioProbe | undefined
  readonly bytes: number
  readonly measured: AudioMeasurements | undefined
  /** Whether the player repeats sounds, which brings up a seam that clicks. */
  readonly loop: boolean
  readonly maxMeasuredSeconds: number
}

/** The sound's details and notes. */
function Details({ kind, format, probe, bytes, measured, loop, maxMeasuredSeconds, t }: DetailsProps): ReactNode {
  const channels = measured?.channels ?? probe?.channels
  const rate = probe?.sampleRate ?? measured?.sampleRate
  const formatParts = [
    probe?.format ?? format,
    probe?.encoding,
    rate === undefined ? undefined : t('unit.khz', { value: kilohertzText(rate) }),
    channels === undefined ? undefined : channels === 1 ? t('channels.mono') : channels === 2 ? t('channels.stereo') : t('channels.other', { count: channels }),
  ].filter(part => part !== undefined)
  const seconds = measured?.seconds ?? probe?.seconds
  const lengthText = (value: number): string => {
    const [text, inSeconds] = lengthValue(value)
    return inSeconds ? t('unit.seconds', { value: text }) : text
  }
  const notes: string[] = []
  if (measured !== undefined) {
    if (measured.peak === 0) notes.push(t('note.silent'))
    const clipped = measured.channelLevels.reduce((total, level) => total + level.clipped, 0)
    if (clipped > 0) notes.push(t(clipped === 1 ? 'note.clipping.one' : 'note.clipping.other', { count: clipped }))
    if (kind !== 'music' && measured.peak > 0 && measured.leadingSilence >= LATE_START_SECONDS) notes.push(t('note.lateStart', { length: lengthText(measured.leadingSilence) }))
    if (loop && measured.seam !== undefined && seamClicks(measured.seam)) notes.push(t('note.seam'))
    if (measured.stereo?.identical === true && measured.peak > 0) notes.push(t('note.identical'))
    if (measured.channelLevels.some(level => Math.abs(level.dcOffset) >= 0.01)) notes.push(t('note.dcOffset'))
    if (measured.seconds > maxMeasuredSeconds) notes.push(t('note.partial', { length: lengthText(maxMeasuredSeconds) }))
  }
  const measuring = <span className={css.pending}>{t('details.measuring')}</span>
  return (
    <div className={css.details}>
      <dl className={css.facts} aria-label={t('details.label')}>
        <dt>{t('details.kind')}</dt>
        <dd>{t(`kind.${kind}`)}</dd>
        <dt>{t('details.format')}</dt>
        <dd>{formatParts.join(' · ')}</dd>
        <dt>{t('details.length')}</dt>
        <dd>{seconds === undefined ? measuring : lengthText(seconds)}</dd>
        <dt>{t('details.size')}</dt>
        <dd>{fileSizeText(bytes)}</dd>
        <dt>{t('details.loudness')}</dt>
        <dd>{measured === undefined ? measuring : measured.loudness === undefined ? t('details.notMeasured') : t('unit.lufs', { value: measured.loudness.toFixed(1).replace('-', '−') })}</dd>
        <dt>{t('details.peak')}</dt>
        <dd>{measured === undefined ? measuring : t('unit.dbfs', { value: decibelText(measured.peak) })}</dd>
      </dl>
      {notes.length > 0 && (
        <ul className={css.notes} aria-label={t('note.label')}>
          {notes.map(note => <li key={note} className={css.note}>{note}</li>)}
        </ul>
      )}
    </div>
  )
}
