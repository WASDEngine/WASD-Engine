/**
 * The multiplayer tools of dedicated servers: their plans, purchase, deployment, state, logs, management, and changes;
 * the user confirms each purchase or change on the WASD Engine site.
 */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { formatPrice, MultiplayerError } from './multiplayer-api.ts'
import {
  BOOLEAN, chooseServer, estimatesJson, findSize, FOR_USER, freeLeft, freeOnConfirm, freeServersLine, freeWhileLeft, holdsFree, hostOf,
  json, JSON_VALUE, notApproved, readPlans, releasedGame, releasedGameOf, SERVER, serverJson, serverLine, signedIn, sizeLine, STRING,
  text,
} from './multiplayer-parts.ts'
import {
  createFreePrompt, createPrompt, deletePrompt, resizePrompt, restorePrompt, sizeLabels, type DeletedServer, type PromptSize,
} from './multiplayer-prompts.ts'
import { estimateSizes, readTestRecord } from './multiplayer-test.ts'
import type { MultiplayerSurface, MultiplayerToolHost } from './multiplayer-tools.ts'

/**
 * The multiplayer tools of dedicated servers: their plans, their purchase, deployment, state, logs, management, and
 * changes, each purchase or change confirmed by the user on the WASD Engine site.
 * @param host - what the tools run on.
 * @param surface - how the surface asks the user and shows a confirmation page.
 * @returns the definitions, in catalog order.
 */
