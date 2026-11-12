/**
 * 2D animations: Godot's text scenes and resources (SpriteFrames with atlas regions, Sprite2D grids with and without
 * AnimationPlayer frame tracks, Godot 3 syntax), sprite sheet JSON from Aseprite and TexturePacker, numbered image
 * sequences, grids, strip guesses, unique names, frame sampling, and the details the agent reads.
 */
import { describe, expect, it } from 'vitest'
import { godotAnimations, GodotParseError, parseGodotText, workspacePathOf } from '../src/client/godot.ts'
import {
  animationDetails, godotProjectOf, godotSpriteAnimations, gridAnimation, gridRegions, ownFramesAnimation, sampledFrames,
  sequenceAnimation, sheetAnimations, stripGuess, uniqueNames,
} from '../src/client/sprites.ts'

/** A Godot 4 scene: an AnimatedSprite2D with embedded SpriteFrames over atlas regions, and an animated Sprite2D grid. */
const PLAYER_TSCN = `[gd_scene load_steps=8 format=3 uid="uid://b6x2"]

[ext_resource type="Texture2D" uid="uid://c1" path="res://art/hero.png" id="1_hero"]
[ext_resource type="Texture2D" path="res://art/coin.png" id="2_coin"]

[sub_resource type="AtlasTexture" id="AtlasTexture_a"]
atlas = ExtResource("1_hero")
region = Rect2(0, 0, 32, 32)

[sub_resource type="AtlasTexture" id="AtlasTexture_b"]
atlas = ExtResource("1_hero")
region = Rect2(32, 0, 32, 32)

[sub_resource type="SpriteFrames" id="SpriteFrames_q"]
animations = [{
"frames": [{
"duration": 1.0,
"texture": SubResource("AtlasTexture_a")
}, {
"duration": 2.0,
"texture": SubResource("AtlasTexture_b")
}],
"loop": true,
"name": &"run",
"speed": 10.0
}, {
"frames": [],
"loop": true,
"name": &"empty",
"speed": 5.0
}]

[sub_resource type="Animation" id="Animation_spin"]
resource_name = "spin"
length = 0.6
loop_mode = 1
tracks/0/type = "value"
tracks/0/path = NodePath("Coin:frame")
tracks/0/keys = {
"times": PackedFloat32Array(0, 0.2, 0.4),
"transitions": PackedFloat32Array(1, 1, 1),
"update": 1,
"values": [0, 1, 3]
}

[sub_resource type="AnimationLibrary" id="AnimationLibrary_l"]
_data = {
&"spin": SubResource("Animation_spin")
}

[node name="Player" type="CharacterBody2D"]

[node name="AnimatedSprite2D" type="AnimatedSprite2D" parent="."]
sprite_frames = SubResource("SpriteFrames_q")
animation = &"run"

[node name="Coin" type="Sprite2D" parent="."]
texture = ExtResource("2_coin")
hframes = 4

[node name="Torch" type="Sprite2D" parent="."]
texture = ExtResource("1_hero")
hframes = 2
vframes = 2

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries = {
&"": SubResource("AnimationLibrary_l")
}
`

/** A Godot 3 SpriteFrames resource with whole-texture frames. */
const GODOT3_TRES = `[gd_resource type="SpriteFrames" load_steps=3 format=2]

[ext_resource path="res://art/walk_1.png" type="Texture" id=1]
[ext_resource path="res://art/walk_2.png" type="Texture" id=2]

[resource]
animations = [ {
"frames": [ ExtResource( 1 ), ExtResource( 2 ) ],
"loop": false,
"name": "walk",
"speed": 4.0
} ]
`

