/** The access token lives in a file only the user can read, survives restarts, and is checked in constant time. */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizes, loadToken } from '../src/token.ts'
import { setupPrompt } from '../src/prompt.ts'

const folders: string[] = []

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function folder(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-token-'))
  folders.push(created)
  return created
}

describe('loadToken', () => {
  it('creates a token only the user can read, and returns it again later', async () => {
    const file = join(await folder(), 'nested', 'token')
    const token = await loadToken(file)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await loadToken(file)).toBe(token)
  })

  it('replaces a malformed token', async () => {
    const file = join(await folder(), 'token')
    await writeFile(file, 'short\n')
    const token = await loadToken(file)
    expect(token).not.toBe('short')
    expect((await readFile(file, 'utf8')).trim()).toBe(token)
  })

  it('fails when the file cannot be read', async () => {
    await expect(loadToken(await folder())).rejects.toThrow()
  })
})

describe('authorizes', () => {
  const token = 'a'.repeat(43)

  it('accepts only the bearer token', () => {
    expect(authorizes(`Bearer ${token}`, token)).toBe(true)
    expect(authorizes(`bearer ${token}`, token)).toBe(true)
    expect(authorizes(`Bearer ${'b'.repeat(43)}`, token)).toBe(false)
    expect(authorizes(`Bearer ${token}x`, token)).toBe(false)
    expect(authorizes(`Basic ${token}`, token)).toBe(false)
    expect(authorizes(null, token)).toBe(false)
  })
})

describe('setupPrompt', () => {
  it('names the endpoint, the header, and the Claude Code and Codex configuration', () => {
    const prompt = setupPrompt('http://127.0.0.1:9273/mcp', token())
    expect(prompt).toContain('URL: http://127.0.0.1:9273/mcp')
    expect(prompt).toContain(`Header: Authorization: Bearer ${token()}`)
    expect(prompt).toContain(`claude mcp add-json wasd-engine '{"type":"http","url":"http://127.0.0.1:9273/mcp","headers":{"Authorization":"Bearer ${token()}"}}' --scope user`)
    expect(prompt).toContain('[mcp_servers.wasd-engine]\n  url = "http://127.0.0.1:9273/mcp"')
    expect(prompt).toContain(`http_headers = { "Authorization" = "Bearer ${token()}" }`)
    expect(prompt).toContain('search_game_tools')
  })

  function token(): string {
    return 'T'.repeat(43)
  }
})
