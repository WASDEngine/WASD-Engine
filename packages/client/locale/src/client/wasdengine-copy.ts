/**
 * WASD Engine copy for the common namespace (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes): local builds carry the product name in the sidebar and the window title instead
 * of "DSH Local Build"; their version tag still marks them as local.
 */
import { WASDENGINE_LOCAL_BUILD_TITLE } from './wasdengine/locales.ts'

/**
 * Brand the common dictionaries for registration. The inputs stay unchanged, so code that
 * imports the upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped common dictionary, keyed by language.
 * @returns copies whose `brand.localBuild` is {@link WASDENGINE_LOCAL_BUILD_TITLE}.
 * @throws when a dictionary has no `brand.localBuild` message.
 */
export function brandCommonDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    if (!('brand.localBuild' in messages)) throw new Error(`WASD Engine common copy: ${language} has no message brand.localBuild`)
    branded[language] = { ...messages, 'brand.localBuild': WASDENGINE_LOCAL_BUILD_TITLE }
  }
  return branded as T
}
