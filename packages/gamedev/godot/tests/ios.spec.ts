/** The Apple Developer team of iOS exports: the Team IDs of certificates, the Xcode project's name, and the team's removal. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { certificateTeams, detectAppleTeam, iosBinaryName, removeTeam } from '../src/ios.ts'
import { scratch, subprocessFixture, type Scratch, type SubprocessFixture } from './helpers.ts'

const fixture = (team: string): Promise<string> => readFile(new URL(`./fixtures/apple-development-${team}.pem`, import.meta.url), 'utf8')

const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
})

describe('certificateTeams', () => {
  it('reads the team from each valid certificate\'s Organizational Unit, each team once', async () => {
    const first = await fixture('ABCDE12345')
    const second = await fixture('FGHIJ67890')
    const valid = new Date('2030-01-01T00:00:00Z')
    expect(certificateTeams(`${first}\n${first}`, valid)).toEqual(['ABCDE12345'])
    expect(certificateTeams(`${second}garbage\n${first}`, valid)).toEqual(['ABCDE12345', 'FGHIJ67890'])
  })

  it('skips certificates outside their validity and text that is no certificate', async () => {
    const first = await fixture('ABCDE12345')
    expect(certificateTeams(first, new Date('2040-01-01T00:00:00Z'))).toEqual([])
    expect(certificateTeams(first, new Date('2020-01-01T00:00:00Z'))).toEqual([])
    expect(certificateTeams('-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----', new Date())).toEqual([])
  })
})

describe('detectAppleTeam', () => {
  it('finds no team outside macOS, which has no keychain to read', async () => {
    const host = await subprocessFixture()
    hosts.push(host)
    const signal = new AbortController().signal
    const team = await detectAppleTeam({ subprocess: host.subprocess, platform: 'linux', timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, now: new Date() })
    expect(team).toBeUndefined()
  })
})

describe('iosBinaryName', () => {
  it('keeps the ASCII letters and digits of the game\'s name', () => {
    expect(iosBinaryName('Tiny Farm: Deluxe!')).toBe('TinyFarmDeluxe')
    expect(iosBinaryName('Café Crème')).toBe('CafeCreme')
    expect(iosBinaryName('3D Racer')).toBe('Game3DRacer')
    expect(iosBinaryName('游戏')).toBe('Game')
    expect(iosBinaryName(undefined)).toBe('Game')
    expect(iosBinaryName('A'.repeat(80))).toHaveLength(64)
  })
})

describe('removeTeam', () => {
  it('removes the team from the project\'s signing settings and its export options, and nothing else', async () => {
    const dir = await scratch('ios-team')
    folders.push(dir)
    await mkdir(join(dir.root, 'Game.xcodeproj'))
    await mkdir(join(dir.root, 'Game'))
    await writeFile(join(dir.root, 'Game.xcodeproj', 'project.pbxproj'), [
      '\t\t\t\t\t\tDevelopmentTeam = WASDNOTEAM;', '\t\t\t\tDEVELOPMENT_TEAM = WASDNOTEAM;', '\t\t\t\tDEVELOPMENT_TEAM = "WASDNOTEAM";',
      '\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;', '\t\t\t\tPRODUCT_NAME = Game;', '',
    ].join('\n'))
    await writeFile(join(dir.root, 'Game', 'export_options.plist'), '<dict>\n    <key>teamID</key>\n    <string>WASDNOTEAM</string>\n    <key>method</key>\n</dict>\n')
    await removeTeam(dir.root, 'Game', 'WASDNOTEAM')
    expect(await readFile(join(dir.root, 'Game.xcodeproj', 'project.pbxproj'), 'utf8')).toBe('\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tPRODUCT_NAME = Game;\n')
    expect(await readFile(join(dir.root, 'Game', 'export_options.plist'), 'utf8')).toBe('<dict>\n    <key>method</key>\n</dict>\n')
  })

  it('leaves a project without export options as it is otherwise', async () => {
    const dir = await scratch('ios-team')
    folders.push(dir)
    await mkdir(join(dir.root, 'Game.xcodeproj'))
    await writeFile(join(dir.root, 'Game.xcodeproj', 'project.pbxproj'), 'PRODUCT_NAME = Game;\n')
    await removeTeam(dir.root, 'Game', 'WASDNOTEAM')
    expect(await readFile(join(dir.root, 'Game.xcodeproj', 'project.pbxproj'), 'utf8')).toBe('PRODUCT_NAME = Game;\n')
  })
})
