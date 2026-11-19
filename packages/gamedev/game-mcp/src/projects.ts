/**
 * The `create_game_project` tool: a connected agent creates a game project as the Create game project dialog does,
 * through the Workspace controller's `gameProjectController`, in the location the call names or in WASD Engine's
 * folder for game projects. The call opens no Session, so the project shows in the window with none; its Sessions start
 * when the user opens it or when a game tool call names it. A location in a temporary folder is refused, so an agent's
 * throwaway work stays out of the user's game projects. Each created project is reported through the
 * `game-mcp/project-created` event with the AI model the agent named in `model`, which the released game's page credits.
 * The result of a call that created a project ends with the deployment's guidance for building the new game, when it
 * sets one.
 * @module @deepseek-ai/dsh-game-mcp/src/projects
 */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GameProjectNameProblem } from '@deepseek-ai/dsh-api-workspace-controller'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { SEARCH_TOOL, type McpCallResult } from './catalog.ts'
import type { GameMcpCall, GameMcpProjectCreated, JsonObject } from './provider.ts'
import { inTemporaryFolder } from './temporary-folders.ts'

function errorResult(text: string): McpCallResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/** What the agent reads, after a creation that named no model, about naming the model it is. */
const MODEL_HINT = ' The game\'s page credits the AI model that makes the game: pass model, the full name of the AI model you are, such as Claude Opus 5.5, '
  + 'to godot_run when you first run the game.'

/**
 * Report a created game project to the `game-mcp/project-created` listeners.
 * @param ctx - Host context.
 * @param created - the calling agent, the new folder, and the model the agent named.
 */
