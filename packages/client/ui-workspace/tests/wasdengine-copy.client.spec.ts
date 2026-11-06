/**
 * WASDEngine fork guard for the `workspace` copy: every message that names a Workspace names a
 * game project in every language, and the upstream dictionaries stay as upstream ships them.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { brandWorkspaceDictionaries } from '../src/client/wasdengine/copy.ts'
import { WASDENGINE_WORKSPACE_COPY } from '../src/client/wasdengine/locales.ts'
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

it.each(Object.keys(dictionaries))('names game projects instead of Workspaces in %s', (id) => {
  const language = id as keyof typeof dictionaries
  const branded = brandWorkspaceDictionaries(dictionaries)[language]
  expect(Object.keys(branded)).toEqual(Object.keys(dictionaries[language]))
  expect(Object.keys(WASDENGINE_WORKSPACE_COPY[language] ?? {}).sort()).toEqual(Object.keys(WASDENGINE_WORKSPACE_COPY.en ?? {}).sort())
  const remaining = Object.entries(branded).filter(([, message]) => WORKSPACE_WORDS[language].test(message))
  expect(remaining).toEqual([])
})

it('leaves the upstream dictionaries unchanged and refuses copy that no longer matches them', () => {
  brandWorkspaceDictionaries(dictionaries)
  expect(en['section.workspaces']).toBe('Workspaces')
  expect(() => brandWorkspaceDictionaries({ en: {} })).toThrow('WASD Engine workspace copy: en has no message ')
  expect(() => brandWorkspaceDictionaries({ eo: {} })).toThrow('WASD Engine workspace copy: eo has no game project copy')
})

it('registers the branded dictionaries for the workspace namespace', () => {
  const plugin = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  expect(plugin).toContain('ctx.locale.register(NS, brandWorkspaceDictionaries({ zh, en, ja, es, fr, de, ru, pt }))')
})
