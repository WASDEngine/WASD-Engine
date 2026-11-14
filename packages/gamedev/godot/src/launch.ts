/**
 * Launch options of a run: the Godot command-line options a run may pass, the game's own arguments, and the window
 * size of a run that names none.
 * @module @deepseek-ai/dsh-godot/src/launch
 */
import { GodotInputError } from './input.ts'

/** How one allowed Godot option takes its value: none, an integer or number in a range, or text of a pattern. */
export type GodotOptionValue =
  | 'flag'
  | { readonly integer: readonly [number, number] }
  | { readonly number: readonly [number, number] }
  | { readonly pattern: RegExp; readonly accepts: string }

/**
 * The Godot command-line options a run passes on request, with their values. They change how the game runs and draws,
 * never where it reads or writes files or how it connects to the Host.
 */
export const GODOT_ENGINE_OPTIONS: Readonly<Record<string, GodotOptionValue>> = {
  '--fixed-fps': { integer: [1, 1000] },
  '--max-fps': { integer: [0, 1000] },
  '--time-scale': { number: [0.01, 100] },
  '--disable-vsync': 'flag',
  '--frame-delay': { integer: [0, 1000] },
  '--delta-smoothing': { pattern: /^(?:enable|disable)$/u, accepts: 'enable or disable' },
  '--debug-collisions': 'flag',
  '--debug-paths': 'flag',
  '--debug-navigation': 'flag',
  '--debug-avoidance': 'flag',
  '--print-fps': 'flag',
  '--verbose': 'flag',
  '--language': { pattern: /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/u, accepts: 'a locale such as de or pt_BR' },
}

/** Most arguments a run passes to the game. */
export const MAX_GAME_ARGS = 64

/** Longest argument a run passes to the game, in UTF-16 code units. */
const MAX_GAME_ARG_CHARS = 4096

/** The prefix of the harness's own arguments, which a game argument must not take. */
const HARNESS_ARG_PREFIX = '--wasd-'

/** Requests from the Game tab arrive over the wire, where a list may hold anything. */
function requireStrings(args: readonly unknown[], name: string): void {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new GodotInputError(`${name} must be a list of strings.`)
}

function own(option: string): GodotOptionValue | undefined {
  return Object.hasOwn(GODOT_ENGINE_OPTIONS, option) ? GODOT_ENGINE_OPTIONS[option] : undefined
}

function optionValue(option: string, kind: Exclude<GodotOptionValue, 'flag'>, value: string): string {
  if ('pattern' in kind) {
    if (!kind.pattern.test(value)) throw new GodotInputError(`engine_args: ${option} takes ${kind.accepts}, got ${JSON.stringify(value)}.`)
    return value
  }
  const [min, max] = 'integer' in kind ? kind.integer : kind.number
  const parsed = Number(value)
  const integer = 'integer' in kind
  if (value.trim() === '' || !Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    throw new GodotInputError(`engine_args: ${option} takes ${integer ? 'an integer' : 'a number'} from ${min} to ${max}, got ${JSON.stringify(value)}.`)
  }
  return String(parsed)
}

/**
 * Validate the Godot options of a run request.
 * @param args - options as the request lists them: each option, then its value as the next item or after `=`.
 * @returns the options with each value as the item after its option.
 * @throws {GodotInputError} for a list that holds anything but strings, an option outside {@link GODOT_ENGINE_OPTIONS},
 * a repeated option, or a missing or invalid value.
 */
export function parseEngineArgs(args: readonly string[]): string[] {
  requireStrings(args, 'engine_args')
  const parsed: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const option = equals > 2 ? arg.slice(0, equals) : arg
    const kind = own(option)
    if (kind === undefined) {
      throw new GodotInputError(`engine_args: ${JSON.stringify(arg)} is not an option a run passes; these are: ${Object.keys(GODOT_ENGINE_OPTIONS).join(', ')}.`)
    }
    if (seen.has(option)) throw new GodotInputError(`engine_args: ${option} appears twice.`)
    seen.add(option)
    if (kind === 'flag') {
      if (equals > 2) throw new GodotInputError(`engine_args: ${option} takes no value.`)
      parsed.push(option)
      continue
    }
    let value = equals > 2 ? arg.slice(equals + 1) : args[index + 1]
    if (equals <= 2) index += 1
    if (value === undefined) throw new GodotInputError(`engine_args: ${option} needs a value.`)
    value = optionValue(option, kind, value)
    parsed.push(option, value)
  }
  return parsed
}

