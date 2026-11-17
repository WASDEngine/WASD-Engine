// Stand-in for the LibGodot runner in tests; tests/helpers.ts starts it through a shell script that runs Node. Like
// `godot_runner`, it takes `--libgodot <library> --parent-pid <pid> --` before Godot's own command line, which it
// keeps. It reads its behavior from `.fake-godot.json` in the `--path` project folder and appends the Godot command
// line it received to `.fake-godot.log` there; the names are hidden, as Godot's import skips hidden files, so they never
// count as project changes. Modes follow the Host's command lines: `--import` runs the import step, which writes the
// class cache `.godot/global_script_class_cache.cfg` unless `classCache` is false and records `imported` at its end,
// `--export-release` writes the configured export files next to the requested page, in subfolders as their names say,
// records the export presets, the `project.godot` it saw, the size of the boot splash image it names, and the Android
// export's environment variables, appends the configured `appendProject` text to `project.godot` when there is one, and
// records `exported` at its end, `--headless ... --script` runs the `script` section, which writes its `files` into the
// folder that WASD_OUTPUT_DIR names and records `scripted` with that folder, HOME, and its start and end times at its
// end, when the config has one, a bare `--headless --path` run plays the `instance` section entry named by the
// instance's `WASD_TEST_NAME` (or its `*` entry) when the config has an `instance` section, and the static check, which
// records `checked` at its end, otherwise; anything else runs a game that speaks the wasd_harness.gd protocol on the
// loopback port the Host passes.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'

const raw = process.argv.slice(2)
const args = raw[0] === '--libgodot' ? raw.slice(raw.indexOf('--') + 1) : raw
const project = args[args.indexOf('--path') + 1]
const configFile = join(project, '.fake-godot.json')
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
const record = entry => appendFileSync(join(project, '.fake-godot.log'), `${JSON.stringify(entry)}\n`)
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const write = (stream, text) => new Promise(resolve => stream.write(text, resolve))

record({ argv: args })

async function emitOutput(section) {
  if (section.stdout !== undefined) await write(process.stdout, section.stdout)
  if (section.stderr !== undefined) await write(process.stderr, section.stderr)
}

async function finish(section) {
  if (section.signal !== undefined) process.kill(process.pid, section.signal)
  process.exit(section.exitCode ?? 0)
}

async function runImport(section) {
  await emitOutput(section)
  if (section.delayMs !== undefined) await sleep(section.delayMs)
  if (section.classCache !== false) {
    mkdirSync(join(project, '.godot'), { recursive: true })
    writeFileSync(join(project, '.godot', 'global_script_class_cache.cfg'), 'list=[]\n')
  }
  record({ imported: true })
  await finish(section)
}

async function runScript(section) {
  const startedAt = Date.now()
  const outputDir = process.env.WASD_OUTPUT_DIR
  await emitOutput(section)
  if (section.delayMs !== undefined) await sleep(section.delayMs)
  // The `files` section names files to write into the run's WASD_OUTPUT_DIR, as a script writes its results there.
  for (const [name, text] of Object.entries(section.files ?? {})) {
    mkdirSync(dirname(join(outputDir, name)), { recursive: true })
    writeFileSync(join(outputDir, name), text)
  }
  record({ scripted: true, outputDir: outputDir ?? null, home: process.env.HOME ?? null, startedAt, endedAt: Date.now() })
  await finish(section)
}

async function runCheck(section) {
  const paths = args.slice(args.lastIndexOf('--') + 1)
  if (section.delayMs !== undefined) await sleep(section.delayMs)
  for (const path of paths) {
    // An add-on plugin that the check loads before this script, as `wasd_check.gd` reports it on its own line.
    const plugin = section.plugins?.[path]
    if (plugin !== undefined) await write(process.stdout, `WASD_CHECK ${JSON.stringify({ path: plugin.path, plugin: true, loaded: true, errors: plugin.errors ?? [] })}\n`)
    if (section.omit?.includes(path)) continue
    if (section.garbage?.includes(path)) {
      await write(process.stdout, `WASD_CHECK {"path": "${path}", "loaded"\n`)
      continue
    }
    if (section.invalid?.includes(path)) {
      await write(process.stdout, `WASD_CHECK ${JSON.stringify({ path, loaded: 'yes', errors: [] })}\n`)
      continue
    }
    await write(process.stdout, `WASD_CHECK ${JSON.stringify({ path, loaded: true, errors: section.errors?.[path] ?? [] })}\n`)
  }
  await emitOutput(section)
  record({ checked: true })
  await finish(section)
}