describe('Godot text resources', () => {
  it('parses sections, attributes, and the variant syntax of values', () => {
    const sections = parseGodotText('[gd_resource type="X" format=3]\n; a comment\n[resource]\nvalue = {\n"list": [1, -2.5, 1e3, true, null, &"name", ^"path"],\n"call": Vector2(1, 2),\n"typed": Array[int]([4, 5])\n}\n')
    expect(sections.map(section => section.tag)).toEqual(['gd_resource', 'resource'])
    expect(sections[0]?.attributes.get('format')).toBe(3)
    const value = sections[1]?.properties.get('value')
    expect(value).toEqual({
      kind: 'dict',
      entries: new Map<string, unknown>([
        ['list', [1, -2.5, 1000, true, null, 'name', 'path']],
        ['call', { kind: 'call', name: 'Vector2', args: [1, 2] }],
        ['typed', { kind: 'call', name: 'Array', args: [[4, 5]] }],
      ]),
    })
    expect(() => parseGodotText('[resource]\nvalue = [1, 2')).toThrow(GodotParseError)
    expect(() => parseGodotText('stray = 1')).toThrow('a property before the first section')
  })

  it('finds SpriteFrames animations over atlas regions, animated Sprite2D grids, and grids without an animation', () => {
    const animations = godotAnimations(PLAYER_TSCN)
    expect(animations.map(animation => animation.name)).toEqual(['run', 'spin', 'Torch frames'])
    expect(animations[0]).toEqual({
      name: 'run',
      loop: true,
      frames: [
        { texture: 'res://art/hero.png', region: { x: 0, y: 0, width: 32, height: 32 }, seconds: 0.1 },
        { texture: 'res://art/hero.png', region: { x: 32, y: 0, width: 32, height: 32 }, seconds: 0.2 },
      ],
    })
    const spin = animations[1]
    expect(spin?.frames.map(frame => [frame.cell?.index, Number(frame.seconds.toFixed(3))])).toEqual([[0, 0.2], [1, 0.2], [3, 0.2]])
    expect(spin?.loop).toBe(true)
    expect(animations[2]?.frames).toHaveLength(4)
  })

  it('reads Godot 3 resources whose frames are whole textures', () => {
    expect(godotAnimations(GODOT3_TRES)).toEqual([{
      name: 'walk',
      loop: false,
      frames: [{ texture: 'res://art/walk_1.png', seconds: 0.25 }, { texture: 'res://art/walk_2.png', seconds: 0.25 }],
    }])
  })

  it('resolves res:// paths against the folder holding project.godot', () => {
    expect(workspacePathOf('res://art/hero.png', '')).toBe('art/hero.png')
    expect(workspacePathOf('res://art/hero.png', 'game')).toBe('game/art/hero.png')
    expect(workspacePathOf('uid://x', '')).toBeUndefined()
    expect(godotProjectOf('game/scenes/a.tscn', ['', 'game'])).toBe('game')
    expect(godotProjectOf('other/a.tscn', ['game'])).toBe('')
  })

  it('turns the animations that show an image into playable frames, Sprite2D cells into regions', () => {
    const files = [{ path: 'game/scenes/player.tscn', text: PLAYER_TSCN }, { path: 'game/broken.tres', text: '[resource' }]
    const hero = godotSpriteAnimations(files, 'game/art/hero.png', ['game'], { width: 64, height: 64 })
    expect(hero.map(animation => [animation.name, animation.definedIn, animation.frames.length])).toEqual([
      ['run', 'game/scenes/player.tscn', 2],
      ['Torch frames', 'game/scenes/player.tscn', 4],
    ])
    expect(hero[1]?.frames[3]).toEqual({ path: 'game/art/hero.png', region: { x: 32, y: 32, width: 32, height: 32 }, durationMs: 200 })
    const coin = godotSpriteAnimations(files, 'game/art/coin.png', ['game'], { width: 64, height: 16 })
    expect(coin.map(animation => animation.name)).toEqual(['spin'])
    expect(coin[0]?.frames.map(frame => frame.region?.x)).toEqual([0, 16, 48])
  })
})

