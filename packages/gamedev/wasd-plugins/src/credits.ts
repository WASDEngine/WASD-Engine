/**
 * What a game was made with, which its page on the WASD Engine site credits: the AI models that worked on the
 * project, the game tools whose calls succeeded for it, and the add-ons installed in it through WASD Engine. A project
 * keeps the models and tools in `.wasdengine/credits.json`, which grows as agents use game tools on the project and as
 * releases name the model that released them; the add-ons come from the project's add-on record,
 * `.wasdengine/addons.json`, at each release. One {@link CreditsLedger} owns the credits files of this process, writes
 * each project's file one change at a time, and attributes the tool calls of agents connected through WASD Engine's MCP
 * server that name no project to the project the same agent used last.
 * @module @deepseek-ai/dsh-wasd-plugins/src/credits
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { STATE_DIR, writeWhole } from './state.ts'

/** File name of a project's credits inside its state folder. */
export const CREDITS_FILE = 'credits.json'

/** File name of a project's add-on record inside its state folder, which the game add-ons plugin writes. */
const ADDONS_FILE = 'addons.json'

/** Version of the credits file's format. */
const CREDITS_FORMAT = 1

/** Most models a project credits; a new model past it replaces the earliest. */
export const MAX_MODEL_CREDITS = 6

/** Longest model name in characters. */
export const MAX_MODEL_NAME = 60

/** Most add-ons a release credits. */
export const MAX_ADDON_CREDITS = 24

/** Longest add-on title in characters. */
const MAX_ADDON_TITLE = 80

/** Game tools a game can credit, in the order its page lists them. */
export const TOOL_CREDITS = ['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'polyhaven'] as const

/** A game tool a game can credit. */
export type ToolCredit = typeof TOOL_CREDITS[number]

/** An AI model a game credits: WASD Engine's built-in AI, or another model by its name. */
export type ModelCredit = { readonly builtin: true } | { readonly name: string }

/** An add-on a game credits, by its catalog id and title, with the tool it extends. */
export interface AddonCredit {
  readonly id: string
  readonly title: string
  /** The tool the add-on extends, such as Blender for MPFB; absent when the record names no tool a game credits. */
  readonly host?: ToolCredit
}

/** What a game was made with. */
export interface GameCredits {
  /** AI models, earliest first. */
  readonly models: readonly ModelCredit[]
  /** Game tools, in {@link TOOL_CREDITS} order. */
  readonly tools: readonly ToolCredit[]
  /** Add-ons, in the order the project installed them; the tool each extends is among `tools`. */
  readonly addons: readonly AddonCredit[]
}

/** The models and tools a project's credits file holds. */
export interface ProjectCredits {
  readonly models: readonly ModelCredit[]
  readonly tools: readonly ToolCredit[]
}

/** Display names of the tools. */
const TOOL_NAMES: Readonly<Record<ToolCredit, string>> = {
  godot: 'Godot',
  blender: 'Blender',
  gimp: 'GIMP',
  supercollider: 'SuperCollider',
  elevenlabs: 'ElevenLabs',
  'nano-banana': 'Nano Banana',
  polyhaven: 'Poly Haven',
}

/**
 * Session tool name prefixes of each tool. Blender, GIMP, and SuperCollider reach a Session as the MCP servers
 * `wasd_blender`, `wasd_gimp`, and `wasd_supercollider` of their plugins.
 */
const SESSION_TOOL_PREFIXES: ReadonlyArray<readonly [string, ToolCredit]> = [
  ['godot_', 'godot'],
  ['mcp__wasd_blender__', 'blender'],
  ['mcp__wasd_gimp__', 'gimp'],
  ['mcp__wasd_supercollider__', 'supercollider'],
  ['elevenlabs_', 'elevenlabs'],
  ['image_', 'nano-banana'],
  ['polyhaven_', 'polyhaven'],
]

/** Name prefix of this plugin's own tools, whose calls work on a game project too. */
const WASD_TOOL_PREFIX = 'wasd_'

/** Id of this plugin's provider on WASD Engine's MCP server. */
export const WASD_PROVIDER = 'wasd'

/**
 * The tool a Session's tool call credits.
 * @param name - the tool name as the Session calls it.
 * @returns the tool, or undefined for a tool no game credits.
 */
export function sessionToolCredit(name: string): ToolCredit | undefined {
  return SESSION_TOOL_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1]
}

/**
 * Whether a Session's successful call of a tool credits the Session's model: a call of a credited tool or of this
 * plugin's tools.
 * @param name - the tool name as the Session calls it.
 * @returns whether the call is game work.
 */
