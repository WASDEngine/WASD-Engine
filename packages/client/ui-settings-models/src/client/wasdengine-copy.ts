/**
 * WASD Engine copy for the models onboarding (fork-owned; `wasdengine/FORK.md` lists the fork changes): the API key
 * step asks for an API token from the WASD Engine account page, in the Desktop welcome window's words, instead of
 * naming the official DeepSeek provider.
 */
import { WASDENGINE_MODELS_COPY } from './wasdengine/locales.ts'

/**
 * Brand the models dictionaries for registration. The inputs stay unchanged, so code that imports the upstream
 * dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `settings.models` dictionary, keyed by language.
 * @returns copies whose onboarding step asks for a WASD Engine API token.
 * @throws when a language has no WASD Engine copy, or the copy names a message its dictionary lacks.
 */
export function brandModelsDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const overrides = WASDENGINE_MODELS_COPY[language]
    if (overrides === undefined) throw new Error(`WASD Engine models copy: ${language} has no WASD Engine copy`)
    const copy: Record<string, string> = { ...messages }
    for (const [key, message] of Object.entries(overrides)) {
      if (!(key in copy)) throw new Error(`WASD Engine models copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return branded as T
}
