/** Web checks serve the export, read the browser's result line, and report what players meet, with findings. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebCheckSample } from '../src/types.ts'
import {
  checkWebBuild, GodotWebCheckError, parseWebCheckOutput, serveFolder, summarizeWebCheck, WEB_CHECK_ARGUMENT, WEB_CHECK_MARKER,
  WEB_CHECK_MESSAGES, WEB_CHECK_OUTPUT_BYTES, WEB_CHECK_UNAVAILABLE, webCheckMessages,
} from '../src/web-check.ts'
import { scratch, subprocessFixture, type Scratch, type SubprocessFixture } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal
const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
})

/** A sample with nothing wrong: started in 3 s, drawing steadily at 4 s, 60 fps, few draw calls, no messages. */
const HEALTHY: WebCheckSample = {
  started: true,
  startMs: 3000,
  readyMs: 4000,
  longTasks: [[100, 400], [2500, 300]],
  frameMs: [16.7, 16.6, 16.7, 16.8, 16.7],
  drawCalls: [120, 130, 125, 128, 126],
  programs: 40,
  console: [{ level: 'info', text: 'Godot Engine v4.7.2.stable.official - https://godotengine.org' }],
  unresponsive: false,
}

/** What the browser printed for Shotgun Dave's Web build. */
const SHOTGUN: WebCheckSample = {
  started: true,
  startMs: 3400,
  readyMs: 52_300,
  longTasks: [[1754, 30_182], [32_799, 22_422], [59_420, 5999], [65_427, 1177], [611, 1139], [32_234, 562]],
  frameMs: [33.3, 33.4, 33.3, 16.7, 50, 916.6],
  drawCalls: [5193, 2915, 2915, 1426, 2915, 2915],
  programs: 226,
  console: [
    { level: 'info', text: 'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org' },
    { level: 'error', text: 'WARNING: TAA is only available when using the Forward+ renderer.' },
    { level: 'error', text: '   at: viewport_set_use_taa (servers/rendering/renderer_viewport.cpp:1450)' },
    { level: 'error', text: 'ERROR: shader type fog not supported in OpenGL renderer' },
    { level: 'error', text: '   at: shader_set_code (drivers/gles3/storage/material_storage.cpp:2283)' },
    ...Array.from({ length: 3 }, () => [
      { level: 'error' as const, text: 'ERROR: Too many instances using shader instance variables. Consider increasing rendering/limits/global_shader_variables/buffer_size in the Project Settings. Maximum items supported by this hardware is: 1024.' },
      { level: 'error' as const, text: '   at: global_shader_parameters_instance_allocate (drivers/gles3/storage/material_storage.cpp:2101)' },
    ]).flat(),
    { level: 'error', text: 'WARNING: The Compatibility renderer does not support manually emitting particles.' },
    { level: 'warning', text: 'A page warning that is not Godot\'s' },
    { level: 'error', text: 'Uncaught TypeError: x is not a function' },
  ],
  unresponsive: true,
}

/** The finding of a page that stopped answering and had not answered again when the check ended. */
const STOPPED = 'The page stopped answering during the check and had not answered again when the check ended, so the check measured no frames: the game froze, for good or for longer than players wait, and browsers offer to close a page that stays frozen. Browsers run Godot\'s scripts and drawing on one thread, so a loop that never ends, or work that takes many seconds in one frame, stops the whole tab: look for loops whose exit condition can stay false, and spread long work over frames with `await get_tree().process_frame`.'

/** The finding of a page that the browser reported unresponsive and that answered again. */
const UNRESPONSIVE = 'The browser reported the page unresponsive during the check: it ran nothing else for several seconds, and browsers offer players to close such a page.'