export function serverTools(host: MultiplayerToolHost, surface: MultiplayerSurface): ToolDefinition[] {
  const PROJECT = { type: 'string', description: surface.projectDescription } as const

  const plansTool = defineTool({
    name: 'wasd_server_plans',
    description: 'List the dedicated server sizes with their monthly prices, CPU, RAM, bandwidth, storage, and how many players each holds, from the WASD Engine site, and the free servers WASD Engine gave the signed-in account, which cost nothing. After wasd_multiplayer_test, it also fits each size to what the test measured. Show the user the sizes and prices and let them choose; never pick a size for them.',
    parameters: { project: PROJECT },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: BOOLEAN,
          currency: STRING,
          region: STRING,
          sizes: JSON_VALUE,
          bandwidth_policy: STRING,
          purchase: STRING,
          estimate_basis: STRING,
          measured: { type: 'json', description: 'What the project\'s last wasd_multiplayer_test measured.' },
          estimates: { type: 'json', description: 'Each size fitted to that test.' },
          free_servers: { type: 'json', description: 'The free servers WASD Engine gave the signed-in account, by size: how many, how many are in use, and how many more it creates free.' },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const plans = await readPlans(host, exec.signal)
      let projectDir: string | undefined
      try {
        projectDir = await host.project(args.project, exec)
      } catch {
        // The sizes also serve a conversation without a project.
        projectDir = undefined
      }
      const measured = projectDir === undefined ? undefined : await readTestRecord(projectDir)
      const estimates = measured === undefined ? undefined : estimateSizes(measured, plans.sizes)
      const lines = [
        ...plans.available ? [] : ['WASD Engine does not sell dedicated servers yet; these are the planned sizes.'],
        `Dedicated server sizes (${plans.region.name}):`,
        ...plans.sizes.map((size) => {
          const estimate = estimates?.find(candidate => candidate.size === size.id)
          return `- ${sizeLine(size, plans.currency)}${estimate === undefined ? '' : `; with this game, bandwidth for about ${estimate.playerHoursPerMonth.toLocaleString('en-US')} player-hours a month${estimate.holdsTest ? '' : ', but less memory or processor than the test used'}`}`
        }),
        `Bandwidth: emails at ${plans.bandwidth_policy.emails_at_percent.map(percent => `${String(percent)}%`).join(', ')}. ${plans.bandwidth_policy.at_limit}`,
        `Buying: ${plans.purchase.requires} The user confirms every purchase on the site.`,
      ]
      const free = freeServersLine(plans)
      if (free !== undefined) lines.push(free)
      const grants = (plans.grants ?? []).filter(grant => grant.granted > 0)
      return {
        available: plans.available,
        currency: plans.currency,
        region: plans.region.name,
        sizes: json(plans.sizes),
        bandwidth_policy: plans.bandwidth_policy.at_limit,
        purchase: plans.purchase.requires,
        estimate_basis: plans.estimate_basis,
        ...measured === undefined ? {} : { measured: json(measured) },
        ...estimates === undefined ? {} : { estimates: estimatesJson(estimates) },
        ...grants.length === 0 ? {} : { free_servers: json(grants) },
        for_user: lines.join('\n'),
      }
    },
  })

  const PENDING_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, enum: ['awaiting_confirmation', 'declined', 'cancelled', 'unavailable'] },
      server_id: { type: 'string' },
      size: { type: 'string' },
      price: { type: 'string', description: 'Monthly price of the size.' },
      free: { type: 'boolean', description: 'true when one of the free servers WASD Engine gave the account was left for it: it is free while one is left when the user confirms on the site.' },
      confirm_url: { type: 'string', description: 'The page where the user confirms; nothing happens before that.' },
      expires_at: { type: 'string' },
      opened: { type: 'boolean', description: 'Whether WASD Engine opened the page in the user\'s browser.' },
      confirm_message: { type: 'string', description: 'What the user confirms on the page.' },
      for_user: FOR_USER,
    },
  } as const

  /** Show the confirmation page, and the text that tells the user where to confirm. */
  const confirmation = async (
    url: string, what: string, exec: ToolRunContext,
  ): Promise<{ readonly opened: boolean; readonly forUser: string }> => {
    const opened = surface.channel === 'app' && await surface.openLink(url, exec)
    return {
      opened,
      forUser: opened
        ? `WASD Engine opened a page on ${hostOf(url)} in the browser. ${what} Nothing happens until you confirm there. If it did not open, use this link: ${url}`
        : `Open this page to confirm: ${url} ${what} Nothing happens until you confirm there.`,
    }
  }

  const create = defineTool({
    name: 'wasd_server_create',
    description: 'Create a dedicated server for the released game, of a size the user chose from wasd_server_plans. It never charges by itself: it returns a page on the WASD Engine site where the user confirms and pays, which needs a valid payment method on their account; a size of which wasd_server_plans lists free servers left for the account is free while one is left when the user confirms, and then needs no card. Tell the user the size\'s monthly price, or that it is free while one of those free servers is left, and what it includes before calling it. The server then runs the newest release\'s server build.',
    parameters: {
      project: PROJECT,
      size: { type: 'string', required: true, description: 'Size id from wasd_server_plans, such as small.' },
      name: { type: 'string', description: 'Name of the server, at most 48 characters. Default: the game\'s title.' },
    },
    output: { schema: PENDING_SCHEMA, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      if (args.name !== undefined && (args.name.trim() === '' || args.name.length > 48)) throw new MultiplayerError('name must be 1 to 48 characters.')
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const plans = await api.plans()
      if (!plans.available) throw new MultiplayerError('WASD Engine does not sell dedicated servers yet. Player-hosted multiplayer works without them.', 'servers_unavailable')
      const size = findSize(plans, args.size)
      const price = formatPrice(size.price_cents, plans.currency)
      const free = freeLeft(plans, size.id) > 0
      const what = free
        ? `This is a ${size.name} server for ${game.title}, ${freeWhileLeft(size.name, price)}`
        : `This is a ${size.name} server for ${game.title} at ${price} a month.`
      const site = hostOf(access.origin)
      const prompt = free ? createFreePrompt(size.name, game.title, site) : createPrompt(size.name, price, game.title, site)
      const answer = await surface.approve(exec, 'wasd_server_create', prompt)
      if (answer !== 'approved') return { status: answer, size: size.id, price, ...free ? { free } : {}, for_user: notApproved(answer, 'created or charged') }
      const pending = await api.create(game.id, size.id, args.name?.trim())
      const shown = await confirmation(pending.confirm_url, what, exec)
      return {
        status: 'awaiting_confirmation' as const,
        server_id: pending.server.id,
        size: size.id,
        price,
        ...free ? { free } : {},
        confirm_url: pending.confirm_url,
        expires_at: pending.expires_at,
        opened: shown.opened,
        confirm_message: free
          ? `Confirm the ${size.name} game server for ${game.title} on the WASD Engine site; ${freeOnConfirm(size.name)}`
          : `Confirm the ${size.name} game server for ${game.title} at ${price} a month on the WASD Engine site; nothing is charged until you confirm there.`,
        for_user: shown.forUser,
      }
    },
  })

  const deploy = defineTool({
    name: 'wasd_server_deploy',
    description: 'Deploy a release\'s server build to the game\'s server: the newest release unless version names one, such as an earlier version to roll back. Players get a 60-second warning, then the server restarts on that build; the world is kept. Releases deploy to the game\'s servers by themselves, so call this for a rollback or a server that missed one. Tell the user the server restarts.',
    parameters: {
      project: PROJECT,
      server: SERVER,
      version: { type: 'integer', description: 'Release whose server build to deploy. Default: the newest.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { server: JSON_VALUE, for_user: FOR_USER } },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const { api, game } = await releasedGameOf(host, args.project, exec)
      const server = await chooseServer(api, game.id, args.server)
      const deployed = await api.deploy(server.id, args.version)
      return {
        server: serverJson(deployed),
        for_user: `${deployed.name} is switching to ${args.version === undefined ? 'the newest server build' : `version ${String(args.version)}`}: players get a 60-second warning, then it restarts with its world kept. ${serverLine(deployed)}`,
      }
    },
  })

  const status = defineTool({
    name: 'wasd_server_status',
    description: 'Show the game\'s dedicated servers, or one of them: state, address, release version, players, CPU and memory, this month\'s bandwidth and storage against the size\'s allowance, the last backup, and the price. A server that used all its bandwidth stops until the allowance resets with its next billing month.',
    parameters: { project: PROJECT, server: { type: 'string', description: 'Server id. Default: every server of the game.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { servers: JSON_VALUE, for_user: FOR_USER } },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const { api, game } = await releasedGameOf(host, args.project, exec)
      const servers = args.server === undefined ? await api.servers(game.id) : [await chooseServer(api, game.id, args.server)]
      return {
        servers: servers.map(serverJson),
        for_user: servers.length === 0
          ? `${game.title} has no dedicated servers.`
          : [`${game.title}'s servers:`, ...servers.map(server => `- ${serverLine(server)}`)].join('\n'),
      }
    },
  })

  const logs = defineTool({
    name: 'wasd_server_logs',
    description: 'Read the latest lines of a dedicated server\'s log: what the game printed, its errors, and WASD Engine\'s notes such as restarts.',
    parameters: { project: PROJECT, server: SERVER, limit: { type: 'integer', description: 'Most lines, 1 to 500. Default: 200.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { server_id: STRING, lines: JSON_VALUE, for_user: FOR_USER } },
      render: (_args, value) => text(value, Array.isArray(value.lines)
        ? value.lines.map((line) => {
          const entry = line as { at?: string; stream?: string; text?: string }
          return `${entry.at ?? ''} [${entry.stream ?? ''}] ${entry.text ?? ''}`.trim()
        })
        : []),
    },
    async execute(args, exec) {
      const limit = args.limit ?? 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new MultiplayerError('limit must be a whole number from 1 to 500.')
      const { api, game } = await releasedGameOf(host, args.project, exec)
      const server = await chooseServer(api, game.id, args.server)
      const lines = await api.logs(server.id, limit)
      return {
        server_id: server.id,
        lines: json(lines),
        for_user: lines.length === 0 ? `${server.name} has logged nothing yet.` : `The last ${String(lines.length)} line${lines.length === 1 ? '' : 's'} of ${server.name}'s log:`,
      }
    },
  })

  const manage = defineTool({
    name: 'wasd_server_manage',
    description: 'Start, stop, restart, back up, or restore a dedicated server. Stopping keeps the world and the monthly price; only deleting ends billing. Players get a warning before a stop or restart. restore replaces the current world with a backup from wasd_server_status or the backup list it returns, so ask the user first.',
    parameters: {
      project: PROJECT,
      server: SERVER,
      action: { type: 'string', enum: ['start', 'stop', 'restart', 'backup', 'restore', 'backups'], required: true, description: 'backups lists the backups to restore from.' },
      backup_id: { type: 'string', description: 'The backup to restore.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { status: STRING, server: { type: 'json' }, backups: { type: 'json' }, for_user: FOR_USER },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const { api, game } = await releasedGameOf(host, args.project, exec)
      const server = await chooseServer(api, game.id, args.server)
      if (args.action === 'backups') {
        const backups = await api.backups(server.id)
        return {
          status: 'listed',
          backups: json(backups),
          for_user: backups.length === 0
            ? `${server.name} has no backups yet.`
            : [`${server.name}'s backups:`, ...backups.map(backup => `- ${backup.id}: ${backup.created_at ?? 'unknown time'}${backup.reason === null || backup.reason === undefined ? '' : ` (${backup.reason})`}`)].join('\n'),
        }
      }
      if (args.action === 'restore') {
        if (args.backup_id === undefined) throw new MultiplayerError('Pass backup_id; action backups lists them.')
        const backup = (await api.backups(server.id)).find(candidate => candidate.id === args.backup_id)
        if (backup === undefined) throw new MultiplayerError(`${server.name} has no backup ${args.backup_id}; action backups lists them.`)
        const answer = await surface.approve(exec, 'wasd_server_manage', restorePrompt(server.name, backup.created_at ?? backup.id))
        if (answer !== 'approved') return { status: answer, for_user: notApproved(answer, 'restored') }
      }
      const action = args.action
      const changed = await api.act(server.id, action, action === 'restore' ? args.backup_id : undefined)
      const done: Record<typeof action, string> = {
        start: `${changed.name} is starting.`,
        stop: `${changed.name} is stopping after a warning to its players; its world and its monthly price stay.`,
        restart: `${changed.name} restarts after a warning to its players.`,
        backup: `${changed.name} is backing up its world.`,
        restore: `${changed.name} is restoring the backup; players get a warning before it restarts.`,
      }
      return { status: 'done', server: serverJson(changed), for_user: `${done[action]} ${serverLine(changed)}` }
    },
  })

  const change = defineTool({
    name: 'wasd_server_change',
    description: 'Change a dedicated server\'s size, or delete the server. It never changes the bill by itself: it returns a page on the WASD Engine site where the user confirms. For a paid server, a bigger size is charged from the confirmation, prorated, and a smaller one credited. A free server (wasd_server_status marks it) moved to a size without free servers left becomes a new purchase at that size\'s monthly price, with no credit. A size with free servers left for the account (wasd_server_plans lists them) is free while one is left when the user confirms. Deleting stops the server and deletes its world 7 days later; a paid server\'s monthly price comes off the bill unless the confirmation page says another of the account\'s servers keeps it, and a free one changes no bill. Deleting a server whose purchase still awaits confirmation cancels that purchase, which never ran or charged anything. Tell the user the price difference or what deleting loses before calling it.',
    parameters: {
      project: PROJECT,
      server: SERVER,
      size: { type: 'string', description: 'New size id from wasd_server_plans.' },
      delete: { type: 'boolean', description: 'true deletes the server.' },
    },
    output: { schema: PENDING_SCHEMA, render: (_args, value) => text(value) },
    async execute(args, exec) {
      if ((args.size === undefined) === (args.delete !== true)) throw new MultiplayerError('Pass either size or delete: true.')
      const { api, game, access } = await releasedGameOf(host, args.project, exec)
      const server = await chooseServer(api, game.id, args.server)
      const granted = server.granted === true
      if (args.delete === true) {
        // Deleting a server whose purchase still awaits confirmation cancels that purchase, on the site's page too.
        const deleted: DeletedServer = server.state === 'awaiting_confirmation' ? 'purchase' : granted ? 'free' : 'paid'
        const answer = await surface.approve(exec, 'wasd_server_change', deletePrompt(server.name, deleted, hostOf(access.origin)))
        if (answer !== 'approved') return { status: answer, server_id: server.id, for_user: notApproved(answer, deleted === 'purchase' ? 'cancelled' : 'deleted') }
        const pending = await api.remove(server.id)
        const what: Record<DeletedServer, string> = {
          purchase: `This cancels the purchase of ${server.name}: it never ran and was never charged, so cancelling it costs nothing.`,
          free: `This deletes ${server.name}: it stops for every player and its world is deleted 7 days later; it is one of the account's free servers, so the bill does not change.`,
          paid: `This deletes ${server.name}: it stops for every player and its world is deleted 7 days later; its monthly price comes off the bill, unless the confirmation page says another of the account's servers keeps it.`,
        }
        const shown = await confirmation(pending.confirm_url, what[deleted], exec)
        return {
          status: 'awaiting_confirmation' as const,
          server_id: server.id,
          confirm_url: pending.confirm_url,
          expires_at: pending.expires_at,
          opened: shown.opened,
          confirm_message: deleted === 'purchase'
            ? `Confirm cancelling the purchase of the server ${server.name} on the WASD Engine site; nothing is charged.`
            : `Confirm deleting the server ${server.name} on the WASD Engine site; its world is deleted 7 days later.`,
          for_user: shown.forUser,
        }
      }
      const plans = await api.plans()
      const size = findSize(plans, args.size as string)
      if (size.id === server.size) throw new MultiplayerError(`${server.name} is already ${size.name}.`)
      const current = plans.sizes.find(candidate => candidate.id === server.size)
      const price = formatPrice(size.price_cents, plans.currency)
      const free = freeLeft(plans, size.id) > 0 || holdsFree(server, size.id)
      const from: PromptSize = {
        name: current?.name ?? server.size,
        price: current === undefined ? undefined : formatPrice(current.price_cents, plans.currency),
        free: granted,
      }
      const fromLabel = sizeLabels(from).en
      const answer = await surface.approve(exec, 'wasd_server_change', resizePrompt(server.name, from, { name: size.name, price, free }, hostOf(access.origin)))
      if (answer !== 'approved') return { status: answer, server_id: server.id, size: size.id, price, ...free ? { free } : {}, for_user: notApproved(answer, 'changed') }
      const pending = await api.resize(server.id, size.id)
      // A free server moved to a size without a free one left is bought at that size's price, with no credit.
      const purchase = granted && !free
      const what = free
        ? `This changes ${server.name} from ${fromLabel} to ${size.name}, ${freeWhileLeft(size.name, price)}`
        : purchase
          ? `This changes ${server.name} from ${fromLabel} to ${size.name}, a new purchase at ${price} a month; the free ${from.name} server stays on the account for another server.`
          : `This changes ${server.name} from ${fromLabel} to ${size.name} at ${price} a month.`
      const shown = await confirmation(pending.confirm_url, what, exec)
      return {
        status: 'awaiting_confirmation' as const,
        server_id: server.id,
        size: size.id,
        price,
        ...free ? { free } : {},
        confirm_url: pending.confirm_url,
        expires_at: pending.expires_at,
        opened: shown.opened,
        confirm_message: free
          ? `Confirm changing the server ${server.name} to ${size.name} on the WASD Engine site; ${freeOnConfirm(size.name)}`
          : purchase
            ? `Confirm changing the server ${server.name} to ${size.name}, a new purchase at ${price} a month, on the WASD Engine site; nothing is charged until you confirm there.`
            : `Confirm changing the server ${server.name} to ${size.name} at ${price} a month on the WASD Engine site.`,
        for_user: shown.forUser,
      }
    },
  })

  return [plansTool, create, deploy, status, logs, manage, change]
}
