/**
 * WASDEngine fork guard for the common copy: local builds are titled WASD Engine in every
 * language, and the upstream dictionaries stay as upstream ships them.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { brandCommonDictionaries } from '../src/client/wasdengine-copy.ts'
import { WASDENGINE_LOCAL_BUILD_TITLE } from '../src/client/wasdengine/locales.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/locales/index.ts'

const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

it.each(Object.keys(dictionaries))('titles local builds WASD Engine in %s', (id) => {
  const branded = brandCommonDictionaries(dictionaries)
  expect(branded[id as keyof typeof branded]['brand.localBuild']).toBe(WASDENGINE_LOCAL_BUILD_TITLE)
  expect(Object.keys(branded[id as keyof typeof branded])).toEqual(Object.keys(dictionaries[id as keyof typeof dictionaries]))
})

it('leaves the upstream dictionaries unchanged and refuses one without the title', () => {
  brandCommonDictionaries(dictionaries)
  expect(en['brand.localBuild']).toBe('DSH Local Build')
  expect(() => brandCommonDictionaries({ en: {} })).toThrow('WASD Engine common copy: en has no message brand.localBuild')
})

it('registers the branded dictionaries for the common namespace', () => {
  const plugin = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  expect(plugin).toContain('locale.register(COMMON_NS, brandCommonDictionaries({ zh, en, ja, es, fr, de, ru, pt }))')
})