function frame(seq, width, height) {
  const payload = Buffer.alloc(8 + 8)
  payload.writeUInt32LE(seq, 0)
  payload.writeUInt16LE(width, 4)
  payload.writeUInt16LE(height, 6)
  payload.write(`JPEG${String(seq).padStart(4, '0')}`, 8, 'latin1')
  return payload
}

async function runGame(section) {
  const user = args.slice(args.lastIndexOf('--') + 1)
  const value = name => user.find(arg => arg.startsWith(`--wasd-${name}=`))?.slice(`--wasd-${name}=`.length)
  const port = Number(value('port'))
  const token = value('token')
  await emitOutput(section)
  if (section.exitBeforeConnect !== undefined) process.exit(section.exitBeforeConnect)
  const keepAlive = setInterval(() => {}, 1000)
  if (section.connect === 'never') return
  if (section.connectDelayMs !== undefined) await sleep(section.connectDelayMs)
  if (section.decoy) {
    const decoy = net.connect(port, '127.0.0.1')
    decoy.on('error', () => {})
    await once(decoy, 'connect')
    if (section.decoy === 'garbage') {
      const header = Buffer.alloc(5)
      header.writeUInt32LE(0x7fffffff, 0)
      decoy.write(header)
    }
    await sleep(50)
  }
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  const encode = (kind, payload) => {
    const header = Buffer.alloc(5)
    header.writeUInt32LE(payload.length + 1, 0)
    header[4] = kind
    return Buffer.concat([header, payload])
  }
  const encodeJson = message => encode(1, Buffer.from(JSON.stringify(message), 'utf8'))
  const send = (kind, payload) => socket.write(encode(kind, payload))
  const json = message => socket.write(encodeJson(message))
  const state = { frame: 1, paused: false, width: section.width ?? 640, height: section.height ?? 360, sequence: 0, stream: undefined, frozen: false, presenting: true }
  const status = () => ({
    type: 'status', frame: state.frame, fps: 60, paused: state.paused, scene: section.scene ?? 'res://main.tscn',
    mouseMode: 0, width: state.width, height: state.height, droppedLogs: 0,
  })
  const hello = {
    type: 'hello', protocol: section.protocol ?? 1, token: section.token ?? token, pid: process.pid, godot: '4.7.2-stable (fake)',
    project: 'Fake', mainScene: 'res://main.tscn', displayServer: section.displayServer ?? 'headless',
    renderingDriver: 'fake', renderingMethod: 'forward_plus', width: state.width, height: state.height,
    ...section.layer === undefined ? {} : { layer: section.layer },
    ...section.wasdRuntime === undefined ? {} : { wasdRuntime: section.wasdRuntime },
  }
  switch (section.first ?? 'hello') {
    case 'frame': send(2, frame(1, 1, 1)); break
    case 'status': json(status()); break
    case 'garbage': {
      const header = Buffer.alloc(5)
      header.writeUInt32LE(0x7fffffff, 0)
      socket.write(header)
      break
    }
    case 'split': {
      const whole = encodeJson(hello)
      socket.write(whole.subarray(0, 2))
      await sleep(30)
      socket.write(whole.subarray(2))
      break
    }
    // hello and the first logs message in one write, as the harness's first frame can send them
    case 'withLogs': socket.write(Buffer.concat([encodeJson(hello), encodeJson({ type: 'logs', entries: section.firstLogs })])); break
    default: json(hello)
  }
  if (section.status !== false) json(status())
  if (section.repeatHello) json(hello)
  if (section.logs !== undefined) json({ type: 'logs', entries: section.logs })
  if (section.garbageAfterHello) send(9, Buffer.from('?'))
  if (section.selfExitAfterMs !== undefined) {
    setTimeout(() => {
      state.exiting = true
      socket.end()
      setTimeout(() => process.exit(0), 50)
    }, section.selfExitAfterMs)
  }
  const ticker = setInterval(() => {
    if (state.frozen) return
    state.frame += 1
    if (section.statusIntervalMs !== undefined && state.frame % Math.max(1, Math.round(section.statusIntervalMs / 20)) === 0) json(status())
  }, 20)
  let streamer
  const stopStream = () => {
    clearInterval(streamer)
    streamer = undefined
  }
  const reply = (id, body) => json({ type: 'result', id, ok: true, ...body })
  const fail = (id, error) => json({ type: 'result', id, ok: false, ...error === undefined ? {} : { error } })
  const quit = async () => {
    clearInterval(ticker)
    stopStream()
    const onQuit = section.onQuit ?? 'exit'
    if (onQuit === 'ignore') return
    socket.end()
    if (onQuit === 'linger') return
    clearInterval(keepAlive)
    await sleep(30)
    process.exit(section.quitExitCode ?? 0)
  }
  const exitNow = async (exit) => {
    state.exiting = true
    clearInterval(ticker)
    stopStream()
    if (exit.holdSocket) {
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'ignore', 'ignore', socket] })
      holder.unref()
      await sleep(100)
    } else if (exit.closeFirst) {
      socket.end()
      await sleep(200)
    }
    if (exit.stdout !== undefined) await write(process.stdout, exit.stdout)
    if (exit.stderr !== undefined) await write(process.stderr, exit.stderr)
    if (exit.signal !== undefined) process.kill(process.pid, exit.signal)
    process.exit(exit.code ?? 0)
  }
  const handle = async (message) => {
    record({ request: message })
    if (section.logsOn?.[message.type] !== undefined) json({ type: 'logs', entries: section.logsOn[message.type] })
    const behavior = section.replies?.[message.type]
    if (section.exitOn?.type === message.type) return exitNow(section.exitOn)
    if (section.resetOn === message.type) {
      socket.resetAndDestroy()
      if (section.exitAfterReset !== undefined) {
        await sleep(100)
        process.exit(section.exitAfterReset)
      }
      return
    }
    if (section.closeOn === message.type) {
      socket.end()
      return
    }
    if (section.freezeOn === message.type) {
      state.frozen = true
      return
    }
    if (section.stray === message.type) {
      const id = Buffer.alloc(4)
      id.writeUInt32LE(message.id, 0)
      send(3, Buffer.concat([id, Buffer.from('stray')]))
      id.writeUInt32LE(999_999, 0)
      send(3, Buffer.concat([id, Buffer.from('stray')]))
    }
    if (behavior === 'none') return
    if (behavior === 'error') return fail(message.id, `fake ${message.type} failure`)
    if (behavior === 'noerror') return fail(message.id, undefined)
    if (typeof behavior === 'string' && behavior.startsWith('slow:')) await sleep(Number(behavior.slice(5)))
    // `failAfter:<ms>` refuses the request once that many milliseconds have passed.
    if (typeof behavior === 'string' && behavior.startsWith('failAfter:')) {
      await sleep(Number(behavior.slice('failAfter:'.length)))
      return fail(message.id, `fake ${message.type} failure`)
    }
    switch (message.type) {
      case 'stream':
        stopStream()
        state.stream = message
        if (message.fps > 0) {
          streamer = setInterval(() => {
            state.sequence += 1
            send(2, frame(state.sequence, Math.min(state.width, message.maxWidth), state.height))
          }, Math.max(5, Math.round(1000 / message.fps)))
        }
        return reply(message.id, { fps: message.fps })
      case 'pace':
        if (message.present !== undefined) state.presenting = message.present
        return reply(message.id, { maxFps: message.maxFps, presenting: state.presenting })
      case 'screenshot': {
        const scale = message.maxWidth > 0 && state.width > message.maxWidth ? message.maxWidth / state.width : 1
        const jpeg = message.format === 'jpeg'
        const meta = {
          format: jpeg ? 'jpeg' : 'png', width: Math.round(state.width * scale), height: Math.round(state.height * scale),
          windowWidth: state.width, windowHeight: state.height, frame: state.frame, paused: state.paused,
        }
        const id = Buffer.alloc(4)
        id.writeUInt32LE(message.id, 0)
        const image = Buffer.concat([id, Buffer.from(jpeg ? 'JPEG-BYTES' : section.png ?? 'PNG-BYTES', 'latin1')])
        if (section.imageFirst) send(3, image)
        reply(message.id, meta)
        if (!section.imageFirst) send(3, image)
        return
      }
      case 'view': {
        const id = Buffer.alloc(4)
        id.writeUInt32LE(message.id, 0)
        reply(message.id, {
          format: 'png', width: message.width, height: message.height, frame: state.frame, paused: state.paused,
          camera: { position: [0, 2, 6], direction: [0, -0.3, -1], fov: 35 },
        })
        send(3, Buffer.concat([id, Buffer.from('VIEW-PNG-BYTES', 'latin1')]))
        return
      }
      case 'input': {
        if (message.events.some(event => event.key === 'BadKey')) return fail(message.id, 'unknown key BadKey')
        // `timedOut` answers as a sequence that its real-time limit ended after half of its events.
        const timedOut = behavior === 'timedOut'
        const waited = timedOut ? 0 : message.events.reduce((sum, event) => sum + (event.wait ?? 0), 0)
        if (waited > 0) await sleep(waited * 1000)
        state.frame += 1
        const events = timedOut ? Math.floor(message.events.length / 2) : message.events.length
        return reply(message.id, { events, frames: 1 + Math.round(waited * 60), seconds: waited, frame: state.frame, timedOut, cancelled: false })
      }
      case 'wait': {
        // `timedOut` answers as a wait that its real-time limit ended halfway.
        const timedOut = behavior === 'timedOut'
        const requested = message.seconds ?? message.frames / 60
        const seconds = timedOut ? requested / 2 : requested
        await sleep(Math.min(seconds * 1000, 2000))
        const frames = timedOut || message.frames === undefined ? Math.round(seconds * 60) : message.frames
        state.frame += frames
        return reply(message.id, { frames, seconds, frame: state.frame, paused: state.paused, timedOut, cancelled: false })
      }
      case 'pause':
      case 'resume':
        state.paused = message.type === 'pause'
        reply(message.id, { paused: state.paused, frame: state.frame })
        return json(status())
      case 'step': {
        // `cancelled` answers as a step that a resume ended halfway, `timedOut` as one that its real-time limit ended
        // halfway, which pauses the game.
        const cancelled = behavior === 'cancelled'
        const timedOut = behavior === 'timedOut'
        const frames = cancelled || timedOut ? Math.floor(message.frames / 2) : message.frames
        state.frame += frames
        state.paused = !cancelled
        return reply(message.id, { frames, seconds: frames / 60, frame: state.frame, paused: state.paused, timedOut, cancelled })
      }
      case 'cancel':
        if (state.heldAudio?.id === message.request) {
          const held = state.heldAudio
          state.heldAudio = undefined
          held.answer(true)
        }
        return reply(message.id, { cancelled: true })
      case 'eval':
        return reply(message.id, { value: section.evalValue ?? message.expression, valueType: 'String' })
      case 'tree':
        return reply(message.id, { tree: section.tree ?? { name: 'Main', class: 'Node2D', path: '/root/Main' }, truncated: section.treeTruncated ?? false })
      case 'performance': {
        const series = ['frame', 'physics', 'harness', 'process', 'draw', 'gpu', 'renderCpu', 'objects', 'primitives', 'drawCalls']
        return reply(message.id, section.performance ?? {
          seconds: message.seconds, frames: 0, droppedFrames: 0, pausedFrames: 0, physicsSteps: 0, streamedFrames: 0,
          series: Object.fromEntries(series.map(name => [name, []])), monitorsStart: {}, monitorsEnd: {}, custom: {},
          nodes: { total: 1, processing: 0, physicsProcessing: 0, truncated: false, classes: [['Window', 1]], scripts: [] },
          context: {
            paused: state.paused, timeScale: 1, maxFps: 0, physicsTicksPerSecond: 60, vsyncMode: 1, lowProcessorMode: false,
            renderingMethod: 'forward_plus', renderingDriver: 'fake', adapter: '', adapterVendor: '', width: state.width, height: state.height, streamFps: 0,
            frameCap: 0, presenting: state.presenting, refreshRate: 60, wasdRuntime: section.wasdRuntime ?? false,
          },
          scriptProfiler: section.wasdRuntime ?? false, scripts: [], scriptSeconds: 0, scriptFrames: 0, engineCalls: false,
          timedOut: false, cancelled: false,
        })
      }
      case 'audio': {
        // A capture of `seconds` of a 441 Hz sine at half scale in both channels, or the configured `audio` reply and
        // samples; the samples follow the answer as kind 5. With `replies.audio` 'untilCancel', the capture answers
        // with a tenth of a second when a `cancel` names it.
        const rate = 44100
        if (behavior === 'untilCancel' && message.held !== true) {
          state.heldAudio = { id: message.id, answer: () => handle({ ...message, seconds: 0.1, held: true }) }
          return
        }
        const frames = section.audio?.frames ?? Math.round(message.seconds * rate)
        const samples = Buffer.alloc(4 + frames * 8)
        samples.writeUInt32LE(message.id, 0)
        const amplitude = section.audio?.amplitude ?? 0.5
        for (let index = 0; index < frames; index++) {
          const value = amplitude * Math.sin(2 * Math.PI * 441 * index / rate)
          samples.writeFloatLE(value, 4 + index * 8)
          samples.writeFloatLE(value, 8 + index * 8)
        }
        reply(message.id, {
          sampleRate: rate, channels: 2, frames, seconds: frames / rate, droppedFrames: 0, masterVolumes: [[0, 0, false]],
          masterBypassed: false, detached: false, driver: 'Dummy', outputLatencyMs: 0, startFrame: state.frame, frame: state.frame,
          buses: [{ name: 'Master', volumeDb: 0, mute: false, solo: false, bypass: false, send: '', effects: [], peakDb: -6 }],
          players: [], morePlayers: 0, timedOut: false, cancelled: message.held === true, ...section.audio?.reply,
        })
        return send(5, samples)
      }
      case 'quit':
        reply(message.id, { quitting: true })
        return quit()
      default:
        return fail(message.id, `unknown request type ${message.type}`)
    }
  }
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0)
      if (buffered.length < 4 + length) return
      const body = buffered.subarray(5, 4 + length)
      buffered = buffered.subarray(4 + length)
      void handle(JSON.parse(body.toString('utf8')))
    }
  })
  socket.on('close', () => {
    record({ closed: true })
    if (section.onHostClose !== 'linger' && !state.exiting) process.exit(0)
  })
}

