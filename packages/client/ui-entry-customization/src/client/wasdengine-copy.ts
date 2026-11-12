/**
 * WASD Engine copy for the More menu rows (fork-owned; `wasdengine/FORK.md` lists the fork changes): the Customize
 * mode drafts that Create your plugin starts ask for a WASD Engine plugin instead of a DSH plugin.
 */
import { WASDENGINE_ENTRY_CUSTOMIZATION_COPY } from './wasdengine/locales.ts'

/**
 * Brand the More menu dictionaries for registration. The inputs stay unchanged, so code that imports the upstream
 * dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `entryCustomization` dictionary, keyed by language.
 * @returns copies whose Create your plugin drafts ask for a WASD Engine plugin.
 * @throws when a language has no WASD Engine copy, or the copy names a message its dictionary lacks.
 */
export function brandEntryCustomizationDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const overrides = WASDENGINE_ENTRY_CUSTOMIZATION_COPY[language]
    if (overrides === undefined) throw new Error(`WASD Engine entry copy: ${language} has no WASD Engine copy`)
    const copy: Record<string, string> = { ...messages }
    for (const [key, message] of Object.entries(overrides)) {
      if (!(key in copy)) throw new Error(`WASD Engine entry copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return branded as T
}
