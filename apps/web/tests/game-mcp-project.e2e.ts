/**
 * A connected agent creates a game project through WASD Engine's MCP server in the shipped Web composition:
 * `create_game_project` makes the folder in WASD Engine's folder for game projects with a Git repository and its one
 * commit, as the Create game project dialog does, and registers it with no Session, and the window's sidebar lists it as
 * a game project.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it, onTestFailed, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-game-mcp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const NAME = 'Space Frogs'

let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let client: Client | undefined
let data: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await client?.close()
  client = undefined
  await browser?.close()
  browser = undefined
  await scaffold?.close()
  scaffold = undefined
  if (data !== undefined) await rm(data, { recursive: true, force: true })
  data = undefined
})

it('creates a game project for a connected agent, which the window lists as a game project with no Session', async () => {
  data = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-project-'))
  // A patch replaces the row's whole configuration: a data folder of its own, and any free port, as the installed app
  // may hold the usual one.
  const overlay = join(data, 'game-mcp.patch.yml')
  await writeFile(overlay, `- id: game-mcp\n  config:\n    dataRoot: ${JSON.stringify(join(data, 'game-mcp'))}\n    port: 0\n`)
  scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  const ctx = scaffold.ctx
  // Connected agents' calls run while someone is signed in.
  const account = ctx.get('deepseekAccount')
  if (account !== undefined) vi.spyOn(account, 'getState').mockResolvedValue({ status: 'credential-stored', links: { usageUrl: '', topUpUrl: '' }, attempt: null })
  const server = ctx.get('gameMcp')
  if (server === undefined) throw new Error('the game MCP server is not loaded')
  const watching = new AbortController()
  let url: string | undefined
  for await (const view of server.watch(watching.signal)) {
    if (view.state === 'failed') throw new Error(`the game MCP server failed: ${view.message ?? ''}`)
    if (view.state !== 'listening') continue
    url = view.url
    break
  }
  watching.abort()
  if (url === undefined) throw new Error('the game MCP server has no address')
  const token = (await readFile(join(data, 'game-mcp', 'token'), 'utf8')).trim()

  browser = await chromium.launch()
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-game-mcp-project'))
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const sessions = page.getByRole('tree', { name: 'Sessions' })
  await sessions.waitFor({ timeout: 30_000 })
  const liveSessions = ctx.sessions.list().length

  client = new Client({ name: 'claude-code', version: '2.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const result = await client.callTool({ name: 'create_game_project', arguments: { name: NAME } })
  const text = (result.content as { type: string; text?: string }[]).flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n')
  expect(result.isError, text).toBeFalsy()

  // The folder sits in WASD Engine's folder for game projects, with the repository the dialog makes.
  const path = join(scaffold.workspaceCwd, 'Documents', 'WASD Engine', NAME)
  expect(text).toBe(`Created the game project "${NAME}" in ${path}, which WASD Engine lists among the user's game projects. `
    + 'The folder holds a Git repository with one empty commit and nothing else. Make the game in this folder, and pass its path as project to the game tools.')
  expect(execFileSync('git', ['-C', path, 'log', '--format=%s'], { encoding: 'utf8' }).trim()).toBe(`Create ${NAME}`)
  const workspace = ctx.workspaceRegistry.list().find(entry => entry.path === path)
  expect(workspace?.title).toBe(NAME)
  expect(workspace?.sessionIds).toEqual([])
  expect(ctx.sessions.list()).toHaveLength(liveSessions)

  // The window lists the project as a game project, folded, and showing it opened no Session.
  const row = sessions.locator(`[role="treeitem"][data-row-key="workspace:${String(workspace?.id)}"]`)
  await row.waitFor({ timeout: 30_000 })
  expect(await row.textContent()).toContain(NAME)
  expect(await row.getAttribute('aria-expanded')).toBe('false')
  // A game project row shows its actions while hovered.
  await row.hover()
  await row.getByRole('button', { name: `Game project actions for ${NAME}` }).waitFor({ timeout: 10_000 })
  expect(ctx.sessions.list()).toHaveLength(liveSessions)
  expect(ctx.workspaceRegistry.list().find(entry => entry.path === path)?.sessionIds).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
}, 180_000)
