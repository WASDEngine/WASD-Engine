/** The multiplayer tools, as the Session's agent and connected agents call them, against an in-memory WASD Engine site. */
import { createHmac } from 'node:crypto'
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GodotInstancesReport, GodotInstancesRequest } from '@deepseek-ai/dsh-godot'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { LocalizedPrompt } from '../src/multiplayer-prompts.ts'
import {
  MCP_SURFACE, MULTIPLAYER_MCP_INSTRUCTIONS, MULTIPLAYER_PROMPT, MULTIPLAYER_TOOLS, multiplayerMcpTools, multiplayerToolDefinitions,
  type ApprovalAnswer, type MultiplayerSurface, type MultiplayerToolHost,
} from '../src/multiplayer-tools.ts'
import type { SiteAccess } from '../src/site-client.ts'
import { wasdMcpProvider } from '../src/tools.ts'
import { GAME, multiplayerProject, multiplayerSite, olderAddon, ORIGIN, PLANS, removeProjects, TOKEN } from './multiplayer-site.ts'

const ADDON = fileURLToPath(new URL('../addon/wasd_multiplayer', import.meta.url))
const exec = { signal: new AbortController().signal } as ToolRunContext

afterEach(removeProjects)

type Site = ReturnType<typeof multiplayerSite>

interface HostOptions {
  readonly access?: SiteAccess | null
  readonly instances?: (request: GodotInstancesRequest) => GodotInstancesReport
}

function toolHost(site: Site, projectDir: string, options: HostOptions = {}) {
  const runs: GodotInstancesRequest[] = []
  const host: MultiplayerToolHost = {
    project: requested => Promise.resolve(requested ?? projectDir),
    access: () => Promise.resolve(options.access === null ? undefined : options.access ?? { origin: ORIGIN, token: TOKEN }),
    siteOrigin: () => Promise.resolve(ORIGIN),
    fetch: site.fetch,
    runInstances: (request) => {
      runs.push(request)
      return Promise.resolve(options.instances?.(request) ?? { projectDir, instances: [], importIssues: [] })
    },
    addonSource: ADDON,
  }
  return { host, runs }
}

function appSurface(answer: ApprovalAnswer = 'approved', opened = true) {
  const asked: { toolName: string; prompt: LocalizedPrompt }[] = []
  const links: string[] = []
  const surface: MultiplayerSurface = {
    channel: 'app',
    projectDescription: 'Folder containing project.godot.',
    approve: (_exec, toolName, prompt) => {
      asked.push({ toolName, prompt })
      return Promise.resolve(answer)
    },
    openLink: (url) => {
      links.push(url)
      return Promise.resolve(opened)
    },
  }
  return { surface, asked, links }
}

