/**
 * WASDEngine fork guard for the More menu copy: the Customize mode drafts that Create your plugin starts ask for a
 * WASD Engine plugin in every language, no message names DSH, the upstream dictionaries stay as upstream ships them,
 * and the plugin registers the branded copy. `wasdengine/FORK.md` (repository root) runs this spec after every
 * upstream merge.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { brandEntryCustomizationDictionaries } from '../src/client/wasdengine-copy.ts'

const dictionaries = { en, zh, ja, es, fr, de, ru, pt }

/** The draft prompts that Create your plugin starts, one per menu region. */
const PROMPT_KEYS = ['createPrompt.sidebar', 'createPrompt.conversation', 'createPrompt.rightbar'] as const

it.each(Object.keys(dictionaries))('asks for a WASD Engine plugin in %s', (id) => {
  const language = id as keyof typeof dictionaries
  const branded: Readonly<Record<string, string>> = brandEntryCustomizationDictionaries(dictionaries)[language]
  expect(Object.keys(branded)).toEqual(Object.keys(dictionaries[language]))
  for (const [key, message] of Object.entries(branded)) expect(message, key).not.toMatch(/\bDSH\b/u)
  for (const key of PROMPT_KEYS) {
    expect(dictionaries[language][key], key).toMatch(/\bDSH\b/u)
    expect(branded[key], key).toContain('WASD Engine')
  }
})

it('leaves the upstream dictionaries unchanged and refuses copy that no longer matches them', () => {
  brandEntryCustomizationDictionaries(dictionaries)
  expect(en['createPrompt.sidebar']).toBe('Create a DSH plugin with a left sidebar entry.')
  expect(() => brandEntryCustomizationDictionaries({ en: {} })).toThrow('WASD Engine entry copy: en has no message createPrompt.sidebar')
  expect(() => brandEntryCustomizationDictionaries({ eo: {} })).toThrow('WASD Engine entry copy: eo has no WASD Engine copy')
})

it('registers the branded dictionaries for the entryCustomization namespace', () => {
  const plugin = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  expect(plugin).toContain("ctx.locale.register('entryCustomization', brandEntryCustomizationDictionaries({ en, zh, ja, es, fr, de, ru, pt }))")
})
