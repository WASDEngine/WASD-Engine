/** The add-on catalog as the agent reads it: the Session's system prompt section and the MCP server's instructions. */
import { afterEach, describe, expect, it } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { catalogLines, mcpInstructions, sessionPrompt } from '../src/prompt.ts'
import { scratch, writeCatalog, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined

afterEach(async () => {
  await dir?.cleanup()
  dir = undefined
})

const JUDGMENT = 'Decide yourself when one is worth it; you do not need to ask the user first. '
  + 'Install an add-on when the work at hand needs what it does and building that with plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps. '
  + 'Skip it when Godot\'s own nodes, Blender\'s own tools, or a short script do the job, and do not install one in case it is needed later. '
  + 'action search shows each add-on\'s download size, conflicts, and when to skip it.'

const LIST = [
  'Each add-on below shows its id, its application, the stages at which it helps (prototype makes the core game playable, content adds levels, characters, and assets, polish adds game feel and finish, and ship tests and releases the game), and when to use it:',
  '- other-camera (Godot; polish): Never in tests.',
  '- test-camera (Godot; prototype, polish): The camera must follow a moving target with smoothing.',
  '- test-rig (Blender; content): A character needs a rig.',
  '- test-trees (Blender; content): The game needs many low-poly trees.',
].join('\n')

async function entries() {
  dir = await scratch('prompt')
  return (await loadCatalog(await writeCatalog(dir.root))).entries
}

describe('the add-on catalog in the agent\'s instructions', () => {
  it('lists each add-on with its application, stages, and when to use it, Godot add-ons first', async () => {
    expect(catalogLines(await entries())).toBe(LIST.slice(LIST.indexOf('\n') + 1))
  })

  it('tells the Session\'s agent to decide itself, load the guide skill, and tell the user what it added', async () => {
    expect(sessionPrompt(await entries())).toBe(`# Game add-ons

game_addons installs tested third-party add-ons into the game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with the built-in Godot and Blender. ${JUDGMENT}
After installing one, load its guide, the skill named by its id, before using it, and tell the user what you added and why, with its license and any credit it requires. Remove an add-on only when the game no longer uses it.

${LIST}`)
  })

  it('tells a connected agent the same, with absolute projects, the guide action, and Blender\'s enable call', async () => {
    expect(mcpInstructions(await entries())).toBe(`game_addons installs tested third-party add-ons into the user's game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with WASD Engine's Godot 4.7 and Blender 5.2. ${JUDGMENT}
Install one with action install and project set to the absolute folder that holds project.godot; it unpacks the add-on into addons/, enables it in project.godot, adds its license to THIRD_PARTY_NOTICES.md, and imports the project. Before using an add-on, read its guide with action guide, and for a Blender add-on run import wasd_addons; wasd_addons.enable("<id>") with blender_execute_python. Tell the user what you added and why, with its license and any credit it requires.

${LIST}`)
  })
})
