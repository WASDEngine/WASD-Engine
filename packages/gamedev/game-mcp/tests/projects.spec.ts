/**
 * A connected agent's `create_game_project` creates a game project through the Workspace controller's game project
 * controller, as the Create game project dialog does: in the location it names, unless that is in a temporary folder,
 * or in WASD Engine's folder for game projects, without a Session, and with a result or an error that tells the agent
 * what happened, where a created project's result ends with the deployment's guidance for the new game; each created
 * project is reported with the model the agent named. The calls pass no temporary folders unless they test them, because
 * the system's temporary folder holds the test's folder, and no guidance unless they test it.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { GameProjectController } from '@deepseek-ai/dsh-api-workspace-controller'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpCallResult } from '../src/catalog.ts'
import { createGameProject } from '../src/projects.ts'
import type { GameMcpProjectCreated, JsonObject } from '../src/provider.ts'

const CREATED_AT = '2026-11-14T00:00:00.000Z'

/** What the agent reads, after the quoted name, about a device name that Windows reserves. */
const DEVICE_TEXT = 'is not a folder name that every computer accepts: Windows reserves CON, PRN, AUX, NUL, COM0 to COM9, COM¹, COM², '
  + 'COM³, LPT0 to LPT9, LPT¹, LPT², and LPT³ for devices, with or without an extension. Pass another name.'

let root: string
let ctx: Context
/** Registrations of the fake Workspace registry, by canonical path. */
let registered: string[]
/** The created projects that the `game-mcp/project-created` event reported. */
let created: GameMcpProjectCreated[]
const client = { id: 'claude-code', title: 'Claude Code' }
const call = { client, signal: new AbortController().signal }

/** What a creation that named no model adds about naming it. */
const MODEL_HINT = ' The game\'s page credits the AI model that makes the game: pass model, the name of the AI model you are, to godot_run when you '
  + 'first run the game.'

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-mcp-projects-')))
  registered = []
  created = []
  ctx = new Context()
  ctx.on('game-mcp/project-created', (project) => { created.push(project) })
  ctx.provide('workspaceRegistry', {
    create: async (path: string) => {
      const canonical = await realpath(path)
      registered.push(canonical)
      return { id: `w${registered.length}`, path: canonical, title: basename(canonical), sessionIds: [], createdAt: CREATED_AT, updatedAt: CREATED_AT }
    },
  } as never)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * Mount the game project controller with the test's Documents folder.
 * @param git - the Git commands' runner; by default every command succeeds.
 * @returns the Git commands it ran, with their folders.
 */
function mountProjects(git: (args: readonly string[]) => Promise<string> = () => Promise.resolve('')): Array<{ args: readonly string[]; cwd: string }> {
  const commands: Array<{ args: readonly string[]; cwd: string }> = []
  new GameProjectController(ctx, { documentsDirectory: join(root, 'Documents'), documentsLookupTimeoutMs: 10_000, required: false }, (args, cwd) => {
    commands.push({ args, cwd })
    return git(args)
  })
  return commands
}

