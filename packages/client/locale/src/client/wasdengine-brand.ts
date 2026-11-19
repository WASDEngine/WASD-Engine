/**
 * WASD Engine's wording of upstream dictionaries (fork-owned; `wasdengine/FORK.md` lists the fork changes): one helper
 * that every client package the fork words differently uses for its namespace. It imports nothing, so client bundles
 * inline it (`@deepseek-ai/dsh-client-locale/brand`, which `INLINE_SAFE` in `packages/client/tsdown.client.ts` admits).
 * @module @deepseek-ai/dsh-client-locale/brand
 */

/** How {@link brandDictionaries} brands one namespace's dictionaries. */
export interface BrandOptions {
  /** WASD Engine's messages that replace upstream ones by key, per language, or one function of the language. */
  readonly copy?:
    | Readonly<Record<string, Readonly<Record<string, string>>>>
    | ((language: string) => Readonly<Record<string, string>> | undefined)
  /** What a language without `copy` lacks, which then fails; without it, such a language keeps its messages. */
  readonly requiredCopy?: string
  /** An upstream name and what replaces it in every message, before `copy` applies. */
  readonly rename?: readonly [upstream: string | RegExp, replacement: string]
}

/**
 * Brand one namespace's dictionaries for registration: in every message the upstream name of `rename` becomes its
 * replacement, and then each language's `copy` replaces messages by key. The inputs stay unchanged, so code that
 * imports the upstream dictionaries directly still reads upstream copy.
 * @param namespace - the namespace's name in errors, such as `workspace`.
 * @param dictionaries - every shipped dictionary of the namespace, keyed by language.
 * @param options - the copy and the name the dictionaries get.
 * @returns branded copies of the dictionaries.
 * @throws when a language has no copy that `requiredCopy` asks for, or its copy names a message its dictionary lacks.
 */
export function brandDictionaries<T extends Record<string, Record<string, string>>>(
  namespace: string, dictionaries: T, options: BrandOptions,
): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    const overrides = typeof options.copy === 'function' ? options.copy(language) : options.copy?.[language]
    if (overrides === undefined && options.requiredCopy !== undefined) {
      throw new Error(`WASD Engine ${namespace} copy: ${language} has no ${options.requiredCopy}`)
    }
    const copy: Record<string, string> = {}
    for (const [key, message] of Object.entries(messages)) {
      copy[key] = options.rename === undefined ? message : message.replaceAll(options.rename[0], options.rename[1])
    }
    for (const [key, message] of Object.entries(overrides ?? {})) {
      if (!(key in copy)) throw new Error(`WASD Engine ${namespace} copy: ${language} has no message ${key}`)
      copy[key] = message
    }
    branded[language] = copy
  }
  return branded as T
}
