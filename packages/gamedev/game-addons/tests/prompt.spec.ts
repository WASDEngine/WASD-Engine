/** The add-on catalog as the agent reads it: the Session's system prompt section and the MCP server's instructions. */
import { afterEach, describe, expect, it } from 'vitest'
import { CATEGORIES, loadCatalog } from '../src/catalog.ts'
import { catalogIndex, catalogLines, mcpInstructions, sessionPrompt } from '../src/prompt.ts'
import { scratch, writeCatalog, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined

afterEach(async () => {
  await dir?.cleanup()
  dir = undefined
})

const JUDGMENT = 'Decide yourself when one is worth it; you do not need to ask the user first. '
  + 'Install an add-on when the work at hand needs what it does and building that with plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps. '
  + 'Skip it when Godot\'s own nodes, Blender\'s own tools, or a short script do the job, and do not install one in case it is needed later.'

const DETAILS = 'action search with an add-on\'s id, a category, or words shows when it helps, when to skip it, its download size, license, and conflicts.'

const LOOK_ORDER = 'A 3D game looks finished when it is built in this order, each step with the add-on that the index lists for it: '
  + '1. before the first scene, write down the game\'s style, its light, a palette with one accent color for what the player must notice, and two or three reference pictures; '
  + '2. light the scene, and judge everything after it in that light; '
  + '3. give every mesh a surface, so that none stays white; '
  + '4. fill the world with ground, cover, and water in large, middle, and small shapes; '
  + '5. add characters whose feet do not slide and that cast a shadow, with faces that blink and speak where they are seen up close; '
  + '6. put motion into every view: wind, cloth, light in the air, fire, smoke, water; '
  + '7. answer every hit, shot, and landing with an effect, a mark that stays, and a movement of the camera; '
  + '8. give the interface a look, a typeface, a loading screen, and button prompts; '
  + '9. lay one screen look over the finished picture, last. '
  + 'Then look at screenshots from the player\'s camera in three places, with godot_run web: true as well, and fix whatever was left as the engine made it.'

const INDEX = [
  'Environment: lighting, sky, weather, terrain, water, grass, trees, scattering, roads, dungeons, level layout (environment)',
  '- test-trees (Blender): procedural low-poly trees',
  'Characters: humans, rigs, animation clips, movement, faces, crowds (characters)',
  '- test-rig (Blender): control rigs for characters',
  'Camera and game feel (camera)',
  '- other-camera: another camera add-on',
  '- test-camera: cameras that follow and frame targets',
].join('\n')

async function entries() {
  dir = await scratch('prompt')
  return (await loadCatalog(await writeCatalog(dir.root))).entries
}

describe('the add-on catalog in the agent\'s instructions', () => {
  it('lists the categories in one order, which the Add-ons dialog\'s sections follow', () => {
    // src/client/categories.ts holds the dialog's order, which tests/addons-button.client.spec.tsx pins to the same list.
    expect(CATEGORIES).toEqual(['environment', 'rendering', 'characters', 'physics', 'gameplay', 'camera', 'interface', 'two-d', 'kits', 'assets', 'testing'])
  })

  it('groups the add-ons by category in the categories\' order, each with its id and cue, and marks Blender add-ons', async () => {
    const all = await entries()
    expect(catalogIndex(all).map(group => [group.category, group.entries.map(entry => entry.id)])).toEqual([
      ['environment', ['test-trees']],
      ['characters', ['test-rig']],
      ['camera', ['other-camera', 'test-camera']],
    ])
    expect(catalogLines(all)).toBe(INDEX)
  })

  it('adds a state after the cue of the add-ons that have one', async () => {
    expect(catalogLines(await entries(), entry => entry.id === 'test-camera' ? 'installed' : ''))
      .toContain('- test-camera: cameras that follow and frame targets [installed]\n'.trimEnd())
  })

  it('tells the Session\'s agent to decide itself, read about an add-on before building what it does, load the guide skill, and tell the user what it added', async () => {
    expect(sessionPrompt(await entries())).toBe(`# Game add-ons

game_addons installs tested third-party add-ons into the game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with the built-in Godot and Blender. ${JUDGMENT}
Before you build what a listed add-on does, read about it: ${DETAILS} After installing one, load its guide, the skill named by its id, before using it, and tell the user what you added and why, with its license and any credit it requires. Remove an add-on only when the game no longer uses it.

Every add-on, under its category, with what it is for:
${INDEX}`)
  })

  it('lists only the add-ons that agents may use, and nothing when the user turned off every one', async () => {
    const allowed = (await entries()).filter(entry => entry.id !== 'test-rig')
    expect(sessionPrompt(allowed)).toContain('- test-camera: cameras that follow and frame targets')
    expect(sessionPrompt(allowed)).not.toContain('test-rig')
    expect(sessionPrompt(allowed)).not.toContain('(characters)')
    expect(sessionPrompt([])).toBe('')
  })

  it('tells a connected agent the same, with the index from action search instead of its lines, absolute projects, the guide action, and Blender\'s enable call', () => {
    expect(mcpInstructions()).toBe(`game_addons installs tested third-party add-ons into the user's game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with WASD Engine's Godot 4.7 and Blender 5.2. ${JUDGMENT}
Read the catalog's index with action search and no query before you plan a game: it lists every add-on under its category with what it is for. Before you build what a listed add-on does, read about it: ${DETAILS}
Install one with action install and project set to the absolute folder that holds project.godot; it unpacks the add-on into addons/, enables it in project.godot, adds its license to THIRD_PARTY_NOTICES.md, and imports the project. Before using an add-on, read its guide with action guide, and for a Blender add-on run import wasd_addons; wasd_addons.enable("<id>") with blender_execute_python. Tell the user what you added and why, with its license and any credit it requires.
${LOOK_ORDER}`)
    // The order names steps, not add-ons, so that it holds whichever add-ons the user turned off.
    expect(LOOK_ORDER).not.toMatch(/wasd-|[a-z]+-[a-z]+-[a-z]+/u)
  })
})
