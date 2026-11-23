/** Where the shipped add-on catalog and its smoke tests live, and the format of one smoke test. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

/** The shipped catalog, beside the gamedev preset in the Web app bundle. */
export const CATALOG_DIR = join(REPO, 'packages/bundle/web-app/wasdengine/addons')

/** The notices file beside the catalog's folders, which lists every icon with its license, copyright, and source. */
export const ICON_NOTICES = 'ICONS.md'

/** The bundled skills, whose names an add-on guide must not take. */
export const BUNDLED_SKILLS_DIR = join(REPO, 'packages/bundle/web-app/wasdengine/skills')

/** The smoke tests of the shipped catalog, one folder per add-on id. */
export const SMOKE_DIR = fileURLToPath(new URL('./smoke/', import.meta.url))

/**
 * How the end-to-end suite runs one add-on's smoke test: a `scene` headless, a `scene` rendered without a window
 * (`render`), a SceneTree `script` with user arguments, or a `blender` Python file in a worker that enabled the add-on.
 * A Godot smoke test copies the `files/` folder of its own smoke folder, or of the one `files` names, into the project.
 * Its `prepare` script, such as a helper of the add-on that an agent runs with `godot_script`, runs with its arguments
 * after an import of those files and before the next one. The run must print every `expect` marker, no `SMOKE_FAIL`,
 * and end with `exitCode` (default 0). A Godot run must also print no error, a line that starts with `ERROR:` or
 * `SCRIPT ERROR:`, since an error that a game prints in a browser stops its release; what Godot reports while it
 * shuts down about resources left in use does not count, and `errors` holds a part of each other error line that
 * the run may print because a game does not meet it, such as one that only quitting brings. `webNotes` holds
 * one phrase of each note that the Web export's feature scan raises about the add-on's own files, in the scan's
 * order; without it the files must raise none. `with` names other Godot add-ons of the catalog that the suite
 * installs beside the add-on once its own files are checked, for a smoke test of what the add-ons do together.
 */
export const SmokeSpec = z.strictObject({
  run: z.enum(['scene', 'render', 'script', 'blender']),
  path: z.string().min(1),
  args: z.array(z.string()).exactOptional(),
  files: z.string().min(1).exactOptional(),
  prepare: z.strictObject({ path: z.string().min(1), args: z.array(z.string()) }).exactOptional(),
  expect: z.array(z.string().min(1)).min(1),
  exitCode: z.number().int().exactOptional(),
  timeoutSeconds: z.number().int().min(1).max(600),
  importTwice: z.boolean().exactOptional(),
  errors: z.array(z.string().min(1)).min(1).exactOptional(),
  webNotes: z.array(z.string().min(1)).min(1).exactOptional(),
  with: z.array(z.string().min(1)).min(1).exactOptional(),
})
