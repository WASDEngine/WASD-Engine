/**
 * The 2D animations that Godot scenes and resources define over an image: SpriteFrames animations (in a `.tres` file
 * or embedded in a `.tscn` scene, as AnimatedSprite2D uses them), whose frames are whole textures or AtlasTexture
 * regions, and Sprite2D frame grids (`hframes` × `vframes`), animated by the `frame` tracks of an AnimationPlayer's
 * animations or, without any, played cell by cell. The text resource format of Godot 4 (`format=3`) and Godot 3
 * (`format=2`) is parsed here: section headers, `key = value` properties, and the variant syntax of their values.
 */

/** One parsed variant value. Dictionaries keep their keys as text; constructor calls keep their arguments. */
export type GodotValue =
  | null
  | boolean
  | number
  | string
  | readonly GodotValue[]
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly GodotValue[] }
  | { readonly kind: 'dict'; readonly entries: ReadonlyMap<string, GodotValue> }

/** One `[tag attribute=value …]` section with its properties. */
export interface GodotSection {
  readonly tag: string
  readonly attributes: ReadonlyMap<string, GodotValue>
  readonly properties: ReadonlyMap<string, GodotValue>
}

/** A rectangle in pixels. */
export interface PixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One frame of a Godot 2D animation: a texture, a region of it, and how long it shows. */
export interface GodotFrame {
  /** `res://` path of the texture. */
  readonly texture: string
  /** The region of the texture, or undefined for the whole texture. */
  readonly region?: PixelRect
  /** The cell of a Sprite2D frame grid, which the image's size turns into a region. */
  readonly cell?: { readonly index: number; readonly columns: number; readonly rows: number }
  readonly seconds: number
}

/** One Godot 2D animation. */
export interface GodotAnimation {
  readonly name: string
  readonly frames: readonly GodotFrame[]
  readonly loop: boolean
}

