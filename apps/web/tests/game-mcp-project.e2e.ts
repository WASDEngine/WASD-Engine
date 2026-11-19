/**
 * A connected agent creates a game project through WASD Engine's MCP server in the shipped Web composition: the
 * overview of the server instructions, with every shipped plugin, fits in the 4,096 characters that Claude Code keeps
 * and puts a fitting download before Nano Banana and ElevenLabs, a plugin's guide comes from `search_game_tools`, and
 * `create_game_project` makes the folder in WASD Engine's folder for game projects with a Git repository and its one
 * commit, as the Create game project dialog does, and registers it with no Session, its result ends with the new game
 * guidance of WASD Engine's game tools overlay, the window's sidebar lists it as a game project, and the project's
 * credits hold the model the agent named.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it, onTestFailed, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { listeningGameMcp, shippedNewGameGuidance, writeGameMcpPatch } from './game-mcp-support.ts'
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
  const guidance = shippedNewGameGuidance()
  scaffold = await launchWebScaffold({ extraOverlayPath: await writeGameMcpPatch(data, guidance) })
  const ctx = scaffold.ctx
  const { url, token } = await listeningGameMcp(ctx, data)

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

  // Claude Code passes its model the first 4,096 characters of the instructions: the overview, with every shipped
  // plugin, fits in them, and a plugin's guide, which may come after the cut, is one search away.
  const instructions = client.getInstructions() ?? ''
  const overview = instructions.slice(0, instructions.indexOf('\n\n## '))
  expect(overview.length).toBeGreaterThan(0)
  expect(overview.length).toBeLessThanOrEqual(4096)
  for (const plugin of ['Godot (godot_*)', 'Blender (blender_*)', 'Game add-ons (game_*)', 'Graphics review (graphics_*)', 'GIMP (gimp_*)', 'SuperCollider (supercollider_*)']) {
    expect(overview).toContain(`\n- ${plugin}: `)
  }
  expect(overview).toContain('read the whole catalog with game_addons action search')
  // Each asset comes from a fitting download first, then from Nano Banana and ElevenLabs.
  for (const preference of [
    'on Poly Haven and download them into the game. Look here before you make or generate an asset, and use what suits the game\'s art style.\n',
    'with Google\'s Nano Banana 2.1. Prefer it to drawing 2D art yourself.\n',
    'clone the user\'s own voices. Prefer it to SuperCollider.\n',
  ]) {
    expect(overview).toContain(preference)
  }
  // What to do and what to tell the user come before the plugin list, whose end a harness that cuts the instructions takes first.
  expect(overview).toContain('building faster, convenience, matching what you made in code, and not having looked are not reasons.\n\nWhat each plugin adds:\n')
  const guide = await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'blender' } })
  expect((guide.content as { type: string; text?: string }[])[0]?.text)
    .toContain('Blender guide (where it names one of the tools below without the blender_ prefix, add the prefix):\n\nBlender runs headless')

  // The agent names the model it is, which WASD Engine cannot see, so the game's page can credit it.
  const result = await client.callTool({ name: 'create_game_project', arguments: { name: NAME, model: 'Claude Fable 5.2' } })
  const text = (result.content as { type: string; text?: string }[]).flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n')
  expect(result.isError, text).toBeFalsy()

  // The folder sits in WASD Engine's folder for game projects, with the repository the dialog makes.
  const path = join(scaffold.workspaceCwd, 'Documents', 'WASD Engine', NAME)
  expect(text).toBe(`Created the game project "${NAME}" in ${path}, which WASD Engine lists among the user's game projects. `
    + 'The folder holds a Git repository with one empty commit and no game files yet. '
    + 'Before you write code, plan the game around the plugins that search_game_tools lists, and read the guide of each one you will use. '
    + 'Make the game in this folder, and write its project.godot before you install add-ons into it. '
    + 'Where a game tool takes project, pass this folder\'s absolute path; the blender_*, gimp_*, and supercollider_* tools take project '
    + `only together with session.\n\n${guidance}`)
  expect(guidance).toMatch(/^These additional instructions are the recommended prompt for building games with WASD Engine\./u)
  expect(execFileSync('git', ['-C', path, 'log', '--format=%s'], { encoding: 'utf8' }).trim()).toBe(`Create ${NAME}`)
  const workspace = ctx.workspaceRegistry.list().find(entry => entry.path === path)
  expect(workspace?.title).toBe(NAME)
  expect(workspace?.sessionIds).toEqual([])
  expect(ctx.sessions.list()).toHaveLength(liveSessions)
  // WASD Engine Plugins credits the new game with the named model, which a release from the window uploads later.
  await vi.waitFor(async () => {
    expect(JSON.parse(await readFile(join(path, '.wasdengine', 'credits.json'), 'utf8'))).toEqual({
      format: 1, models: [{ name: 'Claude Fable 5.2' }], tools: [], agents: [{ id: 'claude-code', model: 'Claude Fable 5.2' }],
    })
  }, { timeout: 10_000 })

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