describe('parseWebCheckOutput', () => {
  it('reads the last result line and ignores other output', () => {
    const stdout = [
      'GPU process started',
      `${WEB_CHECK_MARKER}${JSON.stringify({ ...HEALTHY, programs: 1 })}`,
      `${WEB_CHECK_MARKER}${JSON.stringify(HEALTHY)}`,
      'exiting',
    ].join('\n')
    expect(parseWebCheckOutput(stdout)).toEqual(HEALTHY)
  })

  it('reads the size of the screenshot the browser saved, and no result from an invalid one', () => {
    const shot = { ...HEALTHY, screenshot: { width: 1280, height: 720 } }
    expect(parseWebCheckOutput(`${WEB_CHECK_MARKER}${JSON.stringify(shot)}`)).toEqual(shot)
    expect(parseWebCheckOutput(`${WEB_CHECK_MARKER}${JSON.stringify({ ...HEALTHY, screenshot: { width: 0, height: 720 } })}`)).toBeUndefined()
  })

  it('reads no result from missing, garbled, or invalid lines', () => {
    expect(parseWebCheckOutput('nothing here\n')).toBeUndefined()
    expect(parseWebCheckOutput(`${WEB_CHECK_MARKER}{"started": tru`)).toBeUndefined()
    expect(parseWebCheckOutput(`${WEB_CHECK_MARKER}${JSON.stringify({ ...HEALTHY, programs: -1 })}`)).toBeUndefined()
    expect(parseWebCheckOutput(`${WEB_CHECK_MARKER}${JSON.stringify({ ...HEALTHY, console: [{ level: 'loud', text: 'x' }] })}`)).toBeUndefined()
  })
})

describe('webCheckMessages', () => {
  it('counts Godot\'s errors and warnings and the page\'s errors, without location lines or plain output', () => {
    expect(webCheckMessages(SHOTGUN.console)).toEqual([
      { level: 'warning', text: 'WARNING: TAA is only available when using the Forward+ renderer.', count: 1 },
      { level: 'error', text: 'ERROR: shader type fog not supported in OpenGL renderer', count: 1 },
      { level: 'error', text: 'ERROR: Too many instances using shader instance variables. Consider increasing rendering/limits/global_shader_variables/buffer_size in the Project Settings. Maximum items supported by this hardware is: 1024.', count: 3 },
      { level: 'warning', text: 'WARNING: The Compatibility renderer does not support manually emitting particles.', count: 1 },
      { level: 'error', text: 'Uncaught TypeError: x is not a function', count: 1 },
    ])
  })
})

describe('webCheckMessages with counts', () => {
  it('adds how often the browser counted a message to the times it repeats', () => {
    const output = `${WEB_CHECK_MARKER}${JSON.stringify({
      ...HEALTHY,
      console: [
        { level: 'error', text: 'ERROR: Too many instances using shader instance variables.', count: 40 },
        { level: 'info', text: 'loaded' },
        { level: 'error', text: 'ERROR: Too many instances using shader instance variables.' },
      ],
    })}\n`
    const sample = parseWebCheckOutput(output) as WebCheckSample
    expect(sample.console[0]).toEqual({ level: 'error', text: 'ERROR: Too many instances using shader instance variables.', count: 40 })
    expect(sample.console[1]).toEqual({ level: 'info', text: 'loaded' })
    expect(webCheckMessages(sample.console)).toEqual([{ level: 'error', text: 'ERROR: Too many instances using shader instance variables.', count: 41 }])
    expect(parseWebCheckOutput(output.replace('"count":40', '"count":0'))).toBeUndefined()
  })
})

