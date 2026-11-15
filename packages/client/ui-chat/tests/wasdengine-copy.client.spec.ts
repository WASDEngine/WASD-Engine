/**
 * WASDEngine fork guard for the `chat` copy: the failure rows of a turn that a sign-out stopped, that ran
 * without a sign-in, or that a restart closed name WASD Engine in every language, no message names DeepSeek
 * or DSH, the upstream dictionaries stay as upstream ships them, and the plugin registers the branded copy.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locale.ts'
import { brandChatDictionaries } from '../src/client/wasdengine/copy.ts'
import { WASDENGINE_CHAT_COPY } from '../src/client/wasdengine/locales.ts'

const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

/** The upstream product names: DeepSeek for the account, DSH for the harness process. */
const UPSTREAM_NAMES = /DeepSeek|\bDSH\b/u

/** The stopped row after a sign-out, the stopped row of a turn a restart closed, and the failure row without a sign-in. */
const FAILURE_KEYS = ['message.failure.accountSignedOut', 'message.failure.interrupted', 'message.failure.accountSignInRequired'] as const

it.each(Object.keys(dictionaries))('names WASD Engine instead of DeepSeek or DSH in %s', (id) => {
  const language = id as keyof typeof dictionaries
  const branded: Readonly<Record<string, string>> = brandChatDictionaries(dictionaries)[language]
  expect(Object.keys(branded)).toEqual(Object.keys(dictionaries[language]))
  for (const [key, message] of Object.entries(branded)) expect(message, key).not.toMatch(UPSTREAM_NAMES)
  for (const key of FAILURE_KEYS) {
    expect(dictionaries[language][key], key).toMatch(UPSTREAM_NAMES)
    expect(branded[key], key).toContain('WASD Engine')
  }
})

it('keeps upstream English wording apart from the product names', () => {
  // An upstream rewording fails here; carry it into every language of WASDENGINE_CHAT_COPY.
  for (const key of FAILURE_KEYS) {
    expect(WASDENGINE_CHAT_COPY.en?.[key], key).toBe(en[key].replaceAll('DeepSeek', 'WASD Engine').replaceAll('DSH', 'WASD Engine'))
  }
})

it('leaves the upstream dictionaries unchanged and refuses copy that no longer matches them', () => {
  brandChatDictionaries(dictionaries)
  expect(en['message.failure.accountSignInRequired']).toBe('Sign in to DeepSeek and ensure the request destination supports account authentication.')
  expect(brandChatDictionaries(dictionaries).en['message.failure.accountSignInRequired'])
    .toBe('Sign in to WASD Engine and ensure the request destination supports account authentication.')
  expect(() => brandChatDictionaries({ en: {} })).toThrow('WASD Engine chat copy: en has no message ')
  expect(() => brandChatDictionaries({ eo: {} })).toThrow('WASD Engine chat copy: eo has no failure copy')
})

it('registers the branded dictionaries for the chat namespace', () => {
  const plugin = readFileSync(new URL('../src/client/apply.ts', import.meta.url), 'utf8')
  expect(plugin).toContain('ctx.locale.register(NS, brandChatDictionaries({ zh, en, ja, es, fr, de, ru, pt }))')
})
