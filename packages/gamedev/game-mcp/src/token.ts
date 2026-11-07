/**
 * The server's access token: 32 random bytes in base64url, kept in a file only the user can read, so agents set up
 * once keep working across Host restarts. A missing or malformed file gets a new token.
 * @module @deepseek-ai/dsh-game-mcp/src/token
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Format of a token. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/**
 * Read the token, or create and save one.
 * @param file - absolute path of the token file.
 * @returns the token.
 * @throws when the file cannot be read for a reason other than its absence, or cannot be written.
 */
export async function loadToken(file: string): Promise<string> {
  let stored: string | undefined
  try {
    stored = (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (stored !== undefined && TOKEN_PATTERN.test(stored)) return stored
  const token = randomBytes(32).toString('base64url')
  await writeFileAtomic(file, `${token}\n`, { mode: 0o600, dirMode: 0o700 })
  return token
}

/**
 * Check an `Authorization` header against the token in constant time.
 * @param header - the header value, or null when absent.
 * @param token - the server's token.
 * @returns whether the header is `Bearer <token>`.
 */
export function authorizes(header: string | null, token: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header ?? '')
  if (match === null) return false
  const given = Buffer.from(match[1] as string)
  const expected = Buffer.from(token)
  return given.byteLength === expected.byteLength && timingSafeEqual(given, expected)
}