export function isGameWork(name: string): boolean {
  return sessionToolCredit(name) !== undefined || name.startsWith(WASD_TOOL_PREFIX)
}

/**
 * Whether a tool name names a project in its `project` argument: the Godot tools and this plugin's tools do.
 * @param name - the tool name as the Session calls it, or as a connected agent calls it.
 * @returns whether `project` is the folder of the game.
 */
export function namesProject(name: string): boolean {
  return name.startsWith('godot_') || name.startsWith(WASD_TOOL_PREFIX)
}

/** The tool a game credits under an id, such as a provider's id or the host of an add-on record's entry. */
function toolCredit(id: string): ToolCredit | undefined {
  return (TOOL_CREDITS as readonly string[]).includes(id) ? id as ToolCredit : undefined
}

/** Providers whose id is not the id of the tool they credit: the image tool's provider credits the model that makes its images. */
const PROVIDER_CREDITS: ReadonlyMap<string, ToolCredit> = new Map([['image', 'nano-banana']])

/**
 * The tool a provider of WASD Engine's MCP server credits: the image provider credits Nano Banana, and every other
 * credited tool's provider has the tool's id.
 * @param provider - the provider id.
 * @returns the tool, or undefined for a provider no game credits.
 */
export function providerToolCredit(provider: string): ToolCredit | undefined {
  return PROVIDER_CREDITS.get(provider) ?? toolCredit(provider)
}

/** File name extensions of model weights, which a credit leaves out. */
const WEIGHTS_EXTENSION = /\.(?:gguf|ggml|ggjt|bin|safetensors|onnx|pt|pth|ckpt|llamafile|mlmodel|mlpackage|tflite)$/iu

/**
 * A model id or name reduced to what a public page may show: a name with a `/` or `\`, such as the file path a local
 * model server reports as its model's id, a `file:` URL, or a provider's `org/model` id, becomes its last part, so no
 * folder of the user's computer reaches the page, and a model file's extension goes.
 */
function shownModel(name: string): string {
  let last = name.split(/[\\/]/u).map(part => part.trim()).filter(part => part !== '').at(-1) ?? ''
  // A folder's dots and a drive or URL scheme alone, such as `C:` or `file:`, name no model.
  if (last === '.' || last === '..' || (last !== name.trim() && last.endsWith(':'))) return ''
  while (WEIGHTS_EXTENSION.test(last)) last = last.replace(WEIGHTS_EXTENSION, '').trim()
  return last
}

/**
 * A model name as a release credits it on the game's public page: a name that looks like a path keeps only its last
 * part, without a model file's extension (`/Users/me/models/Qwen3-8B-Q4_K_M.gguf` credits `Qwen3-8B-Q4_K_M`); then it
 * is trimmed, at most {@link MAX_MODEL_NAME} characters, without control characters. Cleaning a cleaned name changes
 * nothing, so a credits file whose name differs from its cleaned form, such as a path an earlier version stored, credits
 * no model.
 * @param name - the name.
 * @returns the cleaned name, or undefined when nothing is left.
 */
export function modelName(name: string): string | undefined {
  let current = name
  for (;;) {
    const cleaned = cleanText(shownModel(current), MAX_MODEL_NAME)
    // A cut at the length limit can leave a model file's extension at the end, which the next round takes off.
    if (cleaned === undefined || cleaned === current) return cleaned
    current = cleaned
  }
}

/**
 * Text as a credit holds it: control characters and runs of white space become one space, trimmed, and cut after the
 * last whole character (grapheme) that keeps it within `max` code points, the unit the site counts.
 */
function cleanText(text: string, max: number): string | undefined {
  let spaced = ''
  for (const char of text) {
    const code = char.codePointAt(0) as number
    spaced += code < 0x20 || code === 0x7F ? ' ' : char
  }
  let cleaned = ''
  let points = 0
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(spaced.replace(/\s+/gu, ' ').trim())) {
    const size = Array.from(segment).length
    if (points + size > max) break
    cleaned += segment
    points += size
  }
  cleaned = cleaned.trim()
  return cleaned === '' ? undefined : cleaned
}

/**
 * The names a release's result lists for its credits, as the game's page lists them.
 * @param credits - the credits.
 * @returns the models, then each tool with the add-ons that extend it, such as `Blender with MPFB (MakeHuman)`, then
 * add-ons of no credited tool.
 */