describe('summarizeWebCheck', () => {
  it('reports a healthy build without findings', () => {
    expect(summarizeWebCheck(HEALTHY, 20, 180_000)).toEqual({
      seconds: 20,
      started: true,
      startSeconds: 3,
      readySeconds: 4,
      longestFreezeSeconds: 0.4,
      freezes: 0,
      fps: 60,
      slowestFrameMs: 17,
      drawCalls: { median: 126, max: 130 },
      programs: 40,
      messages: [],
      moreMessages: 0,
      findings: [],
      problems: [],
    })
  })

  it('explains freezes, draw calls, frame rate, and the Compatibility renderer\'s missing features', () => {
    const report = summarizeWebCheck(SHOTGUN, 20, 180_000)
    expect(report).toMatchObject({
      startSeconds: 3.4, readySeconds: 52.3, longestFreezeSeconds: 30.2, freezes: 5, fps: 6, slowestFrameMs: 917,
      drawCalls: { median: 2915, max: 5193 }, programs: 226,
    })
    expect(report.findings).toEqual([
      'The game took 52.3 s from opening the page to draw frames steadily, with its files already on this computer; players also wait for the download first.',
      UNRESPONSIVE,
      'The page froze for up to 30.2 s at a time (5 freezes of a second or more), drawing nothing and answering no input; browsers offer to close a page that stays frozen. Browsers run Godot\'s scripts and drawing on one thread, so work that takes seconds in one frame stops the whole tab: spread it over frames, for example by building a level in chunks with `await get_tree().process_frame` between them. Many new materials or lights appearing at once also freeze it while their shaders compile.',
      'It drew about 2915 meshes per frame (WebGL draw calls, up to 5193); a browser spends far longer on each draw call than a desktop driver, so above about 1,500 the frame rate falls. Merge static meshes, draw repeated objects with MultiMeshInstance3D, and give small distant objects visibility ranges.',
      // Six frames in 1083 ms: one slow frame pulls the rate down, as players feel it.
      'It ran at 6 frames per second in a 1280x720 page.',
      'Some objects render with zeros for their `instance uniform` values: browsers keep every object\'s instance uniforms in one uniform buffer of 16 to 64 KB, 16 values per object, so only about 60 to 250 objects get theirs and the rest read zeros. Give fewer objects instance uniforms: share materials, or pack per-object values into MultiMesh custom data or vertex colors.',
      'GPUParticles3D.emit_particle() does nothing on the Web, where the Compatibility renderer draws, so particles emitted with it never appear: give each effect its own one-shot CPUParticles3D or GPUParticles3D node and restart() it instead.',
      'FogVolume shaders (`shader_type fog`) do not run on the Web, so that fog is missing there.',
      'TAA and FSR exist only in Forward+, so on the Web the edges they smoothed, such as alpha-tested leaves and shadow edges, show their raw pixels.',
    ])
  })

  it('reports a page that stopped answering, without frames it could not measure', () => {
    const report = summarizeWebCheck({ ...HEALTHY, frameMs: [], drawCalls: [], unresponsive: true }, 20, 180_000)
    expect(report).not.toHaveProperty('fps')
    expect(report).not.toHaveProperty('drawCalls')
    expect(report.findings).toEqual([STOPPED])
    const { readyMs: _ready, ...loading } = HEALTHY
    expect(summarizeWebCheck({ ...loading, frameMs: [], drawCalls: [], unresponsive: true }, 20, 120_000).findings).toEqual([
      'The game did not draw frames steadily within 120 s of opening the page, so players would see it frozen or crawling that long.',
      STOPPED,
    ])
  })

  it('reports a game that started but never drew frames steadily', () => {
    const { readyMs: _ready, ...frozen } = HEALTHY
    const report = summarizeWebCheck({ ...frozen, frameMs: [20_000], drawCalls: [900] }, 20, 120_000)
    expect(report).toMatchObject({ startSeconds: 3, fps: 0, slowestFrameMs: 20_000 })
    expect(report).not.toHaveProperty('readySeconds')
    expect(report.findings[0]).toBe('The game did not draw frames steadily within 120 s of opening the page, so players would see it frozen or crawling that long.')
  })

  it('reports a game that never started or whose page process ended', () => {
    const { startMs: _start, readyMs: _ready, ...loading } = HEALTHY
    const report = summarizeWebCheck({ ...loading, started: false, frameMs: [], drawCalls: [], crashed: 'oom' }, 20, 120_000)
    expect(report).toEqual({
      seconds: 20, started: false, longestFreezeSeconds: 0.4, freezes: 0, programs: 40, messages: [], moreMessages: 0, crashed: 'oom',
      findings: [
        'The page\'s process ended during the check (oom): a game that runs out of memory in a browser, which gives a page a few GB at most, stops this way.',
        'The game did not start within 120 s of opening the page, so the check saw only its loading.',
      ],
      problems: ['the game did not start', 'the page\'s process ended (oom)'],
    })
  })

  it('names the problems that stop a release: no steady frames, a page that stopped answering for good, and printed errors', () => {
    const { readyMs: _ready, ...frozen } = HEALTHY
    expect(summarizeWebCheck({ ...frozen, frameMs: [], drawCalls: [], unresponsive: true }, 20, 120_000).problems)
      .toEqual(['the game never drew frames steadily', 'the page stopped answering'])
    // A page that answered again drew frames afterwards, and warnings are findings only.
    expect(summarizeWebCheck({ ...HEALTHY, unresponsive: true, console: [{ level: 'error', text: 'WARNING: TAA is only available when using the Forward+ renderer.' }] }, 20, 180_000).problems)
      .toEqual([])
    const errors = [
      { level: 'error' as const, text: 'ERROR: shader type fog not supported in OpenGL renderer' },
      { level: 'error' as const, text: 'ERROR: shader type fog not supported in OpenGL renderer' },
      { level: 'error' as const, text: 'SCRIPT ERROR: Cannot call method \'compute_list_begin\' on a null value.' },
    ]
    expect(summarizeWebCheck({ ...HEALTHY, console: errors.slice(0, 1) }, 20, 180_000).problems).toEqual(['the build printed 1 error'])
    expect(summarizeWebCheck({ ...HEALTHY, console: errors }, 20, 180_000).problems).toEqual(['the build printed 2 different errors'])
    expect(summarizeWebCheck(SHOTGUN, 20, 180_000).problems).toEqual(['the build printed 3 different errors'])
  })

  it('explains a game that uses the RenderingDevice, which Web builds lack', () => {
    const finding = 'The game uses the RenderingDevice, which Web builds do not have: the Compatibility renderer has none, so `RenderingServer.get_rendering_device()` and `create_local_rendering_device()` return null, and compute shaders, RenderingDevice textures such as `Texture2DRD`, and `CompositorEffect`s do nothing or fail there. Give that work a path without the RenderingDevice, such as `SoftBody3D` sheets on Jolt for cloth, and look at it with godot_run with web set to true.'
    for (const text of [
      'SCRIPT ERROR: Cannot call method \'compute_list_begin\' on a null value.',
      'USER ERROR: Cloth: no RenderingDevice, so the solver cannot run.',
      'ERROR: Texture2DRD is not supported by this renderer.',
    ]) {
      expect(summarizeWebCheck({ ...HEALTHY, console: [{ level: 'error', text }] }, 20, 180_000).findings, text).toEqual([finding])
    }
  })

  it('names the screenshot the browser saved, at the path the check asked for', () => {
    const shot = { ...HEALTHY, screenshot: { width: 1280, height: 720 } }
    expect(summarizeWebCheck(shot, 20, 180_000, '/game/.wasdengine/web-check.jpg').screenshot)
      .toEqual({ path: '/game/.wasdengine/web-check.jpg', width: 1280, height: 720 })
    expect(summarizeWebCheck(shot, 20, 180_000)).not.toHaveProperty('screenshot')
    expect(summarizeWebCheck(HEALTHY, 20, 180_000, '/game/.wasdengine/web-check.jpg')).not.toHaveProperty('screenshot')
  })

  it('reports a low frame rate, and a single freeze only from two seconds on', () => {
    const slow = summarizeWebCheck({ ...HEALTHY, frameMs: [50, 50, 50], longTasks: [[0, 1500]] }, 20, 180_000)
    expect(slow.findings).toEqual(['It ran at 20 frames per second in a 1280x720 page.'])
    expect(summarizeWebCheck({ ...HEALTHY, longTasks: [[0, 1500], [3000, 1200]] }, 20, 180_000).findings[0])
      .toMatch(/^The page froze for up to 1.5 s at a time \(2 freezes of a second or more\)/u)
  })

  it('lists at most the message limit and counts the rest', () => {
    const console = Array.from({ length: WEB_CHECK_MESSAGES + 3 }, (_, index) => ({ level: 'error' as const, text: `ERROR: problem ${String(index)}` }))
    const report = summarizeWebCheck({ ...HEALTHY, console }, 20, 180_000)
    expect(report.messages).toHaveLength(WEB_CHECK_MESSAGES)
    expect(report.moreMessages).toBe(3)
  })
})

