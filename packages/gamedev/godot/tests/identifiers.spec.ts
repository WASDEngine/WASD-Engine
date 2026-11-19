/**
 * A game's app identifiers: the one that the project keeps for each platform in `project.godot`, a new one from the
 * game's name and six random letters, and the platforms' own rules for them.
 */
import { describe, expect, it } from 'vitest'
import {
  APP_IDENTIFIER_SETTINGS, nameIdentifier, newAppIdentifier, storedAppIdentifier, validAppIdentifier, withAppIdentifier,
  WASD_SETTINGS_SECTION,
} from '../src/identifiers.ts'

const PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="Tiny Farm"\n'

describe('app identifiers', () => {
  it('makes the identifier that a name gives each platform from any name', () => {
    expect(nameIdentifier('android', 'Tiny Farm')).toBe('com.wasdengine.game.tiny_farm')
    expect(nameIdentifier('android', '  Café -- Crème!  ')).toBe('com.wasdengine.game.cafe_creme')
    expect(nameIdentifier('macos', 'Café Über Ünïcode!')).toBe('com.wasdengine.game.cafe-uber-unicode')
    expect(nameIdentifier('android', '3D Racer')).toBe('com.wasdengine.game.game_3d_racer')
    expect(nameIdentifier('ios', '3D Racer')).toBe('com.wasdengine.game.game-3d-racer')
    expect(nameIdentifier('android', '🚀 !!')).toBe('com.wasdengine.game.game')
    expect(nameIdentifier('macos', 'x'.repeat(100))).toBe(`com.wasdengine.game.${'x'.repeat(60)}`)
  })

  it('gives games whose names differ only in letters without an ASCII form different identifiers', () => {
    expect(nameIdentifier('android', '游戏')).toBe('com.wasdengine.game.game_847c5f68')
    expect(nameIdentifier('android', ' 游戏 ')).toBe('com.wasdengine.game.game_847c5f68')
    expect(nameIdentifier('macos', '游戏')).toBe('com.wasdengine.game.game-847c5f68')
    expect(nameIdentifier('android', 'Space 射击')).toBe('com.wasdengine.game.space_5ef2fcce')
    expect(nameIdentifier('ios', 'Space 冒险')).toBe('com.wasdengine.game.space-2b34eb87')
    expect(nameIdentifier('android', 'Привет мир')).toBe('com.wasdengine.game.game_830d1964')
    expect(nameIdentifier('macos', `${'x'.repeat(100)} 游戏`)).toMatch(new RegExp(`^com\\.wasdengine\\.game\\.${'x'.repeat(60)}-[0-9a-f]{8}$`, 'u'))
  })

  it('makes a new identifier from the name and six random letters, which every platform accepts', () => {
    const android = newAppIdentifier('android', '3D Racer')
    const ios = newAppIdentifier('ios', '3D Racer')
    expect(android).toMatch(/^com\.wasdengine\.game\.game_3d_racer\.[a-z]{6}$/u)
    expect(ios).toMatch(/^com\.wasdengine\.game\.game-3d-racer\.[a-z]{6}$/u)
    expect(validAppIdentifier('android', android) && validAppIdentifier('ios', ios)).toBe(true)
    expect(new Set(Array.from({ length: 20 }, () => newAppIdentifier('macos', 'Tiny Farm'))).size).toBe(20)
    expect(nameIdentifier('macos', 'Tiny Farm')).toBe('com.wasdengine.game.tiny-farm')
  })

  it('keeps each platform\'s identifier in its own setting of the project\'s wasd_engine section', () => {
    expect(storedAppIdentifier(PROJECT, 'android')).toBeUndefined()
    const once = withAppIdentifier(PROJECT, 'android', 'com.wasdengine.game.tiny_farm.qwerty')
    expect(once).toBe(`${PROJECT}\n[${WASD_SETTINGS_SECTION}]\n\n${APP_IDENTIFIER_SETTINGS.android}="com.wasdengine.game.tiny_farm.qwerty"\n`)
    const both = withAppIdentifier(once, 'ios', 'com.studio.tiny-farm')
    expect(storedAppIdentifier(both, 'android')).toBe('com.wasdengine.game.tiny_farm.qwerty')
    expect(storedAppIdentifier(both, 'ios')).toBe('com.studio.tiny-farm')
    expect(storedAppIdentifier(both, 'macos')).toBeUndefined()
    // A new value replaces the old one in place, and other lines and line endings stay.
    const crlf = withAppIdentifier(both.replaceAll('\n', '\r\n'), 'ios', 'com.studio.farm')
    expect(crlf.split('\r\n').filter(line => line.startsWith(APP_IDENTIFIER_SETTINGS.ios))).toEqual([`${APP_IDENTIFIER_SETTINGS.ios}="com.studio.farm"`])
    expect(crlf).not.toMatch(/[^\r]\n/u)
    expect(storedAppIdentifier(crlf, 'android')).toBe('com.wasdengine.game.tiny_farm.qwerty')
  })

  it('refuses a kept value that the platform does not accept', () => {
    expect(validAppIdentifier('android', 'com.studio.3d_game')).toBe(false)
    expect(validAppIdentifier('android', 'com.studio.my-game')).toBe(false)
    expect(validAppIdentifier('ios', 'com.studio.my-game')).toBe(true)
    expect(validAppIdentifier('ios', 'game')).toBe(false)
    const bad = `${PROJECT}\n[${WASD_SETTINGS_SECTION}]\n\n${APP_IDENTIFIER_SETTINGS.android}="com.studio.my-game"\n`
    expect(() => storedAppIdentifier(bad, 'android')).toThrow('wasd_engine/export/android_package_name to "com.studio.my-game", which is not an Android package name')
    expect(() => storedAppIdentifier(`${PROJECT}\n[${WASD_SETTINGS_SECTION}]\n${APP_IDENTIFIER_SETTINGS.ios}=12\n`, 'ios')).toThrow('not an Apple bundle identifier')
  })
})
