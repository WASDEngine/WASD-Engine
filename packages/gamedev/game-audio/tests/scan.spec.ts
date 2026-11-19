/** The walk of a project for sounds lists its audio files, following links to folders and files only inside it. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanSounds } from '../src/scan.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const LIMITS = { maxFolders: 100, maxSounds: 100 }
/** Symbolic links need a privilege on Windows, so the specs that make them run elsewhere. */
const linking = it.skipIf(process.platform === 'win32')

describe('scanSounds', () => {
  linking('lists sounds through links inside the project, and none through links that lead out of it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-game-audio-scan-'))
    roots.push(root)
    const project = join(root, 'game')
    await mkdir(join(project, 'audio'), { recursive: true })
    await writeFile(join(project, 'audio', 'jump.wav'), 'RIFF')
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    await writeFile(join(root, 'elsewhere', 'private.mp3'), 'ID3')
    await symlink(join(root, 'elsewhere'), join(project, 'linked'))
    await symlink(join(root, 'elsewhere', 'private.mp3'), join(project, 'private.mp3'))
    await symlink(join(project, 'audio', 'jump.wav'), join(project, 'jump-link.wav'))
    const scan = await scanSounds(project, LIMITS, new AbortController().signal)
    expect(scan.sounds.map(sound => sound.path).sort()).toEqual(['audio/jump.wav', 'jump-link.wav'])
  })
})
