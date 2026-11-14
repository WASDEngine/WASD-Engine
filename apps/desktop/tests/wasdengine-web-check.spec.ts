/** Web check mode starts only from its argument, accepts only a valid loopback request, and starts itself the way it was started. */
import { Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { INSTRUMENTATION, WEB_CHECK_ARGUMENT, webCheckCommand, webCheckRequest } = await import('../src/wasdengine-web-check.ts')

const REQUEST = { url: 'http://127.0.0.1:4321/index.html', seconds: 20, startTimeoutMs: 180_000, width: 1280, height: 720 }

describe('webCheckRequest', () => {
  it('reads the request of the Web check argument, and nothing from a normal launch', () => {
    expect(webCheckRequest(['/Applications/WASD Engine.app/Contents/MacOS/WASD Engine'])).toBeUndefined()
    expect(webCheckRequest(['electron', '/app', `${WEB_CHECK_ARGUMENT}=${JSON.stringify(REQUEST)}`])).toEqual(REQUEST)
    expect(webCheckRequest(['exe', `${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, width: 1280.4 })}`])).toEqual(REQUEST)
  })

  it('refuses a request that is not JSON, not loopback, or has no positive limits', () => {
    expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}={`])).toThrow(SyntaxError)
    expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=null`])).toThrow('Web check: the request is not an object')
    expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, url: 'https://example.com/' })}`]))
      .toThrow('Web check: the request URL must be a loopback http URL')
    expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, seconds: 0 })}`]))
      .toThrow('Web check: seconds, startTimeoutMs, width, and height must be positive numbers')
  })
})

describe('webCheckCommand', () => {
  it('starts the application folder with Electron\'s default app, and the executable alone otherwise', () => {
    expect(webCheckCommand('/dev/Electron', '/repo/apps/desktop', true)).toEqual(['/dev/Electron', '/repo/apps/desktop'])
    expect(webCheckCommand('/Applications/WASD Engine.app/Contents/MacOS/WASD Engine', '/ignored', false))
      .toEqual(['/Applications/WASD Engine.app/Contents/MacOS/WASD Engine'])
  })
})

describe('INSTRUMENTATION', () => {
  it('is a script the page can run', () => {
    expect(() => new Script(INSTRUMENTATION)).not.toThrow()
  })
})
