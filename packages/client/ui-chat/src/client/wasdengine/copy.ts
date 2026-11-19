/**
 * WASD Engine copy for the `chat` namespace (fork-owned; `wasdengine/FORK.md` lists the fork
 * changes): the failure rows of a turn that a sign-out stopped, that ran without a sign-in, or that a
 * restart closed name WASD Engine instead of DeepSeek or DSH, and the Chinese running status of every
 * Turn does not use DeepSeek's Chinese company name.
 */
import { brandDictionaries } from '@deepseek-ai/dsh-client-locale/brand'
import { WASDENGINE_CHAT_COPY } from './locales.ts'

/**
 * Brand the `chat` dictionaries for registration. The inputs stay unchanged, so code that imports
 * the upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `chat` dictionary, keyed by language.
 * @returns copies whose failure messages name WASD Engine and whose Chinese running status does not
 *   name DeepSeek.
 * @throws when a language has no failure copy, or the copy names a message its dictionary lacks.
 */
export function brandChatDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  return brandDictionaries('chat', dictionaries, { copy: WASDENGINE_CHAT_COPY, requiredCopy: 'failure copy' })
}
