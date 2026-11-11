/** Remote outcomes of Game tab actions map to the issues the tab reports. */
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { failureOf } from '../src/client/actions.ts'

it('reports nothing for a successful call', () => {
  expect(failureOf({ ok: true, value: undefined })).toBeUndefined()
})

it('maps each Godot refusal to its issue and keeps the Host explanation', () => {
  expect(failureOf({ ok: false, error: new RemoteError('godot/no-project', 'no project.godot under /work', { directory: '/work' }) }))
    .toEqual({ issue: 'noProject', message: 'no project.godot under /work' })
  expect(failureOf({ ok: false, error: new RemoteError('godot/runtime-unavailable', 'unavailable', { message: 'install Godot from the Game tab' }) }))
    .toEqual({ issue: 'runtimeUnavailable', message: 'install Godot from the Game tab' })
  expect(failureOf({ ok: false, error: new RemoteError('godot/not-running', 'call godot_run first', {}) }))
    .toEqual({ issue: 'notRunning', message: 'call godot_run first' })
  expect(failureOf({ ok: false, error: new RemoteError('godot/stale-run', 'run r1 ended', { runId: 'r1' }) }))
    .toEqual({ issue: 'staleRun', message: 'run r1 ended' })
  expect(failureOf({ ok: false, error: new RemoteError('godot/too-many-runs', '4 games already run', { limit: 4 }) }))
    .toEqual({ issue: 'tooManyRuns', message: '4 games already run', limit: 4 })
  expect(failureOf({ ok: false, error: new RemoteError('godot/low-memory', 'memory is short', { availableBytes: 1, requiredBytes: 2 }) }))
    .toEqual({ issue: 'lowMemory', message: 'memory is short' })
})

it('reports a Session that another Host process writes, which Play cannot resume', () => {
  expect(failureOf({ ok: false, error: new RemoteError('session/writer-held', 'held', { sessionId: SessionId('s1') }) }))
    .toEqual({ issue: 'sessionInUse', message: 'held' })
})

it('keeps the message of every other failure', () => {
  expect(failureOf({ ok: false, error: new RemoteError('gateway/internal', 'client api: godot/run failed: offline', {}) }))
    .toEqual({ issue: 'failed', message: 'client api: godot/run failed: offline' })
})
