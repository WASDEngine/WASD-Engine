/**
 * Stand-in for sclang behind the bridge. It reads terminal input in ESC-ended commands, answers the bridge's
 * WasdWorker.boot and WasdWorker.dispatch calls with the worker class's reply lines, and posts other text to stdout.
 * FAKE_SCLANG_MODE selects a startup behavior: `normal`, `bad-ready` (an invalid ready line), `no-class` (the error
 * sclang posts when the worker class is missing), or `stubborn` (it ignores the end of its input). The method name
 * selects a reply: `echo`, `fail`, `partial`, `wrong_id`, `garbage`, `twice`, `hang`, `crash`, and `error_only`.
 */
import { readFileSync, rmSync } from 'node:fs'

const mode = process.env.FAKE_SCLANG_MODE ?? 'normal'
const post = (text) => { process.stdout.write(text) }
let token = ''

const unquote = (text) => text.replace(/\\(.)/gu, '$1')

function reply(id, value) {
  post(`\n${token} END ${String(id)} ${JSON.stringify(value)}\n`)
}

function dispatch(id, method, params) {
  switch (method) {
    case 'echo':
      post('posted text\n')
      reply(id, { ok: true, result: { params } })
      break
    case 'fail':
      post('ERROR: it failed\n')
      reply(id, { ok: false, error: { type: 'Error', message: 'boom', traceback: 'receiver: 1' } })
      break
    case 'error_only':
      reply(id, { ok: false, error: { type: 'Error', message: 'quiet' } })
      break
    case 'partial':
      post('no newline')
      reply(id, { ok: true, result: {} })
      break
    case 'wrong_id':
      reply(id + 1, { ok: true, result: {} })
      break
    case 'garbage':
      post(`\n${token} END ${String(id)} not json\n`)
      break
    case 'twice':
      reply(id, { ok: true, result: {} })
      reply(id, { ok: true, result: {} })
      break
    case 'hang':
      break
    case 'crash':
      process.exit(3)
      break
    default:
      reply(id, { ok: false, error: { type: 'Error', message: `no method ${method}` } })
  }
}

function command(text) {
  if (text === '0.exit') {
    if (mode !== 'stubborn') process.exit(0)
    return
  }
  const boot = /^WasdWorker\.boot\("([0-9a-f]+)", "((?:[^"\\]|\\.)*)"\)$/u.exec(text)
  if (boot !== null) {
    if (mode === 'no-class') {
      post('ERROR: Class not defined.\nERROR: Command line parse failed\n')
      return
    }
    token = boot[1]
    const params = JSON.parse(readFileSync(unquote(boot[2]), 'utf8'))
    post(mode === 'bad-ready' ? `\n${token} READY {"version": 3}\n` : `\n${token} READY ${JSON.stringify({ version: '3.14.1-fake', helpSource: params.helpSource })}\n`)
    return
  }
  const call = /^WasdWorker\.dispatch\((\d+), "([a-z_]+)", "((?:[^"\\]|\\.)*)"\)$/u.exec(text)
  if (call === null) {
    post(`ERROR: unknown command ${text}\n`)
    return
  }
  const file = unquote(call[3])
  const params = JSON.parse(readFileSync(file, 'utf8'))
  rmSync(file)
  dispatch(Number(call[1]), call[2], params)
}

post('compiling class library...\n')
process.stderr.write('fake sclang starting\n')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (let end = buffer.indexOf('\u001b'); end !== -1; end = buffer.indexOf('\u001b')) {
    command(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
  }
})
process.stdin.on('end', () => {
  if (mode === 'stubborn') setInterval(() => {}, 1000)
  else process.exit(0)
})
