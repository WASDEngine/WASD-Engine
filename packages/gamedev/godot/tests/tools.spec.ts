/** The godot_* tools run, observe, and drive the Session's game through the real tool pipeline. */
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCREENSHOTS_GITIGNORE } from '../src/captures.ts'
import { GodotRun } from '../src/run.ts'
import { DIGEST_ENTRIES, formatDigest, formatLogEntry, formatTree, STARTUP_ENTRIES, TEXT_BUDGET, toolLogEntry } from '../src/tools.ts'
import type { GodotVideoEncodeEvent, GodotVideoEncodeResult } from '../src/types.ts'
import { callTool, compose, text, type Composition, type CompositionOptions } from './composition.ts'
import { configureFake, fakeLog, fakeRequests, scratch, until } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
/** Deadline of a spec that starts several fake Godot processes, which a loaded machine starts slowly. */
const PROCESSES_TIMEOUT = 30_000

let composition: Composition | undefined
afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function setup(options: CompositionOptions = {}): Promise<Composition> {
  composition = await compose(options)
  return composition
}

async function started(options: CompositionOptions = {}): Promise<Composition> {
  const value = await setup(options)
  const result = await callTool(value, 'godot_run')
  expect(result.isError, text(result)).toBe(false)
  return value
}

function value(result: Awaited<ReturnType<typeof callTool>>): Record<string, JsonValue> {
  if (result.isError) throw new Error(`unexpected tool failure: ${text(result)}`)
  return result.value as Record<string, JsonValue>
}

