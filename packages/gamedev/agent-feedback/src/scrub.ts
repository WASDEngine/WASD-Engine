/**
 * What `feedback_send` takes out of feedback before it leaves this computer: the user's home folder, which becomes `~`;
 * the user's account name, which becomes `<user>`; email addresses, which become `<email>`; and keys, tokens, passwords,
 * and other strings that look like secrets, which become `<redacted>`.
 * @module @deepseek-ai/dsh-agent-feedback/src/scrub
 */

/** What identifies the user on this computer. */
export interface UserTraces {
  /** The home folder, such as `/Users/ada` or `C:\Users\ada`; empty for none. */
  readonly home: string
  /** The account name, such as `ada`; empty for none. */
  readonly userName: string
}

/** Account names that name nobody, which stay in feedback since replacing them would garble ordinary words. */
const GENERIC_NAMES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'default', 'dev', 'developer', 'guest', 'owner', 'root', 'test', 'ubuntu', 'user',
])

/** Characters that end a path segment, after which a home folder's path is complete. */
const PATH_END = String.raw`(?=$|[\\/\s"'` + '`' + String.raw`)\]},;:<>|])`

/** Keys and tokens whose form names them, most specific first. */
const SECRET_FORMS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{16,}/gu,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/gu,
  /\bgh[opsur]_[A-Za-z0-9]{20,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{30,}/gu,
  /\bya29\.[0-9A-Za-z_-]{20,}/gu,
]

/** The credentials of an HTTP authorization scheme, such as `Bearer ...`. */
const SCHEME_SECRET = /\b(bearer|basic)(\s+)([\w.~+/=-]{12,})/giu

/** Names of secrets whose value follows them in `name=value` or `"name": "value"` form. */
const SECRET_NAMES = [
  'api[_-]?key', 'access[_-]?key', 'secret[_-]?key', 'client[_-]?secret', 'access[_-]?token', 'refresh[_-]?token', 'auth[_-]?token',
  'token', 'secret', 'password', 'passwd', 'pwd',
].join('|')

/** A name of a secret followed by `:` or `=` and its value, such as `api_key=...` or `"password": "..."`. */
const NAMED_SECRET = new RegExp(String.raw`\b((?:${SECRET_NAMES})["']?\s*[:=]\s*["']?)([^\s"',;]{6,})`, 'giu')

/** A run of letters, digits, and the characters of encoded keys, long enough to be one. */
const LONG_RUN = /[A-Za-z0-9+/=_-]{24,}/gu

/**
 * Whether a long run of letters and digits looks like a key or a token rather than a word or an identifier: hexadecimal
 * of 32 digits or more, or digits and letters that change kind on most characters, as random text does.
 * @param run - the run.
 * @returns true for a secret-like run.
 */
function secretLike(run: string): boolean {
  if (/^[0-9a-f]{32,}$/iu.test(run)) return true
  if (!/[0-9]/u.test(run) || !/[A-Za-z]/u.test(run)) return false
  const kind = (character: string): number => /[0-9]/u.test(character) ? 0 : /[a-z]/u.test(character) ? 1 : /[A-Z]/u.test(character) ? 2 : 3
  let changes = 0
  for (let index = 1; index < run.length; index++) {
    if (kind(run.charAt(index)) !== kind(run.charAt(index - 1))) changes++
  }
  return changes / (run.length - 1) >= 0.45
}

/**
 * A pattern that finds a path, in either slash and, where the file system ignores case, in any case.
 * @param path - the path.
 * @param ignoreCase - whether letters match in either case.
 * @returns the pattern, or undefined for an empty path.
 */
function pathPattern(path: string, ignoreCase: boolean): RegExp | undefined {
  const trimmed = path.replace(/[\\/]+$/u, '')
  if (trimmed === '') return undefined
  const body = trimmed.split(/[\\/]+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join(String.raw`[\\/]+`)
  return new RegExp(`${body}${PATH_END}`, ignoreCase ? 'giu' : 'gu')
}

/**
 * Take the user's traces and secrets out of feedback text.
 * @param text - the text an agent wrote.
 * @param traces - the user's home folder and account name.
 * @param ignoreCase - whether this computer's file system ignores the case of paths, as on macOS and Windows.
 * @returns the text with each trace replaced by its placeholder.
 */
export function scrubFeedback(text: string, traces: UserTraces, ignoreCase: boolean): string {
  let scrubbed = text
  for (const form of SECRET_FORMS) scrubbed = scrubbed.replace(form, '<redacted>')
  scrubbed = scrubbed.replace(SCHEME_SECRET, (_whole, scheme: string, space: string) => `${scheme}${space}<redacted>`)
  scrubbed = scrubbed.replace(NAMED_SECRET, (_whole, name: string) => `${name}<redacted>`)
  scrubbed = scrubbed.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu, '<email>')
  const home = pathPattern(traces.home, ignoreCase)
  if (home !== undefined) scrubbed = scrubbed.replace(home, '~')
  scrubbed = scrubbed.replace(LONG_RUN, run => secretLike(run) ? '<redacted>' : run)
  const name = traces.userName.trim()
  if (name.length >= 2 && !GENERIC_NAMES.has(name.toLowerCase())) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    scrubbed = scrubbed.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), '<user>')
  }
  return scrubbed
}
