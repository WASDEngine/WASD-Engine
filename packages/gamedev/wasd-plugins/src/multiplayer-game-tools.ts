/**
 * The multiplayer tools that make and test a game's own multiplayer: `wasd_multiplayer_guide`, the setup, the local
 * test, and the lobby statistics.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { linkedGame } from './game-link.ts'
import { formatPrice, MultiplayerError, type ServerPlans, type ServerSize } from './multiplayer-api.ts'
import {
  BOOLEAN, estimatesJson, FOR_USER, freeServersLine, INTEGER, isFile, json, JSON_VALUE, MAX_LOBBY_PLAYERS, MAX_SERVER_PLAYERS, modes,
  readPlans, releasedGameOf, sizeLine, SLEEP_FALLBACK, STRING, TEST_TIMEOUT_MS, text,
} from './multiplayer-parts.ts'
import {
  ADDON_DIR, hasMultiplayerAddon, installMultiplayerAddon, MULTIPLAYER_MODES, pluginVersion, readMultiplayerConfig, withMultiplayerAddon,
  writeMultiplayerConfig,
} from './multiplayer-project.ts'
import {
  clientConnected, estimateSizes, freePort, instanceProblems, instanceStats, planTest, saveTestRecord, testRecord, type SizeEstimate,
} from './multiplayer-test.ts'
import type { MultiplayerSurface, MultiplayerToolHost } from './multiplayer-tools.ts'
import { writeWhole } from './state.ts'

/**
 * The multiplayer tools that make and test a game's own multiplayer: the guide, the setup, the local test, and the
 * lobby statistics.
 * @param host - what the tools run on.
 * @param surface - how the surface asks the user and shows a confirmation page.
 * @returns the definitions, in catalog order.
 */