function tool(definitions: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = definitions.find(definition => definition.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}

async function call(definitions: readonly ToolDefinition[], name: string, args: Record<string, unknown> = {}) {
  const definition = tool(definitions, name)
  const value = await definition.execute(args, exec) as JsonValue & Record<string, unknown>
  const text = definition.output.render(args, value).map(block => block.type === 'text' ? block.text : '').join('')
  return { value, text }
}

const stats = (fields: Record<string, unknown>) => `WASD_TEST_STATS ${JSON.stringify({ connected: true, bytes_in: 0, bytes_out: 0, packets_in: 0, packets_out: 0, tick_ms_avg: 0.5, tick_ms_max: 2, rss_bytes: 10 * 1024 * 1024, seconds: 30, ...fields })}\n`

/**
 * A deletion said to end the server's billing outright, in each language: a paid server's unit can stay on the bill
 * for a suspended server that starts again in its place, and a free server has no billing.
 */
const BILLING_ENDS = new RegExp([
  'billing ends', '计费结束', '課金が終わり', 'facturación termina', 'facturation prend fin', 'Abrechnung endet', 'оплата прекратится', 'cobrança termina',
].join('|'), 'u')

/** Every language of a prompt names sizes, prices, and free servers in its own words, never in English. */
function expectLocalizedSizes(prompt: LocalizedPrompt | undefined): void {
  expect(Object.keys(prompt ?? {}).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
  for (const [locale, text] of Object.entries(prompt ?? {})) {
    if (locale !== 'en') expect(text, locale).not.toMatch(/\(free\)|a month/u)
  }
}

describe('wasd_multiplayer_guide', () => {
  it('compares both modes with the site\'s live prices while signed out, and recommends a dedicated server for a persistent world', async () => {
    const site = multiplayerSite()
    const { host } = toolHost(site, await multiplayerProject(), { access: null })
    const { value, text } = await call(multiplayerToolDefinitions(host, appSurface().surface), 'wasd_multiplayer_guide', { persistent_world: true })
    expect(value.recommendation).toEqual({ mode: 'dedicated', reason: 'The world has to keep going while nobody plays, which only a dedicated server kept on (Always on) does.' })
    expect((value.modes as { id: string; cost: string }[]).map(mode => [mode.id, mode.cost])).toEqual([
      ['player_hosted', 'Free for the developer and the players.'],
      ['dedicated', 'From $5 a month per server, by size.'],
    ])
    // The site says how servers sleep and which sizes stay on.
    expect(text).toContain('- Dedicated server (from $5 a month): WASD Engine runs the game\'s server in Oregon, and anyone can join at any time. A server with no players for 15 minutes sleeps, keeping its world, and wakes in a few seconds when a player joins. Medium, Large, and XL servers can stay on instead')
    expect(text).toContain('- Small (small): $5 a month; about 10 players at once and 1,500 player-hours a month; 0.125 cores guaranteed, bursts to 1 core; 256 MB RAM; 150 GB bandwidth a month; 5 GB storage')
    expect(text).toContain('- XL (xl): $50 a month')
    expect(text).toContain('players sign in with a WASD Engine account in both')
    expect(site.calls).toEqual([{ method: 'GET', path: '/api/v1/servers/plans', authorized: false }])
  })

  it('recommends player-hosted for a small co-op game and still answers when the sizes cannot be read', async () => {
    const site = multiplayerSite({ plans: 'error' })
    const { host } = toolHost(site, await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' }))
    const { value, text } = await call(multiplayerToolDefinitions(host, appSurface().surface), 'wasd_multiplayer_guide', { players: 4, genre: 'co-op shooter' })
    expect(value).toMatchObject({ recommendation: { mode: 'player_hosted' }, current_mode: 'player_hosted', sizes: [] })
    expect(value.plans_error).toMatch(/could not read the server sizes \(HTTP 500\)/u)
    expect(text).toContain('Recommendation: player-hosted.')
    expect(text).toContain('WASD Engine runs the game\'s server, and anyone can join at any time. A server may sleep while nobody plays and wake when a player joins.')
  })
})

describe('wasd_multiplayer_setup', () => {
  it('copies the add-on, turns on its autoload and editor plugin, and points the configuration at the linked game', async () => {
    const site = multiplayerSite()
    const dir = await multiplayerProject()
    const definitions = multiplayerToolDefinitions(toolHost(site, dir).host, appSurface().surface)
    const { value, text } = await call(definitions, 'wasd_multiplayer_setup', { mode: 'dedicated' })
    expect(value).toMatchObject({ project_dir: dir, mode: 'dedicated', max_players: 32, project_changed: true, addon_version: '1.3.0' })
    expect(value.addon_files).toBeGreaterThan(5)
    expect(text).toContain('The game is set up for a dedicated server, up to 32 players.')
    expect(text).toContain('Next steps:\n- In the main scene: `if WasdMultiplayer.is_server(): WasdMultiplayer.serve()`')
    const project = await readFile(join(dir, 'project.godot'), 'utf8')
    expect(project).toContain('[autoload]\n\nScore="*res://score.gd"\nWasdMultiplayer="*res://addons/wasd_multiplayer/wasd_multiplayer.gd"\n')
    expect(project).toContain('[editor_plugins]\n\nenabled=PackedStringArray("res://addons/wasd_multiplayer/plugin.cfg")\n')
    const copied = await readdir(join(dir, 'addons', 'wasd_multiplayer'))
    expect(copied).toContain('wasd_multiplayer.gd')
    expect(copied).not.toContain('README.i18n.yaml')
    expect(await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')).toContain(
      `[wasd]\n\nmode="dedicated"\nmax_players=32\napi_origin="${ORIGIN}"\napp_origin="${ORIGIN}"\ngame_id="${GAME.id}"\nversion=0\n`,
    )

    const again = await call(definitions, 'wasd_multiplayer_setup', { mode: 'player_hosted', max_players: 4 })
    expect(again.value).toMatchObject({ mode: 'player_hosted', max_players: 4, project_changed: false })
    expect(await readFile(join(dir, 'project.godot'), 'utf8')).toBe(project)
    expect(await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')).toContain('mode="player_hosted"\nmax_players=4\n')
    await expect(call(definitions, 'wasd_multiplayer_setup', { mode: 'player_hosted', max_players: 17 })).rejects.toThrow('max_players must be a whole number from 2 to 16 for player_hosted.')
  })

  it('names the backup of the add-on files the game had changed, and keeps the configuration\'s other keys', async () => {
    const site = multiplayerSite()
    const dir = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\nserver_fps=30\ncount_traffic=false\n' })
    const addon = await olderAddon(dir)
    await writeFile(join(addon, 'wasd_multiplayer.gd'), 'extends Node\n# The game\'s patch.\n')
    await writeFile(join(addon, 'examples', 'lobby_menu.gd'), 'extends Control\n')
    const definitions = multiplayerToolDefinitions(toolHost(site, dir).host, appSurface().surface)
    const { value, text } = await call(definitions, 'wasd_multiplayer_setup', { mode: 'dedicated' })
    const backup = value.addon_backup as string
    const copy = `${backup}/addons/wasd_multiplayer/wasd_multiplayer.gd`
    expect(value).toMatchObject({ addon_kept: ['examples/lobby_menu.gd'], addon_backup_files: [copy] })
    expect(text).toContain(`The setup replaced add-on files that the game had changed; the game's versions are at ${copy}.`)
    // The result names the file where it is.
    expect(await readFile(join(dir, copy), 'utf8')).toBe('extends Node\n# The game\'s patch.\n')
    expect(await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')).toBe(
      `[wasd]\nmode="dedicated"\nserver_fps=30\ncount_traffic=false\nmax_players=32\napi_origin="${ORIGIN}"\napp_origin="${ORIGIN}"\ngame_id="${GAME.id}"\nversion=0\n`,
    )
  })

  it('changes nothing and fails with a coded refusal when the project\'s addons folder leads outside the project', async () => {
    const site = multiplayerSite()
    const dir = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    // Add-ons that several projects share, in a folder of their own.
    const shared = await multiplayerProject({ linked: false })
    await olderAddon(shared)
    await symlink(join(shared, 'addons'), join(dir, 'addons'))
    const project = await readFile(join(dir, 'project.godot'), 'utf8')
    const definitions = multiplayerToolDefinitions(toolHost(site, dir).host, appSurface().surface)
    const refused = await call(definitions, 'wasd_multiplayer_setup', { mode: 'dedicated' }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HarnessError)
    expect(refused).toMatchObject({ name: 'MultiplayerSetupError', code: 'WASD_MULTIPLAYER_OUTSIDE_PROJECT' })
    expect(await readFile(join(dir, 'project.godot'), 'utf8')).toBe(project)
    expect(await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')).toBe('[wasd]\nmode="player_hosted"\n')
  })
})

describe('wasd_multiplayer_test', () => {
  it('runs the server and clients headless with signed tickets, saves the measurement, and fits the sizes to it', async () => {
    const site = multiplayerSite()
    const dir = await multiplayerProject({ config: '[wasd]\nmode="dedicated"\n', addon: true })
    const { host, runs } = toolHost(site, dir, {
      instances: request => ({
        projectDir: dir,
        importIssues: [],
        instances: request.instances.map((instance, index) => ({
          name: instance.name, exitCode: 0, timedOut: false, stderr: '',
          stdout: index === 0
            ? `WASD_TEST_EVENT {"event":"ready","role":"server","port":1}\n${stats({ role: 'server', peers: 2, bytes_in: 1_300_000, bytes_out: 2_600_000, packets_in: 1300, packets_out: 2600, tick_ms_avg: 1.5, tick_ms_max: 4, rss_bytes: 50 * 1024 * 1024 })}`
            : stats({ role: 'client', peers: 1 }),
        })),
      }),
    })
    const definitions = multiplayerToolDefinitions(host, appSurface().surface)
    const { value, text } = await call(definitions, 'wasd_multiplayer_test', { clients: 2, seconds: 30 })
    expect(value).toMatchObject({ mode: 'dedicated', clients: 2, connected: 2, passed: true, seconds: 26, memory_mb: 50, cpu_cores: 0.09, mb_per_player_hour: 297, fits: 'small' })
    expect(text).toContain('All 2 test players connected to the server. The server used about 50 MB of memory, 9% of a processor core, and 297 MB of traffic per player-hour.')
    expect(text).toContain('At that rate a Small server ($5 a month) holds it, and its bandwidth lasts about 505 player-hours a month.')

    const [request] = runs
    expect(request?.timeoutMs).toBe(60_000)
    const [server, ...clients] = request?.instances ?? []
    expect(server).toMatchObject({ name: 'server', delayMs: 0, env: { WASD_MULTIPLAYER_TEST: 'server', WASD_SERVER: '1', WASD_TEST_SECONDS: '30' } })
    const key = Buffer.from(server?.env.WASD_TICKET_KEY ?? '', 'base64')
    expect(key).toHaveLength(32)
    expect(clients.map(client => client.name)).toEqual(['player1', 'player2'])
    for (const client of clients) {
      expect(client.env).toMatchObject({ WASD_MULTIPLAYER_TEST: 'client', WASD_TEST_PORT: server?.env.WASD_PORT, WASD_TEST_SECONDS: '26' })
      const [prefix, body, signature] = (client.env.WASD_TEST_TICKET ?? '').split('.')
      expect(prefix).toBe('wjt1')
      expect(signature).toBe(createHmac('sha256', key).update(`wjt1.${body ?? ''}`).digest('base64url'))
      const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as { s: string; p: string; n: string; exp: number }
      expect(payload).toMatchObject({ s: server?.env.WASD_SERVER_ID, n: client.name })
      expect(payload.p).toMatch(/^[a-z2-7]{20}$/u)
      expect(payload.exp).toBeGreaterThan(Date.now() / 1000)
    }

    expect(JSON.parse(await readFile(join(dir, '.wasdengine', 'multiplayer-test.json'), 'utf8'))).toMatchObject({ format: 1, mode: 'dedicated', mb_per_player_hour: 297 })
    const plans = await call(definitions, 'wasd_server_plans')
    expect(plans.value.estimates).toEqual([
      { size: 'small', player_hours_per_month: 505, holds_test: true },
      { size: 'medium', player_hours_per_month: 1010, holds_test: true },
      { size: 'large', player_hours_per_month: 2020, holds_test: true },
      { size: 'xl', player_hours_per_month: 5050, holds_test: true },
    ])
    expect(plans.text).toContain('- Small (small): $5 a month; about 10 players at once and 1,500 player-hours a month; 0.125 cores guaranteed, bursts to 1 core; 256 MB RAM; 150 GB bandwidth a month; 5 GB storage; with this game, bandwidth for about 505 player-hours a month')
  })

  it('reports a host that printed no results with the first problem it reported', async () => {
    const site = multiplayerSite()
    const dir = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n', addon: true })
    const { host, runs } = toolHost(site, dir, {
      instances: request => ({
        projectDir: dir,
        importIssues: ['res://main.gd:3: Parse Error'],
        instances: request.instances.map(instance => ({
          name: instance.name, exitCode: 1, timedOut: false, stderr: '',
          stdout: 'WASD_TEST_EVENT {"event":"failed","role":"host","error":"listen_failed","message":"The test host could not listen on port 1 (error 22)."}\n',
        })),
      }),
    })
    const { value, text } = await call(multiplayerToolDefinitions(host, appSurface().surface), 'wasd_multiplayer_test', { clients: 1, seconds: 10 })
    expect(runs[0]?.instances.map(instance => [instance.name, instance.env.WASD_MULTIPLAYER_TEST])).toEqual([['host', 'host'], ['player2', 'client']])
    expect(value).toMatchObject({ passed: false, connected: 0, estimates: [], import_issues: ['res://main.gd:3: Parse Error'] })
    expect(text).toContain('The host reported no test results')
    expect(text).toContain('First problem: host: failed: The test host could not listen on port 1 (error 22).')
    expect(text).toContain('Import errors:\n- res://main.gd:3: Parse Error')
  })

  it('refuses a project without the add-on, and arguments out of range, before starting anything', async () => {
    const site = multiplayerSite()
    const { host, runs } = toolHost(site, await multiplayerProject())
    const definitions = multiplayerToolDefinitions(host, appSurface().surface)
    await expect(call(definitions, 'wasd_multiplayer_test')).rejects.toThrow('The project has no WASD Multiplayer add-on; call wasd_multiplayer_setup first.')
    await expect(call(definitions, 'wasd_multiplayer_test', { clients: 4 })).rejects.toThrow('clients must be 1, 2, or 3.')
    expect(runs).toEqual([])
  })
})

describe('dedicated server tools in a Session', () => {
  it('asks before creating a server, opens the confirmation page, and gives the user the link too', async () => {
    const site = multiplayerSite()
    const { surface, asked, links } = appSurface()
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    const { value, text } = await call(definitions, 'wasd_server_create', { size: 'small', name: 'West 1' })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.toolName).toBe('wasd_server_create')
    expect(asked[0]?.prompt.en).toBe('Create a Small game server for "Defenders" at $5 a month? WASD Engine then opens a page on site.test where you confirm and pay; nothing is charged before that.')
    expect(Object.keys(asked[0]?.prompt ?? {}).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect(site.calls.filter(entry => entry.method === 'POST')).toEqual([{ method: 'POST', path: '/api/v1/servers', authorized: true, body: { game_id: GAME.id, size: 'small', name: 'West 1' } }])
    const confirmUrl = value.confirm_url as string
    expect(confirmUrl).toMatch(/^https:\/\/site\.test\/servers\/confirm\/token-\d+$/u)
    expect(links).toEqual([confirmUrl])
    expect(value).toMatchObject({ status: 'awaiting_confirmation', size: 'small', price: '$5', opened: true, expires_at: '2026-11-13T00:00:00Z' })
    expect(text).toBe(`WASD Engine opened a page on site.test in the browser. This is a Small server for Defenders at $5 a month. Nothing happens until you confirm there. If it did not open, use this link: ${confirmUrl}`)
  })

  it('creates nothing when the user declines, while signed out, before the first release, or while servers are not sold', async () => {
    const site = multiplayerSite()
    const declined = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, appSurface('declined').surface)
    expect((await call(declined, 'wasd_server_create', { size: 'small' })).value).toEqual({
      status: 'declined', size: 'small', price: '$5', for_user: 'The user declined, so nothing was created or charged.',
    })
    const signedOut = multiplayerToolDefinitions(toolHost(site, await multiplayerProject(), { access: null }).host, appSurface().surface)
    await expect(call(signedOut, 'wasd_server_create', { size: 'small' })).rejects.toThrow(/WASD Engine is signed out/u)
    const unreleased = multiplayerToolDefinitions(toolHost(site, await multiplayerProject({ linked: false })).host, appSurface().surface)
    await expect(call(unreleased, 'wasd_server_create', { size: 'small' })).rejects.toThrow(/Release it once with wasd_release_game/u)
    const closedSite = multiplayerSite({ plans: { ...PLANS, available: false } })
    const closed = multiplayerToolDefinitions(toolHost(closedSite, await multiplayerProject()).host, appSurface().surface)
    await expect(call(closed, 'wasd_server_create', { size: 'small' })).rejects.toThrow('WASD Engine does not sell dedicated servers yet. Player-hosted multiplayer works without them.')
    await expect(call(declined, 'wasd_server_create', { size: 'huge' })).rejects.toThrow('There is no server size "huge"; the sizes are small, medium, large, xl.')
    expect(site.calls.filter(entry => entry.method === 'POST')).toEqual([])
  })

  it('changes a size or deletes a server only through the confirmation page, after asking', async () => {
    const site = multiplayerSite()
    const main = site.addServer()
    const { surface, asked, links } = appSurface('approved', false)
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    const resized = await call(definitions, 'wasd_server_change', { size: 'medium' })
    expect(asked[0]?.prompt.en).toBe('Change the server "Main" from Small ($5 a month) to Medium ($10 a month)? WASD Engine then opens a page on site.test where you confirm the change; your bill changes only after that.')
    // Each language names the sizes' prices in its own words.
    expect(asked[0]?.prompt.zh).toBe('要把服务器 "Main" 从 Small（每月 $5）改为 Medium（每月 $10）吗？随后 WASD Engine 会打开 site.test 上的页面，你在那里确认更改；之后账单才会变化。')
    expect(asked[0]?.prompt.de).toBe('Den Server "Main" von Small ($5 im Monat) auf Medium ($10 im Monat) ändern? WASD Engine öffnet danach eine Seite auf site.test, auf der du die Änderung bestätigst; erst dann ändert sich deine Rechnung.')
    expectLocalizedSizes(asked[0]?.prompt)
    expect(resized.value).toMatchObject({ status: 'awaiting_confirmation', server_id: main.id, size: 'medium', price: '$10', opened: false })
    expect(resized.text).toBe(`Open this page to confirm: ${resized.value.confirm_url as string} This changes Main from Small ($5 a month) to Medium at $10 a month. Nothing happens until you confirm there.`)
    const deleted = await call(definitions, 'wasd_server_change', { delete: true })
    // A suspended server of the size that was paid for before starts again on the unit, and the page then names it.
    expect(asked[1]?.prompt.en).toBe('Delete the server "Main"? It stops for every player and its world is deleted 7 days later. Its monthly price comes off your bill, unless the confirmation page says another of your servers keeps it. WASD Engine then opens a page on site.test where you confirm.')
    expect(asked[1]?.prompt.zh).toBe('要删除服务器 "Main" 吗？它会对所有玩家停止，7 天后其世界数据会被删除。它的月费会从账单中去掉，除非确认页面说明你的另一台服务器会接替它。随后 WASD Engine 会打开 site.test 上的页面，由你确认。')
    expect(Object.values(asked[1]?.prompt ?? {}).join('\n')).not.toMatch(BILLING_ENDS)
    expect(deleted.text).toContain('This deletes Main: it stops for every player and its world is deleted 7 days later; its monthly price comes off the bill, unless the confirmation page says another of the account\'s servers keeps it.')
    expect(deleted.value).toMatchObject({ status: 'awaiting_confirmation', server_id: main.id })
    expect(links).toHaveLength(2)
    expect(site.calls.filter(entry => entry.method === 'PATCH' || entry.method === 'DELETE').map(entry => [entry.method, entry.path, entry.body])).toEqual([
      ['PATCH', `/api/v1/servers/${main.id}`, { size: 'medium' }],
      ['DELETE', `/api/v1/servers/${main.id}`, undefined],
    ])
    await expect(call(definitions, 'wasd_server_change', {})).rejects.toThrow('Pass either size or delete: true.')
    await expect(call(definitions, 'wasd_server_change', { size: 'small' })).rejects.toThrow('Main is already Small.')
  })

  it('cancels a purchase still awaiting confirmation, which never ran and was never charged, instead of deleting a server', async () => {
    const site = multiplayerSite()
    const { surface, asked } = appSurface('approved', false)
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    await call(definitions, 'wasd_server_create', { size: 'small' })
    const cancelled = await call(definitions, 'wasd_server_change', { delete: true })
    expect(asked[1]?.prompt.en).toBe('Cancel the purchase of the server "Defenders"? It never ran and was never charged, so cancelling it costs nothing. WASD Engine then opens a page on site.test where you confirm.')
    expect(asked[1]?.prompt.zh).toBe('要取消服务器 "Defenders" 的购买吗？它从未运行，也从未扣费，因此取消不会产生任何费用。随后 WASD Engine 会打开 site.test 上的页面，由你确认。')
    expect(Object.keys(asked[1]?.prompt ?? {}).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect(Object.values(asked[1]?.prompt ?? {}).join('\n')).not.toMatch(BILLING_ENDS)
    expect(`${cancelled.text}\n${asked[1]?.prompt.en ?? ''}`).not.toMatch(/stops for every player|monthly price|world is deleted/u)
    expect(cancelled.value).toMatchObject({
      status: 'awaiting_confirmation', confirm_message: 'Confirm cancelling the purchase of the server Defenders on the WASD Engine site; nothing is charged.',
    })
    expect(cancelled.text).toContain('This cancels the purchase of Defenders: it never ran and was never charged, so cancelling it costs nothing.')
    expect(site.calls.filter(entry => entry.method === 'DELETE')).toHaveLength(1)
    const declined = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, appSurface('declined').surface)
    expect((await call(declined, 'wasd_server_change', { delete: true })).value.for_user).toBe('The user declined, so nothing was cancelled.')
  })

  it('reports, logs, deploys, backs up, and restores the game\'s server, asking before a restore', async () => {
    const site = multiplayerSite()
    const main = site.addServer()
    const { surface, asked } = appSurface()
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    expect((await call(definitions, 'wasd_server_status')).text).toBe(
      `Defenders's servers:\n- Main (small, ${main.id}): running; 3 playing; version 2; bandwidth 12% of 150 GB this month; storage 1.0 GB of 5.0 GB; address wss://host-1.site.test/s/${main.id}`,
    )
    // A server without players sleeps until a player joins, unless its owner keeps it on.
    Object.assign(main, { state: 'sleeping', players_online: 0, sleeps_after_minutes: 15 })
    expect((await call(definitions, 'wasd_server_status')).text).toContain(': asleep with no players; a joining player wakes it; 0 playing;')
    expect((await call(definitions, 'wasd_server_status')).text).toContain('; sleeps after 15 minutes without players')
    Object.assign(main, { state: 'running', players_online: 3, always_on: true, sleeps_after_minutes: null })
    expect((await call(definitions, 'wasd_server_status')).text).toContain('; Always on: stays up without players')
    const logs = await call(definitions, 'wasd_server_logs', { limit: 2 })
    expect(logs.text).toBe('The last 2 lines of Main\'s log:\n2026-11-12T10:00:00Z [stdout] Server ready\n2026-11-12T10:00:01Z [system] Restarted')
    expect((await call(definitions, 'wasd_server_deploy', { version: 1 })).text).toContain('Main is switching to version 1: players get a 60-second warning')
    expect((await call(definitions, 'wasd_server_manage', { action: 'backups' })).text).toBe('Main\'s backups:\n- backup-1: 2026-11-11T00:00:00Z (daily)')
    expect((await call(definitions, 'wasd_server_manage', { action: 'stop' })).text).toContain('Main is stopping after a warning to its players; its world and its monthly price stay.')
    expect((await call(definitions, 'wasd_server_manage', { action: 'restore', backup_id: 'backup-1' })).value).toMatchObject({ status: 'done' })
    expect(asked.map(entry => entry.prompt.en)).toEqual(['Restore the server "Main" from the backup of 2026-11-11T00:00:00Z? Its current world is replaced, and players get a warning before it restarts.'])
    await expect(call(definitions, 'wasd_server_manage', { action: 'restore', backup_id: 'backup-9' })).rejects.toThrow('Main has no backup backup-9; action backups lists them.')
    expect(site.calls.filter(entry => entry.method === 'POST').map(entry => [entry.path, entry.body])).toEqual([
      [`/api/v1/servers/${main.id}/deploy`, { version: 1 }],
      [`/api/v1/servers/${main.id}/actions`, { action: 'stop' }],
      [`/api/v1/servers/${main.id}/actions`, { action: 'restore', backup_id: 'backup-1', confirm: true }],
    ])
    const declined = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, appSurface('cancelled').surface)
    expect((await call(declined, 'wasd_server_manage', { action: 'restore', backup_id: 'backup-1' })).value).toEqual({ status: 'cancelled', for_user: 'The question was cancelled, so nothing was restored.' })
    expect(site.calls.filter(entry => entry.method === 'POST')).toHaveLength(3)
  })

  it('names the servers to choose from when the game has several, and shows the lobbies of a player-hosted game', async () => {
    const site = multiplayerSite()
    const first = site.addServer({ name: 'West' })
    const second = site.addServer({ name: 'East' })
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, appSurface().surface)
    await expect(call(definitions, 'wasd_server_logs')).rejects.toThrow(`This game has 2 servers; pass server, one of: ${first.id} (West), ${second.id} (East).`)
    expect((await call(definitions, 'wasd_lobby_stats')).text).toBe('Defenders has 3 open lobbies with 7 players. Relayed traffic this month: 12.3 GB of the 2000 GB fair-use level. Player-hosted multiplayer costs nothing.')
    expect(site.calls.at(-1)?.path).toBe(`/api/v1/play/stats?game_id=${GAME.id}`)
  })

  it('says when the relay is off for a game past its fair use, and when the site runs no lobbies', async () => {
    const paused = multiplayerToolDefinitions(toolHost(multiplayerSite({ lobbies: 'paused' }), await multiplayerProject()).host, appSurface().surface)
    const { value, text } = await call(paused, 'wasd_lobby_stats')
    expect(value).toMatchObject({ relay_available: false, relay_paused_until: '2026-12-01T00:00:00Z', relay_gb_this_month: 2001.2, relay_soft_cap_gb: 2000 })
    expect(text).toBe('Defenders has 3 open lobbies with 7 players. Relayed traffic this month: 2001.2 GB, past the 2000 GB fair-use level, so the relay is off for this game until 2026-12-01: players whose networks block a direct connection cannot join until then. Player-hosted multiplayer costs nothing.')
    const off = multiplayerToolDefinitions(toolHost(multiplayerSite({ lobbies: 'unavailable' }), await multiplayerProject()).host, appSurface().surface)
    await expect(call(off, 'wasd_lobby_stats')).rejects.toThrow('WASD Engine does not run player-hosted lobbies right now, so there are no lobby statistics. Try again later.')
  })
})

describe('multiplayer tools of connected agents', () => {
  it('require absolute projects except for the guide and the sizes, and a restore only with confirm', async () => {
    const site = multiplayerSite()
    const dir = await multiplayerProject()
    const tools = multiplayerMcpTools(multiplayerToolDefinitions(toolHost(site, dir).host, MCP_SURFACE))
    expect(tools.map(entry => entry.name)).toEqual([...MULTIPLAYER_TOOLS])
    const byName = new Map(tools.map(entry => [entry.name, entry]))
    expect(byName.get('wasd_multiplayer_guide')?.inputSchema?.required).toEqual([])
    expect(byName.get('wasd_server_create')?.inputSchema?.required).toEqual(['project', 'size'])
    expect(tools.filter(entry => entry.readOnly === true).map(entry => entry.name)).toEqual(['wasd_multiplayer_guide', 'wasd_lobby_stats', 'wasd_server_plans', 'wasd_server_status', 'wasd_server_logs'])
    const context = { client: { id: 'claude-code', title: 'Claude Code' }, signal: new AbortController().signal, session: vi.fn(), reveal: vi.fn() }
    await expect(byName.get('wasd_server_create')?.prepare?.({ project: 'game', size: 'small' }, context)).rejects.toThrow('project must be an absolute path.')
    await expect(byName.get('wasd_server_create')?.prepare?.({ size: 'small' }, context)).rejects.toThrow('project must be an absolute path.')
    expect(await byName.get('wasd_multiplayer_guide')?.prepare?.({}, context)).toEqual({ args: {} })
    const manage = byName.get('wasd_server_manage')
    expect(manage?.inputSchema?.properties).toHaveProperty('confirm')
    await expect(manage?.prepare?.({ project: dir, action: 'restore', backup_id: 'backup-1' }, context)).rejects.toThrow(/Pass confirm: true only after your user agreed/u)
    expect(await manage?.prepare?.({ project: dir, action: 'restore', backup_id: 'backup-1', confirm: true }, context)).toEqual({ args: { project: dir, action: 'restore', backup_id: 'backup-1' } })
  })

  it('create servers without the app\'s prompt and hand the confirmation page to the URL elicitation', async () => {
    const site = multiplayerSite()
    const dir = await multiplayerProject()
    const tools = multiplayerMcpTools(multiplayerToolDefinitions(toolHost(site, dir).host, MCP_SURFACE))
    const create = tools.find(entry => entry.name === 'wasd_server_create')
    const value = await create?.definition.execute({ project: dir, size: 'medium' }, exec) as JsonValue & Record<string, unknown>
    expect(value).toMatchObject({ status: 'awaiting_confirmation', opened: false, confirm_message: 'Confirm the Medium game server for Defenders at $10 a month on the WASD Engine site; nothing is charged until you confirm there.' })
    expect(value.for_user).toBe(`Open this page to confirm: ${value.confirm_url as string} This is a Medium server for Defenders at $10 a month. Nothing happens until you confirm there.`)
    expect(create?.confirmation?.(value)).toEqual({ url: value.confirm_url, message: value.confirm_message })
    expect(create?.confirmation?.({ status: 'declined', for_user: 'x' })).toBeUndefined()
    expect(tools.filter(entry => entry.confirmation !== undefined).map(entry => entry.name)).toEqual(['wasd_server_create', 'wasd_server_change'])
  })

  it('join the wasd provider after the release tools, with the multiplayer rules in its instructions', () => {
    const tools = multiplayerMcpTools(multiplayerToolDefinitions(toolHost(multiplayerSite(), '/game').host, MCP_SURFACE))
    const provider = wasdMcpProvider([], { claim: () => Promise.resolve() }, tools, MULTIPLAYER_MCP_INSTRUCTIONS)
    expect(provider.tools().map(entry => entry.name)).toEqual([...MULTIPLAYER_TOOLS])
    expect(provider.instructions).toContain(MULTIPLAYER_MCP_INSTRUCTIONS)
    expect(MULTIPLAYER_MCP_INSTRUCTIONS).toContain('State the monthly price and what it includes before suggesting a server, or that it is free while one is left when your user confirms, if wasd_server_plans lists free servers of that size left for your user\'s account,')
  })
})

describe('free servers WASD Engine gave the account', () => {
  const GRANTS = [{ size: 'small', granted: 2, in_use: 1, available: 1 }, { size: 'large', granted: 1, in_use: 1, available: 0 }]

  it('lists the account\'s free servers with the sizes, only when signed in', async () => {
    const site = multiplayerSite({ grants: GRANTS })
    const signedIn = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, appSurface().surface)
    const plans = await call(signedIn, 'wasd_server_plans')
    expect(plans.text).toContain('Free servers WASD Engine gave this account: 2 Small (1 left), 1 Large (0 left). A server of a size with one left is free while one is still left when the user confirms it on the site.')
    expect(plans.value.free_servers).toEqual(GRANTS)
    expect((await call(signedIn, 'wasd_multiplayer_guide')).text).toContain('Free servers WASD Engine gave this account: 2 Small (1 left)')
    const signedOut = multiplayerToolDefinitions(toolHost(site, await multiplayerProject(), { access: null }).host, appSurface().surface)
    const anonymous = await call(signedOut, 'wasd_server_plans')
    expect(anonymous.text).not.toContain('Free servers')
    expect(anonymous.value.free_servers).toBeUndefined()
  })

  it('creates a server of a size with a free one left as free while one is left when the user confirms, and charges for a size without', async () => {
    const site = multiplayerSite({ grants: GRANTS })
    const { surface, asked } = appSurface()
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    const free = await call(definitions, 'wasd_server_create', { size: 'small' })
    // The site decides whether the server is free only when the user confirms there.
    expect(asked[0]?.prompt.en).toBe('Create a free Small game server for "Defenders"? WASD Engine gave this account free Small servers, and it is free while one of them is left when you confirm. WASD Engine then opens a page on site.test where you confirm; if none is left by then, the page shows the price instead.')
    expect(asked[0]?.prompt.zh).toBe('要为 "Defenders" 创建一台免费的 Small 游戏服务器吗？WASD Engine 为此账号提供了免费的 Small 服务器，只要你确认时还剩一台，它就是免费的。随后 WASD Engine 会打开 site.test 上的页面，由你确认；如果到那时一台都不剩，页面会改为显示价格。')
    expect(asked[0]?.prompt.fr).toBe('Créer un serveur de jeu Small gratuit pour "Defenders" ? WASD Engine a offert à ce compte des serveurs Small gratuits, et il est gratuit tant qu’il en reste un quand vous confirmez. WASD Engine ouvre ensuite une page sur site.test où vous confirmez ; s’il n’en reste plus d’ici là, la page affiche le prix à la place.')
    expectLocalizedSizes(asked[0]?.prompt)
    expect(free.value).toMatchObject({ status: 'awaiting_confirmation', size: 'small', price: '$5', free: true })
    expect(free.value.confirm_message).toBe('Confirm the Small game server for Defenders on the WASD Engine site; it is free while one of your free Small servers is left when you confirm.')
    expect(free.text).toContain('This is a Small server for Defenders, free while one of the free Small servers WASD Engine gave this account is left when you confirm; if none is left by then, the page shows its price, $5 a month, instead. Nothing happens until you confirm there.')
    expect(`${free.text}\n${String(free.value.confirm_message)}\n${asked[0]?.prompt.en ?? ''}`).not.toMatch(/costs nothing|nothing is charged/u)
    // Every free Large server is in use, so another one is a purchase.
    const paid = await call(definitions, 'wasd_server_create', { size: 'large' })
    expect(asked[1]?.prompt.en).toBe('Create a Large game server for "Defenders" at $20 a month? WASD Engine then opens a page on site.test where you confirm and pay; nothing is charged before that.')
    expect(paid.value.free).toBeUndefined()
    expect(paid.text).toContain('This is a Large server for Defenders at $20 a month.')
    // The pending free Small server holds the last free one, so another Small server is a purchase.
    expect((await call(definitions, 'wasd_server_create', { size: 'small' })).value.free).toBeUndefined()
    const declined = multiplayerToolDefinitions(toolHost(multiplayerSite({ grants: GRANTS }), await multiplayerProject()).host, appSurface('declined').surface)
    expect((await call(declined, 'wasd_server_create', { size: 'small' })).value).toEqual({
      status: 'declined', size: 'small', price: '$5', free: true, for_user: 'The user declined, so nothing was created or charged.',
    })
  })

  it('names a free server\'s size as free when it changes size, the new size too while a free one is left, and a paid size as a new purchase', async () => {
    const site = multiplayerSite({ grants: [{ size: 'medium', granted: 1, in_use: 0, available: 1 }] })
    const main = site.addServer({ granted: true })
    const { surface, asked } = appSurface('approved', false)
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    expect((await call(definitions, 'wasd_server_status')).text).toContain(`Main (small, ${main.id}): running; free: one of the free servers WASD Engine gave the account; 3 playing`)
    const free = await call(definitions, 'wasd_server_change', { size: 'medium' })
    expect(asked[0]?.prompt.en).toBe('Change the server "Main" from Small (free) to Medium (free)? WASD Engine gave this account free Medium servers, and the new size is free while one of them is left when you confirm. WASD Engine then opens a page on site.test where you confirm the change; your bill changes only after that.')
    expect(asked[0]?.prompt.zh).toBe('要把服务器 "Main" 从 Small（免费）改为 Medium（免费）吗？WASD Engine 为此账号提供了免费的 Medium 服务器，只要你确认时还剩一台，新规格就是免费的。随后 WASD Engine 会打开 site.test 上的页面，你在那里确认更改；之后账单才会变化。')
    expectLocalizedSizes(asked[0]?.prompt)
    expect(free.value).toMatchObject({ status: 'awaiting_confirmation', size: 'medium', price: '$10', free: true })
    expect(free.text).toContain('This changes Main from Small (free) to Medium, free while one of the free Medium servers WASD Engine gave this account is left when you confirm; if none is left by then, the page shows its price, $10 a month, instead.')
    expect(free.value.confirm_message).toBe('Confirm changing the server Main to Medium on the WASD Engine site; it is free while one of your free Medium servers is left when you confirm.')
    // A free server moved to a size without a free one left is bought at that size's price; nothing credits it.
    const paid = await call(definitions, 'wasd_server_change', { size: 'large' })
    expect(asked[1]?.prompt.en).toBe('Change the server "Main" from Small (free) to Large ($20 a month)? Large is a new purchase at $20 a month, and the free Small server stays on this account for another server. WASD Engine then opens a page on site.test where you confirm and pay; nothing is charged before that.')
    expect(asked[1]?.prompt.ja).toBe('サーバー "Main" を Small（無料）から Large（月額 $20）に変更しますか？Large は月額 $20 の新規購入となり、無料の Small サーバーは別のサーバー用にこのアカウントに残ります。このあと WASD Engine が site.test のページを開き、そこで確認して支払います。それまで料金はかかりません。')
    expectLocalizedSizes(asked[1]?.prompt)
    expect(paid.value.free).toBeUndefined()
    expect(paid.text).toContain('This changes Main from Small (free) to Large, a new purchase at $20 a month; the free Small server stays on the account for another server.')
    expect(paid.value.confirm_message).toBe('Confirm changing the server Main to Large, a new purchase at $20 a month, on the WASD Engine site; nothing is charged until you confirm there.')
  })

  it('asks again for the same free size as free while the server\'s own pending resize holds the free server', async () => {
    const site = multiplayerSite({ grants: [{ size: 'medium', granted: 1, in_use: 0, available: 1 }] })
    site.addServer({ granted: true })
    const { surface, asked } = appSurface('approved', false)
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    await call(definitions, 'wasd_server_change', { size: 'medium' })
    // The unconfirmed resize holds the free Medium server, which the sizes then count as taken.
    expect((await call(definitions, 'wasd_server_plans')).value.free_servers).toEqual([{ size: 'medium', granted: 1, in_use: 0, available: 0 }])
    // A new request replaces the server's own one, so the site covers it with the same free server.
    const again = await call(definitions, 'wasd_server_change', { size: 'medium' })
    expect(asked[1]?.prompt.en).toBe(asked[0]?.prompt.en)
    expect(again.value).toMatchObject({ status: 'awaiting_confirmation', size: 'medium', free: true })
    expect(again.text).toContain('This changes Main from Small (free) to Medium, free while one of the free Medium servers WASD Engine gave this account is left')
  })

  it('deletes a free server without a change to the bill', async () => {
    const site = multiplayerSite()
    site.addServer({ granted: true })
    const { surface, asked } = appSurface('approved', false)
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    const deleted = await call(definitions, 'wasd_server_change', { delete: true })
    expect(asked[0]?.prompt.en).toBe('Delete the free server "Main"? It stops for every player and its world is deleted 7 days later; your bill does not change, and the free server can cover another one. WASD Engine then opens a page on site.test where you confirm.')
    expect(asked[0]?.prompt.zh).toBe('要删除免费服务器 "Main" 吗？它会对所有玩家停止，7 天后其世界数据会被删除；你的账单不会变化，这个免费名额可以留给另一台服务器。随后 WASD Engine 会打开 site.test 上的页面，由你确认。')
    expect(Object.keys(asked[0]?.prompt ?? {}).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect(deleted.value).toMatchObject({ status: 'awaiting_confirmation', confirm_message: 'Confirm deleting the server Main on the WASD Engine site; its world is deleted 7 days later.' })
    expect(deleted.text).toContain('This deletes Main: it stops for every player and its world is deleted 7 days later; it is one of the account\'s free servers, so the bill does not change.')
    expect(`${deleted.text}\n${Object.values(asked[0]?.prompt ?? {}).join('\n')}`).not.toMatch(BILLING_ENDS)
  })

  it('names a size the site no longer lists by its id, and as free while a free server covers it', async () => {
    const site = multiplayerSite()
    site.addServer({ size: 'tiny' })
    site.addServer({ name: 'Spare', size: 'tiny', granted: true })
    const { surface, asked } = appSurface('approved', false)
    const definitions = multiplayerToolDefinitions(toolHost(site, await multiplayerProject()).host, surface)
    const [paid, free] = (await call(definitions, 'wasd_server_status')).value.servers as { id: string }[]
    await call(definitions, 'wasd_server_change', { server: paid?.id, size: 'small' })
    expect(asked[0]?.prompt.en).toBe('Change the server "Main" from tiny to Small ($5 a month)? WASD Engine then opens a page on site.test where you confirm the change; your bill changes only after that.')
    expect(asked[0]?.prompt.zh).toBe('要把服务器 "Main" 从 tiny 改为 Small（每月 $5）吗？随后 WASD Engine 会打开 site.test 上的页面，你在那里确认更改；之后账单才会变化。')
    await call(definitions, 'wasd_server_change', { server: free?.id, size: 'small' })
    expect(asked[1]?.prompt.en).toContain('Change the server "Spare" from tiny (free) to Small ($5 a month)? Small is a new purchase at $5 a month, and the free tiny server stays')
    expect(asked[1]?.prompt.pt).toContain('Mudar o servidor "Spare" de tiny (grátis) para Small ($5 por mês)?')
  })
})

describe('wasd_server_create and wasd_server_change descriptions', () => {
  it('say that only the site decides a free server when the user confirms, and what a change does to a paid and a free server\'s bill', () => {
    const definitions = multiplayerToolDefinitions(toolHost(multiplayerSite(), '/game').host, appSurface().surface)
    expect(tool(definitions, 'wasd_server_create').description).toBe('Create a dedicated server for the released game, of a size the user chose from wasd_server_plans. It never charges by itself: it returns a page on the WASD Engine site where the user confirms and pays, which needs a valid payment method on their account; a size of which wasd_server_plans lists free servers left for the account is free while one is left when the user confirms, and then needs no card. Tell the user the size\'s monthly price, or that it is free while one of those free servers is left, and what it includes before calling it. The server then runs the server build of the game\'s latest release.')
    expect(tool(definitions, 'wasd_server_change').description).toBe('Change a dedicated server\'s size, or delete the server. It never changes the bill by itself: it returns a page on the WASD Engine site where the user confirms. For a paid server, a bigger size is charged from the confirmation, prorated, and a smaller one credited. A free server (wasd_server_status marks it) moved to a size without free servers left becomes a new purchase at that size\'s monthly price, with no credit. A size with free servers left for the account (wasd_server_plans lists them) is free while one is left when the user confirms. Deleting stops the server and deletes its world 7 days later; a paid server\'s monthly price comes off the bill unless the confirmation page says another of the account\'s servers keeps it, and a free one changes no bill. Deleting a server whose purchase still awaits confirmation cancels that purchase, which never ran or charged anything. Tell the user the price difference or what deleting loses before calling it.')
  })
})

describe('MULTIPLAYER_PROMPT', () => {
  it('states the four rules the agent follows before any cost', () => {
    expect(MULTIPLAYER_PROMPT).toContain('1. Call wasd_multiplayer_guide first and show the user its comparison with the costs before setting anything up')
    expect(MULTIPLAYER_PROMPT).toContain('2. State the monthly price and what it includes before suggesting a server; when wasd_server_plans lists free servers of a size left for the account, a server of that size is free while one is left when the user confirms, so say that instead.')
    expect(MULTIPLAYER_PROMPT).toContain('3. Let the user choose the size from wasd_server_plans; never pick one for them.')
    expect(MULTIPLAYER_PROMPT).toContain('4. Explain that the owner gets emails at 70%, 90%, and 100% of a server\'s monthly bandwidth, and that at 100% the server stops until its next billing month')
  })
})
