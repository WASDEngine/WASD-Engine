/**
 * WASD Engine copy for the common namespace (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes): local builds carry the product name in the sidebar and the window title instead
 * of "DSH Local Build"; their version tag still marks them as local.
 */
import { brandDictionaries } from './wasdengine-brand.ts'
import { WASDENGINE_LOCAL_BUILD_TITLE } from './wasdengine/locales.ts'

/**
 * Brand the common dictionaries for registration. The inputs stay unchanged, so code that
 * imports the upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped common dictionary, keyed by language.
 * @returns copies whose `brand.localBuild` is {@link WASDENGINE_LOCAL_BUILD_TITLE}.
 * @throws when a dictionary has no `brand.localBuild` message.
 */
export function brandCommonDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  return brandDictionaries('common', dictionaries, { copy: () => ({ 'brand.localBuild': WASDENGINE_LOCAL_BUILD_TITLE }) })
}
