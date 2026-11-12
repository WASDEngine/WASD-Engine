/**
 * WASDEngine fork spec (`wasdengine/FORK.md`): a model directory selection can apply to its Session only, which the
 * first build tip of WASD Engine Plugins uses so that its Max effort does not become every new Session's default.
 */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

type SelectModel = TypertClientRemote['session']['selectModel']

const SESSION = 'session-only' as SessionId
const MAX = { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'max' }

it('asks the Host to keep the saved default only when the caller says so', async () => {
  const selectModel = vi.fn<SelectModel>(request => Promise.resolve({
    ok: true as const,
    value: { selected: { provider: request.provider, model: request.model } },
  }))
  const directory = new ModelDirectory({ selectModel }, SESSION, () => true, new ModelCatalogDirectory(new Context()),
    createSnapshotStore<unknown>(undefined), () => true)

  expect(await directory.select(MAX, { saveDefault: false })).toEqual({ ok: true, value: undefined })
  expect(await directory.select(MAX)).toEqual({ ok: true, value: undefined })
  expect(selectModel.mock.calls.map(([request]) => request)).toEqual([
    { sessionId: SESSION, ...MAX, saveDefault: false },
    { sessionId: SESSION, ...MAX },
  ])
  directory.dispose()
})
