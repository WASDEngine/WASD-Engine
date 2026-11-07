/**
 * WASDEngine fork guard for the computer use copy: every language names WASD Engine instead of DeepSeek Harness,
 * and the upstream dictionaries stay as upstream ships them.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { brandCuaDictionaries } from '../src/client/wasdengine-copy.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const dictionaries = { en, zh, ja, es, fr, de, ru, pt }

it('names WASD Engine instead of DeepSeek Harness in every language', () => {
  const branded = brandCuaDictionaries(dictionaries)
  for (const messages of Object.values(branded)) expect(Object.values(messages).join('\n')).not.toContain('DeepSeek Harness')
  expect(branded.en.approvalRiskNotice).toMatch(/press Stop in WASD Engine\.$/u)
  expect(en.approvalRiskNotice).toContain('DeepSeek Harness')
})

it('registers the branded dictionaries', () => {
  const plugin = readFileSync(new URL('../src/client/mount.ts', import.meta.url), 'utf8')
  expect(plugin).toContain('ctx.locale.register(NS, brandCuaDictionaries({ en, zh, ja, es, fr, de, ru, pt }))')
})