/** GET or HEAD one path of an origin. */
function fetchRaw(origin: string, path: string, method = 'GET', host?: string): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((done, fail) => {
    const req = request(`${origin}${path}`, { method, ...host === undefined ? {} : { headers: { host } } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { done({ status: response.statusCode ?? 0, type: response.headers['content-type'], body }) })
    })
    req.on('error', fail)
    req.end()
  })
}

describe('serveFolder', () => {
  it('serves the folder\'s files with their types and nothing outside it', async () => {
    const dir = await scratch('serve')
    folders.push(dir)
    const site = join(dir.root, 'site')
    await mkdir(join(site, 'sub'), { recursive: true })
    await writeFile(join(site, 'index.html'), '<p>hi</p>')
    await writeFile(join(site, 'index.wasm'), 'wasm')
    await writeFile(join(site, 'sub', 'a b.pck'), 'pack')
    await writeFile(join(dir.root, 'secret.txt'), 'no')
    const served = await serveFolder(site)
    try {
      expect(await fetchRaw(served.origin, '/index.html')).toEqual({ status: 200, type: 'text/html; charset=utf-8', body: '<p>hi</p>' })
      expect(await fetchRaw(served.origin, '/index.wasm')).toMatchObject({ status: 200, type: 'application/wasm', body: 'wasm' })
      expect(await fetchRaw(served.origin, '/sub/a%20b.pck')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'pack' })
      expect(await fetchRaw(served.origin, '/index.html', 'HEAD')).toMatchObject({ status: 200, body: '' })
      expect(await fetchRaw(served.origin, '/index.html', 'POST')).toMatchObject({ status: 405 })
      expect((await fetchRaw(served.origin, '/missing.js')).status).toBe(404)
      expect((await fetchRaw(served.origin, '/')).status).toBe(404)
      expect((await fetchRaw(served.origin, '/sub')).status).toBe(404)
      expect((await fetchRaw(served.origin, '/../secret.txt')).status).toBe(404)
      expect((await fetchRaw(served.origin, '/%2e%2e/secret.txt')).status).toBe(404)
      expect((await fetchRaw(served.origin, '/%E0%A4%A')).status).toBe(400)
      // A page that rebinds a name of its own to this computer names that name as its Host.
      expect((await fetchRaw(served.origin, '/index.html', 'GET', 'attacker.example')).status).toBe(403)
    } finally {
      await served.close()
    }
  })
})

