/**
 * WASD Engine copy for the `settings.account` namespace (fork-owned; `wasdengine/FORK.md` lists
 * the fork changes): every message names WASD Engine instead of DeepSeek Harness or a DeepSeek
 * account, the sign-in dialog welcomes with the WASD Engine tagline, the desktop onboarding
 * introduces game development, and the balance, Top up and quota notice speak of the plan's
 * monthly AI usage and its upgrade, which `/top_up` offers. The messages that replace upstream's,
 * and WASD Engine's own messages, which upstream's dictionaries lack, come from `locales/wasdengine.ts`.
 */
import { WASDENGINE_ACCOUNT_COPY, WASDENGINE_ACCOUNT_MESSAGES, type WasdengineAccountKey } from './locales/wasdengine.ts'

export type { WasdengineAccountKey } from './locales/wasdengine.ts'

/** The product and account name shown in place of the upstream names. */
export const WASDENGINE_PRODUCT_NAME = 'WASD Engine'

/**
 * "DeepSeek Harness", "Harness" on its own, and "DeepSeek" naming the account or the
 * platform. Model names such as DeepSeek-V4.1-Flash keep the DeepSeek name.
 */
const UPSTREAM_NAME = /DeepSeek Harness|\bHarness\b|DeepSeek(?!-V\d)/gu


/** Account dictionaries with WASD Engine's own messages added. */
export type WithWasdengineMessages<T extends Record<string, Record<string, string>>> =
  { [L in keyof T]: T[L] & Record<WasdengineAccountKey, string> }

/**
 * Add WASD Engine's own messages to account dictionaries, in English for a language they do not
 * cover, so the dictionaries have every key of the `settings.account` namespace. The inputs stay
 * unchanged.
 * @param dictionaries - account dictionaries, keyed by language.
 * @returns copies with WASD Engine's own messages added.
 * @throws when a dictionary already has a key of WASD Engine's own messages.
 */
export function withWasdengineMessages<T extends Record<string, Record<string, string>>>(
  dictionaries: T,
): WithWasdengineMessages<T> {
  const added: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const own = WASDENGINE_ACCOUNT_MESSAGES[language] ?? WASDENGINE_ACCOUNT_MESSAGES.en
    for (const key of Object.keys(own)) {
      if (key in messages) throw new Error(`WASD Engine account messages: ${language} already has a message ${key}`)
    }
    added[language] = { ...messages, ...own }
  }
  return added as WithWasdengineMessages<T>
}

/**
 * Brand the account dictionaries for registration: replace the upstream names in every
 * message, apply {@link WASDENGINE_ACCOUNT_COPY}, then add WASD Engine's own messages
 * ({@link withWasdengineMessages}). The inputs stay unchanged, so code that imports the
 * upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped account dictionary, keyed by language.
 * @returns branded copies with the same keys and WASD Engine's own.
 * @throws when the copy names a message key that a dictionary lacks, or a dictionary already
 * has a key of WASD Engine's own messages.
 */
export function brandAccountDictionaries<T extends Record<string, Record<string, string>>>(
  dictionaries: T,
): WithWasdengineMessages<T> {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const copy: Record<string, string> = {}
    for (const [key, message] of Object.entries(messages)) {
      copy[key] = message.replaceAll(UPSTREAM_NAME, WASDENGINE_PRODUCT_NAME)
    }
    for (const [key, message] of Object.entries(WASDENGINE_ACCOUNT_COPY[language] ?? {})) {
      if (!(key in copy)) throw new Error(`WASD Engine account copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return withWasdengineMessages(branded as T)
}
