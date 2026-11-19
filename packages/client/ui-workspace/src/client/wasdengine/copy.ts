/**
 * WASD Engine copy for the `workspace` namespace (fork-owned; `wasdengine/FORK.md` lists the
 * fork changes): the messages that name a Workspace name a game project instead.
 */
import { brandDictionaries } from '@deepseek-ai/dsh-client-locale/brand'
import { WASDENGINE_WORKSPACE_COPY } from './locales.ts'

/**
 * Brand the `workspace` dictionaries for registration. The inputs stay unchanged, so code
 * that imports the upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `workspace` dictionary, keyed by language.
 * @returns copies whose Workspace messages name a game project.
 * @throws when a language has no game project copy, or the copy names a message its dictionary lacks.
 */
export function brandWorkspaceDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  return brandDictionaries('workspace', dictionaries, { copy: WASDENGINE_WORKSPACE_COPY, requiredCopy: 'game project copy' })
}