/** Write a stand-in browser: a Node script that loads the requested page and prints `result`, or prints `output` alone. */
async function browser(dir: Scratch, behavior: { readonly result?: WebCheckSample; readonly output?: string }): Promise<string[]> {
  const script = join(dir.root, 'browser.mjs')
  await writeFile(script, `
const argument = process.argv.find(arg => arg.startsWith(${JSON.stringify(`${WEB_CHECK_ARGUMENT}=`)}))
const request = JSON.parse(argument.slice(${String(WEB_CHECK_ARGUMENT.length + 1)}))
const page = await fetch(request.url).then(response => response.text())
console.log('loaded ' + page.length + ' ' + request.width + 'x' + request.height + ' ' + request.seconds + ' ' + request.startTimeoutMs + ' ' + request.deadlineMs)
${behavior.output === undefined ? '' : `console.log(${JSON.stringify(behavior.output)})`}
${behavior.result === undefined ? '' : `console.log(${JSON.stringify(`${WEB_CHECK_MARKER}${JSON.stringify(behavior.result)}`)})`}
`)
  return [process.execPath, script]
}

posix('checkWebBuild', () => {
  const setup = async (behavior: { readonly result?: WebCheckSample; readonly output?: string }, command?: string[]) => {
    const dir = await scratch('web-check')
    folders.push(dir)
    const host = await subprocessFixture()
    hosts.push(host)
    const outputDir = join(dir.root, 'web')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'index.html'), '<canvas></canvas>')
    return {
      outputDir,
      check: async () => checkWebBuild({
        subprocess: host.subprocess, command: command ?? await browser(dir, behavior), outputDir, entry: 'index.html',
        seconds: 7, startTimeoutMs: 9000, timeoutMs: 30_000, graceMs: 1000, outputBytes: 64 * 1024, signal,
      }),
    }
  }

  it('opens the served page in the browser and summarizes its result', async () => {
    const { check } = await setup({ result: HEALTHY })
    expect(await check()).toEqual({ ...summarizeWebCheck(HEALTHY, 7, 9000), seconds: 7 })
  })

  it('keeps a megabyte of the browser\'s output at least, and tells the browser how much the result line may take', async () => {
    const dir = await scratch('web-check-output')
    folders.push(dir)
    const script = join(dir.root, 'browser.mjs')
    // Two megabytes of other output, then a result of about 800 KB that names the request's resultBytes in an error.
    await writeFile(script, `
const argument = process.argv.find(arg => arg.startsWith(${JSON.stringify(`${WEB_CHECK_ARGUMENT}=`)}))
const request = JSON.parse(argument.slice(${String(WEB_CHECK_ARGUMENT.length + 1)}))
const filler = 'x'.repeat(1023) + '\\n'
for (let index = 0; index < 2048; index++) process.stdout.write(filler)
const console = Array.from({ length: 400 }, (_unused, index) => ({ level: 'info', text: 'log ' + index + ' ' + 'y'.repeat(2000) }))
console.push({ level: 'error', text: 'ERROR: result bytes ' + request.resultBytes })
const result = ${JSON.stringify(HEALTHY)}
process.stdout.write(${JSON.stringify(WEB_CHECK_MARKER)} + JSON.stringify({ ...result, console }) + '\\n')
`)
    const host = await subprocessFixture()
    hosts.push(host)
    const outputDir = join(dir.root, 'web')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'index.html'), '<canvas></canvas>')
    const report = await checkWebBuild({
      subprocess: host.subprocess, command: [process.execPath, script], outputDir, entry: 'index.html',
      seconds: 7, startTimeoutMs: 9000, timeoutMs: 30_000, graceMs: 1000, outputBytes: 64 * 1024, signal,
    })
    expect(report.messages).toEqual([{ level: 'error', text: `ERROR: result bytes ${String(WEB_CHECK_OUTPUT_BYTES - 64 * 1024)}`, count: 1 }])
  })

  it('asks the browser for a screenshot where the request names one, after deleting an earlier one, and names it', async () => {
    const dir = await scratch('web-check-screenshot')
    folders.push(dir)
    const host = await subprocessFixture()
    hosts.push(host)
    const outputDir = join(dir.root, 'web')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'index.html'), '<canvas></canvas>')
    const screenshot = join(dir.root, 'web-check.jpg')
    await writeFile(screenshot, 'an earlier check')
    const script = join(dir.root, 'browser.mjs')
    // The stand-in reports whether the earlier screenshot was still there, then saves its own.
    await writeFile(script, `
import { existsSync, writeFileSync } from 'node:fs'
const argument = process.argv.find(arg => arg.startsWith(${JSON.stringify(`${WEB_CHECK_ARGUMENT}=`)}))
const request = JSON.parse(argument.slice(${String(WEB_CHECK_ARGUMENT.length + 1)}))
const console = [{ level: 'error', text: 'ERROR: earlier screenshot present: ' + existsSync(request.screenshot) }]
writeFileSync(request.screenshot, 'this check')
process.stdout.write(${JSON.stringify(WEB_CHECK_MARKER)} + JSON.stringify({ ...${JSON.stringify(HEALTHY)}, console, screenshot: { width: 640, height: 360 } }) + '\\n')
`)
    const report = await checkWebBuild({
      subprocess: host.subprocess, command: [process.execPath, script], outputDir, entry: 'index.html',
      seconds: 7, startTimeoutMs: 9000, timeoutMs: 30_000, graceMs: 1000, outputBytes: 64 * 1024, screenshot, signal,
    })
    expect(report.messages).toEqual([{ level: 'error', text: 'ERROR: earlier screenshot present: false', count: 1 }])
    expect(report.screenshot).toEqual({ path: screenshot, width: 640, height: 360 })
    expect(await readFile(screenshot, 'utf8')).toBe('this check')
  })

  it('fails without a browser, and when the browser prints no result', async () => {
    const empty = await setup({}, [])
    await expect(empty.check()).rejects.toThrow(new GodotWebCheckError(WEB_CHECK_UNAVAILABLE))
    const silent = await setup({ output: 'GPU process isn\'t usable' })
    const failure = await silent.check().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GodotWebCheckError)
    expect((failure as Error).message).toBe([
      'The Web check\'s browser ended (exit code 0) without a result.',
      'Last output:',
      // The browser's own deadline leaves it 10 s before the check's to print its result and exit.
      'loaded 17 1280x720 7 9000 20000',
      'GPU process isn\'t usable',
    ].join('\n'))
  })
})
