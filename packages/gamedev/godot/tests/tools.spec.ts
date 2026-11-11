/** The godot_* tools run, observe, and drive the Session's game through the real tool pipeline. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { DIGEST_ENTRIES, formatDigest, formatLogEntry, formatTree, STARTUP_ENTRIES, TEXT_BUDGET, toolLogEntry } from '../src/tools.ts'
import { callTool, compose, text, type Composition, type CompositionOptions } from './composition.ts'
import { configureFake, fakeLog, fakeRequests, until } from './helpers.ts'

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

  it.each([
    [{ model: 'blind' } as const, 'does not accept images'],
    [{ model: 'unknown' } as const, 'does not accept images'],
    [{ model: 'none' } as const, 'Screenshots need an attachment store and a resolved model route'],
    [{ attachments: false }, 'Screenshots need an attachment store and a resolved model route'],
  ])('refuses screenshots the model cannot see: %j', async (options, message) => {
    const c = await started(options)
    expect(text(await callTool(c, 'godot_screenshot'))).toContain(message)
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
    // The game's own limit is the sample's seconds plus requestTimeoutMs.
    expect((await fakeRequests(c.project)).find(request => request.type === 'performance')).toMatchObject({ seconds: 0.5, timeoutMs: 5500 })
    expect(text(await callTool(c, 'godot_performance', { seconds: 30 }))).toContain('seconds must be from 0.25 to 20.')
    expect(text(await callTool(c, 'godot_performance', { seconds: 0.1 }))).toContain('seconds must be from 0.25 to 20.')
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