describe('sprite sheets, sequences, and grids', () => {
  it('reads Aseprite frame tags, directions, and durations', () => {
    const json = {
      frames: {
        'hero 0.aseprite': { frame: { x: 0, y: 0, w: 16, h: 16 }, duration: 100 },
        'hero 1.aseprite': { frame: { x: 16, y: 0, w: 16, h: 16 }, duration: 150 },
        'hero 2.aseprite': { frame: { x: 32, y: 0, w: 16, h: 16 }, duration: 100 },
      },
      meta: { image: 'hero.png', frameTags: [{ name: 'idle', from: 0, to: 1, direction: 'forward' }, { name: 'bob', from: 0, to: 2, direction: 'pingpong' }] },
    }
    const animations = sheetAnimations(json, 'art/hero.png', 'art/hero.json')
    expect(animations.map(animation => [animation.name, animation.frames.map(frame => frame.region?.x)])).toEqual([
      ['idle', [0, 16]],
      ['bob', [0, 16, 32, 16]],
    ])
    expect(animations[0]?.frames[1]?.durationMs).toBe(150)
    // TexturePacker's list without tags plays every frame under the image's name; another image's sheet adds nothing.
    expect(sheetAnimations({ frames: [{ frame: { x: 0, y: 0, w: 8, h: 8 } }] }, 'a/coin.png', 'a/coin.json').map(animation => animation.name)).toEqual(['coin'])
    expect(sheetAnimations({ ...json, meta: { image: 'other.png' } }, 'art/hero.png', 'art/hero.json')).toEqual([])
    expect(sheetAnimations('nope', 'art/hero.png', 'art/hero.json')).toEqual([])
  })

  it('finds numbered images in number order', () => {
    const siblings = ['fx/boom_10.png', 'fx/boom_2.png', 'fx/boom_1.png', 'fx/boom_1.txt', 'fx/other_1.png', 'fx/sub/boom_3.png']
    const sequence = sequenceAnimation('fx/boom_2.png', siblings, 10)
    expect(sequence).toMatchObject({ name: 'boom', source: 'sequence', definedIn: 'fx/', loop: true })
    expect(sequence?.frames.map(frame => [frame.path, frame.durationMs])).toEqual([['fx/boom_1.png', 100], ['fx/boom_2.png', 100], ['fx/boom_10.png', 100]])
    expect(sequenceAnimation('fx/boom.png', siblings)).toBeUndefined()
    expect(sequenceAnimation('fx/other_1.png', siblings)).toBeUndefined()
  })

  it('cuts grids into cells, guesses strips of square frames, and samples frames evenly', () => {
    expect(gridRegions(100, 50, { columns: 4, rows: 2, count: 6 }).map(region => [region.x, region.y, region.width, region.height]))
      .toEqual([[0, 0, 25, 25], [25, 0, 25, 25], [50, 0, 25, 25], [75, 0, 25, 25], [0, 25, 25, 25], [25, 25, 25, 25]])
    expect(gridRegions(2, 2, { columns: 4, rows: 1 })).toEqual([])
    expect(gridAnimation('a.png', 64, 16, { columns: 4, rows: 1 }, 8).frames.map(frame => frame.durationMs)).toEqual([125, 125, 125, 125])
    expect(stripGuess(128, 32)).toEqual({ columns: 4, rows: 1 })
    expect(stripGuess(32, 96)).toEqual({ columns: 1, rows: 3 })
    expect(stripGuess(100, 30)).toBeUndefined()
    expect(stripGuess(32, 32)).toBeUndefined()
    expect(sampledFrames([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4).map(entry => entry.index)).toEqual([0, 3, 6, 9])
    expect(sampledFrames([0, 1], 4).map(entry => entry.index)).toEqual([0, 1])
  })

  it('names repeated animations after their files, and reports details', () => {
    const unique = uniqueNames([
      { name: 'run', source: 'godot', definedIn: 'scenes/a.tscn', frames: [], loop: true },
      { name: 'run', source: 'godot', definedIn: 'scenes/b.tscn', frames: [], loop: true },
      { name: 'frames', source: 'frames', frames: [], loop: true },
    ])
    expect(unique.map(animation => animation.name)).toEqual(['run (a.tscn)', 'run (b.tscn)', 'frames'])
    const own = ownFramesAnimation('a.gif', [100, 100, 0, 200])
    expect(animationDetails(own, () => ({ width: 40, height: 30 }))).toEqual({
      name: 'frames', source: 'frames', frames: 4, fps: 8, seconds: 0.5, loop: true, frameWidth: 40, frameHeight: 30,
    })
    const mixed = gridAnimation('a.png', 64, 32, { columns: 2, rows: 1 })
    expect(animationDetails({ ...mixed, frames: [...mixed.frames, { path: 'b.png', durationMs: 1000 / 12 }] }, () => undefined)).not.toHaveProperty('frameWidth')
  })
})
