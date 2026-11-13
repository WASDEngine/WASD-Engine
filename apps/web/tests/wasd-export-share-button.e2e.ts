/**
 * The Export / Share button of a game project's Session through the shipped Web composition. A blank Session, whose
 * header shows no actions, offers Export / Share in the New Session row; its dialog sends the share prompt to the
 * Session's agent; and the started Session offers Export / Share in its header instead, where a private link with
 * downloads and a desktop export send their own prompts. A project whose game another folder on this computer
 * releases, as a copy's does, names that folder, and Release as a new game asks the agent for a new game.
 */
import { createHash } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const PROVIDER = 'wasd-export-share-web-test'
const MODEL = 'scripted'
const SESSION = SessionId('wasd-release-blank')
const COPY_SESSION = SessionId('wasd-release-copy')
const RECORD = 'First run it with godot_run, bring it to its gameplay, and record its preview with wasd_record_preview, with input events that show the game in action; check the still it returns, and record again when it does not show the game well.'
const SHARE_PROMPT = `Release this game on WASD Engine. ${RECORD} Then call wasd_release_game with the arguments {"visibility":"public"} and short release notes about what changed since the last release, and give me the share link.`
const PRIVATE_PROMPT = `Release this game on WASD Engine. ${RECORD} Then call wasd_release_game with the arguments {"visibility":"private","desktop":["windows"]} and these release notes, and give me the share link.\n\nRelease notes: Friends only`
const EXPORT_PROMPT = 'Export this game for desktop computers: call wasd_export_desktop with the arguments {"platforms":["windows","macos"]}, then tell me where each file is and how to open it.'
const NEW_GAME_PROMPT = `Release this game on WASD Engine as a new game. ${RECORD} Then call wasd_release_game with the arguments {"visibility":"public","new_game":true} and short release notes about what is in this version, and give me the share link.`

/** Answers every request with one text block and keeps the requests. */
class AnsweringAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Released.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Released.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Whether the latest request to the model carries `text` as a user message. */
function prompted(adapter: AnsweringAdapter, text: string): boolean {
  return adapter.requests.at(-1)?.messages.flatMap(message => message.role === 'user' ? message.content : [])
    .some(block => block.type === 'text' && block.text === text) === true
}

