/**
 * WASDEngine fork guard for the account copy: the registered dictionaries name WASD Engine
 * in every language, the onboarding introduces game development, and the upstream
 * dictionaries stay as upstream ships them.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { WASDENGINE_ACCOUNT_COPY, WASDENGINE_PRODUCT_NAME, brandAccountDictionaries } from '../src/client/wasdengine-copy.ts'

const dictionaries = { en, zh, ja, es, fr, de, ru, pt }
const branded = brandAccountDictionaries(dictionaries)

describe('WASD Engine account copy', () => {
  it.each(Object.keys(dictionaries))('names WASD Engine instead of DeepSeek Harness or a DeepSeek account in %s', (id) => {
    for (const [key, message] of Object.entries(branded[id as keyof typeof branded])) {
      expect(message, key).not.toMatch(/\bHarness\b/u)
      expect(message, key).not.toMatch(/DeepSeek(?!-V\d)/u)
    }
    expect(branded[id as keyof typeof branded].onboardingBrand).toBe(WASDENGINE_PRODUCT_NAME)
  })

  it.each(Object.keys(dictionaries))('applies the game-development onboarding copy in %s', (id) => {
    const copy = WASDENGINE_ACCOUNT_COPY[id]
    expect(copy, id).toBeDefined()
    for (const [key, message] of Object.entries(copy!)) {
      expect(branded[id as keyof typeof branded][key as keyof typeof en], key).toBe(message)
    }
    expect(copy!.onboardingIntroduction).toContain(WASDENGINE_PRODUCT_NAME)
  })

  it('keeps model names and leaves the upstream dictionaries unchanged', () => {
    // A language without WASD Engine copy gets the name replacement alone.
    expect(brandAccountDictionaries({ 'x-test': { model: 'DeepSeek-V4.1-Flash on your DeepSeek account in DeepSeek Harness' } })['x-test'].model)
      .toBe(`DeepSeek-V4.1-Flash on your ${WASDENGINE_PRODUCT_NAME} account in ${WASDENGINE_PRODUCT_NAME}`)
    expect(en.onboardingBrand).toBe('DeepSeek Harness')
    expect(zh.loginDescription).toContain('DeepSeek')
  })

  it('refuses copy for a message the dictionaries do not have', () => {
    expect(() => brandAccountDictionaries({ en: { onboardingBrand: 'DeepSeek Harness' } }))
      .toThrow('WASD Engine account copy: en has no message loginDescription')
  })

  it('registers the branded dictionaries for the account namespace', () => {
    const plugin = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    expect(plugin).toContain("ctx.locale.register('settings.account', brandAccountDictionaries({ en, zh, ja, es, fr, de, ru, pt }))")
  })
})
