/**
 * WASDEngine fork guard for the Office preview copy: every language names WASD Engine instead of DeepSeek Harness,
 * and the upstream dictionaries stay as upstream ships them.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { brandOfficeDictionaries } from '../src/client/office/wasdengine-copy.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/office/locales.ts'

const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

it('names WASD Engine instead of DeepSeek Harness in every language', () => {
  const branded = brandOfficeDictionaries(dictionaries)
  for (const messages of Object.values(branded)) expect(Object.values(messages).join('\n')).not.toContain('DeepSeek Harness')
  expect(branded.en.unavailable).toBe('Office previews are unavailable. Enable the document preview service on the computer running WASD Engine.')
  expect(en.unavailable).toContain('DeepSeek Harness')
})

it('registers the branded dictionaries', () => {
  const plugin = readFileSync(new URL('../src/client/office/index.ts', import.meta.url), 'utf8')
  expect(plugin).toContain("ctx.locale.register('sidebarOffice', brandOfficeDictionaries({ zh, en, ja, es, fr, de, ru, pt }))")
})