function text(result: McpCallResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('create_game_project', () => {
  it('creates the folder in WASD Engine\'s folder for game projects with a repository, registers it, and names it', async () => {
    const commands = mountProjects()
    const result = await createGameProject(ctx, { name: '  Space Frogs  ' }, call, [], '')

    const path = join(root, 'Documents', 'WASD Engine', 'Space Frogs')
    expect(result.isError).toBeUndefined()
    // The plugins come from search_game_tools, whose list is complete where a cut overview's is not; add-ons install into a
    // project.godot that the empty folder does not have yet; and the Blender, GIMP, and SuperCollider tools refuse project
    // without session.
    expect(text(result)).toBe(`Created the game project "Space Frogs" in ${path}, which WASD Engine lists among the user's game projects. `
      + 'The folder holds a Git repository with one empty commit and no game files yet. '
      + 'Before you write code, plan the game around the plugins that search_game_tools lists, and read the guide of each one you will use. '
      + 'Make the game in this folder, and write its project.godot before you install add-ons into it. '
      + 'Where a game tool takes project, pass this folder\'s absolute path; the blender_*, gimp_*, and supercollider_* tools take project '
      + `only together with session.${MODEL_HINT}`)
    expect(existsSync(path)).toBe(true)
    expect(registered).toEqual([path])
    expect(created).toEqual([{ client, path }])
    expect(commands.map(command => [command.args.find(arg => arg === 'init' || arg === 'commit'), command.cwd])).toEqual([['init', path], ['commit', path]])
  })

  it('creates the folder in the location the call names, with the folders above it', async () => {
    mountProjects()
    const location = join(root, 'games', 'jams')
    const result = await createGameProject(ctx, { name: 'Moon Miner', location }, call, [], '')

    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain(`in ${join(location, 'Moon Miner')}, which WASD Engine lists`)
    expect(registered).toEqual([join(location, 'Moon Miner')])
    expect(existsSync(join(root, 'Documents'))).toBe(false)
  })

  it('trims the location as the dialog does, and creates the folder in the default folder for a null, empty, or blank one', async () => {
    mountProjects()
    const location = join(root, 'jams')
    const spaced = await createGameProject(ctx, { name: 'Moon Miner', location: `  ${location} ` }, call, [], '')
    expect(spaced.isError).toBeUndefined()
    expect(text(spaced)).toContain(`in ${join(location, 'Moon Miner')}, which WASD Engine lists`)
    expect(existsSync(`${location} `)).toBe(false)
    const omitted: JsonObject[] = [{ name: 'Null', location: null }, { name: 'Empty', location: '' }, { name: 'Blank', location: '   ' }]
    for (const args of omitted) {
      const result = await createGameProject(ctx, args, call, [], '')
      expect(result.isError, JSON.stringify(args)).toBeUndefined()
    }
    const documents = join(root, 'Documents', 'WASD Engine')
    expect(registered).toEqual([join(location, 'Moon Miner'), join(documents, 'Null'), join(documents, 'Empty'), join(documents, 'Blank')])
  })

  it('reports each created project with the model the agent named, and says where to name it only after a call that named none', async () => {
    mountProjects()
    const named = await createGameProject(ctx, { name: 'Named', location: root, model: '  Claude Fable 5.2 ' }, call, [], '')
    expect(named.isError).toBeUndefined()
    expect(text(named)).toMatch(/only together with session\.$/u)
    const unnamed: JsonObject[] = [{ name: 'Null', model: null }, { name: 'Empty', model: '' }, { name: 'Blank', model: '   ' }]
    for (const args of unnamed) {
      const result = await createGameProject(ctx, { ...args, location: root }, call, [], '')
      expect(result.isError, JSON.stringify(args)).toBeUndefined()
      expect(text(result).endsWith(MODEL_HINT), JSON.stringify(args)).toBe(true)
    }
    expect(created).toEqual([
      { client, path: join(root, 'Named'), model: 'Claude Fable 5.2' },
      { client, path: join(root, 'Null') },
      { client, path: join(root, 'Empty') },
      { client, path: join(root, 'Blank') },
    ])
  })

  it('ends a created project\'s result with the deployment\'s guidance for the new game, and a refusal\'s without it', async () => {
    mountProjects()
    const guidance = 'These additional instructions are the recommended prompt for building games with WASD Engine:\n* Play the game yourself'
    const named = await createGameProject(ctx, { name: 'Named', location: root, model: 'Claude Fable 5.2' }, call, [], guidance)
    expect(named.isError).toBeUndefined()
    expect(named.content).toHaveLength(1)
    expect(text(named).endsWith(`only together with session.\n\n${guidance}`)).toBe(true)
    // The guidance follows the request to name the model, which ends the text it adds to.
    const unnamed = await createGameProject(ctx, { name: 'Unnamed', location: root }, call, [], guidance)
    expect(text(unnamed).endsWith(`${MODEL_HINT}\n\n${guidance}`)).toBe(true)

    const taken = await createGameProject(ctx, { name: 'Named', location: root }, call, [], guidance)
    expect(taken.isError).toBe(true)
    expect(text(taken)).toBe(`${join(root, 'Named')} already exists; pass another name or location.`)
    const temporary = await createGameProject(ctx, { name: 'Scratch', location: join(root, 'scratch') }, call, [root], guidance)
    expect(temporary.isError).toBe(true)
    expect(text(temporary)).not.toContain(guidance)
    expect(registered).toEqual([join(root, 'Named'), join(root, 'Unnamed')])
  })

  it('creates the project although a listener of its report fails', async () => {
    mountProjects()
    ctx.on('game-mcp/project-created', () => { throw new Error('the listener failed on purpose') })
    const result = await createGameProject(ctx, { name: 'Listened', location: root }, call, [], '')
    expect(result.isError).toBeUndefined()
    expect(registered).toEqual([join(root, 'Listened')])
  })

  it('says when the folder holds no repository because Git is missing', async () => {
    mountProjects(() => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })))
    const result = await createGameProject(ctx, { name: 'No Git', location: root }, call, [], '')

    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('The folder holds no game files yet, and no Git repository. Before you write code, plan the game')
    expect(registered).toEqual([join(root, 'No Git')])
  })

  it('refuses arguments, names, locations, and paths it cannot use, and registers nothing', async () => {
    mountProjects()
    await mkdir(join(root, 'Taken'))
    await writeFile(join(root, 'file'), '')
    const cases: Array<[JsonObject, string]> = [
      [{}, 'Pass name, the name of the game project.'],
      [{ name: 7 }, 'Pass name, the name of the game project.'],
      [{ name: 'Game', location: 7 }, 'location must be a string: the absolute path of the folder to create the project in.'],
      [{ name: 'Game', location: root, model: 7 }, 'model must be a string: the name of the AI model you are.'],
      [{ name: 'a/b', location: root }, '"a/b" is not a folder name that every computer accepts. Pass a name without / \\ : * ? " < > |, control characters, or a trailing period, of at most 255 bytes.'],
      [{ name: 'con.txt', location: root }, `"con.txt" ${DEVICE_TEXT}`],
      // The text names every device name the Host refuses, the zeros and the superscript digits too.
      [{ name: 'lpt²', location: root }, `"lpt²" ${DEVICE_TEXT}`],
      [{ name: 'COM0.wav', location: root }, `"COM0.wav" ${DEVICE_TEXT}`],
      [{ name: '\u200b', location: root }, 'The name "\u200b" has no visible characters. Pass a name that shows letters, digits, or symbols.'],
      [{ name: '.git', location: root }, '".git" is the name of Git\'s own folder. Pass another name.'],
      [{ name: 'Game', location: 'games' }, 'location must be the absolute path of a folder, got "games".'],
      [{ name: 'Taken', location: root }, `${join(root, 'Taken')} already exists; pass another name or location.`],
    ]
    for (const [args, message] of cases) {
      const result = await createGameProject(ctx, args, call, [], '')
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toBe(message)
    }
    const blocked = await createGameProject(ctx, { name: 'Game', location: join(root, 'file', 'child') }, call, [], '')
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toMatch(/^WASD Engine could not create the game project: cannot create ".*file\/child": /u)
    expect(registered).toEqual([])
    expect(created).toEqual([])
  })

  it('refuses a location in a temporary folder, however it is spelled, and still creates in the folder for game projects', async () => {
    mountProjects()
    const temporary = join(root, 'private', 'tmp')
    await mkdir(join(temporary, 'scratch'), { recursive: true })
    // A junction on Windows, which needs no privilege; other systems ignore the type.
    await symlink(temporary, join(root, 'tmp'), 'junction')
    const locations = [temporary, join(temporary, 'scratch'), join(root, 'tmp', 'scratch'), join(root, 'tmp', 'new', 'folders')]
    for (const location of [...locations, `  ${join(temporary, 'scratch')} `]) {
      const result = await createGameProject(ctx, { name: 'Scratch', location }, call, [join(root, 'tmp')], '')
      expect(result.isError, location).toBe(true)
      expect(text(result)).toBe(`${location.trim()} is in a temporary folder, whose files the system may delete, so WASD Engine creates no game project `
        + 'there. Leave location out to create the project in WASD Engine\'s folder for game projects, or pass a folder that lasts. '
        + 'To try something out in a temporary folder, make the folder yourself and pass it as project: the game tools work in it without a game project.')
    }
    expect(existsSync(join(temporary, 'new'))).toBe(false)
    // The folder for game projects is WASD Engine's own choice, so it is used wherever the Documents folder is.
    const kept = await createGameProject(ctx, { name: 'Kept' }, call, [root], '')
    expect(kept.isError).toBeUndefined()
    expect(registered).toEqual([join(root, 'Documents', 'WASD Engine', 'Kept')])
  })

  it('asks for a location when WASD Engine cannot find the Documents folder', async () => {
    const create = vi.fn()
    ctx.provide('gameProjectController', { defaults: () => Promise.resolve({ directory: null, required: false }), create } as never)
    const result = await createGameProject(ctx, { name: 'Game' }, call, [], '')

    expect(result.isError).toBe(true)
    expect(text(result)).toBe('WASD Engine cannot find the user\'s Documents folder, where it keeps game projects; pass location, the absolute path of the folder to create the project in.')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses when WASD Engine keeps no game projects', async () => {
    const result = await createGameProject(ctx, { name: 'Game', location: root }, call, [], '')
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('This WASD Engine keeps no game projects, so it cannot create one.')
  })
})
