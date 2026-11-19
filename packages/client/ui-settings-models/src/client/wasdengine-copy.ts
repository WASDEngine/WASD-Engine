/**
 * WASD Engine copy for the models onboarding (fork-owned; `wasdengine/FORK.md` lists the fork changes): the API key
 * step asks for an API token from the WASD Engine account page, in the Desktop welcome window's words, instead of
 * naming the official DeepSeek provider.
 */
import { brandDictionaries } from '@deepseek-ai/dsh-client-locale/brand'
import { WASDENGINE_MODELS_COPY } from './wasdengine/locales.ts'

/**
 * Brand the models dictionaries for registration. The inputs stay unchanged, so code that imports the upstream
 * dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `settings.models` dictionary, keyed by language.
 * @returns copies whose onboarding step asks for a WASD Engine API token.
 * @throws when a language has no WASD Engine copy, or the copy names a message its dictionary lacks.
 */
export function brandModelsDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  return brandDictionaries('models', dictionaries, { copy: WASDENGINE_MODELS_COPY, requiredCopy: 'WASD Engine copy' })
}