export function gameTools(host: MultiplayerToolHost, surface: MultiplayerSurface): ToolDefinition[] {
  const PROJECT = { type: 'string', description: surface.projectDescription } as const

  const guide = defineTool({
    name: 'wasd_multiplayer_guide',
    description: 'Explain the two ways a Godot game goes online with WASD Engine, with the live server sizes and prices, and recommend one for this game. Player-hosted is free: one player\'s browser hosts and friends join with a code. A dedicated server runs the game\'s server build around the clock for a monthly price by size. Players sign in with a WASD Engine account in both. Call it before setting up multiplayer, and show the user its for_user text so they choose.',
    parameters: {
      project: PROJECT,
      genre: { type: 'string', description: 'What kind of game it is, such as "co-op shooter" or "survival sandbox".' },
      players: { type: 'integer', description: 'Most players the game should have together.' },
      persistent_world: { type: 'boolean', description: 'true when the world must keep going while nobody plays.' },
      competitive: { type: 'boolean', description: 'true for ranked or competitive play, where cheating matters.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modes: JSON_VALUE,
          sizes: JSON_VALUE,
          recommendation: { type: 'object', required: true, additionalProperties: false, properties: { mode: STRING, reason: STRING } },
          current_mode: { type: 'string', description: 'The mode the project is set up for, when it is.' },
          plans_error: { type: 'string', description: 'Why the server sizes could not be read.' },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      let projectDir: string | undefined
      try {
        projectDir = await host.project(args.project, exec)
      } catch {
        // The guide also serves a conversation without a project.
        projectDir = undefined
      }
      const current = projectDir === undefined ? undefined : (await readMultiplayerConfig(projectDir))?.mode
      let plans: ServerPlans | undefined
      let plansError: string | undefined
      try {
        plans = await readPlans(host, exec.signal)
      } catch (error) {
        exec.signal.throwIfAborted()
        plansError = (error as Error).message
      }
      const players = args.players ?? 0
      const dedicated = args.persistent_world === true || args.competitive === true || players > MAX_LOBBY_PLAYERS
      const reason = args.persistent_world === true
        ? 'The world has to keep going while nobody plays, which only a dedicated server kept on (Always on) does.'
        : args.competitive === true
          ? 'In competitive play a host could cheat; a dedicated server decides what happens.'
          : players > MAX_LOBBY_PLAYERS
            ? `More than ${String(MAX_LOBBY_PLAYERS)} players together need a dedicated server.`
            : 'Sessions among friends work well player-hosted, and it costs nothing; the game can move to a dedicated server later without rewriting its networking.'
      const recommendation = { mode: dedicated ? 'dedicated' : 'player_hosted', reason }
      const sizes = plans === undefined ? [] : plans.sizes.map(size => sizeLine(size, plans.currency))
      const free = plans === undefined ? undefined : freeServersLine(plans)
      const lines = [
        'There are two ways to put this game online, and players sign in with a WASD Engine account in both:',
        '- Player-hosted (free): one player hosts from their browser and friends join with a code. 2 to 8 players works well. The session ends when the host leaves, and the host\'s game tab has to stay open and in front.',
        plans === undefined
          ? `- Dedicated server (a monthly price by size): WASD Engine runs the game's server, and anyone can join at any time. ${SLEEP_FALLBACK}`
          : `- Dedicated server (from ${formatPrice(Math.min(...plans.sizes.map(size => size.price_cents)), plans.currency)} a month): WASD Engine runs the game's server in ${plans.region.name}, and anyone can join at any time. ${plans.sleep?.summary ?? SLEEP_FALLBACK} ${plans.bandwidth_policy.at_limit}`,
        ...sizes.length === 0 ? [] : ['Server sizes:', ...sizes.map(line => `- ${line}`)],
        ...free === undefined ? [] : [free],
        `Recommendation: ${dedicated ? 'a dedicated server' : 'player-hosted'}. ${reason}`,
        ...plansError === undefined ? [] : [`The server sizes could not be read: ${plansError}`],
      ]
      return {
        modes: modes(plans),
        sizes: plans === undefined ? [] : json(plans.sizes),
        recommendation,
        ...current === undefined ? {} : { current_mode: current },
        ...plansError === undefined ? {} : { plans_error: plansError },
        for_user: lines.join('\n'),
      }
    },
  })

  const setup = defineTool({
    name: 'wasd_multiplayer_setup',
    description: 'Set the Godot project up for online multiplayer in the mode the user chose: copy the WASD Multiplayer add-on into addons/wasd_multiplayer, turn on its WasdMultiplayer autoload and editor plugin, and set the mode, the most players, the site, and the released game in res://wasd_multiplayer.cfg, keeping the file\'s other settings. The add-on handles WASD sign-in, lobbies, connections, and dedicated server joins; the game uses Godot\'s own multiplayer API (@rpc, MultiplayerSpawner, MultiplayerSynchronizer). Calling it again switches the mode or updates the add-on: it replaces the add-on\'s own files, first keeping the ones the game changed in a backup folder that the result names, and keeps the example files the game changed and the files it added.',
    parameters: {
      project: PROJECT,
      mode: { type: 'string', enum: MULTIPLAYER_MODES, required: true, description: 'player_hosted (free, a player hosts) or dedicated (a server WASD Engine runs).' },
      max_players: { type: 'integer', description: `Most players together. Default: 8 for player_hosted (at most ${String(MAX_LOBBY_PLAYERS)}), 32 for dedicated.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_dir: STRING,
          mode: STRING,
          max_players: INTEGER,
          addon_version: { type: 'string', description: 'Version the add-on\'s plugin.cfg names.' },
          addon_files: INTEGER,
          addon_kept: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files in the add-on folder that the game changed or added, such as an example it adapted, which the setup left as they were.',
          },
          addon_backup: {
            type: 'string',
            description: 'Project folder of the backup that keeps the game\'s versions of the add-on files it had changed, which the setup replaced.',
          },
          addon_backup_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'The game\'s versions in addon_backup, as paths in the project: <addon_backup>/addons/wasd_multiplayer/ followed by each file\'s path in the add-on folder.',
          },
          project_changed: BOOLEAN,
          next_steps: { type: 'array', required: true, items: { type: 'string' } },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value, [
        ...value.addon_kept === undefined ? [] : [`The add-on files the game changed or added stayed as they were: ${value.addon_kept.join(', ')}.`],
        ...value.addon_backup_files === undefined
          ? []
          : [`The setup replaced add-on files that the game had changed; the game's versions are at ${value.addon_backup_files.join(', ')}.`],
        'Next steps:',
        ...value.next_steps.map(step => `- ${step}`),
      ]),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const mode = args.mode
      const limit = mode === 'player_hosted' ? MAX_LOBBY_PLAYERS : MAX_SERVER_PLAYERS
      const maxPlayers = args.max_players ?? (mode === 'player_hosted' ? 8 : 32)
      if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > limit) throw new MultiplayerError(`max_players must be a whole number from 2 to ${String(limit)} for ${mode}.`)
      if (!await isFile(join(host.addonSource, 'wasd_multiplayer.gd'))) throw new MultiplayerError('This WASD Engine has no WASD Multiplayer add-on to install; update WASD Engine.')
      const exclusive = host.exclusive ?? (<T>(_project: string, _signal: AbortSignal, change: () => Promise<T>) => change())
      return await exclusive(projectDir, exec.signal, async () => {
        const installed = await installMultiplayerAddon(projectDir, host.addonSource)
        const projectFile = join(projectDir, 'project.godot')
        const before = await readFile(projectFile, 'utf8')
        const after = withMultiplayerAddon(before)
        if (after !== before) await writeWhole(projectFile, after)
        let origin: string | undefined
        try {
          origin = await host.siteOrigin()
        } catch {
          // Without an account plugin, the add-on keeps its default origins.
          origin = undefined
        }
        const existing = await readMultiplayerConfig(projectDir)
        const access = origin === undefined ? undefined : await host.access()
        const account = access !== undefined && access.origin === origin ? access.account : undefined
        const game = origin === undefined ? undefined : await linkedGame(projectDir, origin, account)
        await writeMultiplayerConfig(projectDir, {
          mode,
          maxPlayers,
          apiOrigin: origin ?? existing?.apiOrigin ?? '',
          appOrigin: origin ?? existing?.appOrigin ?? '',
          gameId: game?.id ?? existing?.gameId ?? '',
          version: existing?.version ?? 0,
        })
        let version: string | undefined
        try {
          version = pluginVersion(await readFile(join(host.addonSource, 'plugin.cfg'), 'utf8'))
        } catch {
          // A plugin.cfg without a version only leaves the version out.
          version = undefined
        }
        const nextSteps = mode === 'player_hosted'
          ? [
            'Host with `await WasdMultiplayer.host_lobby({"max_players": N, "public": true})`, show the lobby code it returns, and join with `await WasdMultiplayer.join_lobby(code)`; WasdMultiplayer.list_lobbies() lists public lobbies.',
            'Spawn players on WasdMultiplayer.player_joined(peer_id, player) and remove them on player_left; the host is peer 1 and decides what happens.',
            'Use Godot\'s own multiplayer API for game state: @rpc functions, MultiplayerSpawner, and MultiplayerSynchronizer.',
            `See ${ADDON_DIR}/examples for a lobby screen, then call wasd_multiplayer_test.`,
          ]
          : [
            'In the main scene: `if WasdMultiplayer.is_server(): WasdMultiplayer.serve()`, else `await WasdMultiplayer.join_server()`; the server build runs headless.',
            'Spawn players on WasdMultiplayer.player_joined(peer_id, player), where player.id stays the same for one account across sessions, and keep the world under user:// so it persists.',
            'Save on WasdMultiplayer.server_stopping(), calling WasdMultiplayer.delay_stop() before a save that awaits and stop_ready() after it, and warn players on server_warning(seconds, reason, message).',
            'Call wasd_multiplayer_test, then wasd_release_game, which uploads the server build; a server needs the user to pick a size from wasd_server_plans.',
          ]
        // The backup keeps each file at its path in the project, inside the backup folder.
        const backup = installed.backup
        return {
          project_dir: projectDir,
          mode,
          max_players: maxPlayers,
          ...version === undefined ? {} : { addon_version: version },
          addon_files: installed.written.length,
          ...installed.kept.length === 0 ? {} : { addon_kept: [...installed.kept] },
          ...backup === undefined
            ? {}
            : { addon_backup: backup.folder, addon_backup_files: backup.files.map(path => `${backup.folder}/${ADDON_DIR}/${path}`) },
          project_changed: after !== before,
          next_steps: nextSteps,
          for_user: mode === 'player_hosted'
            ? `The game is set up for player-hosted multiplayer, up to ${String(maxPlayers)} players. It costs nothing: one player hosts from their browser and friends join with a code, signed in with a WASD Engine account.`
            : `The game is set up for a dedicated server, up to ${String(maxPlayers)} players. The server needs a monthly size, which you choose before anything is bought; players sign in with a WASD Engine account.`,
        }
      })
    },
  })

  const test = defineTool({
    name: 'wasd_multiplayer_test',
    description: 'Test the game\'s multiplayer on this computer: run the host, or the dedicated server, and 1 to 3 clients as headless instances that connect over loopback, with made-up players and no WASD Engine services or costs. Reports whether every client connected, the server\'s frame time, memory, processor use, and traffic per player-hour, and which server size holds the game. Needs wasd_multiplayer_setup first; the game\'s main scene must use WasdMultiplayer.',
    parameters: {
      project: PROJECT,
      clients: { type: 'integer', description: 'Clients to connect, 1 to 3. Default: 2.' },
      seconds: { type: 'integer', description: 'How long the host or server runs, 10 to 120 seconds. Default: 30.' },
      mode: { type: 'string', enum: MULTIPLAYER_MODES, description: 'Mode to test. Default: the mode the project is set up for.' },
    },
    timeoutMs: TEST_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_dir: STRING,
          mode: STRING,
          clients: INTEGER,
          connected: INTEGER,
          passed: BOOLEAN,
          seconds: INTEGER,
          mb_per_player_hour: { type: 'number' },
          cpu_cores: { type: 'number' },
          memory_mb: { type: 'number' },
          tick_ms_avg: { type: 'number' },
          tick_ms_max: { type: 'number' },
          fits: { type: 'string', description: 'The smallest server size that holds what the test measured.' },
          estimates: JSON_VALUE,
          instances: JSON_VALUE,
          import_issues: { type: 'array', required: true, items: { type: 'string' } },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value, [
        ...value.import_issues.length === 0 ? [] : ['Import errors:', ...value.import_issues.map(issue => `- ${issue}`)],
        ...value.passed ? [] : [`Instances: ${JSON.stringify(value.instances)}`],
      ]),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const clients = args.clients ?? 2
      const seconds = args.seconds ?? 30
      if (!Number.isInteger(clients) || clients < 1 || clients > 3) throw new MultiplayerError('clients must be 1, 2, or 3.')
      if (!Number.isInteger(seconds) || seconds < 10 || seconds > 120) throw new MultiplayerError('seconds must be a whole number from 10 to 120.')
      if (!await hasMultiplayerAddon(projectDir)) throw new MultiplayerError('The project has no WASD Multiplayer add-on; call wasd_multiplayer_setup first.')
      const mode = args.mode ?? (await readMultiplayerConfig(projectDir))?.mode
      if (mode === undefined) throw new MultiplayerError('The project names no multiplayer mode; call wasd_multiplayer_setup first, or pass mode.')
      const plan = planTest(mode, clients, seconds, await freePort())
      const report = await host.runInstances({ projectDir, instances: plan.instances, timeoutMs: (seconds + 30) * 1000 }, exec.signal)
      const reports = report.instances.map(instance => ({ instance, stats: instanceStats(instance), problems: instanceProblems(instance) }))
      const hostStats = reports[0]?.stats
      const connected = reports.slice(1).filter(entry => entry.stats !== undefined && clientConnected(entry.stats)).length
      const summary = reports.map(({ instance, stats, problems }) => ({
        name: instance.name,
        exit_code: instance.exitCode,
        timed_out: instance.timedOut,
        ...stats === undefined ? { output_tail: `${instance.stdout}\n${instance.stderr}`.trim().split(/\r?\n/u).slice(-15).join('\n') } : { stats },
        ...problems.length === 0 ? {} : { problems },
      }))
      const firstProblem = reports.flatMap(({ instance, problems }) => problems.map(problem => `${instance.name}: ${problem}`))[0]
      if (hostStats === undefined) {
        return {
          project_dir: projectDir,
          mode,
          clients,
          connected,
          passed: false,
          seconds: plan.clientSeconds,
          estimates: [],
          instances: json(summary),
          import_issues: [...report.importIssues],
          for_user: `The ${mode === 'player_hosted' ? 'host' : 'server'} reported no test results: it did not run the WASD Multiplayer add-on's test mode, or it failed first. Check that the main scene uses WasdMultiplayer, then test again.${firstProblem === undefined ? '' : ` First problem: ${firstProblem}`}`,
        }
      }
      const record = testRecord(mode, clients, connected, plan.clientSeconds, hostStats)
      await saveTestRecord(projectDir, record)
      let estimates: SizeEstimate[] = []
      let currency = 'usd'
      let sizes: ServerSize[] = []
      try {
        const plans = await readPlans(host, exec.signal)
        sizes = plans.sizes
        currency = plans.currency
        estimates = estimateSizes(record, plans.sizes)
      } catch {
        // Without the site's sizes, the result keeps the measurement alone.
        exec.signal.throwIfAborted()
      }
      const fits = estimates.find(estimate => estimate.holdsTest)?.size
      const fitting = sizes.find(size => size.id === fits)
      const passed = connected === clients
      return {
        project_dir: projectDir,
        mode,
        clients,
        connected,
        passed,
        seconds: plan.clientSeconds,
        mb_per_player_hour: record.mb_per_player_hour,
        cpu_cores: record.cpu_cores,
        memory_mb: record.memory_mb,
        tick_ms_avg: record.tick_ms_avg,
        tick_ms_max: record.tick_ms_max,
        ...fits === undefined ? {} : { fits },
        estimates: estimatesJson(estimates),
        instances: json(summary),
        import_issues: [...report.importIssues],
        for_user: [
          `${passed ? clients === 1 ? 'The test player' : `All ${String(clients)} test players` : `${String(connected)} of ${String(clients)} test players`} connected to the ${mode === 'player_hosted' ? 'host' : 'server'}.`,
          `The ${mode === 'player_hosted' ? 'host' : 'server'} used about ${String(record.memory_mb)} MB of memory, ${String(Math.round(record.cpu_cores * 100))}% of a processor core, and ${String(record.mb_per_player_hour)} MB of traffic per player-hour.`,
          ...mode === 'dedicated' && fitting !== undefined
            ? [`At that rate a ${fitting.name} server (${formatPrice(fitting.price_cents, currency)} a month) holds it, and its bandwidth lasts about ${(estimates.find(estimate => estimate.size === fits)?.playerHoursPerMonth ?? 0).toLocaleString('en-US')} player-hours a month.`]
            : [],
          ...passed || firstProblem === undefined ? [] : [`First problem: ${firstProblem}`],
        ].join(' '),
      }
    },
  })

  const lobbyStats = defineTool({
    name: 'wasd_lobby_stats',
    description: 'Show the released game\'s player-hosted lobbies: how many are open, how many players are in them, and this month\'s relay traffic against the fair-use level, past which the relay is off for the game until the next month. Player-hosted multiplayer is free; nothing is billed.',
    parameters: { project: PROJECT },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lobbies_open: INTEGER,
          players_online: INTEGER,
          relay_gb_this_month: { type: 'number', required: true },
          relay_soft_cap_gb: { type: 'number', required: true },
          relay_available: BOOLEAN,
          relay_paused_until: { type: 'string', description: 'When the relay is back for the game, while its fair use is used up.' },
          month: STRING,
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const { api, game } = await releasedGameOf(host, args.project, exec)
      const stats = await api.lobbyStats(game.id)
      const used = Math.round(stats.relay.bytes_this_month / 1e8) / 10
      const cap = Math.round(stats.relay.soft_cap_bytes / 1e8) / 10
      const available = stats.relay.available ?? true
      const pausedUntil = stats.relay.paused_until ?? undefined
      let relay = `Relayed traffic this month: ${String(used)} GB of the ${String(cap)} GB fair-use level.`
      if (stats.relay.soft_cap_bytes <= 0) relay = `Relayed traffic this month: ${String(used)} GB; the relay has no fair-use level.`
      else if (!available) relay = `Relayed traffic this month: ${String(used)} GB, past the ${String(cap)} GB fair-use level, so the relay is off for this game until ${pausedUntil === undefined ? 'next month' : pausedUntil.slice(0, 10)}: players whose networks block a direct connection cannot join until then.`
      return {
        lobbies_open: stats.lobbies_open,
        players_online: stats.players_online,
        relay_gb_this_month: used,
        relay_soft_cap_gb: cap,
        relay_available: available,
        ...pausedUntil === undefined ? {} : { relay_paused_until: pausedUntil },
        month: stats.month,
        for_user: `${game.title} has ${String(stats.lobbies_open)} open lobb${stats.lobbies_open === 1 ? 'y' : 'ies'} with ${String(stats.players_online)} player${stats.players_online === 1 ? '' : 's'}. ${relay} Player-hosted multiplayer costs nothing.`,
      }
    },
  })

  return [guide, setup, test, lobbyStats]
}
