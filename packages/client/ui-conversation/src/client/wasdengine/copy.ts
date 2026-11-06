/**
 * WASD Engine copy for the `conversation` namespace (fork-owned; `wasdengine/FORK.md` lists
 * the fork changes): the hero shows WASD Engine's headline, its Workspace picker names a game
 * project, and the session-in-use error names WASD Engine instead of DSH.
 */
import { WASDENGINE_CONVERSATION_COPY } from './locales.ts'

/**
 * Brand the `conversation` dictionaries for registration. The inputs stay unchanged, so code
 * that imports the upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `conversation` dictionary, keyed by language.
 * @returns copies with WASD Engine's hero headline and session-in-use error, whose Workspace messages name a game project.
 * @throws when a language has no game project copy, or the copy names a message its dictionary lacks.
 */
export function brandConversationDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const overrides = WASDENGINE_CONVERSATION_COPY[language]
    if (overrides === undefined) throw new Error(`WASD Engine conversation copy: ${language} has no game project copy`)
    const copy: Record<string, string> = { ...messages }
    for (const [key, message] of Object.entries(overrides)) {
      if (!(key in copy)) throw new Error(`WASD Engine conversation copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return branded as T
}
