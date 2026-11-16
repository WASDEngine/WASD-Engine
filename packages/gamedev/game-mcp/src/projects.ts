/**
 * The `create_game_project` tool: a connected agent creates a game project as the Create game project dialog does,
 * through the Workspace controller's `gameProjectController`, in the location the call names or in WASD Engine's
 * folder for game projects. The call opens no Session, so the project shows in the window with none; its Sessions start
 * when the user opens it or when a game tool call names it.
 * @module @deepseek-ai/dsh-game-mcp/src/projects
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GameProjectNameProblem } from '@deepseek-ai/dsh-api-workspace-controller'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { SEARCH_TOOL, type McpCallResult } from './catalog.ts'
import type { JsonObject } from './provider.ts'

function errorResult(text: string): McpCallResult {
  return { isError: true, content: [{ type: 'text', text }] }
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
 * Create a game project for a connected agent: a new folder with a Git repository when Git is available, registered
 * as a game project, with no Session.
 * @param ctx - Host context with the optional game project controller.
 * @param args - the agent's arguments: `name`, the folder name and title, and optional `location`, the absolute path
 *   of the folder to create it in, without the spaces around it, as the dialog takes it; a missing, null, or blank
 *   `location` stands for the dialog's suggested folder, `<Documents>/WASD Engine`.
 * @param signal - the call's cancellation; it stops the Documents lookup or a running Git command, and a folder
 *   created before it is still registered.
 * @returns the result that names the new folder, or an error result that says why nothing was created.
 */
export async function createGameProject(ctx: Context, args: JsonObject, signal: AbortSignal): Promise<McpCallResult> {
  const { name, location } = args
  if (typeof name !== 'string') return errorResult('Pass name, the name of the game project.')
  if (location !== undefined && location !== null && typeof location !== 'string') {
    return errorResult('location must be a string: the absolute path of the folder to create the project in.')
  }
  const requested = typeof location === 'string' ? location.trim() : ''
  const projects = ctx.get('gameProjectController')
  if (projects === undefined) return errorResult('This WASD Engine keeps no game projects, so it cannot create one.')
  try {
    const directory = requested === '' ? (await projects.defaults(signal)).directory : requested
    if (directory === null) {
      return errorResult('WASD Engine cannot find the user\'s Documents folder, where it keeps game projects; pass location, the absolute path of the folder to create the project in.')
    }
    const { workspace, git } = await projects.create({ name, directory }, signal)
    return {
      content: [{
        type: 'text',
        text: `Created the game project ${JSON.stringify(workspace.title)} in ${workspace.path}, which WASD Engine lists among the user's game projects. `
          + (git ? 'The folder holds a Git repository with one empty commit and nothing else. ' : 'The folder is empty, without a Git repository. ')
          + `Before you write code, plan the game around the plugins that ${SEARCH_TOOL} lists, and read the guide of each one you will use. `
          + 'Make the game in this folder, and write its project.godot before you install add-ons into it. '
          + 'Where a game tool takes project, pass this folder\'s absolute path; the blender_*, gimp_*, and supercollider_* tools take project '
          + 'only together with session.',
      }],
    }
  } catch (error) {
    return errorResult(failureText(error))
  }
}