/**
 * The fixed frame rate that validated Godot options set.
 * @param engineArgs - options as {@link parseEngineArgs} returns them.
 * @returns the frames per second of `--fixed-fps`, or undefined without it.
 */
export function fixedFps(engineArgs: readonly string[]): number | undefined {
  const index = engineArgs.indexOf('--fixed-fps')
  return index < 0 ? undefined : Number(engineArgs[index + 1])
}

/**
 * Validate the game arguments of a run request.
 * @param args - arguments the game reads with `OS.get_cmdline_user_args()`.
 * @returns a copy of the arguments.
 * @throws {GodotInputError} for a list that holds anything but strings, more than {@link MAX_GAME_ARGS} arguments, an
 * argument longer than 4096 characters or
 * holding a NUL character, or one that starts with `--wasd-`, the prefix of the harness's own arguments.
 */
export function parseGameArgs(args: readonly string[]): string[] {
  requireStrings(args, 'args')
  if (args.length > MAX_GAME_ARGS) throw new GodotInputError(`args: at most ${MAX_GAME_ARGS} arguments, got ${args.length}.`)
  for (const arg of args) {
    if (arg.length > MAX_GAME_ARG_CHARS) throw new GodotInputError(`args: an argument is longer than ${MAX_GAME_ARG_CHARS} characters.`)
    if (arg.includes('\0')) throw new GodotInputError('args: an argument holds a NUL character.')
    if (arg.startsWith(HARNESS_ARG_PREFIX)) throw new GodotInputError(`args: ${JSON.stringify(arg)} starts with ${HARNESS_ARG_PREFIX}, which WASD Engine's own arguments use.`)
  }
  return [...args]
}

/** The window settings of `project.godot` that size a game's window. */
export interface ProjectWindow {
  /** Window width in pixels: `window_width_override` when positive, else `viewport_width`. */
  readonly width: number
  /** Window height in pixels: `window_height_override` when positive, else `viewport_height`. */
  readonly height: number
  /** `window/stretch/mode`: `disabled`, `canvas_items`, or `viewport`. */
  readonly stretch: string
}

/** Godot's defaults for the `[display]` settings that {@link ProjectWindow} reads. */
const DISPLAY_DEFAULTS = { viewportWidth: 1152, viewportHeight: 648, stretch: 'disabled' } as const

/**
 * Read the window settings from `project.godot` text, with Godot's defaults for absent ones.
 * @param text - complete file content.
 * @returns the window size and stretch mode a run without a window size starts with.
 */
export function parseProjectWindow(text: string): ProjectWindow {
  const values = new Map<string, string>()
  let section = ''
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    const header = /^\[([^\]]+)\]$/u.exec(line)
    if (header !== null) {
      section = header[1] as string
      continue
    }
    const separator = line.indexOf('=')
    if (section === 'display' && separator >= 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const integer = (key: string, fallback: number): number => {
    const value = Number(values.get(key))
    return Number.isInteger(value) && value > 0 ? value : fallback
  }
  const viewportWidth = integer('window/size/viewport_width', DISPLAY_DEFAULTS.viewportWidth)
  const viewportHeight = integer('window/size/viewport_height', DISPLAY_DEFAULTS.viewportHeight)
  const stretch = /^"([a-z_]+)"$/u.exec(values.get('window/stretch/mode') ?? '')?.[1] ?? DISPLAY_DEFAULTS.stretch
  return {
    width: integer('window/size/window_width_override', viewportWidth),
    height: integer('window/size/window_height_override', viewportHeight),
    stretch,
  }
}

/** The window size of a run that names none, scaled up from the project's. */
export interface ScaledWindow {
  /** Window width in pixels. */
  readonly width: number
  /** Window height in pixels. */
  readonly height: number
  /** The whole factor applied to the project's window size. */
  readonly factor: number
}

/**
 * The window size of a run that names none: a project window shorter than `minHeight` whose stretch mode scales the
 * game's content to the window grows by the whole factor that brings its height nearest to `minHeight`, so pixel art
 * keeps square pixels. A project whose stretch mode is `disabled` keeps its size, because a larger window would show
 * more of its world.
 * @param window - the project's window settings.
 * @param minHeight - the height to reach; 0 keeps every project's size.
 * @returns the scaled size, or undefined when the run keeps the project's size.
 */
export function defaultWindowSize(window: ProjectWindow, minHeight: number): ScaledWindow | undefined {
  if (minHeight <= 0 || window.height >= minHeight || window.stretch === 'disabled') return undefined
  const factor = Math.round(minHeight / window.height)
  return factor > 1 ? { width: window.width * factor, height: window.height * factor, factor } : undefined
}
