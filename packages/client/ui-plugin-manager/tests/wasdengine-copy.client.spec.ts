/**
 * WASDEngine fork guard for the plugin manager copy: every language names WASD Engine instead of DeepSeek Harness,
 * and the upstream dictionaries stay as upstream ships them.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { brandPluginManagerDictionaries } from '../src/client/wasdengine-copy.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const dictionaries = { zh, en, ja, es, fr, de, ru, pt }

it('names WASD Engine instead of DeepSeek Harness in every language', () => {
  const branded = brandPluginManagerDictionaries(dictionaries)
  for (const messages of Object.values(branded)) expect(Object.values(messages).join('\n')).not.toContain('DeepSeek Harness')
  expect(branded.en.installGuideSafety).toBe('Install only plugins you trust: they run with your permissions and can damage WASD Engine or leak your data.')
  expect(en.installGuideSafety).toContain('DeepSeek Harness')
})

it('registers the branded dictionaries', () => {
  const plugin = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  expect(plugin).toContain('ctx.locale.register(NS, brandPluginManagerDictionaries({ zh, en, ja, es, fr, de, ru, pt }))')
})
