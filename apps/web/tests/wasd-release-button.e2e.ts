/**
 * The Release button of a game project's Session through the shipped Web composition. A blank Session, whose header
 * shows no actions, offers Release in the New Session row; its dialog sends the release prompt to the Session's agent;
 * and the started Session offers Release in its header instead.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const PROVIDER = 'wasd-release-web-test'
const MODEL = 'scripted'
const SESSION = SessionId('wasd-release-blank')
const RELEASE_PROMPT = 'Release this game on WASD Engine: call wasd_release_game with short release notes about what changed since the last release, then give me the share link.'

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

describe('web e2e: Release button of a game project Session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const adapter = new AnsweringAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Release button answering adapter')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    // A game project whose only Session is blank, as opening a project or New Session leaves it.
    const project = join(scaffold.workspaceCwd, 'neon')
    await mkdir(project)
    await writeFile(join(project, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Neon"\n')
    const workspace = await scaffold.ctx.workspaceRegistry.create(project)
    const handle = await scaffold.ctx.agents.create({
      sessionId: SESSION, meta: { cwd: project }, agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
    try {
      await workspace.attachSession(SESSION)
    } finally {
      await handle.dispose()
    }
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

  it('offers Release in the New Session row of a blank Session, and in the header once the release prompt starts it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-wasd-release-button'))
    const newSessionRelease = page.locator('button[data-placement="newSession"]')
    const headerRelease = page.locator('button[data-placement="header"]')
    await newSessionRelease.waitFor({ timeout: 30_000 })
    expect(await newSessionRelease.textContent()).toBe('Release')
    expect(await headerRelease.count()).toBe(0)

    await newSessionRelease.click()
    const dialog = page.getByRole('dialog', { name: 'Release a new version' })
    const confirm = dialog.getByRole('button', { name: 'Release', exact: true })
    await expect.poll(() => confirm.isEnabled(), { timeout: 10_000 }).toBe(true)
    const settled = scaffold.whenTurnSettled()
    await confirm.click()
    expect(await settled).toBe(SESSION)

    const prompted = adapter.requests[0]?.messages.flatMap(message => message.role === 'user' ? message.content : [])
      .some(block => block.type === 'text' && block.text === RELEASE_PROMPT)
    expect(prompted).toBe(true)
    await headerRelease.waitFor({ timeout: 30_000 })
    expect(await headerRelease.textContent()).toBe('Release')
    expect(await newSessionRelease.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