posix('godot_run and godot_stop', () => {
  it('starts the game and reports import and startup problems', async () => {
    const c = await setup({
      game: {
        import: { stderr: 'WARNING: texture import is slow\n' },
        game: { logs: [{ level: 'script_error', message: 'boom', file: 'res://p.gd', line: 3, function: '_ready', time_ms: 1 }, { level: 'stdout', message: 'ready', time_ms: 1 }] },
      },
      config: { importBeforeRun: true },
    })
    const result = await callTool(c, 'godot_run', { muted: false })
    expect(text(result)).toBe([
      `The game is running: Fake game (${c.project}); scene res://main.tscn, window 640x360, renderer fake / forward_plus, Godot 4.7.2-stable (fake).`,
      '',
      'Errors and warnings logged while importing and starting:',
      '[warning, import] texture import is slow',
      '[script_error] res://p.gd:3 (_ready): boom',
    ].join('\n'))
    expect(value(result)).toMatchObject({ phase: 'running', muted: false, windowless: false, moreIssues: 0 })
    await configureFake(c.project, { game: {} })
    const again = await callTool(c, 'godot_run', { width: 320, height: 200, scene: 'res://main.tscn' })
    expect(text(again)).toContain('muted.')
    expect(text(again)).toContain('No errors or warnings were logged while importing and starting.')
    const stopped = await callTool(c, 'godot_stop')
    expect(text(stopped)).toBe('Stopped the game.')
    expect(text(await callTool(c, 'godot_stop'))).toBe('No game was running.')
    expect((await fakeLog(c.project)).some(entry => (entry.argv as string[] | undefined)?.includes('--resolution'))).toBe(true)
  })

  it('starts the game, lets game time pass, and shows a screenshot in the same call', async () => {
    const c = await setup()
    const result = await callTool(c, 'godot_run', { wait: 0.05, screenshot: true })
    expect(value(result)).toMatchObject({
      phase: 'running', waited: { seconds: 0.05, timedOut: false, paused: false }, screenshot: { width: 320, height: 180 },
    })
    expect(text(result)).toMatch(new RegExp('^The game is running: [^\n]+\n\nNo errors or warnings were logged while importing and starting\\.\n\n'
      + 'Waited \\d+ frames \\(0\\.05 s of game time\\)\\.\n\nScreenshot at frame', 'u'))
    expect(result.content.at(-1)).toMatchObject({ type: 'image' })
    const requests = (await fakeRequests(c.project)).map(request => request.type).filter(type => type === 'wait' || type === 'screenshot')
    expect(requests).toEqual(['wait', 'screenshot'])
    // Without wait the screenshot follows the start at once; without screenshot the result holds no image.
    expect(value(await callTool(c, 'godot_run', { screenshot: true }))).not.toHaveProperty('waited')
    const plain = await callTool(c, 'godot_run')
    expect(value(plain)).not.toHaveProperty('screenshot')
    expect(plain.content.some(block => block.type === 'image')).toBe(false)
  })

  it('says when the wait after the start ended at its real-time limit', async () => {
    const c = await setup({ game: { game: { replies: { wait: 'timedOut' } } } })
    const result = await callTool(c, 'godot_run', { wait: 1 })
    expect(value(result)).toMatchObject({ waited: { timedOut: true, paused: false } })
    expect(text(result)).toMatch(/\n\nThe wait ended at its real-time limit after \d+\.\d\d s of game time \(\d+ frames\)\.$/u)
  })

  it('refuses a screenshot the model cannot see before it starts the game', async () => {
    const c = await setup({ model: 'blind' })
    expect(text(await callTool(c, 'godot_run', { screenshot: true }))).toContain('does not accept images')
    expect(text(await callTool(c, 'godot_stop'))).toBe('No game was running.')
  })

  it('lists at most the first startup problems and counts the rest', async () => {
    const logs = Array.from({ length: STARTUP_ENTRIES + 3 }, (_, index) => ({ level: 'warning', message: `w${index}`, time_ms: 1 }))
    const c = await setup({ game: { game: { logs } } })
    const result = await callTool(c, 'godot_run')
    expect(value(result)).toMatchObject({ moreIssues: 3 })
    expect(text(result)).toContain('… and 3 more; read them with godot_logs.')
  })

  it.each([
    [{ width: 100 }, 'Give width and height together.'],
    [{ height: 100 }, 'Give width and height together.'],
    [{ width: 0, height: 10 }, 'width and height must be integers from 1 to 16384.'],
    [{ width: 10, height: 20_000 }, 'width and height must be integers from 1 to 16384.'],
    [{ scene: 'res://missing.tscn' }, 'does not exist'],
    [{ project: 'nowhere' }, 'No project.godot'],
    [{ wait: 0 }, 'wait must be positive.'],
  ])('refuses %j', async (args, message) => {
    const c = await setup()
    const result = await callTool(c, 'godot_run', args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
  })

  it('fails with the process output when the game does not keep running', async () => {
    const c = await setup({ game: { game: { stderr: 'ERROR: cannot start\n', exitBeforeConnect: 2 } } })
    const result = await callTool(c, 'godot_run')
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: The game did not keep running (failed).\nThe game exited before it connected (exit code 2).\nLast output:\nERROR: cannot start\nErrors and warnings:\n[error, process] cannot start')
    await configureFake(c.project, { game: { exitBeforeConnect: 0 } })
    expect(text(await callTool(c, 'godot_run'))).toBe('Error: The game did not keep running (failed).\nThe game exited before it connected (exit code 0).')
  })

  it('refuses calls without a Session', async () => {
    const c = await setup()
    const result = await executeToolFixture(c.ctx, { signal: new AbortController().signal, callId: ToolCallId('agentless'), name: 'godot_stop', arguments: {} })
    expect(text(result)).toContain('Godot tools run only inside a Session.')
  })

  it('explains how to get a runtime when none is installed, even with a Godot editor on PATH', async () => {
    const c = await setup({ config: { runnerPath: '', libgodotPath: '' } })
    const path = process.env.PATH
    // A `godot` command on PATH is an installed editor, which would run the game in a window.
    process.env.PATH = `${c.dir.root}:${path ?? ''}`
    await writeFile(join(c.dir.root, 'godot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    try {
      const result = await callTool(c, 'godot_run')
      expect(text(result)).toContain('No Godot runtime is installed.')
      await writeFile(join(c.project, 'a.gd'), 'extends Node\n')
      expect(text(await callTool(c, 'godot_check'))).toContain('No Godot runtime is installed.')
    } finally {
      process.env.PATH = path
    }
  })
})

posix('observing the game', () => {
  it('captures screenshots at the model\'s image size and stores them', async () => {
    const c = await started()
    const result = await callTool(c, 'godot_screenshot', { max_width: 320 })
    expect(value(result)).toMatchObject({ width: 320, height: 180, windowWidth: 640, windowHeight: 360, paused: false, image: { attachmentId: 'a1', mediaType: 'image/png', name: expect.stringMatching(/^godot-frame-\d+\.png$/u) as string, originalDimensions: { width: 1280, height: 720 } } })
    expect(text(result)).toMatch(/^Screenshot at frame \d+: 320x180 px of a 640x360 px game window\. /u)
    expect(text(result)).toContain('Mouse coordinates for godot_input are pixels of this image.')
    expect(result.content.at(-1)).toMatchObject({ type: 'image', attachment: { attachmentId: 'a1', width: 640, height: 360 } })
    expect(Buffer.from(c.saved[0]?.data as Uint8Array).toString('latin1')).toBe('PNG-BYTES')
    expect((await fakeRequests(c.project)).find(request => request.type === 'screenshot')).toMatchObject({ format: 'png', maxWidth: 320 })
    expect(text(await callTool(c, 'godot_screenshot', { max_width: 10 }))).toContain('max_width must be from 64 to 4096.')
  })

  it('saves a screenshot and a view as .png files at the path a call gives, for tools that take an image file', async () => {
    const c = await started()
    const saved = join(c.dir.root, 'work', 'shots', 'frame.png')
    const shot = await callTool(c, 'godot_screenshot', { path: 'shots/frame.png' })
    expect(text(shot)).toContain(`Saved the image to ${saved}.`)
    expect(value(shot)).toMatchObject({ savedPath: saved, image: { mediaType: 'image/png' } })
    expect((await readFile(saved)).toString('latin1')).toBe('PNG-BYTES')
    expect(text(await callTool(c, 'godot_screenshot', { path: 'shots/frame.png' }))).toContain('already exists; pass replace: true to overwrite it')
    expect(text(await callTool(c, 'godot_screenshot', { path: 'shots/frame.png', replace: true }))).toContain(`Saved the image to ${saved}.`)
    expect(text(await callTool(c, 'godot_screenshot', { path: 'shots/frame.jpg' }))).toContain('path must end in .png.')
    expect(text(await callTool(c, 'godot_screenshot', { path: 'shots' }))).toContain('path must end in .png.')

    const viewed = join(c.dir.root, 'work', 'shots', 'view.png')
    const view = await callTool(c, 'godot_view', { width: 320, height: 180, path: 'shots/view.png' })
    expect(text(view)).toContain(`Saved the image to ${viewed}.`)
    expect(value(view)).toMatchObject({ width: 320, height: 180, savedPath: viewed })
    expect((await readFile(viewed)).toString('latin1')).toBe('VIEW-PNG-BYTES')
    expect(text(await callTool(c, 'godot_view', { path: 'shots/view.png' }))).toContain('already exists; pass replace: true to overwrite it')
  })

  it('saves at a res:// path in the running game\'s project, and refuses one that leads out of it', async () => {
    const c = await started()
    const shot = await callTool(c, 'godot_screenshot', { path: 'res://shots/frame.png' })
    expect(value(shot)).toMatchObject({ savedPath: join(c.project, 'shots', 'frame.png') })
    expect((await readFile(join(c.project, 'shots', 'frame.png'))).toString('latin1')).toBe('PNG-BYTES')
    const view = await callTool(c, 'godot_view', { width: 320, height: 180, path: 'res://shots/view.png' })
    expect(value(view)).toMatchObject({ savedPath: join(c.project, 'shots', 'view.png') })
    const unsaved = await callTool(c, 'godot_view', { width: 320, height: 180 })
    expect(value(unsaved)).not.toHaveProperty('savedPath')
    expect(text(unsaved)).not.toContain('Saved the image')
    expect(unsaved.content.at(-1)).toMatchObject({ type: 'image' })
    const audio = await callTool(c, 'godot_audio', { seconds: 0.25, path: 'res://captures/mix.wav' })
    expect(value(audio)).toMatchObject({ savedPath: join(c.project, 'captures', 'mix.wav') })
    expect(existsSync(join(c.dir.root, 'work', 'res:'))).toBe(false)
    for (const [tool, path] of [['godot_screenshot', 'res://../frame.png'], ['godot_view', 'res://../view.png'], ['godot_audio', 'res://../mix.wav']] as const) {
      expect(text(await callTool(c, tool, { path }))).toContain(`path ${JSON.stringify(path)} leads out of the project; a res:// path names a file inside it.`)
    }
  })

  it('saves a screenshot and a view as new files in WASD Engine\'s screenshots folder of the project, which Godot does not import', async () => {
    const c = await setup()
    const imports = async (): Promise<number> => (await fakeLog(c.project)).filter(entry => (entry.argv as string[] | undefined)?.includes('--import')).length
    // An import keeps its start to the millisecond, so a script written in that millisecond reads as changed after it;
    // the game's start keeps the script older.
    await writeFile(join(c.project, 'player.gd'), 'extends Node\n')
    // A screenshots folder of the game's own stays as it is.
    await mkdir(join(c.project, 'screenshots'))
    await writeFile(join(c.project, 'screenshots', 'title.png'), 'GAME-ART')
    expect((await callTool(c, 'godot_run')).isError).toBe(false)
    await callTool(c, 'godot_check')
    expect(await imports()).toBe(1)
    const folder = join(c.project, '.wasdengine', 'screenshots')
    const shot = await callTool(c, 'godot_screenshot', { save: true })
    const results = [shot, await callTool(c, 'godot_screenshot', { save: true }), await callTool(c, 'godot_view', { width: 320, height: 180, save: true })]
    const paths = results.map(result => value(result).savedPath as string)
    for (const path of paths) expect(path).toMatch(new RegExp(`^${folder.replaceAll('/', '\\/')}\\/Fake-game_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}(_\\d+)?\\.png$`, 'u'))
    expect(new Set(paths).size).toBe(3)
    expect(text(shot)).toContain(`Saved the image to ${paths[0]}.`)
    expect(shot.content.at(-1)).toMatchObject({ type: 'image' })
    expect((await readFile(paths[0] as string)).toString('latin1')).toBe('PNG-BYTES')
    expect((await readFile(paths[2] as string)).toString('latin1')).toBe('VIEW-PNG-BYTES')
    expect(existsSync(join(folder, '.gdignore'))).toBe(true)
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(SCREENSHOTS_GITIGNORE)
    expect((await readdir(join(c.project, '.wasdengine'))).sort()).toEqual(['screenshots'])
    expect((await readdir(join(c.project, 'screenshots'))).sort()).toEqual(['title.png'])
    // Godot skips the folder, so the next check finds nothing new to import; an image saved elsewhere is new to it.
    await callTool(c, 'godot_check')
    expect(await imports()).toBe(1)
    await callTool(c, 'godot_screenshot', { path: 'res://art/frame.png' })
    await callTool(c, 'godot_check')
    expect(await imports()).toBe(2)
    await rm(folder, { recursive: true })
    await mkdir(folder)
    await writeFile(join(folder, '.gitignore'), '*\n')
    await callTool(c, 'godot_screenshot', { save: true })
    // Marker files that the folder holds stay as they are.
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe('*\n')
    expect(existsSync(join(folder, '.gdignore'))).toBe(true)
    for (const tool of ['godot_screenshot', 'godot_view']) {
      expect(text(await callTool(c, tool, { save: true, path: 'frame.png' }))).toBe('Error: Give path or save, not both.')
    }
  }, PROCESSES_TIMEOUT)

  it('refuses to save in a .wasdengine or screenshots entry of the project that is not a folder', async () => {
    const c = await started()
    const state = join(c.project, '.wasdengine')
    const refusal = (path: string): string => `${path} is not a folder, so save cannot keep the image in ${join(state, 'screenshots')}; `
      + `move ${path} away, or pass path instead.`
    await writeFile(state, 'not a folder')
    expect(text(await callTool(c, 'godot_screenshot', { save: true }))).toBe(`Error: ${refusal(state)}`)
    await rm(state)
    await symlink(join(c.dir.root, 'nowhere'), state)
    expect(text(await callTool(c, 'godot_view', { save: true }))).toBe(`Error: ${refusal(state)}`)
    await rm(state)
    await mkdir(state)
    await writeFile(join(state, 'screenshots'), 'not a folder')
    expect(text(await callTool(c, 'godot_screenshot', { save: true }))).toBe(`Error: ${refusal(join(state, 'screenshots'))}`)
    expect(await readFile(join(state, 'screenshots'), 'utf8')).toBe('not a folder')
    expect((await readdir(state)).sort()).toEqual(['screenshots'])
  })

  it('saves to a path for one call at a time, so the second of two calls at once finds the first one\'s file', async () => {
    const c = await started({ game: { game: { replies: { screenshot: 'slow:200', view: 'slow:200', audio: 'slow:200' } } } })
    const saves = [
      ['godot_screenshot', { path: 'shots/same.png' }, 'PNG-BYTES'],
      ['godot_view', { path: 'shots/same-view.png' }, 'VIEW-PNG-BYTES'],
      ['godot_audio', { seconds: 0.25, path: 'shots/same.wav' }, 'RIFF'],
    ] as const
    for (const [tool, args, bytes] of saves) {
      const results = await Promise.all([callTool(c, tool, args), callTool(c, tool, args)])
      const path = join(c.dir.root, 'work', args.path)
      expect(results.map(result => result.isError)).toContain(false)
      expect(results.filter(result => result.isError).map(text)).toEqual([`Error: ${path} already exists; pass replace: true to overwrite it, or choose another path.`])
      expect((await readFile(path)).toString('latin1').slice(0, bytes.length)).toBe(bytes)
    }
  })

  it('gives up the file it held for a capture that failed', async () => {
    const c = await started({ game: { game: { replies: { screenshot: 'error', view: 'error' } } } })
    expect(text(await callTool(c, 'godot_screenshot', { path: 'shots/frame.png' }))).toContain('fake screenshot failure')
    expect(text(await callTool(c, 'godot_view', { path: 'shots/deeper/view.png' }))).toContain('fake view failure')
    expect(existsSync(join(c.dir.root, 'work', 'shots'))).toBe(false)
    expect(text(await callTool(c, 'godot_screenshot', { save: true }))).toContain('fake screenshot failure')
    expect((await readdir(join(c.project, '.wasdengine', 'screenshots'))).sort()).toEqual(['.gdignore', '.gitignore'])
    await configureFake(c.project, { game: {} })
    await callTool(c, 'godot_run')
    expect(text(await callTool(c, 'godot_screenshot', { path: 'shots/frame.png' }))).toContain('Saved the image to')
  })

  it.skipIf(process.getuid?.() === 0)('reports the capture\'s own failure when the file it held cannot be removed', async () => {
    const c = await started({ game: { game: { replies: { screenshot: 'failAfter:1000' } } } })
    const locked = join(c.dir.root, 'work', 'locked')
    await mkdir(locked)
    const call = callTool(c, 'godot_screenshot', { path: 'locked/frame.png' })
    try {
      await until(() => existsSync(join(locked, 'frame.png')))
      // A folder that cannot change keeps the empty file that the call held.
      await chmod(locked, 0o555)
      expect(text(await call)).toBe('Error: fake screenshot failure')
      expect(await readFile(join(locked, 'frame.png'), 'utf8')).toBe('')
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it.each([
    ['vision', 12, true],
    ['blind', 0, false],
  ] as const)('records the game for a %s model, with a sheet of frames only when the model sees images', async (model, sheetFrames, sheet) => {
    const c = await started({ model })
    const start = vi.spyOn(GodotRun.prototype, 'startRecording').mockImplementation(async (recording, _params, sink) => {
      sink.frame({ recording, index: 0, timeMs: 0, width: 64, height: 36, image: Buffer.from('JPEG-BYTES') })
    })
    const stop = vi.spyOn(GodotRun.prototype, 'stopRecording').mockImplementation(async recording => ({ recording, frames: 1, skipped: 0, seconds: 0.5, width: 64, height: 36 }))
    const route = (path: string): ConnectionFetchRoute => [...c.routes].find(candidate => candidate.path === path) as ConnectionFetchRoute
    const asked: number[] = []
    // The WASD Engine window: it reads the frames, uploads the video, and answers with a sheet when asked for one.
    const window = c.ctx.on('godot/record', async (request: GodotVideoEncodeEvent): Promise<GodotVideoEncodeResult> => {
      asked.push(request.sheetFrames)
      const url = `http://127.0.0.1/api/godot.recording?session=${request.sessionId}&run=${request.runId}&recording=${request.recording}`
      await (await route('/api/godot.recording').fetch(new Request(url))).arrayBuffer()
      await route('/api/godot.video').fetch(new Request(url.replace('godot.recording', 'godot.video'), { method: 'POST', body: new TextEncoder().encode('video') }))
      return { codec: 'H.264', frames: 1, seconds: 0.5, width: 64, height: 36, bytes: 5, ...request.sheetFrames === 0 ? {} : { sheet: { data: 'AAAA', width: 2, height: 2, times: [0] } } }
    })
    try {
      const result = await callTool(c, 'godot_record', { seconds: 0.5 })
      expect(text(result)).toMatch(/^Recorded 0\.50 s at 30 fps, at real time: 1 frames of 64x36 px in H\.264, saved to .+\.mp4 \(1 KB\)/u)
      expect(asked).toEqual([sheetFrames])
      expect(result.content.some(block => block.type === 'image')).toBe(sheet)
      expect(text(result).includes('You receive no images in this Session, so this result leaves the sheet of frames out; the saved video holds them.')).toBe(!sheet)
      expect(await readFile(value(result).path as string, 'utf8')).toBe('video')
    } finally {
      window()
      start.mockRestore()
      stop.mockRestore()
    }
  })

  it.each([
    [{ model: 'blind' } as const, 'does not accept images'],
    [{ model: 'unknown' } as const, 'does not accept images'],
    [{ model: 'none' } as const, 'Screenshots need an attachment store and a resolved model route'],
    [{ attachments: false }, 'Screenshots need an attachment store and a resolved model route'],
  ])('refuses screenshots the model cannot see: %j', async (options, message) => {
    const c = await started(options)
    expect(text(await callTool(c, 'godot_screenshot'))).toContain(message)
    expect(text(await callTool(c, 'godot_view'))).toContain(message)
  })

  it.each([
    [{ model: 'blind' } as const],
    [{ model: 'none' } as const],
    [{ attachments: false }],
  ])('saves the capture of a call that saves it, and leaves out the image the model cannot see: %j', async (options) => {
    const c = await started(options)
    const shot = await callTool(c, 'godot_screenshot', { save: true })
    const saved = value(shot).savedPath as string
    expect(value(shot)).toMatchObject({ width: 640, height: 360, windowWidth: 640, windowHeight: 360, paused: false })
    expect(value(shot)).not.toHaveProperty('image')
    expect(shot.content.some(block => block.type === 'image')).toBe(false)
    expect(text(shot)).toMatch(/^Screenshot at frame \d+: 640x360 px of a 640x360 px game window\. /u)
    expect(text(shot)).toContain(`Saved the image to ${saved}.\n\nYou receive no images in this Session, so this result leaves the image out; the saved file holds it.`)
    expect((await readFile(saved)).toString('latin1')).toBe('PNG-BYTES')
    // Mouse coordinates in screenshot pixels refer to the saved image.
    expect(text(await callTool(c, 'godot_input', { events: [{ kind: 'mouse_button', button: 'left', pressed: true, x: 100, y: 50 }] }))).toContain('Sent 1 events')
    const view = await callTool(c, 'godot_view', { width: 320, height: 180, path: 'view.png' })
    expect(value(view)).toMatchObject({ width: 320, height: 180, savedPath: join(c.dir.root, 'work', 'view.png') })
    expect(value(view)).not.toHaveProperty('image')
    expect(view.content.some(block => block.type === 'image')).toBe(false)
    expect(text(view)).toContain('You receive no images in this Session, so this result leaves the image out; the saved file holds it.')
    expect((await readFile(join(c.dir.root, 'work', 'view.png'))).toString('latin1')).toBe('VIEW-PNG-BYTES')
    expect(c.saved).toEqual([])
    expect((await fakeRequests(c.project)).filter(request => request.type === 'input').map(request => request.events)).toEqual([
      [{ kind: 'mouse_button', button: 'left', pressed: true, x: 100, y: 50 }],
    ])
  })

  it('evaluates expressions and describes the scene tree', async () => {
    const tree = {
      name: 'Main', class: 'Node2D', path: '/root/Main', position: [0, 0], visible: true,
      children: [
        { name: 'Label', class: 'Label', path: '/root/Main/Label', position: [1.234, 2], size: [10, 20], text: 'Hi', visible: false },
        { name: 'Player', class: 'ColorRect', script: 'res://player.gd', processDisabled: true, childCount: 3 },
      ],
    }
    const c = await started({ game: { game: { tree, treeTruncated: true, evalValue: { x: 1 } } } })
    const evaluated = await callTool(c, 'godot_eval', { expression: 'scene.position', node: '/root/Main' })
    expect(text(evaluated)).toBe('String: {"x":1}')
    const seen = await callTool(c, 'godot_eval', { expression: 'scene.position', screenshot: true })
    expect(value(seen)).toMatchObject({ value: { x: 1 }, screenshot: { width: 320, height: 180 } })
    expect(text(seen)).toMatch(/^String: \{"x":1\}\n\nScreenshot at frame/u)
    expect(seen.content.at(-1)).toMatchObject({ type: 'image' })
    expect((await fakeRequests(c.project)).map(request => request.type).slice(-2)).toEqual(['eval', 'screenshot'])
    expect(text(await callTool(c, 'godot_eval', { expression: '  ' }))).toContain('expression must not be empty.')
    const described = await callTool(c, 'godot_scene_tree', { depth: 2, max_nodes: 10 })
    expect(text(described)).toBe([
      'Main (Node2D) position (0, 0)',
      '  Label (Label) position (1.23, 2) size (10, 20) hidden text "Hi"',
      '  Player (ColorRect) res://player.gd processing disabled 3 children not listed',
      '',
      'The node limit cut the tree; narrow it with node or depth.',
    ].join('\n'))
    expect(text(await callTool(c, 'godot_scene_tree', { depth: 65 }))).toContain('depth must be from 0 to 64.')
    expect(formatTree('not a node')).toBe('')
    expect(formatTree({ name: 'A', class: 'B', position: ['x'], children: [] })).toBe('A (B)')
    expect(formatTree({ class: 7 })).toBe('? (7)')
  })

  it('measures performance for the requested real seconds, within their bounds', async () => {
    const c = await started()
    const measured = await callTool(c, 'godot_performance', { seconds: 0.5 })
    expect(text(measured).split('\n')[0]).toBe('Measured 0.50 s of real time: 0 frames at 0.0 FPS; the forward_plus renderer on fake draws a 640x360 window.')
    expect(value(measured)).toMatchObject({ seconds: 0.5, frames: 0, windowless: false, sceneTree: { nodes: 1, classes: [{ name: 'Window', nodes: 1 }] } })
    // The game's own limit is the sample's seconds, twice with the script window, plus requestTimeoutMs.
    expect((await fakeRequests(c.project)).find(request => request.type === 'performance')).toMatchObject({ seconds: 0.5, scriptSeconds: 0.5, timeoutMs: 6000 })
    // Engine methods are timed only when the call asks for them.
    expect((await fakeRequests(c.project)).find(request => request.type === 'performance')).not.toHaveProperty('engineCalls')
    expect(text(measured)).toContain('Scripts: this Godot runtime has no script profiler;')
    const framesOnly = await callTool(c, 'godot_performance', { seconds: 0.5, scripts: false })
    expect(text(framesOnly)).not.toContain('Scripts:')
    expect((await fakeRequests(c.project)).filter(request => request.type === 'performance').at(-1)).toMatchObject({ scriptSeconds: 0, timeoutMs: 5500 })
    await callTool(c, 'godot_performance', { seconds: 0.5, engine_calls: true })
    expect((await fakeRequests(c.project)).filter(request => request.type === 'performance').at(-1)).toMatchObject({ scriptSeconds: 0.5, engineCalls: true })
    expect(text(await callTool(c, 'godot_performance', { seconds: 0.5, scripts: false, engine_calls: true })))
      .toContain('engine_calls times the engine methods of the profiled scripts, so it needs scripts.')
    expect(text(await callTool(c, 'godot_performance', { seconds: 30 }))).toContain('seconds must be from 0.25 to 20.')
    expect(text(await callTool(c, 'godot_performance', { seconds: 0.1 }))).toContain('seconds must be from 0.25 to 20.')
  })

  it('captures the audio mix with its measurements and the picture it asks for, and saves it as a WAV file on request', async () => {
    const c = await started()
    const result = await callTool(c, 'godot_audio', { seconds: 0.5, picture: true })
    expect(text(result).split('\n').slice(0, 4)).toEqual([
      'Captured 0.50 s of the game\'s audio mix, the Master bus after its effects and volume, at 44100 Hz in stereo.',
      'The game runs muted (Dummy audio driver): it mixes its audio as usual, but no device plays it.',
      'Levels: peak -6.0 dBFS, RMS -9.0 dBFS (left -6.0 dBFS peak, -9.0 dBFS RMS; right -6.0 dBFS peak, -9.0 dBFS RMS), loudness -6.7 LUFS.',
      'Silence below -60 dBFS: 0.00 s at the start, 0.00 s at the end.',
    ])
    expect(text(result)).toContain('Sounds (stretches above -50 dBFS): 0.00-0.50 s peak -6.0 dBFS.')
    expect(text(result)).toContain('No AudioStreamPlayer, AudioStreamPlayer2D, or AudioStreamPlayer3D started playing during the capture.')
    expect(text(result)).toContain('Buses (volume, largest peak): Master 0.0 dB, peak -6.0 dB.')
    expect(text(result)).toContain('Image (1024 x')
    expect(value(result)).toMatchObject({ seconds: 0.5, muted: true, dominantHz: expect.any(Number) as number, picture: { attachmentId: 'a1', mediaType: 'image/png' } })
    expect(Math.abs((value(result).dominantHz as number) - 441)).toBeLessThan(25)
    expect(result.content.at(-1)).toMatchObject({ type: 'image', attachment: { attachmentId: 'a1' } })
    expect(Buffer.from(c.saved[0]?.data as Uint8Array).subarray(1, 4).toString('latin1')).toBe('PNG')
    expect((await fakeRequests(c.project)).find(request => request.type === 'audio')).toMatchObject({ seconds: 0.5, timeoutMs: 5500 })

    const saved = await callTool(c, 'godot_audio', { seconds: 0.25, path: 'captures/mix.wav' })
    expect(text(saved)).toContain(`Saved the capture to ${join(c.dir.root, 'work', 'captures', 'mix.wav')}.`)
    // Without picture, the capture's figures come alone.
    expect(saved.content.some(block => block.type === 'image')).toBe(false)
    expect(text(saved)).not.toContain('Image (1024 x')
    expect(c.saved).toHaveLength(1)
    const wav = await readFile(join(c.dir.root, 'work', 'captures', 'mix.wav'))
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.length).toBe(44 + 11025 * 4)
    expect(text(await callTool(c, 'godot_audio', { seconds: 0.25, path: 'captures/mix.wav' }))).toContain('already exists; pass replace: true to overwrite it')
    expect(text(await callTool(c, 'godot_audio', { seconds: 0.25, path: 'captures/mix.wav', replace: true }))).toContain('Saved the capture to')
    expect(text(await callTool(c, 'godot_audio', { path: 'captures/mix.mp3' }))).toContain('path must end in .wav.')
    expect(text(await callTool(c, 'godot_audio', { seconds: 40 }))).toContain('seconds must be from 0.25 to 30.')
  })

  it('plays input from the capture\'s start, keeps to text for a model without images, and reports what the game played', async () => {
    const players = [{ path: '/root/Main/Gun/Shot', class: 'AudioStreamPlayer3D', stream: 'res://sfx/shot.wav', bus: 'SFX', volumeDb: -2, starts: 2, firstAt: 0.21, lastAt: 0.4, playing: false }]
    const c = await started({ model: 'blind', game: { game: { audio: { amplitude: 0, reply: { players, morePlayers: 1, droppedFrames: 12, driver: 'CoreAudio', masterBypassed: true, detached: true } } } } })
    const result = await callTool(c, 'godot_audio', { seconds: 0.25, events: [{ kind: 'key', key: 'Space', pressed: true }], picture: true })
    expect(text(result)).not.toContain('muted')
    expect(text(result)).toContain('The Master bus bypasses its effects')
    expect(text(result)).toContain('The game replaced its audio bus layout during the capture')
    expect(text(result)).toContain('drop 12 audio frames')
    expect(text(result)).toContain('The mix is silent: no sample reaches -120 dBFS.')
    expect(text(result)).toContain('Players that played: /root/Main/Gun/Shot (AudioStreamPlayer3D, res://sfx/shot.wav, bus SFX, -2.0 dB) started 2 times from 0.21 s; and 1 more.')
    expect(result.content.some(block => block.type === 'image')).toBe(false)
    const requests = await fakeRequests(c.project)
    expect(requests.some(request => request.type === 'input')).toBe(true)
    expect(text(await callTool(c, 'godot_audio', { events: [{ kind: 'mouse_button', button: 'left', pressed: true, x: 1, y: 1 }] }))).toContain('this game has no screenshot yet')
  })

  it('reads the log after the Session cursor, by level, within the text budget', async () => {
    const logs = [
      { level: 'stdout', message: 'one', time_ms: 1 },
      { level: 'error', message: 'two', file: 'res://a.gd', line: 4, time_ms: 1 },
      { level: 'stdout', message: 'three', time_ms: 1 },
    ]
    const c = await setup({ game: { game: { logs, logsOn: { eval: Array.from({ length: 40 }, (_, index) => ({ level: 'stdout', message: `${index} ${'x'.repeat(400)}`, time_ms: 1 })) } } } })
    expect(text(await callTool(c, 'godot_logs'))).toContain('No game has run in this Session; call godot_run first.')
    await callTool(c, 'godot_run')
    const all = (value(await callTool(c, 'godot_logs')) as { entries: unknown[]; next: number; missed: boolean })
    expect(all.entries).toMatchObject([{ message: 'one' }, { message: 'two' }, { message: 'three' }])
    expect(all.missed).toBe(false)
    const none = await callTool(c, 'godot_logs')
    expect(text(none)).toBe(`No new log entries.\n\nNext cursor: ${all.next}.`)
    const errors = (value(await callTool(c, 'godot_logs', { since: 0, levels: ['error'], limit: 5 })) as { entries: unknown[] })
    expect(errors.entries).toEqual([{ seq: 2, source: 'game', level: 'error', message: 'two', file: 'res://a.gd', line: 4 }])
    await callTool(c, 'godot_eval', { expression: 'x' })
    const page = await callTool(c, 'godot_logs')
    expect(text(page).length).toBeLessThanOrEqual(TEXT_BUDGET)
    const first = value(page) as { entries: Array<{ seq: number }>; next: number }
    expect(first.entries.length).toBeLessThan(40)
    expect(first.next).toBe(first.entries.at(-1)?.seq)
    let read = first.entries.length
    for (;;) {
      const more = (value(await callTool(c, 'godot_logs')) as { entries: unknown[] }).entries.length
      if (more === 0) break
      read += more
    }
    expect(read).toBe(40)
    expect(text(await callTool(c, 'godot_logs', { limit: 0 }))).toContain('limit must be from 1 to 1000.')
  })

  it('reports entries lost to a full log', async () => {
    const logs = Array.from({ length: 8 }, (_, index) => ({ level: 'stdout', message: `m${index}`, time_ms: 1 }))
    const c = await setup({ game: { game: { logs } }, config: { maxLogEntries: 3 } })
    await callTool(c, 'godot_run')
    const result = await callTool(c, 'godot_logs', { since: 0 })
    expect(value(result)).toMatchObject({ missed: true })
    expect(text(result)).toContain('Older entries after the cursor were discarded because the log is full.')
  })
})

posix('driving the game', () => {
  it('maps mouse coordinates from the latest screenshot to window pixels', async () => {
    const c = await started()
    const click = { kind: 'mouse_button', button: 'left', pressed: true, x: 100, y: 50 }
    expect(text(await callTool(c, 'godot_input', { events: [click] }))).toContain('this game has no screenshot yet')
    expect(text(await callTool(c, 'godot_input', { events: [{ kind: 'key', key: 'Space', pressed: true, hold: 0.1 }] }))).toMatch(/^Sent 1 events over 1 frames \(0\.00 s\); the game is at frame \d+\.$/u)
    await callTool(c, 'godot_screenshot')
    const result = await callTool(c, 'godot_input', { events: [click, { kind: 'mouse_motion', x: 10, y: 10 }], screenshot: true })
    expect(value(result)).toMatchObject({ events: 2, screenshot: { width: 320, height: 180 } })
    expect(result.content.at(-1)).toMatchObject({ type: 'image' })
    expect(text(result)).toContain('Screenshot at frame')
    await callTool(c, 'godot_input', { events: [click], coordinate_space: 'window' })
    const inputs = (await fakeRequests(c.project)).filter(request => request.type === 'input')
    expect(inputs.map(request => request.events)).toEqual([
      [{ kind: 'key', key: 'Space', pressed: true, hold: 0.1 }],
      [{ ...click, x: 200, y: 100 }, { kind: 'mouse_motion', x: 20, y: 20 }],
      [click],
    ])
    expect(text(await callTool(c, 'godot_input', { events: [{ kind: 'key', pressed: true }] }))).toContain('a key event needs key or keycode')
    await callTool(c, 'godot_run')
    expect(text(await callTool(c, 'godot_input', { events: [click] }))).toContain('this game has no screenshot yet')
  })

  it('refuses a screenshot the model cannot see before it sends events or waits', async () => {
    const c = await started({ model: 'blind' })
    const key = { kind: 'key', key: 'Space', pressed: true, hold: 0.1 }
    expect(text(await callTool(c, 'godot_input', { events: [key], screenshot: true }))).toContain('does not accept images')
    expect(text(await callTool(c, 'godot_wait', { frames: 1, screenshot: true }))).toContain('does not accept images')
    expect((await fakeRequests(c.project)).filter(request => request.type === 'input' || request.type === 'wait')).toEqual([])
  })

  it('reports a screenshot that fails after the events or the wait without failing the call', async () => {
    const c = await started({ game: { game: { replies: { screenshot: 'error' } } } })
    const input = await callTool(c, 'godot_input', { events: [{ kind: 'key', key: 'Space', pressed: true }], screenshot: true })
    expect(value(input)).toMatchObject({ events: 1, screenshotError: 'fake screenshot failure' })
    expect(text(input)).toContain('The screenshot after the events failed: fake screenshot failure')
    expect(input.content.some(block => block.type === 'image')).toBe(false)
    const waited = await callTool(c, 'godot_wait', { frames: 1, screenshot: true })
    expect(value(waited)).toMatchObject({ frames: 1, screenshotError: 'fake screenshot failure' })
    expect(text(waited)).toContain('The screenshot after the wait failed: fake screenshot failure')
  })

  it('ends a call cancelled during its screenshot after the events', async () => {
    const c = await started({ game: { game: { replies: { screenshot: 'none' } } } })
    const controller = new AbortController()
    const call = callTool(c, 'godot_input', { events: [{ kind: 'key', key: 'Space', pressed: true }], screenshot: true }, controller.signal)
    await until(async () => (await fakeRequests(c.project)).some(request => request.type === 'screenshot'))
    controller.abort(new Error('turn stopped'))
    const result = await call
    expect(result.isError).toBe(true)
    expect(text(result)).not.toContain('The screenshot after the events failed')
  })

  it('waits game time, pauses, resumes, and steps', async () => {
    const c = await started()
    expect(text(await callTool(c, 'godot_wait', { frames: 3 }))).toMatch(/^Waited 3 frames \(0\.05 s of game time\); the game is at frame \d+\.$/u)
    const waited = await callTool(c, 'godot_wait', { seconds: 0.05, screenshot: true })
    expect(value(waited)).toMatchObject({ seconds: 0.05, screenshot: { width: 320 } })
    expect(waited.content.at(-1)).toMatchObject({ type: 'image' })
    expect(text(await callTool(c, 'godot_control', { action: 'pause' }))).toMatch(/^The game is paused at frame \d+\.$/u)
    expect(text(await callTool(c, 'godot_wait', { seconds: 1 }))).toContain('The game is paused, so game time does not advance')
    expect(text(await callTool(c, 'godot_wait', { frames: 2 }))).toContain('and paused.')
    expect(text(await callTool(c, 'godot_control', { action: 'resume' }))).toMatch(/^The game is running at frame \d+\.$/u)
    expect(text(await callTool(c, 'godot_control', { action: 'step', frames: 4 }))).toMatch(/^Ran 4 frames\. The game is paused at frame \d+\.$/u)
    expect(value(await callTool(c, 'godot_control', { action: 'step' }))).toMatchObject({ frames: 1, paused: true })
  })

  it('reports a wait that its real-time limit ended and a step that a resume ended', async () => {
    const c = await started({ game: { game: { replies: { wait: 'timedOut', step: 'cancelled' } } } })
    const waited = await callTool(c, 'godot_wait', { seconds: 0.1 })
    expect(value(waited)).toMatchObject({ seconds: 0.05, timedOut: true })
    expect(text(waited)).toMatch(/^The wait ended at its real-time limit after 0\.05 s of game time \(3 frames\); the game is at frame /u)
    expect(text(waited)).toContain('Game time passes only while the game runs unpaused.')
    const stepped = await callTool(c, 'godot_control', { action: 'step', frames: 8 })
    expect(value(stepped)).toMatchObject({ frames: 4, paused: false, endedEarly: true, timedOut: false })
    const early = /^Ran 4 frames before a pause, a resume, or a newer step ended the step\. The game is running at frame \d+\.$/u
    expect(text(stepped)).toMatch(early)
  })

  it('reports an input sequence and a step that their real-time limits ended', async () => {
    const c = await started({ game: { game: { replies: { input: 'timedOut', step: 'timedOut' } } } })
    const keys = [{ kind: 'key', key: 'W', pressed: true }, { wait: 2 }, { kind: 'key', key: 'W', pressed: false }]
    const input = await callTool(c, 'godot_input', { events: keys })
    expect(value(input)).toMatchObject({ events: 1, timedOut: true })
    const frame = value(input).frame as number
    expect(text(input)).toBe(
      `The input ended at its real-time limit after 1 of its events, over 1 frames (0.00 s); the keys and buttons it held were released, and the game is at frame ${frame}.`,
    )
    const stepped = await callTool(c, 'godot_control', { action: 'step', frames: 8 })
    expect(value(stepped)).toMatchObject({ frames: 4, paused: true, endedEarly: false, timedOut: true })
    expect(text(stepped)).toMatch(/^Ran 4 frames before the step reached its real-time limit\. The game is paused at frame \d+\.$/u)
    expect((await fakeRequests(c.project)).find(request => request.type === 'input')).toMatchObject({ timeoutMs: 2000 + 200 + 5000 })
  })

  it.each([
    ['godot_wait', {}, 'Give either seconds or frames.'],
    ['godot_wait', { seconds: 1, frames: 1 }, 'Give either seconds or frames.'],
    ['godot_wait', { seconds: 0 }, 'seconds must be positive.'],
    ['godot_wait', { frames: 0 }, 'frames must be from 1 to 100000.'],
    ['godot_control', { action: 'step', frames: 200_000 }, 'frames must be from 1 to 100000.'],
  ])('refuses %s %j', async (tool, args, message) => {
    const c = await started()
    expect(text(await callTool(c, tool, args))).toContain(message)
  })

  it('refuses game requests while no game is running', async () => {
    const c = await setup({ game: { game: { connect: 'never' } } })
    expect(text(await callTool(c, 'godot_screenshot'))).toBe('Error: No game is running in this Session; call godot_run first.')
    void c.godot.run(c.owner.agent.id, {}, new AbortController().signal)
    await until(async () => (await fakeLog(c.project)).length > 0)
    expect(text(await callTool(c, 'godot_eval', { expression: 'x' }))).toBe('Error: The game is starting or stopping; call godot_run to wait for it.')
    await callTool(c, 'godot_stop')
    expect(text(await callTool(c, 'godot_eval', { expression: 'x' }))).toBe('Error: The game is not running (exited); call godot_run to start it again.')
  })

  it('quotes the crash when a request finds the game crashed', async () => {
    const c = await started({ game: { game: { exitOn: { type: 'eval', code: 3, closeFirst: true, stderr: 'fatal\n' } } } })
    await callTool(c, 'godot_eval', { expression: 'x' })
    await until(async () => text(await callTool(c, 'godot_wait', { frames: 1 })).includes('(crashed)'))
    expect(text(await callTool(c, 'godot_wait', { frames: 1 }))).toBe('Error: The game is not running (crashed); call godot_run to start it again.\nThe game crashed (exit code 3).\nLast output:\nfatal')
  })
})

posix('new error reports', () => {
  it('reports errors logged since the previous Godot call in results and failures', async () => {
    const burst = Array.from({ length: DIGEST_ENTRIES + 2 }, (_, index) => ({ level: 'error', message: `e${index}`, time_ms: 1 }))
    const c = await started({ game: { game: { logsOn: { tree: burst, eval: [{ level: 'script_error', message: 'late', file: 'res://x.gd', line: 2, time_ms: 1 }] }, replies: { eval: 'error', pause: 'error' } } } })
    const result = await callTool(c, 'godot_scene_tree')
    expect(value(result)).toMatchObject({ moreNewErrors: 2 })
    expect(text(result)).toContain('New errors since your last Godot call:\n[error] e0\n')
    expect(text(result)).toContain('… and 2 more; read them with godot_logs.')
    expect(text(await callTool(c, 'godot_control', { action: 'resume' }))).not.toContain('New errors')
    const plain = await callTool(c, 'godot_control', { action: 'pause' })
    expect(plain.isError).toBe(true)
    expect(text(plain)).toBe('Error: fake pause failure')
    const failed = await callTool(c, 'godot_eval', { expression: 'x' })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toBe('Error: fake eval failure\n\nNew errors since your last Godot call:\n[script_error] res://x.gd:2: late')
  })

  it('formats entries and reports compactly', () => {
    const long = { seq: 1, runId: 'r', source: 'game' as const, level: 'error' as const, message: 'x'.repeat(600), time: 1 }
    expect(toolLogEntry(long).message).toHaveLength(501)
    expect(formatLogEntry({ seq: 2, source: 'check', level: 'warning', message: 'm', file: 'res://a.gd' })).toBe('[warning, check] res://a.gd: m')
    expect(formatDigest({})).toBe('')
    expect(formatDigest({ newErrors: [{ seq: 1, source: 'game', level: 'error', message: 'm' }] })).toBe('New errors since your last Godot call:\n[error] m')
  })
})

posix('result text', () => {
  it('renders optional facts, paused screenshots, partial checks, and long results', async () => {
    const c = await setup()
    const render = (name: string, value: Record<string, unknown>) => {
      const definition = c.ctx.tools.get(name)
      if (definition === undefined) throw new Error(`missing tool ${name}`)
      return definition.output.render({}, JSON.parse(JSON.stringify(value)) as JsonValue)
    }
    const run = { runId: 'r', phase: 'running', projectDir: '/p', width: 1, height: 2, renderer: 'r', godot: 'g', windowless: true, muted: false, issues: [], moreIssues: 0 }
    expect(render('godot_run', run)[0]).toEqual({ type: 'text', text: 'The game is running: /p; window 1x2, renderer r, Godot g, windowless.\n\nNo errors or warnings were logged while importing and starting.' })
    const image = { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 2, height: 2 }
    const shot = render('godot_screenshot', { width: 2, height: 2, windowWidth: 4, windowHeight: 4, frame: 9, paused: true, image })
    expect(shot[0]).toMatchObject({ text: expect.stringContaining('Screenshot at frame 9 (paused)') as string })
    expect(shot[1]).toEqual({ type: 'image', attachment: image })
    const checked = render('godot_check', { projectDir: '/p', checked: 1, total: 5, files: [{ path: 'res://a.gd', issues: [{ level: 'error', file: 'res://a.gd', message: 'm' }] }] })
    expect(checked[0]).toMatchObject({ text: 'Checked 1 of 5 scripts in /p; 1 have problems:\n[error] res://a.gd: m' })
    const warned = render('godot_check', { projectDir: '/p', checked: 1, total: 1, importWarning: 'The import warning.', files: [] })
    expect(warned[0]).toMatchObject({ text: 'The import warning.\nChecked 1 scripts in /p: no errors.' })
    const long = render('godot_eval', { value: 'x'.repeat(TEXT_BUDGET * 2), valueType: 'String' })[0]
    expect(long?.type === 'text' && long.text.length).toBeLessThanOrEqual(TEXT_BUDGET)
    expect(long?.type === 'text' && long.text.endsWith('… (output shortened)')).toBe(true)
  })

  it('stores screenshots without optional image facts', async () => {
    const c = await started({ game: { game: { png: 'BARE' } } })
    const result = await callTool(c, 'godot_screenshot')
    expect(value(result)).toMatchObject({ image: { attachmentId: 'a1' } })
    expect((value(result) as { image: Record<string, unknown> }).image).not.toHaveProperty('name')
    expect(result.content.at(-1)).toEqual({ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 640, height: 360 } })
  })

  it('names an unnamed project by its folder and omits an unknown scene', async () => {
    const c = await setup({ unnamed: true, game: { game: { scene: '' } } })
    const result = await callTool(c, 'godot_run')
    expect(text(result)).toMatch(new RegExp(`^The game is running: ${c.project.replaceAll('/', '\\/')}; window 640x360,`, 'u'))
    expect(value(result)).not.toHaveProperty('projectName')
    expect(value(result)).not.toHaveProperty('scene')
  })

  it('reports a game that ends during its first second', async () => {
    const c = await setup({ game: { game: { selfExitAfterMs: 100 } } })
    expect(text(await callTool(c, 'godot_run'))).toBe('Error: The game did not keep running (exited).')
  })
})

posix('godot_check', () => {
  async function scripts(c: Composition): Promise<void> {
    await mkdir(join(c.project, 'levels'), { recursive: true })
    await writeFile(join(c.project, 'player.gd'), 'extends Node\n')
    await writeFile(join(c.project, 'levels', 'one.gd'), 'extends Node\n')
    await writeFile(join(c.project, 'levels', 'notes.txt'), '')
  }

  it('checks every script of the project and lists the problems', async () => {
    const c = await setup({
      game: {
        check: {
          errors: {
            'res://player.gd': [
              { level: 'script_error', message: 'Parse Error: Expected ":".', file: 'res://player.gd', line: 4, function: 'GDScript::reload' },
              { level: 'error', message: 'Failed to load script', file: 'modules/gdscript/gdscript_resource_format.cpp', line: 46, function: 'load' },
            ],
          },
        },
      },
    })
    await scripts(c)
    const result = await callTool(c, 'godot_check')
    expect(text(result)).toBe(`Checked 2 scripts in ${c.project}; 1 have problems:\n[script_error] res://player.gd:4: Parse Error: Expected ":".`)
    expect(value(result)).toMatchObject({ checked: 2, total: 2, files: [{ path: 'res://player.gd', issues: [{ line: 4 }] }] })
  })

  it('checks named files and folders of a named or running project', async () => {
    const c = await setup()
    await scripts(c)
    const named = await callTool(c, 'godot_check', { project: 'game', paths: ['res://player.gd', 'game/levels'] })
    expect(text(named)).toBe(`Checked 2 scripts in ${c.project}: no errors.`)
    await callTool(c, 'godot_run')
    expect(value(await callTool(c, 'godot_check', { paths: ['res://levels/one.gd'] }))).toMatchObject({ checked: 1, files: [] })
    const nothing = await callTool(c, 'godot_check', { paths: ['res://levels/../levels/notes.txt'] })
    expect(text(nothing)).toContain('is not a .gd script.')
  })

  it.each([
    [['/elsewhere/a.gd'], 'is outside the project'],
    [['res://missing.gd'], 'does not exist in the project'],
  ])('refuses paths %j', async (paths, message) => {
    const c = await setup()
    expect(text(await callTool(c, 'godot_check', { paths }))).toContain(message)
  })

  it('runs at most maxHeadlessProcesses checks at once, and later ones wait for a free slot', async () => {
    const c = await setup({ config: { maxHeadlessProcesses: 1 }, game: { check: { delayMs: 300 } } })
    await scripts(c)
    const started = performance.now()
    const results = await Promise.all([callTool(c, 'godot_check'), callTool(c, 'godot_check')])
    // Two checks of 300 ms each one after the other.
    expect(performance.now() - started).toBeGreaterThanOrEqual(600)
    for (const result of results) expect(text(result)).toBe(`Checked 2 scripts in ${c.project}: no errors.`)
  })

  it('starts no check while the computer has less memory available than a start needs', async () => {
    const c = await setup({ config: { minAvailableMemoryBytes: Number.MAX_SAFE_INTEGER } })
    await scripts(c)
    expect(text(await callTool(c, 'godot_check'))).toMatch(/ that starting a Godot script check needs, so it did not start\./u)
    expect(await fakeLog(c.project)).toEqual([])
  })

  it('imports the project before the first check and after a script changes', async () => {
    const c = await setup()
    await scripts(c)
    const imports = async (): Promise<number> => (await fakeLog(c.project)).filter(entry => (entry.argv as string[] | undefined)?.includes('--import')).length
    expect(text(await callTool(c, 'godot_check'))).toBe(`Checked 2 scripts in ${c.project}: no errors.`)
    expect(await imports()).toBe(1)
    await callTool(c, 'godot_check', { paths: ['res://player.gd'] })
    expect(await imports()).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(join(c.project, 'player.gd'), 'extends Node2D\n')
    await callTool(c, 'godot_check', { paths: ['res://player.gd'] })
    expect(await imports()).toBe(2)
  }, PROCESSES_TIMEOUT)

  it('reports an import before the check that ends abnormally ahead of the results', async () => {
    const c = await setup({ game: { import: { exitCode: 134, stderr: 'handle_crash: Program crashed with signal 11\n' }, check: {} } })
    await scripts(c)
    const result = await callTool(c, 'godot_check')
    expect(text(result)).toBe([
      'The Godot import step before the check ended abnormally (exit code 134: Program crashed with signal 11), so errors about class_name classes or imported assets may be false.',
      `Checked 2 scripts in ${c.project}: no errors.`,
    ].join('\n'))
    expect(value(result)).toMatchObject({ importWarning: expect.stringContaining('ended abnormally') as string })
  }, PROCESSES_TIMEOUT)

  it('imports a project for a run and for a check at the same time one step after the other', async () => {
    const c = await setup({ game: { import: { delayMs: 300 }, game: {} }, config: { importBeforeRun: true } })
    await scripts(c)
    const [run, check] = await Promise.all([callTool(c, 'godot_run'), callTool(c, 'godot_check')])
    expect(run.isError, text(run)).toBe(false)
    expect(text(check)).toBe(`Checked 2 scripts in ${c.project}: no errors.`)
    const log = await fakeLog(c.project)
    const starts = log.flatMap((entry, index) => (entry.argv as string[] | undefined)?.includes('--import') === true ? [index] : [])
    expect(starts.length).toBeGreaterThan(0)
    for (const index of starts) expect(log[index + 1]).toEqual({ imported: true })
  }, PROCESSES_TIMEOUT)

  it('exports a project for Windows and macOS with their configured templates, one export at a time', async () => {
    // The fake export does not read the templates, so any existing file stands in for them.
    const template = fileURLToPath(import.meta.url)
    const c = await setup({
      game: { export: { files: { 'Fake game.zip': 'zip' } } },
      config: { windowsTemplatePath: template, macosTemplatePath: template },
    })
    const signal = new AbortController().signal
    const [windows, macos] = await Promise.all([
      c.godot.exportDesktop({ projectDir: c.project, platform: 'windows', outputDir: join(c.dir.root, 'windows') }, signal),
      c.godot.exportDesktop({ projectDir: c.project, platform: 'macos', outputDir: join(c.dir.root, 'macos') }, signal),
    ])
    expect([windows.entry, windows.platform, macos.entry, macos.platform]).toEqual(['Fake game.zip', 'windows', 'Fake game.zip', 'macos'])
    const log = await fakeLog(c.project)
    expect(log.flatMap(entry => entry.preset === undefined ? [] : [entry.preset]).sort()).toEqual(['WASD Engine Windows', 'WASD Engine macOS'])
    const starts = log.flatMap((entry, index) => (entry.argv as string[] | undefined)?.includes('--export-release') === true ? [index] : [])
    // The second export starts after the first one ended.
    expect(log.slice(starts[0], starts[1]).some(entry => entry.exported === true)).toBe(true)
  }, PROCESSES_TIMEOUT)

  it('exports for Android with the configured JDK and SDK and the key it generates, and for iOS for the team it is given', async () => {
    const tools = await scratch('android-tools')
    try {
      const java = join(tools.root, 'jdk')
      await mkdir(join(java, 'bin'), { recursive: true })
      await writeFile(join(java, 'bin', 'java'), '')
      // keytool writes the keystore it is asked for.
      await writeFile(join(java, 'bin', 'keytool'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -keystore ] && out="$2"; shift; done\nprintf key > "$out"\n')
      await chmod(join(java, 'bin', 'keytool'), 0o755)
      const sdk = join(tools.root, 'sdk')
      await mkdir(join(sdk, 'platform-tools'), { recursive: true })
      await mkdir(join(sdk, 'build-tools', '36.0.0'), { recursive: true })
      await writeFile(join(sdk, 'platform-tools', 'adb'), '')
      await writeFile(join(sdk, 'build-tools', '36.0.0', 'apksigner'), '')
      // The fake export does not read the templates, so any existing file stands in for them.
      const template = fileURLToPath(import.meta.url)
      const c = await setup({
        game: { export: { files: { 'Fake game.apk': 'apk', 'Fakegame.xcodeproj/project.pbxproj': 'DEVELOPMENT_TEAM = ABCDE12345;\n' } } },
        config: { androidTemplatePath: template, iosTemplatePath: template, androidJavaPath: java, androidSdkPath: sdk },
      })
      const signal = new AbortController().signal
      const android = await c.godot.exportMobile({ projectDir: c.project, platform: 'android', outputDir: join(c.dir.root, 'android') }, signal)
      const keystore = join(c.dir.root, 'data', 'android', 'release.keystore')
      expect(android).toMatchObject({ entry: 'Fake game.apk', identifier: 'com.wasdengine.game.fake_game', signing: { keystore, created: true } })
      const ios = await c.godot.exportMobile({ projectDir: c.project, platform: 'ios', outputDir: join(c.dir.root, 'ios'), appleTeamId: 'ABCDE12345' }, signal)
      expect(ios).toMatchObject({ entry: 'Fakegame.xcodeproj', identifier: 'com.wasdengine.game.fake-game', appleTeamId: 'ABCDE12345' })
      type ExportEntry = { preset: string; env: Record<string, string> }
      const exports = (await fakeLog(c.project)).filter(entry => entry.preset !== undefined) as ExportEntry[]
      expect(exports.map(entry => entry.preset)).toEqual(['WASD Engine Android', 'WASD Engine iOS'])
      // Godot's Android export reads its editor settings from a home folder of its own, which the export removes again.
      expect(exports[0]?.env).toMatchObject({ JAVA_HOME: java, ANDROID_HOME: sdk, GODOT_ANDROID_KEYSTORE_RELEASE_PATH: keystore, GODOT_ANDROID_KEYSTORE_RELEASE_USER: 'release' })
      expect(exports[0]?.env.HOME).not.toBe(exports[1]?.env.HOME)
      expect(existsSync(exports[0]?.env.HOME as string)).toBe(false)
      const again = await c.godot.exportMobile({ projectDir: c.project, platform: 'android', outputDir: join(c.dir.root, 'android') }, signal)
      expect(again.signing).toEqual({ keystore, created: false })
    } finally {
      await tools.cleanup()
    }
  }, PROCESSES_TIMEOUT)

  it('tells a computer without an Android SDK what to install before it downloads the Android template', async () => {
    const c = await setup({ config: { androidJavaPath: join('/', 'missing', 'jdk'), androidSdkPath: join('/', 'missing', 'sdk') } })
    const failure = c.godot.exportMobile({ projectDir: c.project, platform: 'android', outputDir: join(c.dir.root, 'android') }, new AbortController().signal)
    await expect(failure).rejects.toThrow(/fix androidJavaPath[\s\S]*fix androidSdkPath[\s\S]*Android Studio/u)
    expect(existsSync(join(c.dir.root, 'data', 'templates'))).toBe(false)
  }, PROCESSES_TIMEOUT)

  it('imports a project for a check before or after a Web export of it, never during one', async () => {
    const files = Object.fromEntries(['index.html', 'index.js', 'index.wasm', 'index.pck'].map(name => [name, name]))
    // The fake export does not read the template, so any existing file stands in for it.
    const c = await setup({
      game: { import: { delayMs: 300 }, export: { delayMs: 300, files }, check: {} },
      config: { webTemplatePath: fileURLToPath(import.meta.url) },
    })
    await scripts(c)
    const signal = new AbortController().signal
    const [check, exported] = await Promise.all([callTool(c, 'godot_check'), c.godot.exportWeb({ projectDir: c.project, outputDir: join(c.dir.root, 'web') }, signal)])
    expect(text(check)).toBe(`Checked 2 scripts in ${c.project}: no errors.`)
    expect(exported.entry).toBe('index.html')
    // Each import, check, and export ends before the next one starts.
    const log = await fakeLog(c.project)
    let running: string | undefined
    for (const entry of log) {
      const argv = entry.argv as string[] | undefined
      if (argv !== undefined) {
        expect(running).toBeUndefined()
        running = argv.includes('--import') ? 'imported' : argv.includes('--export-release') ? 'exported' : 'checked'
      } else if (running !== undefined && entry[running] === true) {
        running = undefined
      }
    }
    expect(running).toBeUndefined()
    expect(log.filter(entry => entry.imported === true)).toHaveLength(1)
  }, PROCESSES_TIMEOUT)

  it('reports a project without scripts and a check that ends early', async () => {
    const c = await setup({ game: { check: { omit: ['res://player.gd'], stderr: 'crashed here\n', exitCode: 1 } } })
    expect(text(await callTool(c, 'godot_check'))).toBe(`Checked 0 scripts in ${c.project}: no errors.`)
    await scripts(c)
    expect(text(await callTool(c, 'godot_check'))).toContain('The Godot check ended (exit code 1) before checking res://player.gd.\nLast output:\ncrashed here')
  })
})