function reportCreated(ctx: Context, created: GameMcpProjectCreated): void {
  try {
    ctx.emit('game-mcp/project-created', created)
  } catch (error) {
    // A listener's failure must not turn the agent's created project into a failed call.
    ctx.logger.warn(`game-mcp: a game-mcp/project-created listener failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** What the agent reads about a name that the Host refused, by the Host's reason, for the name as the call quoted it. */
const NAME_TEXTS: Readonly<Record<GameProjectNameProblem, (quoted: string) => string>> = {
  invisible: quoted => `The name ${quoted} has no visible characters. Pass a name that shows letters, digits, or symbols.`,
  unportable: quoted => `${quoted} is not a folder name that every computer accepts. Pass a name without / \\ : * ? " < > |, control characters, `
    + 'or a trailing period, of at most 255 bytes.',
  // Every device name that the Host refuses, as Microsoft lists them.
  device: quoted => `${quoted} is not a folder name that every computer accepts: Windows reserves CON, PRN, AUX, NUL, COM0 to COM9, COM¹, COM², `
    + 'COM³, LPT0 to LPT9, LPT¹, LPT², and LPT³ for devices, with or without an extension. Pass another name.',
  git: quoted => `${quoted} is the name of Git's own folder. Pass another name.`,
}

/**
 * The text that tells the agent why no game project was created.
 * @param error - the failure of the defaults lookup or of the creation.
 * @returns the text.
 */
function failureText(error: unknown): string {
  const failure = remoteErrorOf(error)
  if (failure !== undefined) {
    switch (failure.code) {
      case 'gameProject/invalid-name':
        return NAME_TEXTS[failure.details.problem](JSON.stringify(failure.details.name))
      case 'gameProject/invalid-directory':
        return `location must be the absolute path of a folder, got ${JSON.stringify(failure.details.path)}.`
      case 'gameProject/exists':
        return `${failure.details.path} already exists; pass another name or location.`
      default:
        // `gameProject/create-failed` and codes of other owners: the message names the path and the system's reason.
        return `WASD Engine could not create the game project: ${failure.message}`
    }
  }
  return `WASD Engine could not create the game project: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * What the agent reads about a location in a temporary folder.
 * @param location - the location as the call gave it, without the spaces around it.
 * @returns the text.
 */
function temporaryLocationText(location: string): string {
  return `${location} is in a temporary folder, whose files the system may delete, so WASD Engine creates no game project there. `
    + 'Leave location out to create the project in WASD Engine\'s folder for game projects, or pass a folder that lasts. '
    + 'To try something out in a temporary folder, make the folder yourself and pass it as project: the game tools work in it without a game project.'
}

/**
 * Create a game project for a connected agent: a new folder with a Git repository when Git is available, registered
 * as a game project, with no Session, and reported through the `game-mcp/project-created` event.
 * @param ctx - Host context with the optional game project controller.
 * @param args - the agent's arguments: `name`, the folder name and title; optional `location`, the absolute path
 *   of the folder to create it in, without the spaces around it, as the dialog takes it, where a missing, null, or blank
 *   `location` stands for the dialog's suggested folder, `<Documents>/WASD Engine`; and optional `model`, the name of
 *   the AI model the agent is, without the spaces around it, where a missing, null, or blank `model` names none.
 * @param call - the calling agent and the call's cancellation, which stops the Documents lookup or a running Git
 *   command; a folder created before it is still registered.
 * @param temporaryFolders - absolute folders in which a `location` is refused.
 * @param guidance - text that ends the result of a call that created a project, as its own paragraph; empty adds none.
 * @returns the result that names the new folder, after a call that named no model says where to name it, and ends with
 *   the guidance, or an error result that says why nothing was created.
 */
export async function createGameProject(
  ctx: Context, args: JsonObject, call: Pick<GameMcpCall, 'client' | 'signal'>, temporaryFolders: readonly string[], guidance: string,
): Promise<McpCallResult> {
  const { name, location, model } = args
  const { signal } = call
  if (typeof name !== 'string') return errorResult('Pass name, the name of the game project.')
  if (location !== undefined && location !== null && typeof location !== 'string') {
    return errorResult('location must be a string: the absolute path of the folder to create the project in.')
  }
  if (model !== undefined && model !== null && typeof model !== 'string') {
    return errorResult('model must be a string: the full name of the AI model you are, such as Claude Opus 5.5.')
  }
  const named = typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined
  const requested = typeof location === 'string' ? location.trim() : ''
  const projects = ctx.get('gameProjectController')
  if (projects === undefined) return errorResult('This WASD Engine keeps no game projects, so it cannot create one.')
  // A relative location is the game project controller's to refuse.
  if (isAbsolute(requested) && await inTemporaryFolder(temporaryFolders, requested)) return errorResult(temporaryLocationText(requested))
  try {
    const directory = requested === '' ? (await projects.defaults(signal)).directory : requested
    if (directory === null) {
      return errorResult('WASD Engine cannot find the user\'s Documents folder, where it keeps game projects; pass location, the absolute path of the folder to create the project in.')
    }
    const { workspace, git } = await projects.create({ name, directory }, signal)
    reportCreated(ctx, { client: call.client, path: workspace.path, ...named === undefined ? {} : { model: named } })
    const text = `Created the game project ${JSON.stringify(workspace.title)} in ${workspace.path}, which WASD Engine lists among the user's game projects. `
      // WASD Engine may keep the game's credits in the folder at once, so the folder is not said to be empty.
      + (git ? 'The folder holds a Git repository with one empty commit and no game files yet. ' : 'The folder holds no game files yet, and no Git repository. ')
      + `Before you write code, plan the game around the plugins that ${SEARCH_TOOL} lists, and read the guide of each one you will use. `
      + 'Make the game in this folder, and write its project.godot before you install add-ons into it. '
      + 'Where a game tool takes project, pass this folder\'s absolute path; the blender_*, gimp_*, and supercollider_* tools take project '
      + `only together with session.${named === undefined ? MODEL_HINT : ''}`
    return { content: [{ type: 'text', text: guidance === '' ? text : `${text}\n\n${guidance}` }] }
  } catch (error) {
    return errorResult(failureText(error))
  }
}