export function creditNames(credits: GameCredits): string[] {
  const titles = (host: ToolCredit | undefined) => credits.addons.filter(addon => addon.host === host).map(addon => addon.title)
  return [
    ...credits.models.map(model => 'builtin' in model ? 'WASD Engine\'s built-in AI' : model.name),
    ...credits.tools.map((tool) => {
      const addons = titles(tool)
      return addons.length === 0 ? TOOL_NAMES[tool] : `${TOOL_NAMES[tool]} with ${addons.join(', ')}`
    }),
    ...credits.addons.filter(addon => addon.host === undefined || !credits.tools.includes(addon.host)).map(addon => addon.title),
  ]
}

const ModelEntry = z.union([
  z.strictObject({ builtin: z.literal(true) }),
  z.strictObject({ name: z.string().refine(name => modelName(name) === name, 'must be a cleaned model name') }),
])

const CreditsFile = z.object({
  format: z.literal(CREDITS_FORMAT),
  models: z.array(z.unknown()),
  tools: z.array(z.unknown()),
})

const AddonRecord = z.object({
  addons: z.array(z.object({ id: z.string(), title: z.string(), host: z.string().optional() })),
})

/** Pattern of an add-on catalog id, as the game add-ons plugin defines it. */
const ADDON_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Longest add-on id a release credits. */
const MAX_ADDON_ID = 64

function modelKey(model: ModelCredit): string {
  return 'builtin' in model ? 'builtin' : `model:${model.name.toLowerCase()}`
}

function creditKeys(credits: ProjectCredits): string[] {
  return [...credits.models.map(modelKey), ...credits.tools.map(tool => `tool:${tool}`)]
}

function creditsPath(projectDir: string): string {
  return join(projectDir, STATE_DIR, CREDITS_FILE)
}

async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    // A file that is not JSON holds nothing to credit; the next change replaces it.
    return undefined
  }
}

/**
 * Read a project's credits file. Entries this version does not know, and a file that is missing or not this format,
 * credit nothing.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the models and tools.
 */
export async function readCredits(projectDir: string): Promise<ProjectCredits> {
  const parsed = CreditsFile.safeParse(await readJson(creditsPath(projectDir)))
  if (!parsed.success) return { models: [], tools: [] }
  const models: ModelCredit[] = []
  for (const entry of parsed.data.models) {
    const model = ModelEntry.safeParse(entry)
    if (model.success && !models.some(seen => modelKey(seen) === modelKey(model.data))) models.push(model.data)
  }
  const tools = TOOL_CREDITS.filter(tool => parsed.data.tools.includes(tool))
  return { models: models.slice(-MAX_MODEL_CREDITS), tools }
}

/**
 * Read the add-ons a project's add-on record lists, each with the tool it extends. A record that is missing or cannot
 * be read credits none.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the add-ons, each id once, at most {@link MAX_ADDON_CREDITS}.
 */
export async function readAddonCredits(projectDir: string): Promise<AddonCredit[]> {
  const parsed = AddonRecord.safeParse(await readJson(join(projectDir, STATE_DIR, ADDONS_FILE)))
  if (!parsed.success) return []
  const addons: AddonCredit[] = []
  for (const { id, title, host } of parsed.data.addons) {
    const name = cleanText(title, MAX_ADDON_TITLE)
    if (!ADDON_ID_PATTERN.test(id) || id.length > MAX_ADDON_ID || name === undefined || addons.some(seen => seen.id === id)) continue
    const tool = host === undefined ? undefined : toolCredit(host)
    addons.push({ id, title: name, ...tool === undefined ? {} : { host: tool } })
  }
  return addons.slice(0, MAX_ADDON_CREDITS)
}

/**
 * Add credits to a project's credits.
 * @param current - the credits now.
 * @param models - models to credit; one credited already keeps its place.
 * @param tools - tools to credit.
 * @returns the credits afterwards.
 */
function merged(current: ProjectCredits, models: readonly ModelCredit[], tools: readonly ToolCredit[]): ProjectCredits {
  const allModels = [...current.models]
  for (const model of models) {
    if (!allModels.some(seen => modelKey(seen) === modelKey(model))) allModels.push(model)
  }
  return {
    models: allModels.slice(-MAX_MODEL_CREDITS),
    tools: TOOL_CREDITS.filter(tool => current.tools.includes(tool) || tools.includes(tool)),
  }
}

async function writeCredits(projectDir: string, credits: ProjectCredits): Promise<void> {
  await mkdir(join(projectDir, STATE_DIR), { recursive: true })
  await writeWhole(creditsPath(projectDir), `${JSON.stringify({ format: CREDITS_FORMAT, models: credits.models, tools: credits.tools }, null, 2)}\n`)
}

