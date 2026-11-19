/**
 * The text of the Godot tools' results: log entries and their digest, the outcome of a step, an input, and a start
 * wait, and the text and image blocks of a result.
 */
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CapturedScreenshot, ImageValue, ScreenshotValue } from './tool-parts.ts'
import type { GodotLogEntry } from './types.ts'

/** Most characters of text in one tool result. */
export const TEXT_BUDGET = 6000

/** Longest log message quoted in a result. */
export const MESSAGE_CHARS = 500

/** A log entry as tools report it. */
export interface ToolLogEntry {
  readonly seq: number
  readonly source: string
  readonly level: string
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly function?: string
}

/** New-error report fields of every result. */
export interface Digest {
  newErrors?: ToolLogEntry[]
  moreNewErrors?: number
}

/**
 * Text cut to a length.
 * @param text - the text.
 * @param limit - most characters.
 * @returns the text, or its start and an ellipsis.
 */
export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Report a log entry compactly.
 * @param entry - stored entry.
 * @returns the entry without run id, time, and backtrace, with its message shortened.
 */
export function toolLogEntry(entry: GodotLogEntry): ToolLogEntry {
  return {
    seq: entry.seq,
    source: entry.source,
    level: entry.level,
    message: clip(entry.message, MESSAGE_CHARS),
    ...entry.file === undefined ? {} : { file: entry.file },
    ...entry.line === undefined ? {} : { line: entry.line },
    ...entry.function === undefined ? {} : { function: entry.function },
  }
}

/**
 * Format a log entry as one line.
 * @param entry - reported entry.
 * @returns `[level] file:line (function): message`, naming the source when it is not the game.
 */
export function formatLogEntry(entry: ToolLogEntry): string {
  const source = entry.source === 'game' ? '' : `, ${entry.source}`
  const line = entry.line === undefined ? '' : `:${entry.line}`
  const fn = entry.function === undefined ? '' : ` (${entry.function})`
  const location = entry.file === undefined ? '' : `${entry.file}${line}${fn}: `
  return `[${entry.level}${source}] ${location}${entry.message}`
}

/**
 * Format the new-error report of a result.
 * @param digest - report fields.
 * @returns the report, or an empty string when nothing new was logged.
 */
export function formatDigest(digest: Digest): string {
  if (digest.newErrors === undefined) return ''
  const more = digest.moreNewErrors === undefined ? '' : `\n… and ${digest.moreNewErrors} more; read them with godot_logs.`
  return `New errors since your last Godot call:\n${digest.newErrors.map(formatLogEntry).join('\n')}${more}`
}

/** Join text sections and keep them within the budget. */
function finishText(...sections: string[]): string {
  const text = sections.filter(section => section !== '').join('\n\n')
  return text.length > TEXT_BUDGET ? `${text.slice(0, TEXT_BUDGET - 30)}\n… (output shortened)` : text
}

/**
 * A result of text alone.
 * @param sections - the result's sections; empty ones are left out.
 * @returns the text block: the sections joined by blank lines, shortened past `TEXT_BUDGET` characters.
 */
export function textResult(...sections: string[]): ContentBlock[] {
  return [{ type: 'text', text: finishText(...sections) }]
}

/**
 * The image block of a screenshot in a result value.
 * @param shot - the screenshot.
 * @returns the block that shows its image.
 */
export function screenshotBlocks(shot: ScreenshotValue): ContentBlock[] {
  return imageBlocks(shot.image)
}

/**
 * The image block of a stored image.
 * @param image - the image the attachment store keeps.
 * @returns the block that shows it to the model.
 */
export function imageBlocks(image: ImageValue): ContentBlock[] {
  // The value holds the reference that the attachment store returned, so its id is a stored attachment id.
  return [{ type: 'image', attachment: { ...image, attachmentId: brandString<AttachmentId>(image.attachmentId) } }]
}

/**
 * Read a point a call gives as [x, y, z].
 * @param value - the call's list.
 * @param name - the parameter, for the error.
 * @returns the point.
 * @throws when the list is not three finite numbers.
 */