async function runInstance(section) {
  const name = process.env.WASD_TEST_NAME ?? ''
  record({ instance: name, role: process.env.WASD_MULTIPLAYER_TEST ?? null, port: process.env.WASD_TEST_PORT ?? null, ticket: process.env.WASD_TEST_TICKET ?? null, at: Date.now() })
  const behavior = section[name] ?? section['*'] ?? {}
  if (behavior.delayMs !== undefined) await sleep(behavior.delayMs)
  await emitOutput(behavior)
  await finish(behavior)
}

/** The environment variables an export records, which the Android export sets for Godot. */
const EXPORT_ENV = [
  'HOME', 'JAVA_HOME', 'ANDROID_HOME', 'GODOT_ANDROID_KEYSTORE_RELEASE_PATH', 'GODOT_ANDROID_KEYSTORE_RELEASE_USER',
  'GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD',
]

async function runExport(section) {
  const page = args[args.indexOf('--export-release') + 2]
  const presets = join(project, 'export_presets.cfg')
  const settings = readFileSync(join(project, 'project.godot'), 'utf8')
  // The boot splash image Godot would pack: the file that the last boot_splash/image line names, as Godot reads it.
  const splash = [...settings.matchAll(/^boot_splash\/image="res:\/\/([^"]+)"/gmu)].at(-1)?.[1]
  const splashFile = splash === undefined ? undefined : join(project, ...splash.split('/'))
  record({
    preset: args[args.indexOf('--export-release') + 1],
    presets: existsSync(presets) ? readFileSync(presets, 'utf8') : null,
    project: settings,
    splashBytes: splashFile !== undefined && existsSync(splashFile) ? readFileSync(splashFile).length : null,
    env: Object.fromEntries(EXPORT_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
  })
  if (section.appendProject !== undefined) appendFileSync(join(project, 'project.godot'), section.appendProject)
  await emitOutput(section)
  if (section.delayMs !== undefined) await sleep(section.delayMs)
  for (const [name, text] of Object.entries(section.files ?? {})) {
    mkdirSync(dirname(join(dirname(page), name)), { recursive: true })
    writeFileSync(join(dirname(page), name), text)
  }
  record({ exported: true })
  await finish(section)
}

if (args.includes('--import')) await runImport(config.import ?? {})
else if (args.includes('--export-release')) await runExport(config.export ?? {})
else if (args.includes('--headless') && config.script !== undefined) await runScript(config.script)
else if (args.includes('--headless') && !args.includes('--script') && config.instance !== undefined) await runInstance(config.instance)
else if (args.includes('--headless')) await runCheck(config.check ?? {})
else await runGame(config.game ?? {})