/** Owner of the credits files that this process writes, and of what connected agents used before they named a project. */
export class CreditsLedger {
  /** Each project's latest change, which the next change waits for. */
  private readonly changes = new Map<string, Promise<void>>()
  /** Each project's credits as this ledger last wrote or read them, which a call that adds nothing skips writing. */
  private readonly known = new Map<string, ReadonlySet<string>>()
  /** The project each connected agent used last. */
  private readonly clientProjects = new Map<string, string>()
  /** Tools each connected agent used before it named a project. */
  private readonly unattributed = new Map<string, Set<ToolCredit>>()

  /**
   * Credit models and tools to a project. A call that adds nothing this ledger has not seen in the file returns at once.
   * @param projectDir - absolute folder holding `project.godot`.
   * @param models - models that worked on the project.
   * @param tools - tools whose calls succeeded for the project.
   * @returns once the file holds them.
   */
  async add(projectDir: string, models: readonly ModelCredit[], tools: readonly ToolCredit[]): Promise<void> {
    const keys = creditKeys({ models, tools })
    const known = this.known.get(projectDir)
    if (known !== undefined && keys.every(key => known.has(key))) return
    await this.change(projectDir, async () => {
      const current = await readCredits(projectDir)
      const next = merged(current, models, tools)
      if (creditKeys(next).join('\n') !== creditKeys(current).join('\n')) await writeCredits(projectDir, next)
      this.known.set(projectDir, new Set(creditKeys(next)))
    })
  }

  /**
   * Credit a connected agent's successful tool call. A call that names no project credits the project the agent used
   * last; before the agent used one, the tool waits for the next call that names one, or for {@link CreditsLedger.claim}.
   * @param client - the connected agent's id.
   * @param projectDir - absolute folder holding `project.godot` that the call worked on, when it named one.
   * @param tool - the tool the call credits, if any.
   * @returns once the file holds the credits.
   */
  async connected(client: string, projectDir: string | undefined, tool: ToolCredit | undefined): Promise<void> {
    const target = projectDir ?? this.clientProjects.get(client)
    if (target === undefined) {
      if (tool === undefined) return
      const waiting = this.unattributed.get(client) ?? new Set<ToolCredit>()
      waiting.add(tool)
      this.unattributed.set(client, waiting)
      return
    }
    const waiting = this.claimWaiting(client, target)
    await this.add(target, [], tool === undefined ? waiting : [...waiting, tool])
  }

  /**
   * Make a project the one a connected agent works on, and credit it with the tools the agent used before it named a
   * project, as a release by that agent does before it reads the credits.
   * @param client - the connected agent's id.
   * @param projectDir - absolute folder holding `project.godot`.
   * @returns once the file holds the credits.
   */
  async claim(client: string, projectDir: string): Promise<void> {
    const waiting = this.claimWaiting(client, projectDir)
    if (waiting.length > 0) await this.add(projectDir, [], waiting)
  }

  /**
   * Credit a release's model, then collect what the game was made with.
   * @param projectDir - absolute folder holding `project.godot`.
   * @param model - the model that releases the game, if known.
   * @returns the project's models; its tools, with Godot, which builds every release, and each tool an add-on extends;
   * and its add-ons.
   */
  async release(projectDir: string, model: ModelCredit | undefined): Promise<GameCredits> {
    const models = model === undefined ? [] : [model]
    const addons = await readAddonCredits(projectDir)
    const tools: ToolCredit[] = ['godot', ...addons.flatMap(addon => addon.host === undefined ? [] : [addon.host])]
    await this.add(projectDir, models, tools)
    await this.changes.get(projectDir)
    const credits = merged(await readCredits(projectDir), models, tools)
    return { models: credits.models, tools: credits.tools, addons }
  }

  private claimWaiting(client: string, projectDir: string): ToolCredit[] {
    this.clientProjects.set(client, projectDir)
    const waiting = [...this.unattributed.get(client) ?? []]
    this.unattributed.delete(client)
    return waiting
  }

  private async change(projectDir: string, run: () => Promise<void>): Promise<void> {
    const previous = this.changes.get(projectDir) ?? Promise.resolve()
    const next = previous.then(run)
    // The next change runs after this one also when this one fails; its caller receives the failure.
    const settled = next.catch(() => {})
    this.changes.set(projectDir, settled)
    try {
      await next
    } finally {
      if (this.changes.get(projectDir) === settled) this.changes.delete(projectDir)
    }
  }
}
