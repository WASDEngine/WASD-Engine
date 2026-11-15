/**
 * WASD Engine copy for the `chat` namespace (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes): the failure rows of a turn that a sign-out stopped, that ran without a sign-in, or that a
 * restart closed name WASD Engine instead of DeepSeek or DSH.
 */
import { WASDENGINE_CHAT_COPY } from './locales.ts'

/**
 * Brand the `chat` dictionaries for registration. The inputs stay unchanged, so code that imports
 * the upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `chat` dictionary, keyed by language.
 * @returns copies whose failure messages name WASD Engine.
 * @throws when a language has no failure copy, or the copy names a message its dictionary lacks.
 */
export function brandChatDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const overrides = WASDENGINE_CHAT_COPY[language]
    if (overrides === undefined) throw new Error(`WASD Engine chat copy: ${language} has no failure copy`)
    const copy: Record<string, string> = { ...messages }
    for (const [key, message] of Object.entries(overrides)) {
      if (!(key in copy)) throw new Error(`WASD Engine chat copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return branded as T
}
