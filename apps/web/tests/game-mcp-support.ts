/**
 * Helpers for the Web e2e specs that reach WASD Engine's game MCP server as a connected agent does, in the shipped Web
 * composition: the new game guidance that WASD Engine's game tools overlay gives the server, a patch of the server's
 * row, and the server's address and token once it listens, with the account signed in for its tool calls.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-game-mcp'

/** WASD Engine's game tools overlay, whose `game-mcp` row sets the new game guidance. */
const GAME_TOOLS_OVERLAY = fileURLToPath(new URL('../../../packages/bundle/web-app/wasdengine/game-tools.cordis.patch.yml', import.meta.url))

/**
 * The new game guidance that WASD Engine's game tools overlay gives the MCP server.
 * @returns the `newGameGuidance` of the overlay's `game-mcp` row.
 */
export function shippedNewGameGuidance(): string {
  const row = loadOverlayPatches('game-mcp-support', GAME_TOOLS_OVERLAY).flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'game-mcp')
  const guidance = (row?.config as { readonly newGameGuidance?: unknown } | undefined)?.newGameGuidance
  if (typeof guidance !== 'string' || guidance === '') throw new Error('the game tools overlay gives the game-mcp row no newGameGuidance')
  return guidance
}

/**
 * Write a patch of the server's row. It replaces the row's whole configuration: a data folder of its own, any free port,
 * as the installed app may hold the usual one, and the new game guidance.
 * @param folder - the folder of the patch and of the server's data.
 * @param guidance - the new game guidance; empty adds none.
 * @returns the patch's path.
 */
export async function writeGameMcpPatch(folder: string, guidance: string): Promise<string> {
  const patch = join(folder, 'game-mcp.patch.yml')
  await writeFile(patch, `- id: game-mcp\n  config:\n    dataRoot: ${JSON.stringify(join(folder, 'game-mcp'))}\n    port: 0\n`
    + `    newGameGuidance: ${JSON.stringify(guidance)}\n`)
  return patch
}

/**
 * Sign the account in for the server's tool calls, which run only while someone is signed in, and wait until the
 * server listens.
 * @param ctx - the scaffold's settled context.
 * @param folder - the folder that {@link writeGameMcpPatch} wrote the patch to.
 * @returns the endpoint and the access token.
 */
export async function listeningGameMcp(ctx: Context, folder: string): Promise<{ url: string; token: string }> {
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
  return { url, token: (await readFile(join(folder, 'game-mcp', 'token'), 'utf8')).trim() }
}
