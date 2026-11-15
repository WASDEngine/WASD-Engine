/**
 * This window's answer to an agent's `game-audio/measure` request: it reads the sound from the calling Session's
 * workspace, decodes it at its own sample rate as the Audio tab plays it, measures the requested window as the tab's
 * details do and the seam of the requested loop, and draws the waveform and spectrogram picture when asked. A failure
 * rejects with a {@link SoundError} whose code and message the agent receives.
 */
import { AUDIO_ERROR, audioFormatOf } from '@deepseek-ai/dsh-game-audio/audio'
import type { AudioMeasureRequest, AudioMeasureResult } from '@deepseek-ai/dsh-game-audio/types'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { decodeSound, measureSound, pictureOf, SoundError, type DecodeBounds } from './decode.ts'
import type { SoundFile } from './read.ts'

/**
 * Read a complete sound of the calling Session's workspace.
 * @param path - workspace path.
 * @param maxBytes - the largest file to read.
 * @param signal - cancellation.
 * @returns the file, or the Remote failure.
 */
export type ReadSound = (path: string, maxBytes: number, signal: AbortSignal) => Promise<RemoteResult<SoundFile>>

/**
 * Read the sound a request names, or fail with the agent's message.
 * @param read - the bound read.
 * @param request - the request.
 * @param signal - cancellation.
 * @returns the file.
 * @throws {SoundError} naming why the file could not be read.
 */
async function readOrFail(read: ReadSound, request: AudioMeasureRequest, signal: AbortSignal): Promise<SoundFile> {
  const result = await read(request.path, request.maxBytes, signal)
  if (result.ok) return result.value
  const error = result.error
  switch (error.code) {
    case 'workspace-file/not-found':
      throw new SoundError(`${request.path} is no longer in the project.`, AUDIO_ERROR.missing)
    case 'workspace-file/too-large':
      throw new SoundError(`${request.path} is larger than ${fileSizeText(error.details.limit)}, more than one review reads.`, AUDIO_ERROR.tooLarge)
    default:
      throw new SoundError(`${request.path} could not be read: ${error.message}`, AUDIO_ERROR.measure)
  }
}

/**
 * Answer one measure request. The sound must be within what the Audio tab decodes, its length and the memory its
 * samples take, as the decode plan counts them from the file before it decodes; the signal ends the work at each step.
 * @param request - the sound, the window, and the bounds.
 * @param read - reads sounds of the calling Session's workspace.
 * @param signal - the call's cancellation.
 * @param limits - the longest sound and the most memory this window decodes, as for the Audio tab.
 * @returns the measurements, and the picture when the request asks for one.
 * @throws {SoundError} when the sound cannot be read, decoded, or measured, or is too long or too large; the signal's
 * reason when the call ends.
 */
export async function answerMeasure(
  request: AudioMeasureRequest,
  read: ReadSound,
  signal: AbortSignal,
  limits: Pick<DecodeBounds, 'maxSeconds' | 'maxBytes'>,
): Promise<AudioMeasureResult> {
  signal.throwIfAborted()
  const format = audioFormatOf(request.path)
  if (format === undefined) throw new SoundError(`${request.path} is not a sound the Audio panel plays.`, AUDIO_ERROR.format)
  const file = await readOrFail(read, request, signal)
  signal.throwIfAborted()
  const buffer = await decodeSound(file.data, format, { ...limits, name: request.path, signal })
  const { measurements, samples } = await measureSound(buffer, request, signal)
  if (!request.picture) return { measurements }
  return { measurements, picture: await pictureOf(samples, signal) }
}
