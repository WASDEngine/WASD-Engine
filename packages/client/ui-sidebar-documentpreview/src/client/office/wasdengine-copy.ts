/**
 * WASD Engine copy for the Office preview (fork-owned; `wasdengine/FORK.md` lists the fork changes): the message
 * shown while the document preview service is off names WASD Engine where upstream names DeepSeek Harness.
 */

/** The upstream product name in Office preview copy. */
const UPSTREAM_PRODUCT_NAME = /DeepSeek Harness/gu

// Each fork copy module brands its own package's dictionaries; the three packages share no runtime
// dependency that could hold one helper.
/* jscpd:ignore-start */
/**
 * Brand the Office preview dictionaries for registration. The inputs stay unchanged, so code that imports the
 * upstream dictionaries directly still reads upstream copy.
 * @param dictionaries - every shipped `sidebarOffice` dictionary, keyed by language.
 * @returns copies that name WASD Engine instead of DeepSeek Harness.
 */
export function brandOfficeDictionaries<T extends Record<string, Record<string, string>>>(dictionaries: T): T {
  const branded: Record<string, Record<string, string>> = {}
  for (const [language, messages] of Object.entries(dictionaries)) {
    branded[language] = Object.fromEntries(Object.entries(messages).map(([key, message]) => [key, message.replaceAll(UPSTREAM_PRODUCT_NAME, 'WASD Engine')]))
  }
  return branded as T
}
/* jscpd:ignore-end */
