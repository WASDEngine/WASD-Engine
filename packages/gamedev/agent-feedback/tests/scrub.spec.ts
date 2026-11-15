/**
 * What feedback loses before it is sent: the user's home folder, account name, email addresses, and secrets, while the
 * paths, tool names, and identifiers a report needs stay readable.
 */
import { describe, expect, it } from 'vitest'
import { scrubFeedback } from '../src/scrub.ts'

const MAC = { home: '/Users/ada', userName: 'ada' }
const WINDOWS = { home: 'C:\\Users\\ada', userName: 'ada' }

describe('scrubFeedback', () => {
  it('writes the home folder as ~, in either slash and, where paths ignore case, in any case', () => {
    expect(scrubFeedback('Saved /Users/ada/Games/knight/a.png and /users/ADA/x', MAC, true)).toBe('Saved ~/Games/knight/a.png and ~/x')
    expect(scrubFeedback('/users/ADA/x stays on a file system that keeps case', MAC, false)).toBe('/users/<user>/x stays on a file system that keeps case')
    expect(scrubFeedback('C:\\Users\\ada\\game, C:/users/ada/x, and "C:\\\\Users\\\\ada\\\\json"', WINDOWS, true))
      .toBe('~\\game, ~/x, and "~\\\\json"')
    // Another user's folder that only starts with the same letters is no home folder.
    expect(scrubFeedback('/Users/adamson/x', MAC, true)).toBe('/Users/adamson/x')
  })

  it('replaces the account name as a word, and keeps generic account names, which would garble ordinary words', () => {
    expect(scrubFeedback('Ada said hi; ada\'s game; Adam and adaptive stay', MAC, true)).toBe('<user> said hi; <user>\'s game; Adam and adaptive stay')
    expect(scrubFeedback('the user asked for a dev build', { home: '/home/user', userName: 'user' }, false)).toBe('the user asked for a dev build')
    expect(scrubFeedback('ab', { home: '', userName: 'a' }, false)).toBe('ab')
  })

  it('replaces email addresses, keys and tokens by their form, named secrets, and random-looking strings', () => {
    const cases: Array<[string, string]> = [
      ['Mail ada.lovelace+wasd@example.co.uk.', 'Mail <email>.'],
      [`Key sk-proj-${'Ab3'.repeat(10)} and sk-ant-api03-${'xY9'.repeat(10)}`, 'Key <redacted> and <redacted>'],
      [`ghp_${'a1B2'.repeat(9)} AKIAABCDEFGHIJKLMNOP AIza${'Q7r_'.repeat(9)}`, '<redacted> <redacted> <redacted>'],
      ['Authorization: Bearer abcdefghijklmnop0123456789', 'Authorization: Bearer <redacted>'],
      ['api_key=supersecretvalue123 and "password": "hunter22" and token: abc', 'api_key=<redacted> and "password": "<redacted>" and token: abc'],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt <redacted>'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- done', '<redacted> done'],
      ['hash 9156d23092b0abd6ee013c6dc4faa5a0 and NKnB3B0lksmgN96K9Hmlz36KSoNjosMU', 'hash <redacted> and <redacted>'],
    ]
    for (const [text, scrubbed] of cases) expect(scrubFeedback(text, MAC, true), text).toBe(scrubbed)
  })

  it('keeps tool names, identifiers, and ordinary words about secrets', () => {
    const text = 'godot_run on godot_4.7.2_stable_linux.x86_64 broke PlayerAnimationTreeController2D_v2 and '
      + 'CharacterBody3DMovementController; the token expiration is wrong and the password field is empty.'
    expect(scrubFeedback(text, MAC, true)).toBe(text)
  })
})
