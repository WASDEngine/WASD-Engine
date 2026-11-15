/**
 * WASD Engine: a Client Session sends the prompt that carries part of an answer, such as the images a user attaches to
 * an `ask_user_question` answer, with `answersQuestion`, and every other prompt without it.
 */
import { describe, expect } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { sessionBench } from './remote/bench.client.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const SID = 'fk-answer' as SessionId
/** The first client boot pays the cold module transform of the api cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

describe('a prompt that answers a question', () => {
  it('sends answersQuestion only when the caller marks the prompt as part of an answer', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const content = [{ type: 'text' as const, text: 'Images for my answer:' }]
    await expect(session.prompt(content, 'steer', undefined, undefined, { answersQuestion: true })).resolves.toMatchObject({ ok: true })
    await expect(session.prompt([{ type: 'text', text: 'Stop after the terrain.' }], 'steer')).resolves.toMatchObject({ ok: true })
    const requests = mock.log.requests('session/prompt') as Array<Record<string, unknown>>
    expect(requests).toMatchObject([
      { sessionId: SID, mode: 'steer', content, answersQuestion: true },
      { sessionId: SID, mode: 'steer', content: [{ type: 'text', text: 'Stop after the terrain.' }] },
    ])
    expect('answersQuestion' in (requests[1] ?? {})).toBe(false)
  }, COLD_BOOT_TIMEOUT_MS)
})
