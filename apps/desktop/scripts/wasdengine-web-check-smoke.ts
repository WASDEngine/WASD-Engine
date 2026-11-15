/**
 * Web check smoke test of a packaged Desktop app (WASDEngine fork). Packaging runs it once the application is
 * assembled, signed, or notarized, from `smoke-packaged-runtime.ts`: it starts the application's Web check mode the way
 * the Godot plugin does — on macOS from the Web Check Helper bundle of `src/wasdengine-web-check-helper.ts`, elsewhere
 * from the application's executable — against a small loopback page that draws with WebGL, and requires a result that
 * saw the page start, run frames, and log, with no crash and no stall, and saw WebGL draw calls when the machine offers
 * WebGL 2. A helper that cannot start under the build's signature, cannot find Electron's framework, or prints no result
 * then fails packaging instead of every user's Web check; a packaging machine without a GPU, such as a CI runner, still
 * passes on frames alone.
 * @module
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import type { WebCheckRequest, WebCheckSample } from '@deepseek-ai/dsh-godot/types'
import { WASDENGINE_DESKTOP_BRAND } from '../src/wasdengine-brand.ts'
import { WEB_CHECK_ARGUMENT, WEB_CHECK_MARKER, webCheckCommand } from '../src/wasdengine-web-check.ts'
import { webCheckHelperExecutable } from '../src/wasdengine-web-check-helper.ts'

/** The console message the smoke page logs once it removed its loading overlay; ` (WebGL 2)` or ` (no WebGL 2)` follows. */
export const SMOKE_READY_MESSAGE = 'WASD Engine Web check smoke page started'

/** What the ready message ends with when the page draws with WebGL 2. */
export const SMOKE_WEBGL_SUFFIX = ' (WebGL 2)'

/**
 * The smoke page: Godot's page shape as the check reads it (a `#status` loading overlay that the page removes once the
 * game runs), and, where the machine offers WebGL 2, a program and one draw call per animation frame.
 */
export const SMOKE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Web check smoke</title></head>
<body style="margin:0;background:#000">
<div id="status">Loading</div>
<canvas id="canvas" width="64" height="64"></canvas>
<script>
const gl = document.getElementById('canvas').getContext('webgl2');
if (gl) {
  const shader = (type, source) => { const made = gl.createShader(type); gl.shaderSource(made, source); gl.compileShader(made); return made; };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, '#version 300 es\\nvoid main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 8.0; }'));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision mediump float;\\nout vec4 color;\\nvoid main() { color = vec4(0.47, 0.33, 1.0, 1.0); }'));
  gl.linkProgram(program);
  gl.useProgram(program);
}
const draw = () => {
  if (gl) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, 1); }
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
setTimeout(() => {
  document.getElementById('status').remove();
  console.log(${JSON.stringify(SMOKE_READY_MESSAGE)} + (gl ? ${JSON.stringify(SMOKE_WEBGL_SUFFIX)} : ' (no WebGL 2)'));
}, 100);
</script>
</body></html>
`

/** The check's request for the smoke page at `url`: two watched seconds, within generous limits for a loaded builder. */
export function smokeRequest(url: string): WebCheckRequest {
  return { url, seconds: 2, startTimeoutMs: 30_000, deadlineMs: 60_000, width: 320, height: 240 }
}

/**
 * What a smoke result lacks: a page that never started, crashed, stopped answering, ran no animation frames, or whose
 * console message never arrived; and, when that message says the page had WebGL 2, no linked program or draw calls.
 * @param sample - the result the Web check mode printed.
 * @returns one sentence per problem; empty when the result is complete.
 */
export function webCheckSmokeProblems(sample: WebCheckSample): string[] {
  const problems: string[] = []
  if (!sample.started) problems.push('the page never removed its loading overlay')
  if (sample.crashed !== undefined) problems.push(`the page's process ended: ${sample.crashed}`)
  if (sample.unresponsive) problems.push('the page stopped answering')
  if (sample.frameMs.length === 0) problems.push('the check saw no animation frames')
  const ready = sample.console.find(line => line.text.includes(SMOKE_READY_MESSAGE))
  if (ready === undefined) {
    problems.push('the page\'s console message did not reach the result')
  } else if (ready.text.endsWith(SMOKE_WEBGL_SUFFIX)) {
    if (sample.programs < 1) problems.push('the check saw no WebGL program linked')
    if (!sample.drawCalls.some(calls => calls > 0)) problems.push('the check saw no WebGL draw calls')
  }
  return problems
}

/** How the smoke test starts the check. */
export interface WebCheckSmokeOptions {
  /** The packaged application's executable: `<product>.app/Contents/MacOS/<product>` on macOS, `<product>.exe` on Windows. */
  readonly executable: string
  /** The operating system the application runs on. */
  readonly platform?: NodeJS.Platform
  /** Longest wait for the check to exit, in milliseconds. */
  readonly timeoutMs?: number
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) })
  })
}

/**
 * Run the packaged application's Web check mode against the smoke page and check its result.
 * @param options - the application's executable, its platform, and the time limit.
 * @returns the check's result.
 * @throws {Error} when a macOS application has no Web check bundle, the check exits without a result line, its result
 *   lacks something {@link webCheckSmokeProblems} requires, or it outlives the time limit.
 */
export async function smokeWebCheck(options: WebCheckSmokeOptions): Promise<WebCheckSample> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    const helper = webCheckHelperExecutable(dirname(dirname(dirname(options.executable))), WASDENGINE_DESKTOP_BRAND.productName)
    if (!existsSync(helper)) throw new Error(`Web check smoke: the application has no Web check bundle at ${helper}`)
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(SMOKE_PAGE)
  })
  const port = await listen(server)
  try {
    const [program, ...switches] = webCheckCommand(options.executable, dirname(options.executable), false, platform)
    if (program === undefined) throw new Error('Web check smoke: no command')
    const argument = `${WEB_CHECK_ARGUMENT}=${JSON.stringify(smokeRequest(`http://127.0.0.1:${String(port)}/`))}`
    const environment = { ...process.env }
    // A packaging shell may run node through Electron; the check must start Electron's browser process.
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(program, [...switches, argument], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000) })
    const timeoutMs = options.timeoutMs ?? 120_000
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Web check smoke: the check did not exit within ${String(timeoutMs)} ms; stderr: ${stderr}`))
      }, timeoutMs)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (exit) => { clearTimeout(timer); resolve(exit) })
    })
    const line = stdout.split('\n').find(text => text.startsWith(WEB_CHECK_MARKER))
    if (line === undefined) {
      throw new Error(`Web check smoke: ${program} exited with ${String(code)} and printed no result; stderr: ${stderr}`)
    }
    const sample = JSON.parse(line.slice(WEB_CHECK_MARKER.length)) as WebCheckSample
    const problems = webCheckSmokeProblems(sample)
    if (problems.length > 0) throw new Error(`Web check smoke: ${problems.join('; ')}`)
    return sample
  } finally {
    server.close()
  }
}
