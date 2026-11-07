/**
 * Protocol fixture standing in for a Python application worker. It writes its
 * ready line and replies to fd 3, logs to stdout and stderr, and reads JSON
 * request lines from stdin, handling one request at a time like a
 * single-threaded worker. argv[2] selects a start or shutdown behavior;
 * request methods select reply behaviors. When FAKE_WORKER_PIDS names a file,
 * the worker appends its pid to it.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const mode = process.argv[2] ?? 'ready'
const READY = { ready: true, protocol: 1, app: 'fake', version: '1.2.3', python: '3.13.1' }
const send = (value) => { writeSync(3, `${JSON.stringify(value)}\n`) }

if (process.env.FAKE_WORKER_PIDS) appendFileSync(process.env.FAKE_WORKER_PIDS, `${process.pid}\n`)

switch (mode) {
  case 'garbage-ready':
    writeSync(3, 'not a ready line\n')
    break
  case 'wrong-protocol':
    send({ ...READY, protocol: 2 })
    break
  case 'silent':
    process.stderr.write('loading forever\n')
    setInterval(() => {}, 1000)
    break
  case 'exit-before-ready':
    process.stderr.write('cannot import bpy\n')
    process.exit(4)
    break
  case 'killed-before-ready':
    process.kill(process.pid, 'SIGKILL')
    break
  case 'oversized-ready':
    writeSync(3, 'x'.repeat(Number(process.argv[3])))
    setInterval(() => {}, 1000)
    break
  case 'immortal':
    process.on('SIGTERM', () => { process.stderr.write('ignoring SIGTERM\n') })
    send(READY)
    break
  case 'no-stdin':
    // Close the request pipe before anything reads it: every request write then fails with EPIPE.
    closeSync(0)
    send(READY)
    setInterval(() => {}, 1000)
    break
  default:
    send(READY)
}

/** Modes that ignore both the shutdown request and the end of stdin. */
const stubborn = mode === 'stubborn' || mode === 'immortal'
/** Keeps the process alive once stdin no longer does. */
const keepAlive = () => { setInterval(() => {}, 1000) }
if (stubborn) keepAlive()
let ended = false
let busy = false
const queue = []

if (mode !== 'no-stdin') {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    queue.push(JSON.parse(line))
    void pump()
  })
  lines.on('close', () => {
    ended = true
    if (!busy) finish()
  })
}

function finish() {
  if (!stubborn) process.exit(0)
}

async function pump() {
  if (busy) return
  busy = true
  while (queue.length > 0) await handle(queue.shift())
  busy = false
  if (ended) finish()
}

async function handle({ id, method, params }) {
  switch (method) {
    case 'echo':
      return send({ id, ok: true, result: params })
    case 'fail':
      return send({ id, ok: false, error: {
        type: 'ValueError',
        message: params.message ?? 'boom',
        traceback: params.traceback ?? 'Traceback (most recent call last):\n  File "<tool>", line 1, in <module>\nValueError: boom',
      } })
    case 'fail-without-traceback':
      return send({ id, ok: false, error: { type: 'KeyError', message: 'missing' } })
    case 'sleep':
      await delay(params.ms)
      return send({ id, ok: true, result: { slept: params.ms } })
    case 'crash':
      process.stderr.write('fatal: crashing on purpose\n')
      return process.exit(params.code ?? 3)
    case 'die':
      return process.kill(process.pid, 'SIGKILL')
    case 'noisy':
      if (params.stdout) process.stdout.write(params.stdout)
      if (params.stderr) process.stderr.write(params.stderr)
      return send({ id, ok: true, result: null })
    case 'garbage':
      return writeSync(3, 'this is not json\n')
    case 'garbage-twice':
      return writeSync(3, 'first garbage\nsecond garbage\n')
    case 'invalid-utf8':
      return writeSync(3, Buffer.from([0xff, 0xfe, 0x0a]))
    case 'wrong-id':
      return send({ id: id + 100, ok: true, result: null })
    case 'twice':
      send({ id, ok: true, result: 1 })
      return send({ id, ok: true, result: 2 })
    case 'oversized':
      return writeSync(3, `{"id":${id},"ok":true,"result":"${'x'.repeat(params.bytes)}"}\n`)
    case 'split': {
      const line = `${JSON.stringify({ id, ok: true, result: params })}\n`
      writeSync(3, line.slice(0, 5))
      await delay(30)
      return writeSync(3, line.slice(5))
    }
    case 'multibyte-split': {
      const bytes = Buffer.from(`${JSON.stringify({ id, ok: true, result: '€uro' })}\n`)
      // Cut after the first byte of the three-byte euro sign.
      const cut = bytes.indexOf(0xe2) + 1
      writeSync(3, bytes.subarray(0, cut))
      await delay(30)
      return writeSync(3, bytes.subarray(cut))
    }
    case 'garbage-long':
      return writeSync(3, `${'z'.repeat(300)}\n`)
    case 'exit-later':
      send({ id, ok: true, result: null })
      setTimeout(() => { process.exit(params.code ?? 0) }, params.ms ?? 20)
      return
    case 'orphan': {
      // The grandchild inherits the log and reply pipes (fd 3 by number) and stays in this process group.
      const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit', 3] })
      send({ id, ok: true, result: { orphan: orphan.pid } })
      setTimeout(() => { process.exit(5) }, 50)
      return
    }
    case 'pid':
      return send({ id, ok: true, result: process.pid })
    case 'shutdown':
      if (stubborn) return
      if (mode === 'ack-shutdown') send({ id, ok: true, result: null })
      return process.exit(0)
    default:
      return send({ id, ok: false, error: { type: 'MethodNotFound', message: `unknown method ${method}` } })
  }
}
