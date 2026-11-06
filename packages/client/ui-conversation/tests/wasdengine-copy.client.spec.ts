/**
 * WASDEngine fork guard for the `conversation` copy: the hero shows WASD Engine's headline and its
 * Workspace picker names a game project in every language, and the upstream dictionaries stay as
 * upstream ships them.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { brandConversationDictionaries } from '../src/client/wasdengine/copy.ts'
import { WASDENGINE_CONVERSATION_COPY } from '../src/client/wasdengine/locales.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

/** How each upstream dictionary names a Workspace; none of these may survive the rewrite. */
const WORKSPACE_WORDS: Readonly<Record<keyof typeof dictionaries, RegExp>> = {
  zh: /工作区/u,
  en: /workspace/iu,
  ja: /ワークスペース/u,
  es: /espacio(?:s)? de trabajo/iu,
  fr: /espace(?:s)? de travail/iu,
  de: /arbeitsbereich/iu,
  ru: /рабоч(?:ая|ее|ей|его|их|ие) (?:област|пространств|мест)/iu,
  pt: /(?:espaço|espaços|área|áreas) de trabalho/iu,
}

/** The messages the hero's Workspace picker shows. */
const PICKER_KEYS = ['placeholder.workspace', 'hero.chooseWorkspace'] as const

it.each(Object.keys(dictionaries))('shows the WASD Engine headline and names game projects in the hero picker in %s', (id) => {
  const language = id as keyof typeof dictionaries
  const branded = brandConversationDictionaries(dictionaries)[language]
  expect(Object.keys(branded)).toEqual(Object.keys(dictionaries[language]))
  for (const key of PICKER_KEYS) {
    expect(branded[key]).not.toBe(dictionaries[language][key])
    expect(branded[key]).not.toMatch(WORKSPACE_WORDS[language])
  }
  expect(branded['hero.headline']).toBe(WASDENGINE_CONVERSATION_COPY[language]!['hero.headline'])
  expect(branded['hero.headline']).not.toBe(dictionaries[language]['hero.headline'])
})

it('leaves the upstream dictionaries unchanged and refuses copy that no longer matches them', () => {
  brandConversationDictionaries(dictionaries)
  expect(en['hero.chooseWorkspace']).toBe('Choose workspace')
  expect(en['hero.headline']).toBe('Into the Unknown')
  expect(brandConversationDictionaries(dictionaries).en['hero.headline']).toBe('Horizons Yet to Be')
  expect(() => brandConversationDictionaries({ en: {} })).toThrow('WASD Engine conversation copy: en has no message ')
  expect(() => brandConversationDictionaries({ eo: {} })).toThrow('WASD Engine conversation copy: eo has no game project copy')
})

it('registers the branded dictionaries for the conversation namespace', () => {
  const plugin = readFileSync(new URL('../src/client/apply.ts', import.meta.url), 'utf8')
  expect(plugin).toContain('ctx.locale.register(NS, brandConversationDictionaries({ zh, en, ja, es, fr, de, ru, pt }))')
})
