import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebCheckSample } from '@deepseek-ai/dsh-godot/types'
import {
  SMOKE_PAGE, SMOKE_READY_MESSAGE, SMOKE_WEBGL_SUFFIX, smokeRequest, smokeWebCheck, webCheckSmokeProblems,
} from '../scripts/wasdengine-web-check-smoke.ts'
import { WASDENGINE_DESKTOP_BRAND } from '../src/wasdengine-brand.ts'
import { WEB_CHECK_MARKER } from '../src/wasdengine-web-check.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A result of a page that started, drew with WebGL 2, and logged. */
function completeSample(): WebCheckSample {
  return {
    started: true, startMs: 120, readyMs: 1100, longTasks: [], frameMs: [16.7, 16.6], drawCalls: [1, 1], programs: 1,
    console: [{ level: 'info', text: `${SMOKE_READY_MESSAGE}${SMOKE_WEBGL_SUFFIX}` }], unresponsive: false,
  }
}

/**
 * An executable that stands in for the application's Web check mode: it reads the request, fetches the page, and
 * prints `result` (a function of the page's HTML) as the mode's stdout, then exits with `code`.
 */
function fakeCheck(result: string, code = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'wasd-web-check-smoke-'))
  roots.push(root)
  const executable = join(root, 'fake-check.mjs')
  writeFileSync(executable, [
    '#!/usr/bin/env node',
    'const argument = process.argv.find(arg => arg.startsWith("--wasd-web-check="))',
    'const request = JSON.parse(argument.slice("--wasd-web-check=".length))',
    'const html = await (await fetch(request.url)).text()',
    `process.stdout.write(${result})`,
    `process.exitCode = ${String(code)}`,
    '',
  ].join('\n'))
  chmodSync(executable, 0o755)
  return executable
}

describe('webCheckSmokeProblems', () => {
  it('accepts a result that saw the page start, draw, and log', () => {
    expect(webCheckSmokeProblems(completeSample())).toEqual([])
  })

  it('names each part a result lacks', () => {
    const sample: WebCheckSample = {
      ...completeSample(), started: false, crashed: 'crashed', unresponsive: true, frameMs: [], drawCalls: [0], programs: 0, console: [],
    }
    expect(webCheckSmokeProblems(sample)).toEqual([
      'the page never removed its loading overlay',
      'the page\'s process ended: crashed',
      'the page stopped answering',
      'the check saw no animation frames',
      'the page\'s console message did not reach the result',
    ])
  })

  it('requires a program and draw calls when the page had WebGL 2', () => {
    expect(webCheckSmokeProblems({ ...completeSample(), drawCalls: [0, 0], programs: 0 })).toEqual([
      'the check saw no WebGL program linked',
      'the check saw no WebGL draw calls',
    ])
  })

  it('accepts frames alone from a machine without WebGL 2, such as a GPU-less runner', () => {
    const sample: WebCheckSample = {
      ...completeSample(), drawCalls: [0, 0], programs: 0, console: [{ level: 'info', text: `${SMOKE_READY_MESSAGE} (no WebGL 2)` }],
    }
    expect(webCheckSmokeProblems(sample)).toEqual([])
  })
})

describe('smokeRequest and the smoke page', () => {
  it('asks for a short watch of a loopback page that has Godot\'s loading overlay and draws with WebGL', () => {
    expect(smokeRequest('http://127.0.0.1:9/')).toMatchObject({ url: 'http://127.0.0.1:9/', seconds: 2 })
    expect(SMOKE_PAGE).toContain('<div id="status">')
    expect(SMOKE_PAGE).toContain('gl.drawArrays')
    expect(SMOKE_PAGE).toContain(SMOKE_READY_MESSAGE)
  })
})

describe('smokeWebCheck', () => {
  it('serves the page to the check and returns its complete result', async () => {
    const executable = fakeCheck(
      `html.includes('id="status"') ? ${JSON.stringify(`${WEB_CHECK_MARKER}${JSON.stringify(completeSample())}\n`)} : 'no page\\n'`,
    )
    await expect(smokeWebCheck({ executable, platform: 'linux', timeoutMs: 30_000 })).resolves.toMatchObject({ started: true })
  })

  it('fails when the check prints no result, with what it wrote to stderr', async () => {
    const executable = fakeCheck('(process.stderr.write("Web check failed: no GPU\\n"), "")', 1)
    await expect(smokeWebCheck({ executable, platform: 'linux', timeoutMs: 30_000 }))
      .rejects.toThrow(/exited with 1 and printed no result; stderr: Web check failed: no GPU/u)
  })

  it('fails when the result lacks frames', async () => {
    const lacking = { ...completeSample(), frameMs: [] }
    const executable = fakeCheck(JSON.stringify(`${WEB_CHECK_MARKER}${JSON.stringify(lacking)}\n`))
    await expect(smokeWebCheck({ executable, platform: 'linux', timeoutMs: 30_000 })).rejects.toThrow(/saw no animation frames/u)
  })

  it('fails on macOS when the application has no Web check bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasd-web-check-smoke-app-'))
    roots.push(root)
    const macos = join(root, `${WASDENGINE_DESKTOP_BRAND.productName}.app`, 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    await expect(smokeWebCheck({ executable: join(macos, WASDENGINE_DESKTOP_BRAND.productName), platform: 'darwin' }))
      .rejects.toThrow(/has no Web check bundle/u)
  })
})
