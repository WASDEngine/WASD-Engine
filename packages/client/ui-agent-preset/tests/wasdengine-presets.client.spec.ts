/**
 * WASDEngine fork guard for the agent preset copy: the built-in table lists Game developer and Customize mode
 * (`gamedev` and `cordis`) only, and no message in any language names the removed Standard, PTC, or Minimal
 * presets or the former Creator mode name, every message names WASD Engine where upstream's names DSH, and the
 * Developer tools description no longer promises more presets.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { de, en, es, fr, isBuiltInPreset, ja, pt, ru, zh } from '../src/client/locales.ts'

const dictionaries = { en, zh, ja, es, fr, de, ru, pt }

/** How each language named the removed presets and Creator mode. */
const REMOVED_NAMES: Readonly<Record<keyof typeof dictionaries, RegExp>> = {
  en: /Creator mode|Standard mode|PTC mode|Minimal mode/iu,
  zh: /创造模式|标准模式|PTC 模式|极简模式/u,
  ja: /クリエイターモード|標準モード|PTC モード|最小モード/u,
  es: /modo creador|modo estándar|modo PTC|modo mínimo/iu,
  fr: /mode créateur|mode standard|mode PTC|mode minimal/iu,
  de: /Erstellermodus|Creator-Modus|Standardmodus|PTC-Modus|Minimalmodus/iu,
  ru: /режим\S* (?:автора|Creator)|стандартн\S* режим|режим\S* PTC|минимальн\S* режим/iu,
  pt: /modo criador|modo padrão|modo PTC|modo mínimo/iu,
}

/** The Customize mode name in each language. */
const CUSTOMIZE: Readonly<Record<keyof typeof dictionaries, string>> = {
  en: 'Customize mode',
  zh: '自定义模式',
  ja: 'カスタマイズモード',
  es: 'Modo de personalización',
  fr: 'Mode Personnalisation',
  de: 'Anpassungsmodus',
  ru: 'Режим настройки',
  pt: 'Modo de personalização',
}

it.each(Object.keys(dictionaries))('names only Game developer and Customize mode in %s', (id) => {
  const language = id as keyof typeof dictionaries
  const messages: Readonly<Record<string, string>> = dictionaries[language]
  for (const [key, message] of Object.entries(messages)) expect(message, key).not.toMatch(REMOVED_NAMES[language])
  expect(Object.keys(messages).filter(key => /^(?:preset|guide)(?:Standard|Ptc|Minimal)/u.test(key))).toEqual([])
  expect(messages.presetGamedevName).not.toBe('')
  expect(messages.presetGamedevDescription).not.toBe('')
  expect(messages.presetCordisName).toBe(CUSTOMIZE[language])
})

it.each(Object.keys(dictionaries))('names WASD Engine instead of DSH in %s', (id) => {
  const messages: Readonly<Record<string, string>> = dictionaries[id as keyof typeof dictionaries]
  for (const [key, message] of Object.entries(messages)) expect(message, key).not.toMatch(/\bDSH\b/u)
  for (const key of ['sectionIntro', 'presetCordisDescription', 'createPluginDescription', 'guideCordisExplanation']) {
    expect(messages[key], key).toContain('WASD Engine')
  }
})

it('treats gamedev and cordis, and no removed preset, as built-in', () => {
  expect(isBuiltInPreset({ id: 'gamedev' })).toBe(true)
  expect(isBuiltInPreset({ id: 'cordis' })).toBe(true)
  for (const id of ['standard', 'ptc', 'minimal']) expect(isBuiltInPreset({ id }), id).toBe(false)
  expect(isBuiltInPreset({ id: 'gamedev', name: 'Mine' })).toBe(false)
})

it('names Customize mode in the creation recommendations', () => {
  const source = readFileSync(new URL('../../../experimental/client-ui-creation-recommendations/src/client/locales.ts', import.meta.url), 'utf8')
  for (const language of Object.keys(dictionaries) as (keyof typeof dictionaries)[]) {
    expect(source, language).not.toMatch(REMOVED_NAMES[language])
  }
  expect(source).toContain('Customize mode builds a new page')
})

/** How each language's Developer tools description named agent presets. */
const PRESET_WORDS = /preset|预设|プリセット|preestablecid|préréglage|voreinstellung|настройки агента|predefiniç/iu

it('describes Developer tools without offering more presets', () => {
  const source = readFileSync(new URL('../../ui-settings-general/src/client/locales.ts', import.meta.url), 'utf8')
  const descriptions = source.split('\n').filter(line => line.includes("'developerTools.description'"))
  expect(descriptions).toHaveLength(8)
  for (const line of descriptions) expect(line).not.toMatch(PRESET_WORDS)
})
