/**
 * Finding an image's 2D animations: the Godot files that show it are read several at a time, and the animations keep
 * the order of the listed files whichever read finishes first, so a numbered name always names the same animation.
 */
import { describe, expect, it } from 'vitest'
import { findAnimations, type AnimationSources } from '../src/client/animations2d.ts'

/** A Godot 4 scene whose SpriteFrames animation `walk` shows `res://art/hero.png`. */
const WALK_SCENE = `[gd_scene load_steps=3 format=3]

[ext_resource type="Texture2D" path="res://art/hero.png" id="1_hero"]

[sub_resource type="SpriteFrames" id="SpriteFrames_walk"]
animations = [{
"frames": [{
"duration": 1.0,
"texture": ExtResource("1_hero")
}],
"loop": true,
"name": &"walk",
"speed": 5.0
}]
`

/**
 * Sources whose Godot files are read with the given delays, in milliseconds.
 * @param delays - each listed file's delay.
 * @returns the sources.
 */
function delayed(delays: Readonly<Record<string, number>>): AnimationSources {
  return {
    async readText(path) {
      await new Promise((resolve) => { setTimeout(resolve, delays[path] ?? 0) })
      return WALK_SCENE
    },
    files: async () => [],
    godot: async () => ({ files: Object.keys(delays), projects: [''] }),
  }
}

describe('findAnimations', () => {
  it('names the animations of files read in any order the same way, in the order the files are listed', async () => {
    const find = async (delays: Readonly<Record<string, number>>) => {
      const found = await findAnimations('art/hero.png', { width: 16, height: 16 }, undefined, delayed(delays), new AbortController().signal)
      return found.map(animation => [animation.name, animation.definedIn])
    }
    const expected = [
      ['walk (player.tscn)', 'enemies/player.tscn'],
      ['walk (player.tscn) 2', 'heroes/player.tscn'],
      ['walk (player.tscn) 3', 'npcs/player.tscn'],
    ]
    // The first listed file's read finishes last, then first.
    expect(await find({ 'enemies/player.tscn': 30, 'heroes/player.tscn': 15, 'npcs/player.tscn': 0 })).toEqual(expected)
    expect(await find({ 'enemies/player.tscn': 0, 'heroes/player.tscn': 15, 'npcs/player.tscn': 30 })).toEqual(expected)
  })
})
