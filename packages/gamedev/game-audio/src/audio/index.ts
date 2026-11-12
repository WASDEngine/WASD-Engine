/**
 * The browser-safe part of the audio tools, which WASD Engine's Audio tab inlines and the Host tools import: the
 * listed formats and the kinds of game sound, what a file's headers say, the AIFF decoder, the measurements of decoded
 * samples, and their picture. Nothing here reads files itself or uses Node or browser APIs.
 * @module @deepseek-ai/dsh-game-audio/audio
 */
export { AiffDecodeError, decodeAiff, openAiff, type AiffSound } from './aiff.ts'
export { AUDIO_ERROR } from './errors.ts'
export {
  AUDIO_CATEGORIES, AUDIO_EXTENSIONS, audioCategoryOf, audioFormatOf, MUSIC_MIN_SECONDS, pathWords,
  type AudioCategory, type AudioCategoryResult, type AudioCategorySource, type AudioDecoder, type AudioFormat,
} from './formats.ts'
export {
  analyzeAudio, fft, integratedLoudness, LATE_START_SECONDS, loopSeam, magnitudeSpectrum, seamClicks, SILENCE_THRESHOLD, stereoImage,
  type AudioAnalysis, type AudioSamples, type ChannelLevels, type LoopSeam, type StereoImage,
} from './measure.ts'
export { describeAudioImage, drawAudioImage, IMAGE_WIDTH, type AudioImageLayout, type RgbImage } from './picture.ts'
export { PROBE_HEAD_BYTES, PROBE_TAIL_BYTES, probeAudio, readAiffFormat, readExtended, type AiffFormat, type AudioProbe, type ByteReader } from './probe.ts'
