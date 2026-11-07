/**
 * WASD Engine copy for computer use (fork-owned; `wasdengine/FORK.md` lists the fork changes): the application
 * approval risk notice tells the user to press Stop in WASD Engine where upstream names DeepSeek Harness.
 */

/** The upstream product name in computer use copy. */
const UPSTREAM_PRODUCT_NAME = /DeepSeek Harness/gu

// Each fork copy module brands its own package's dictionaries; the three packages share no runtime
// dependency that could hold one helper.
/* jscpd:ignore-start */
/**
 * Brand the computer use dictionaries for registration. The inputs stay unchanged, so code that imports the
 * upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `cuaPermissions` dictionary, keyed by language.
 * @returns copies that name WASD Engine instead of DeepSeek Harness.
 */
export function brandCuaDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    branded[language] = Object.fromEntries(Object.entries(messages).map(([key, message]) => [key, message.replaceAll(UPSTREAM_PRODUCT_NAME, 'WASD Engine')]))
  }
  return branded as T
}
/* jscpd:ignore-end */
