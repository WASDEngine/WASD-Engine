/**
 * Error codes of the audio tools' expected failures, which tool results and the MCP server report and with which a
 * WASD Engine window answers a measure request it cannot fulfil.
 *
 * @module
 */

/** Error codes of the audio tools. */
export const AUDIO_ERROR = {
  /** The path is outside the project folder. */
  outside: 'AUDIO_OUTSIDE_PROJECT',
  /** No file at the path. */
  missing: 'AUDIO_NOT_FOUND',
  /** The file is not a listed audio format. */
  format: 'AUDIO_FORMAT',
  /** An argument out of range. */
  argument: 'AUDIO_ARGUMENT',
  /** No WASD Engine window answered. */
  window: 'AUDIO_NO_WINDOW',
  /** The window could not measure the sound or draw its picture. */
  measure: 'AUDIO_MEASURE',
  /** The file does not decode: it is damaged or uses an encoding the browser does not decode. */
  unreadable: 'AUDIO_UNREADABLE',
  /** The file is larger than the window reads. */
  tooLarge: 'AUDIO_TOO_LARGE',
} as const