export function point(value: readonly number[], name: string): readonly [number, number, number] {
  if (value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${name} must be [x, y, z], three numbers.`)
  return [value[0] as number, value[1] as number, value[2] as number]
}

/**
 * A number as a result writes it.
 * @param value - the number.
 * @returns a whole number as it is, and another with two decimals.
 */
export function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * A file size as a result writes it.
 * @param bytes - the size.
 * @returns whole kilobytes, at least 1, below a megabyte, and megabytes with one decimal from there.
 */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The line of a result that describes a screenshot: its size and the part of the game window it shows.
 * @param shot - the screenshot.
 * @returns the line.
 */
export function describeScreenshot(shot: CapturedScreenshot): string {
  const paused = shot.paused ? ' (paused)' : ''
  if (shot.x !== undefined && shot.y !== undefined && shot.regionWidth !== undefined && shot.regionHeight !== undefined) {
    return `Screenshot at frame ${shot.frame}${paused}: ${shot.width}x${shot.height} px showing the ${shot.regionWidth}x${shot.regionHeight} px region at (${shot.x}, ${shot.y}) of a ${shot.windowWidth}x${shot.windowHeight} px game window. Mouse coordinates for godot_input are pixels of this image, which map into that region.`
  }
  const smaller = shot.width < shot.windowWidth ? ' To see detail at the window\'s own pixels, pass region.' : ''
  return `Screenshot at frame ${shot.frame}${paused}: ${shot.width}x${shot.height} px of a ${shot.windowWidth}x${shot.windowHeight} px game window. Mouse coordinates for godot_input are pixels of this image.${smaller}`
}

/** The screenshot fields of a result that may end with a screenshot. */
export interface ScreenshotOutcome {
  readonly screenshot?: ScreenshotValue
  readonly screenshotError?: string
}

/**
 * What a step of game time did.
 * @param step - the frames it ran and how it ended.
 * @returns the sentence.
 */
export function describeStep(step: { readonly frames?: number; readonly endedEarly?: boolean; readonly timedOut?: boolean }): string {
  if (step.frames === undefined) return ''
  if (step.endedEarly === true) return `Ran ${step.frames} frames before a pause, a resume, or a newer step ended the step. `
  if (step.timedOut === true) return `Ran ${step.frames} frames before the step reached its real-time limit. `
  return `Ran ${step.frames} frames. `
}

/** The completion facts of an input sequence, as `godot_input` returns them. */
interface InputOutcome {
  readonly events: number
  readonly frames: number
  readonly seconds: number
  readonly frame: number
  readonly timedOut: boolean
}

/**
 * What the input of a call did.
 * @param input - the events sent and how the game took them.
 * @returns the sentence.
 */
export function describeInput(input: InputOutcome): string {
  const span = `over ${input.frames} frames (${input.seconds.toFixed(2)} s)`
  return input.timedOut
    ? `The input ended at its real-time limit after ${input.events} of its events, ${span}; the keys and buttons it held were released, and the game is at frame ${input.frame}.`
    : `Sent ${input.events} events ${span}; the game is at frame ${input.frame}.`
}

/** The game time a `godot_run` call let pass after the start; paused when the game was paused, so none passed. */
export interface StartWait {
  readonly frames: number
  readonly seconds: number
  readonly timedOut: boolean
  readonly paused: boolean
}

/**
 * The sentence of a `godot_run` result about the game time it let pass after the start.
 * @param waited - the wait, or undefined when the call asked for none.
 * @returns the sentence, or nothing without a wait.
 */
export function describeStartWait(waited: StartWait | undefined): string {
  if (waited === undefined) return ''
  if (waited.paused) return 'The game is paused, so no game time passed for wait; resume it with godot_control.'
  if (waited.timedOut) return `The wait ended at its real-time limit after ${waited.seconds.toFixed(2)} s of game time (${waited.frames} frames).`
  return `Waited ${waited.frames} frames (${waited.seconds.toFixed(2)} s of game time).`
}

/**
 * The text of a call that acted and then showed the game.
 * @param outcome - what the call did and the screenshot it took.
 * @param action - what the call did, as the result names it.
 * @returns the result's text.
 */
export function describeOutcome(outcome: ScreenshotOutcome, action: string): string {
  if (outcome.screenshot !== undefined) return describeScreenshot(outcome.screenshot)
  return outcome.screenshotError === undefined ? '' : `The screenshot after ${action} failed: ${outcome.screenshotError}`
}