describe('web e2e: Export / Share button of a game project Session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const adapter = new AnsweringAdapter()

  /** A game project whose only Session is blank, as opening a project or New Session leaves it. */
  async function gameProject(folder: string, session: SessionId): Promise<string> {
    const project = join(scaffold.workspaceCwd, folder)
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Neon"\n')
    const workspace = await scaffold.ctx.workspaceRegistry.create(project)
    const handle = await scaffold.ctx.agents.create({
      sessionId: session, meta: { cwd: project }, agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
    try {
      await workspace.attachSession(session)
    } finally {
      await handle.dispose()
    }
    return project
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Export / Share answering adapter')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    await gameProject('neon', SESSION)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.addInitScript((id) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, SESSION)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-composer-input]').first().waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers Export / Share in the New Session row of a blank Session, and in the header once the share prompt starts it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-wasd-export-share-button'))
    const newSessionButton = page.locator('button[data-placement="newSession"]')
    const headerButton = page.locator('button[data-placement="header"]')
    await newSessionButton.waitFor({ timeout: 30_000 })
    expect(await newSessionButton.textContent()).toBe('Export / Share')
    expect(await headerButton.count()).toBe(0)

    await newSessionButton.click()
    const dialog = page.getByRole('dialog', { name: 'Export / Share' })
    expect(await dialog.getByRole('radio', { name: /Share on Explore/u }).isChecked()).toBe(true)
    const confirm = dialog.getByRole('button', { name: 'Share on Explore', exact: true })
    await expect.poll(() => confirm.isEnabled(), { timeout: 10_000 }).toBe(true)
    const settled = scaffold.whenTurnSettled()
    await confirm.click()
    expect(await settled).toBe(SESSION)

    expect(prompted(adapter, SHARE_PROMPT)).toBe(true)
    await headerButton.waitFor({ timeout: 30_000 })
    expect(await headerButton.textContent()).toBe('Export / Share')
    expect(await newSessionButton.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('asks the agent for a private link with the downloads the user checks, and for a desktop export', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-wasd-export-share-private'))
    const headerButton = page.locator('button[data-placement="header"]')
    await headerButton.click({ timeout: 30_000 })
    let dialog = page.getByRole('dialog', { name: 'Export / Share' })
    await dialog.getByRole('radio', { name: /Private link/u }).check()
    await dialog.getByRole('textbox', { name: 'Release notes' }).fill('Friends only')
    await dialog.getByRole('checkbox', { name: 'Windows' }).check()
    let settled = scaffold.whenTurnSettled()
    await dialog.getByRole('button', { name: 'Create private link', exact: true }).click()
    expect(await settled).toBe(SESSION)
    expect(prompted(adapter, PRIVATE_PROMPT)).toBe(true)

    await headerButton.click()
    dialog = page.getByRole('dialog', { name: 'Export / Share' })
    await dialog.getByRole('radio', { name: /Export for Windows and macOS/u }).check()
    expect(await dialog.getByRole('checkbox', { name: 'Windows' }).isChecked()).toBe(true)
    expect(await dialog.getByRole('checkbox', { name: 'macOS' }).isChecked()).toBe(true)
    settled = scaffold.whenTurnSettled()
    await dialog.getByRole('button', { name: 'Export', exact: true }).click()
    expect(await settled).toBe(SESSION)
    expect(prompted(adapter, EXPORT_PROMPT)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('names the other folder that releases the project\'s game, and asks for a new game when the user checks Release as a new game', async () => {
    // Both folders link to one game on the site, and this computer's release folders say the first one released it,
    // as after copying a released project.
    // The site the composition releases to, from the plugin's site links.
    const plugins: { links(signal: AbortSignal): Promise<{ readonly explore: string }> } | undefined = scaffold.ctx.get('wasdPlugins')
    if (plugins === undefined) throw new Error('the Web composition has no WASD Engine Plugins')
    const site = new URL((await plugins.links(new AbortController().signal)).explore).origin
    const game = { id: 'game-1', slug: 'neon-k3x9q2', title: 'Neon', url: `${site}/games/neon-k3x9q2`, version: 3 }
    const original = join(scaffold.workspaceCwd, 'neon')
    const copy = await gameProject('neon copy', COPY_SESSION)
    for (const folder of [original, copy]) {
      await mkdir(join(folder, '.wasdengine'), { recursive: true })
      await writeFile(join(folder, '.wasdengine', 'game.json'), JSON.stringify({ format: 1, games: { [site]: game } }))
    }
    // The record of src/folders.ts in the plugin's dataRoot, dshHomePath('wasd-plugins').
    const records = join(scaffold.harnessHome, 'wasd-plugins', 'release-folders')
    await mkdir(records, { recursive: true })
    const realOriginal = await realpath(original)
    await writeFile(
      join(records, `${createHash('sha256').update(`${site}\n${game.id}`).digest('hex').slice(0, 32)}.json`),
      JSON.stringify({ format: 1, folders: [{ path: realOriginal, inode: (await stat(realOriginal, { bigint: true })).ino.toString() }] }),
    )
    const second = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(second, 'web-e2e-wasd-export-share-button-copy'))
    const errors = watchConsole(second)
    await second.addInitScript((id) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, COPY_SESSION)
    await second.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await second.locator('button[data-placement="newSession"]').click({ timeout: 30_000 })
    const dialog = second.getByRole('dialog', { name: 'Export / Share' })
    await dialog.getByText('Latest release: version 3', { exact: false }).waitFor({ timeout: 10_000 })
    await dialog.getByText(`This folder and ${realOriginal} release the same game, as happens when one is a copy of the other.`, { exact: false }).waitFor()
    const newGame = dialog.getByRole('checkbox', { name: 'Release as a new game' })
    expect(await newGame.isChecked()).toBe(false)
    await newGame.check()
    const settled = scaffold.whenTurnSettled()
    await dialog.getByRole('button', { name: 'Share on Explore', exact: true }).click()
    expect(await settled).toBe(COPY_SESSION)
    expect(prompted(adapter, NEW_GAME_PROMPT)).toBe(true)
    expect(errors.pageErrors).toEqual([])
    await second.close()
  }, 120_000)
})