/** A parse failure, with the line where the text stopped making sense. */
export class GodotParseError extends Error {
  /**
   * @param message - what went wrong.
   * @param line - one-based line of the failure.
   */
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`)
    this.name = 'GodotParseError'
  }
}

/** Frames per second of a Sprite2D grid without an animation, the default speed of Godot's SpriteFrames. */
export const GRID_FPS = 5

class Reader {
  position = 0

  constructor(private readonly text: string) {}

  get done(): boolean {
    return this.position >= this.text.length
  }

  line(at = this.position): number {
    let count = 1
    for (let index = 0; index < at && index < this.text.length; index += 1) if (this.text[index] === '\n') count += 1
    return count
  }

  peek(): string {
    return this.text[this.position] ?? ''
  }

  fail(message: string): never {
    throw new GodotParseError(message, this.line())
  }

  /** Skip spaces, line breaks, and `;` comments. */
  skip(): void {
    for (;;) {
      const character = this.peek()
      if (character === ';') {
        while (!this.done && this.peek() !== '\n') this.position += 1
      } else if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
        this.position += 1
      } else {
        return
      }
    }
  }

  expect(character: string): void {
    this.skip()
    if (this.peek() !== character) this.fail(`expected "${character}"`)
    this.position += 1
  }

  identifier(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.text.slice(this.position, this.position + 256))
    if (match === null) this.fail('expected a name')
    this.position += match[0].length
    return match[0]
  }

  string(): string {
    this.position += 1
    let out = ''
    for (;;) {
      if (this.done) this.fail('unterminated string')
      const character = this.text[this.position] ?? ''
      this.position += 1
      if (character === '"') return out
      if (character !== '\\') {
        out += character
        continue
      }
      const escaped = this.text[this.position] ?? ''
      this.position += 1
      if (escaped === 'n') out += '\n'
      else if (escaped === 't') out += '\t'
      else if (escaped === 'r') out += '\r'
      else if (escaped === 'u') {
        out += String.fromCharCode(Number.parseInt(this.text.slice(this.position, this.position + 4), 16))
        this.position += 4
      } else {
        out += escaped
      }
    }
  }

  value(): GodotValue {
    this.skip()
    const character = this.peek()
    if (character === '"') return this.string()
    if (character === '&' && this.text[this.position + 1] === '"') {
      this.position += 1
      return this.string()
    }
    if (character === '^' && this.text[this.position + 1] === '"') {
      this.position += 1
      return this.string()
    }
    if (character === '[') return this.list(']')
    if (character === '{') return this.dict()
    const number = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/u.exec(this.text.slice(this.position, this.position + 64))
    if (number !== null) {
      this.position += number[0].length
      return Number(number[0])
    }
    const name = this.identifier()
    switch (name) {
      case 'true': return true
      case 'false': return false
      case 'null': return null
      case 'inf': return Number.POSITIVE_INFINITY
      case 'inf_neg': return Number.NEGATIVE_INFINITY
      case 'nan': return Number.NaN
      default: break
    }
    this.skip()
    // A typed array, such as Array[int]([1, 2]) or Array[StringName]([&"a"]): its type is skipped.
    if (this.peek() === '[') {
      let depth = 0
      do {
        if (this.peek() === '[') depth += 1
        else if (this.peek() === ']') depth -= 1
        this.position += 1
      } while (depth > 0 && !this.done)
      this.skip()
    }
    if (this.peek() !== '(') return name
    this.position += 1
    const args: GodotValue[] = []
    this.skip()
    if (this.peek() === ')') {
      this.position += 1
      return { kind: 'call', name, args }
    }
    for (;;) {
      args.push(this.value())
      this.skip()
      if (this.peek() === ',') {
        this.position += 1
        continue
      }
      if (this.peek() === ')') {
        this.position += 1
        return { kind: 'call', name, args }
      }
      this.fail('expected "," or ")"')
    }
  }

  list(close: string): GodotValue[] {
    this.position += 1
    const items: GodotValue[] = []
    for (;;) {
      this.skip()
      if (this.peek() === close) {
        this.position += 1
        return items
      }
      items.push(this.value())
      this.skip()
      if (this.peek() === ',') this.position += 1
      else if (this.peek() !== close) this.fail(`expected "," or "${close}"`)
    }
  }

  dict(): GodotValue {
    this.position += 1
    const entries = new Map<string, GodotValue>()
    for (;;) {
      this.skip()
      if (this.peek() === '}') {
        this.position += 1
        return { kind: 'dict', entries }
      }
      const key = this.value()
      this.expect(':')
      entries.set(typeof key === 'string' ? key : JSON.stringify(key), this.value())
      this.skip()
      if (this.peek() === ',') this.position += 1
      else if (this.peek() !== '}') this.fail('expected "," or "}"')
    }
  }
}

/**
 * Parse a Godot text scene or resource.
 * @param text - the `.tscn` or `.tres` file.
 * @returns its sections in file order.
 * @throws {GodotParseError} when the text is not in Godot's text resource format.
 */
export function parseGodotText(text: string): GodotSection[] {
  const reader: Reader = new Reader(text)
  const sections: GodotSection[] = []
  let current: { tag: string; attributes: Map<string, GodotValue>; properties: Map<string, GodotValue> } | undefined
  for (;;) {
    reader.skip()
    if (reader.done) break
    if (reader.peek() === '[') {
      reader.position += 1
      reader.skip()
      const tag = reader.identifier()
      const attributes = new Map<string, GodotValue>()
      for (;;) {
        reader.skip()
        if (reader.peek() === ']') {
          reader.position += 1
          break
        }
        const key = reader.identifier()
        reader.expect('=')
        attributes.set(key, reader.value())
      }
      current = { tag, attributes, properties: new Map() }
      sections.push(current)
      continue
    }
    const key = /^[^\s=]+/u.exec(text.slice(reader.position, reader.position + 512))?.[0]
    if (key === undefined) reader.fail('expected a property')
    reader.position += key.length
    reader.expect('=')
    const value = reader.value()
    if (current === undefined) reader.fail('a property before the first section')
    current.properties.set(key, value)
  }
  return sections
}

function isCall(value: GodotValue | undefined, name?: string): value is { readonly kind: 'call'; readonly name: string; readonly args: readonly GodotValue[] } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value && value.kind === 'call' && (name === undefined || value.name === name)
}

function isDict(value: GodotValue | undefined): value is { readonly kind: 'dict'; readonly entries: ReadonlyMap<string, GodotValue> } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'kind' in value && value.kind === 'dict'
}

function numberOf(value: GodotValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The id a resource reference names: `ExtResource("1_ab")`, `ExtResource( 1 )`, or the SubResource form. */
function referenceId(value: GodotValue | undefined, kind: 'ExtResource' | 'SubResource'): string | undefined {
  if (!isCall(value, kind)) return undefined
  const id = value.args[0]
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

function rectOf(value: GodotValue | undefined): PixelRect | undefined {
  if (!isCall(value, 'Rect2') && !isCall(value, 'Rect2i')) return undefined
  const [x, y, width, height] = value.args.map(arg => numberOf(arg, Number.NaN))
  if ([x, y, width, height].some(part => part === undefined || !Number.isFinite(part))) return undefined
  if ((width ?? 0) <= 0 || (height ?? 0) <= 0) return undefined
  return { x: x ?? 0, y: y ?? 0, width: width ?? 0, height: height ?? 0 }
}

/** The items of a list value, or undefined for any other value. */
function listOf(value: GodotValue | undefined): readonly GodotValue[] | undefined {
  return Array.isArray(value) ? value as readonly GodotValue[] : undefined
}

/** Numbers of a packed array or a plain list. */
function numbersOf(value: GodotValue | undefined): number[] {
  const list = listOf(value)
  if (list !== undefined) return list.map(item => numberOf(item, Number.NaN)).filter(Number.isFinite)
  if (isCall(value)) return value.args.map(item => numberOf(item, Number.NaN)).filter(Number.isFinite)
  return []
}

/** The parsed parts of one file that animations refer to. */
interface Resolved {
  readonly external: ReadonlyMap<string, string>
  readonly sub: ReadonlyMap<string, GodotSection>
}

function resolveFile(sections: readonly GodotSection[]): Resolved {
  const external = new Map<string, string>()
  const sub = new Map<string, GodotSection>()
  for (const section of sections) {
    const id = section.attributes.get('id')
    const key = typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
    if (key === undefined) continue
    if (section.tag === 'ext_resource') {
      const path = section.attributes.get('path')
      if (typeof path === 'string') external.set(key, path)
    } else if (section.tag === 'sub_resource') {
      sub.set(key, section)
    }
  }
  return { external, sub }
}

/** The texture and region a SpriteFrames frame's `texture` names. */
function frameTexture(value: GodotValue | undefined, file: Resolved): Pick<GodotFrame, 'texture' | 'region'> | undefined {
  const external = referenceId(value, 'ExtResource')
  if (external !== undefined) {
    const texture = file.external.get(external)
    return texture === undefined ? undefined : { texture }
  }
  const sub = referenceId(value, 'SubResource')
  const atlas = sub === undefined ? undefined : file.sub.get(sub)
  if (atlas === undefined || atlas.attributes.get('type') !== 'AtlasTexture') return undefined
  const texture = file.external.get(referenceId(atlas.properties.get('atlas'), 'ExtResource') ?? '')
  if (texture === undefined) return undefined
  const region = rectOf(atlas.properties.get('region'))
  return region === undefined ? { texture } : { texture, region }
}

/** The animations of one SpriteFrames resource's `animations` list (Godot 4) or `frames` and `speed` (Godot 3). */
function spriteFramesAnimations(section: GodotSection, file: Resolved): GodotAnimation[] {
  const list = listOf(section.properties.get('animations'))
  if (list === undefined) return []
  const animations: GodotAnimation[] = []
  for (const item of list) {
    if (!isDict(item)) continue
    const name = item.entries.get('name')
    const speed = numberOf(item.entries.get('speed'), GRID_FPS)
    const frames: GodotFrame[] = []
    for (const frame of listOf(item.entries.get('frames')) ?? []) {
      // Godot 4 frames are dictionaries with a texture and a relative duration; Godot 3 frames are textures.
      const texture = frameTexture(isDict(frame) ? frame.entries.get('texture') : frame, file)
      if (texture === undefined) continue
      const duration = isDict(frame) ? numberOf(frame.entries.get('duration'), 1) : 1
      frames.push({ ...texture, seconds: speed > 0 ? duration / speed : 0 })
    }
    if (frames.length === 0) continue
    animations.push({ name: typeof name === 'string' && name !== '' ? name : 'default', frames, loop: item.entries.get('loop') !== false })
  }
  return animations
}

/** One `frame` track of an animation: the node it moves and its keys. */
interface FrameTrack {
  readonly node: string
  readonly times: readonly number[]
  readonly values: readonly number[]
}

/** An Animation sub-resource's name, length, loop, and `frame` tracks. */
interface FrameAnimation {
  readonly name: string | undefined
  readonly length: number
  readonly loop: boolean
  readonly tracks: readonly FrameTrack[]
}

/** The `frame` tracks of an Animation sub-resource, with its length and loop. */
function frameTracks(section: GodotSection): FrameAnimation {
  const tracks: FrameTrack[] = []
  for (let index = 0; ; index += 1) {
    const path = section.properties.get(`tracks/${index}/path`)
    if (path === undefined) break
    const target = isCall(path, 'NodePath') && typeof path.args[0] === 'string' ? path.args[0] : typeof path === 'string' ? path : ''
    const colon = target.lastIndexOf(':')
    if (colon < 0 || target.slice(colon + 1) !== 'frame') continue
    const keys = section.properties.get(`tracks/${index}/keys`)
    if (!isDict(keys)) continue
    const times = numbersOf(keys.entries.get('times'))
    const values = numbersOf(keys.entries.get('values'))
    if (times.length === 0 || times.length !== values.length) continue
    const node = target.slice(0, colon)
    tracks.push({ node: node.slice(node.lastIndexOf('/') + 1), times, values })
  }
  const name = section.properties.get('resource_name')
  return {
    name: typeof name === 'string' && name !== '' ? name : undefined,
    length: numberOf(section.properties.get('length'), 1),
    loop: numberOf(section.properties.get('loop_mode'), 0) !== 0 || section.properties.get('loop') === true,
    tracks,
  }
}

/** The names an AnimationLibrary gives its animations, by sub-resource id. */
function libraryNames(file: Resolved): Map<string, string> {
  const names = new Map<string, string>()
  for (const section of file.sub.values()) {
    if (section.attributes.get('type') !== 'AnimationLibrary') continue
    const data = section.properties.get('_data')
    if (!isDict(data)) continue
    for (const [name, value] of data.entries) {
      const id = referenceId(value, 'SubResource')
      if (id !== undefined) names.set(id, name)
    }
  }
  return names
}

/**
 * The 2D animations one Godot scene or resource defines.
 * @param text - the `.tscn` or `.tres` file.
 * @returns its SpriteFrames animations and Sprite2D grid animations, with `res://` texture paths.
 * @throws {GodotParseError} when the text is not in Godot's text resource format.
 */
export function godotAnimations(text: string): GodotAnimation[] {
  const sections = parseGodotText(text)
  const file = resolveFile(sections)
  const animations: GodotAnimation[] = []
  for (const section of sections) {
    const isFrames = (section.tag === 'sub_resource' && section.attributes.get('type') === 'SpriteFrames')
      || (section.tag === 'resource' && sections[0]?.attributes.get('type') === 'SpriteFrames')
    if (isFrames) animations.push(...spriteFramesAnimations(section, file))
  }
  // Sprite2D nodes that slice their texture into a grid, by node name.
  const grids = new Map<string, { readonly texture: string; readonly columns: number; readonly rows: number }>()
  for (const section of sections) {
    if (section.tag !== 'node' || section.attributes.get('type') !== 'Sprite2D') continue
    const columns = Math.max(1, Math.floor(numberOf(section.properties.get('hframes'), 1)))
    const rows = Math.max(1, Math.floor(numberOf(section.properties.get('vframes'), 1)))
    const texture = file.external.get(referenceId(section.properties.get('texture'), 'ExtResource') ?? '')
    const name = section.attributes.get('name')
    if (texture === undefined || typeof name !== 'string' || columns * rows < 2) continue
    grids.set(name, { texture, columns, rows })
  }
  if (grids.size === 0) return animations
  const names = libraryNames(file)
  const animated = new Set<string>()
  for (const [id, section] of file.sub) {
    if (section.attributes.get('type') !== 'Animation') continue
    const { name, length, loop, tracks } = frameTracks(section)
    for (const track of tracks) {
      const grid = grids.get(track.node)
      if (grid === undefined) continue
      animated.add(track.node)
      const frames: GodotFrame[] = track.times.map((time, index) => {
        const until = track.times[index + 1] ?? Math.max(length, time)
        const cell = Math.max(0, Math.min(grid.columns * grid.rows - 1, Math.round(track.values[index] ?? 0)))
        return { texture: grid.texture, cell: { index: cell, columns: grid.columns, rows: grid.rows }, seconds: Math.max(0, until - time) }
      }).filter(frame => frame.seconds > 0)
      if (frames.length === 0) continue
      animations.push({ name: name ?? names.get(id) ?? `${track.node} animation`, frames, loop })
    }
  }
  for (const [node, grid] of grids) {
    if (animated.has(node)) continue
    const frames = Array.from({ length: grid.columns * grid.rows }, (_, index): GodotFrame => ({
      texture: grid.texture, cell: { index, columns: grid.columns, rows: grid.rows }, seconds: 1 / GRID_FPS,
    }))
    animations.push({ name: `${node} frames`, frames, loop: true })
  }
  return animations
}

/**
 * The workspace path a `res://` path names.
 * @param resource - the `res://` path.
 * @param projectFolder - workspace path of the folder holding `project.godot`; empty for the workspace folder.
 * @returns the workspace path, or undefined for a path that is not `res://`.
 */
export function workspacePathOf(resource: string, projectFolder: string): string | undefined {
  if (!resource.startsWith('res://')) return undefined
  const inside = resource.slice('res://'.length).replace(/^\/+/u, '')
  return projectFolder === '' ? inside : `${projectFolder}/${inside}`
}
