/** Launch options: the Godot options a run passes, the game's arguments, and the window size of a run that names none. */
import { describe, expect, it } from 'vitest'
import { GodotInputError } from '../src/input.ts'
import { defaultWindowSize, fixedFps, MAX_GAME_ARGS, parseEngineArgs, parseGameArgs, parseProjectWindow } from '../src/launch.ts'

describe('parseEngineArgs', () => {
  it('passes flags and options with their values, as separate items or after =', () => {
    expect(parseEngineArgs(['--fixed-fps', '60', '--disable-vsync', '--time-scale=0.5', '--language', 'pt_BR', '--max-fps', '0'])).toEqual([
      '--fixed-fps', '60', '--disable-vsync', '--time-scale', '0.5', '--language', 'pt_BR', '--max-fps', '0',
    ])
    expect(parseEngineArgs([])).toEqual([])
  })

  it('refuses options outside the list, repeated options, flags with values, and missing or invalid values', () => {
    expect(() => parseEngineArgs(['--write-movie', 'out.avi'])).toThrow(/^engine_args: "--write-movie" is not an option a run passes; these are: --fixed-fps, --max-fps, /u)
    expect(() => parseEngineArgs(['--script', 'x.gd'])).toThrow(GodotInputError)
    expect(() => parseEngineArgs(['--fixed-fps', '30', '--fixed-fps=60'])).toThrow(new GodotInputError('engine_args: --fixed-fps appears twice.'))
    expect(() => parseEngineArgs(['--disable-vsync=true'])).toThrow(new GodotInputError('engine_args: --disable-vsync takes no value.'))
    expect(() => parseEngineArgs(['--fixed-fps'])).toThrow(new GodotInputError('engine_args: --fixed-fps needs a value.'))
    expect(() => parseEngineArgs(['--fixed-fps', '29.5'])).toThrow(new GodotInputError('engine_args: --fixed-fps takes an integer from 1 to 1000, got "29.5".'))
    expect(() => parseEngineArgs(['--time-scale', '0'])).toThrow(new GodotInputError('engine_args: --time-scale takes a number from 0.01 to 100, got "0".'))
    expect(() => parseEngineArgs(['--max-fps', ''])).toThrow(GodotInputError)
    expect(() => parseEngineArgs(['--delta-smoothing', 'maybe'])).toThrow(new GodotInputError('engine_args: --delta-smoothing takes enable or disable, got "maybe".'))
    expect(() => parseEngineArgs([1 as never])).toThrow(new GodotInputError('engine_args must be a list of strings.'))
  })

  it('reads the fixed frame rate', () => {
    expect(fixedFps(parseEngineArgs(['--max-fps', '30', '--fixed-fps', '24']))).toBe(24)
    expect(fixedFps([])).toBeUndefined()
  })
})

describe('parseGameArgs', () => {
  it('copies the game\'s arguments and refuses the harness\'s prefix, NUL characters, long arguments, and too many', () => {
    expect(parseGameArgs(['--capture', 'level=3'])).toEqual(['--capture', 'level=3'])
    expect(() => parseGameArgs(['--wasd-port=1'])).toThrow(new GodotInputError('args: "--wasd-port=1" starts with --wasd-, which WASD Engine\'s own arguments use.'))
    expect(() => parseGameArgs(['a\0b'])).toThrow(new GodotInputError('args: an argument holds a NUL character.'))
    expect(() => parseGameArgs(['x'.repeat(4097)])).toThrow(new GodotInputError('args: an argument is longer than 4096 characters.'))
    expect(() => parseGameArgs(Array.from({ length: MAX_GAME_ARGS + 1 }, () => 'x'))).toThrow(new GodotInputError(`args: at most ${MAX_GAME_ARGS} arguments, got ${MAX_GAME_ARGS + 1}.`))
    expect(() => parseGameArgs('--x' as never)).toThrow(new GodotInputError('args must be a list of strings.'))
  })
})

describe('the window size of a run that names none', () => {
  it('reads the project\'s window size and stretch mode, with Godot\'s defaults', () => {
    expect(parseProjectWindow('config_version=5\n')).toEqual({ width: 1152, height: 648, stretch: 'disabled' })
    expect(parseProjectWindow([
      '[display]', '', 'window/size/viewport_width=640', 'window/size/viewport_height=360', 'window/stretch/mode="canvas_items"',
      '[rendering]', 'window/size/viewport_width=9',
    ].join('\n'))).toEqual({ width: 640, height: 360, stretch: 'canvas_items' })
    expect(parseProjectWindow('[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=180\nwindow/size/window_width_override=1280\nwindow/size/window_height_override=720\n'))
      .toEqual({ width: 1280, height: 720, stretch: 'disabled' })
    expect(parseProjectWindow('[display]\nwindow/size/viewport_width=-4\nwindow/size/viewport_height=abc\n')).toEqual({ width: 1152, height: 648, stretch: 'disabled' })
  })

  it('grows a short window that scales its content by the whole factor nearest the height, and keeps the others', () => {
    expect(defaultWindowSize({ width: 640, height: 360, stretch: 'canvas_items' }, 720)).toEqual({ width: 1280, height: 720, factor: 2 })
    expect(defaultWindowSize({ width: 320, height: 180, stretch: 'viewport' }, 720)).toEqual({ width: 1280, height: 720, factor: 4 })
    expect(defaultWindowSize({ width: 800, height: 450, stretch: 'canvas_items' }, 720)).toEqual({ width: 1600, height: 900, factor: 2 })
    expect(defaultWindowSize({ width: 1152, height: 648, stretch: 'canvas_items' }, 720)).toBeUndefined()
    expect(defaultWindowSize({ width: 640, height: 360, stretch: 'disabled' }, 720)).toBeUndefined()
    expect(defaultWindowSize({ width: 640, height: 360, stretch: 'canvas_items' }, 0)).toBeUndefined()
    expect(defaultWindowSize({ width: 1280, height: 720, stretch: 'canvas_items' }, 720)).toBeUndefined()
  })
})
