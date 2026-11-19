/**
 * What a window's draw of a model costs, counted on the Host before `asset_view` asks a window to draw it, so that the
 * window's queue of pictures draws a heavy model alone: the files the model names that the window loads with it, and
 * the memory the window's loader allocates beyond its files as the files state it. A model's files are found as the
 * window finds them: a glTF model's buffers and images; an OBJ file's first material library and that library's
 * textures; an FBX file's textures in files of their own; and a Collada file's images. A named file counts only when
 * its real path lies inside the folder the window reads from, as the window's reads are confined. The memory counted
 * is that of each texture decoded, as its header states its pixels; a VOX file's meshes, as its voxels make them; and
 * an FBX file's nodes and arrays, as its node records state them. Reading a model's file is the expensive part, so its
 * findings are kept by path, size, and modification time, and at most {@link ModelCostLimits.parses} files are read at
 * once; the sizes of the files it names are read on every call.
 * @module @deepseek-ai/dsh-game-assets/src/model-cost
 */
import type { Stats } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ModelDecoder } from './formats.ts'
import { ByteCursor, exposedFaces, mtllibOf } from './model-files.ts'

/** Most distinct files counted for one model; the asset tools refuse a glTF model that names more. */
export const MAX_NAMED_FILES = 1024

/** Files whose sizes and headers are read at once. */
const STAT_CONCURRENCY = 16

/** The first bytes of a texture read to size it, as the window reads an image's header. */
const HEADER_BYTES = 256 * 1024

/** Bytes of each read while searching an OBJ or Collada file. */
const SEARCH_CHUNK = 1024 * 1024

/** Longest `library_images` text of a Collada file that is searched for image names. */
const MAX_LIBRARY_TEXT = 16 * 1024 * 1024

/** Memory one pixel of a texture takes decoded: RGBA, and for TGA the pixels three.js's decoder keeps beside it. */
const BYTES_PER_PIXEL = { image: 4, tga: 12 } as const

/** What the costs keep and how many files they read at once. */
export interface ModelCostLimits {
  /** Models and textures whose findings are kept, each. */
  readonly entries: number
  /** Model files read at once. */
  readonly parses: number
}

/**
 * The plugin's limits: the findings of the models a few agents look at in turn, and two model files read at once, so
 * that calls for many large models read them one after another instead of all at once.
 */
export const MODEL_COST_LIMITS: ModelCostLimits = { entries: 64, parses: 2 }

/** One model to count. */
export interface ModelCostFile {
  /** Absolute path of the model file. */
  readonly path: string
  readonly decoder: ModelDecoder
  /** Its size in bytes, which with `mtimeMs` names the version whose findings are kept. */
  readonly size: number
  readonly mtimeMs: number
  /** Absolute folder the window reads from, the model inside it. */
  readonly root: string
  /** Largest file the window reads; a larger model file counts nothing, since the window refuses it. */
  readonly maxBytes: number
}

/** What a window's draw of a model costs beyond its own file. */
export interface ModelCost {
  /** Distinct files the model names that may load with it, at most {@link MAX_NAMED_FILES} of which are counted. */
  readonly named: number
  /** The total size of the named files counted that exist inside the folder the window reads. */
  readonly namedBytes: number
  /** Memory the window's loader allocates beyond the files: textures decoded, VOX meshes, FBX nodes and arrays. */
  readonly memory: number
}

/** A file the model names. */
interface Named {
  /** Absolute path, resolved as the window resolves the name. */
  readonly path: string
  /** Whether the window decodes it as a texture. */
  readonly texture: boolean
}

/** What reading a model file finds, before the files it names are read. */
interface ModelFindings {
  readonly named: readonly Named[]
  /** Memory its loader allocates from the file alone. */
  readonly memory: number
}

const NOTHING: ModelFindings = { named: [], memory: 0 }

/** A URL scheme of two letters or more, which a Windows drive such as `C:` is not. */
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]+:/u

/** Whether a name is absolute on POSIX, on Windows with a drive, or as a UNC path, as the window tests it. */
function isAbsoluteName(name: string): boolean {
  return name.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(name) || name.startsWith('\\\\')
}

/**
 * The file a name a model stores loads from, as the window resolves it: a relative name against the model's folder,
 * an absolute name by its file name in that folder, a name that `..` leads out of the folder the window reads nothing,
 * and an embedded image, a web address, or any other URL nothing.
 * @param root - absolute folder the window reads from.
 * @param model - absolute path of the model, inside `root`.
 * @param reference - the name as the model stores it.
 * @returns the absolute path, or undefined for a name that loads no file.
 */
export function namedPath(root: string, model: string, reference: string): string | undefined {
  let decoded = reference
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    // URIError: a name with a stray `%` is a literal file name, as the window reads it.
  }
  if (URL_SCHEME.test(reference) || URL_SCHEME.test(decoded)) return undefined
  const inside = relative(root, model)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
  const segments = inside.split(sep).filter(segment => segment !== '' && segment !== '.')
  segments.pop()
  const slashed = decoded.replaceAll('\\', '/')
  const name = isAbsoluteName(decoded) ? slashed.slice(slashed.lastIndexOf('/') + 1) : slashed
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : join(root, ...segments)
}

/** The magic `glTF` that starts a GLB file, and the type of a GLB file's JSON chunk. */
const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK = 0x4e4f534a

/**
 * The JSON text of a glTF model as the window's loader finds it, whatever the file's name: a GLB file's JSON chunk,
 * the last one among its chunks up to the length its header states, read without its other chunks, or else the whole
 * file's text, a byte order mark dropped as the window drops it.
 * @param path - the model file.
 * @returns the text, or undefined where the loader finds none.
 */
async function gltfText(path: string): Promise<string | undefined> {
  const handle = await open(path)
  try {
    const { size } = await handle.stat()
    const read = async (position: number, length: number): Promise<Buffer | undefined> => {
      if (position + length > size) return undefined
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      return bytesRead === length ? buffer : undefined
    }
    const header = await read(0, 12)
    if (header === undefined || header.readUInt32LE(0) !== GLB_MAGIC) return new TextDecoder().decode(await handle.readFile())
    if (header.readUInt32LE(4) < 2) return undefined
    const contents = header.readUInt32LE(8) - 12
    let json: { start: number; length: number } | undefined
    for (let index = 0; index < contents;) {
      // Each chunk: its length, its type, then its bytes; reading past the file fails the loader.
      const chunk = await read(12 + index, 8)
      if (chunk === undefined) return undefined
      const length = chunk.readUInt32LE(0)
      const start = 12 + index + 8
      if (chunk.readUInt32LE(4) === GLB_JSON_CHUNK) {
        if (start + length > size) return undefined
        json = { start, length }
      }
      index += 8 + length
    }
    if (json === undefined) return undefined
    const text = await read(json.start, json.length)
    return text === undefined ? undefined : new TextDecoder().decode(text)
  } finally {
    await handle.close()
  }
}

/** The buffers and images a glTF model names, as the window loads them. */
async function gltfFindings(file: ModelCostFile): Promise<ModelFindings> {
  const text = await gltfText(file.path)
  if (text === undefined) return NOTHING
  const parsed: unknown = JSON.parse(text)
  const uris = (key: string): string[] => {
    const list: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, key) : undefined
    if (!Array.isArray(list)) return []
    return list.flatMap((entry: unknown) => {
      const uri: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'uri') : undefined
      return typeof uri === 'string' ? [uri] : []
    })
  }
  const named = (reference: string, texture: boolean): Named[] => {
    const path = namedPath(file.root, file.path, reference)
    return path === undefined ? [] : [{ path, texture }]
  }
  return { named: [...uris('buffers').flatMap(uri => named(uri, false)), ...uris('images').flatMap(uri => named(uri, true))], memory: 0 }
}

/**
 * Search a text file a chunk at a time, keeping the unfinished last line of each chunk for the next.
 * @param path - the file.
 * @param visit - called with each run of whole lines; returns true to stop.
 */
async function searchLines(path: string, visit: (text: string) => boolean): Promise<void> {
  const handle = await open(path)
  try {
    const decoder = new TextDecoder()
    const buffer = Buffer.alloc(SEARCH_CHUNK)
    // The pieces of an unfinished line, joined once it ends, so a long line is copied once rather than per chunk.
    let carried: string[] = []
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, SEARCH_CHUNK, null)
      const chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead > 0 })
      if (bytesRead === 0) {
        visit([...carried, chunk].join(''))
        return
      }
      const end = chunk.lastIndexOf('\n') + 1
      if (end === 0) {
        carried.push(chunk)
        continue
      }
      if (visit([...carried, chunk.slice(0, end)].join(''))) return
      carried = [chunk.slice(end)]
    }
  } finally {
    await handle.close()
  }
}

/** The characters JavaScript's `\s` matches. */
const WHITESPACE = /^\s$/u

/** The line terminators that end a line for a regular expression's `^` and `$` in multiline mode. */
function isLineBreak(character: string | undefined): boolean {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029'
}

/**
 * Whether only whitespace stands between the start of the line that holds `at` and `at`, as `^\s*` before it in
 * multiline mode requires. Each run of whitespace is scanned only from the text that follows it, so scanning every
 * candidate of a text takes linear time.
 * @param text - the text.
 * @param at - where the candidate starts.
 * @returns whether the candidate is the first thing on its line.
 */
function firstOnLine(text: string, at: number): boolean {
  for (let index = at - 1; index >= 0; index--) {
    const character = text[index]
    if (isLineBreak(character)) return true
    if (!WHITESPACE.test(character ?? '')) return false
  }
  return true
}

/** Where the whitespace that starts at `at` ends. */
function skipWhitespace(text: string, at: number): number {
  let index = at
  while (index < text.length && WHITESPACE.test(text[index] ?? '')) index++
  return index
}

/**
 * The first index at or after `from` of `tag` followed by a character that ends a word, as `<tag\b` matches it.
 * @param text - the text.
 * @param tag - the tag's opening, such as `<image`.
 * @param from - where the search starts.
 * @returns the index, or -1 when there is none.
 */
function tagStart(text: string, tag: string, from: number): number {
  for (let at = text.indexOf(tag, from); at >= 0; at = text.indexOf(tag, at + 1)) {
    if (!/^[A-Za-z0-9_]$/u.test(text[at + tag.length] ?? '')) return at
  }
  return -1
}

/**
 * The content of the first `<name ...>...</name>` element at or after `from`, as `/<name\b[^>]*>([\s\S]*?)<\/name>/u`
 * finds it, in linear time.
 * @param text - the text.
 * @param name - the element name.
 * @param from - where the search starts.
 * @returns the content and the index after the closing tag, or undefined when no element is complete.
 */
function elementContent(text: string, name: string, from: number): { content: string; next: number } | undefined {
  const start = tagStart(text, `<${name}`, from)
  if (start < 0) return undefined
  // A later start has no `>` or closing tag after it either when this one has none.
  const open = text.indexOf('>', start + name.length + 1)
  if (open < 0) return undefined
  const closing = `</${name}>`
  const close = text.indexOf(closing, open + 1)
  if (close < 0) return undefined
  return { content: text.slice(open + 1, close), next: close + closing.length }
}

/** The texture directives of an MTL file that three.js's MTLLoader loads, as it lowercases them. */
const MTL_MAPS: Readonly<Record<string, string>> = {
  map_kd: 'map', map_ks: 'specularMap', map_ke: 'emissiveMap', norm: 'normalMap', map_bump: 'bumpMap', bump: 'bumpMap', disp: 'displacementMap', map_d: 'alphaMap',
}

/**
 * The texture names of an MTL file as three.js's MTLLoader reads them: per material, the first value of each map type,
 * its options removed as the loader removes them.
 * @param text - the MTL file.
 * @returns the names, relative to the library's folder.
 */
export function mtlTextures(text: string): string[] {
  const names: string[] = []
  let maps = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const space = line.indexOf(' ')
    const key = (space >= 0 ? line.slice(0, space) : line).toLowerCase()
    const value = space >= 0 ? line.slice(space + 1).trim() : ''
    if (key === 'newmtl') {
      maps = new Set()
      continue
    }
    const map = Object.hasOwn(MTL_MAPS, key) ? MTL_MAPS[key] : undefined
    if (map === undefined || maps.has(map)) continue
    maps.add(map)
    const items = value.split(/\s+/u)
    for (const [option, count] of [['-bm', 2], ['-mm', 3], ['-s', 4], ['-o', 4]] as const) {
      const at = items.indexOf(option)
      if (at >= 0) items.splice(at, count)
    }
    const name = items.join(' ').trim()
    if (name !== '' && !/^https?:\/\//iu.test(name)) names.push(name)
  }
  return names
}

/** An OBJ file's first material library and its textures, as the window loads them. */
async function objFindings(file: ModelCostFile): Promise<ModelFindings> {
  let library: string | undefined
  await searchLines(file.path, (text) => {
    library = mtllibOf(text)
    return library !== undefined
  })
  if (library === undefined) return NOTHING
  const path = namedPath(file.root, file.path, library)
  if (path === undefined) return NOTHING
  const named: Named[] = [{ path, texture: false }]
  const info = await statOf(path)
  if (info === undefined || !info.isFile() || info.size > file.maxBytes) return { named, memory: 0 }
  const slashed = library.replaceAll('\\', '/')
  const folder = slashed.slice(0, slashed.lastIndexOf('/') + 1)
  for (const name of mtlTextures(await readFile(path, 'utf8'))) {
    const texture = namedPath(file.root, file.path, `${folder}${name}`)
    if (texture !== undefined) named.push({ path: texture, texture: true })
  }
  return { named, memory: 0 }
}

/** The characters XML's predefined entities stand for. */
const XML_ENTITIES: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', '\'']])

/** Text without its tags, as `text.replaceAll(/<[^>]*>/gu, '')` gives it, in linear time. */
function withoutTags(text: string): string {
  let kept = ''
  let at = 0
  for (;;) {
    const open = text.indexOf('<', at)
    const close = open < 0 ? -1 : text.indexOf('>', open + 1)
    if (close < 0) return kept + text.slice(at)
    kept += text.slice(at, open)
    at = close + 1
  }
}

/** The text of an XML element's content, as a DOM gives it: its tags removed and its character references decoded. */
function xmlText(content: string): string {
  return withoutTags(content).replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole, reference: string) => {
    const code = reference.startsWith('#x') || reference.startsWith('#X') ? Number.parseInt(reference.slice(2), 16) : reference.startsWith('#') ? Number(reference.slice(1)) : undefined
    if (code === undefined) return XML_ENTITIES.get(reference) ?? whole
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/**
 * The image names of a Collada file: the text of the first `init_from` of each `image` in its `library_images`
 * elements, as the window's loader reads them.
 */
async function daeFindings(file: ModelCostFile): Promise<ModelFindings> {
  const libraries: string[] = []
  let open: string | undefined
  let kept = 0
  await searchLines(file.path, (text) => {
    let rest = text
    for (;;) {
      if (open === undefined) {
        const start = rest.indexOf('<library_images')
        if (start < 0) return false
        open = ''
        rest = rest.slice(start)
      }
      const end = rest.indexOf('</library_images>')
      const part = end < 0 ? rest : rest.slice(0, end)
      kept += part.length
      open += part
      if (kept > MAX_LIBRARY_TEXT) return true
      if (end < 0) return false
      libraries.push(open)
      open = undefined
      rest = rest.slice(end)
    }
  })
  const named: Named[] = []
  for (const library of libraries) {
    for (let image = elementContent(library, 'image', 0); image !== undefined; image = elementContent(library, 'image', image.next)) {
      const init = elementContent(image.content, 'init_from', 0)
      const path = init === undefined ? undefined : namedPath(file.root, file.path, xmlText(init.content))
      if (path !== undefined) named.push({ path, texture: true })
    }
  }
  return { named, memory: 0 }
}

/** A position in a file's bytes that also reads text, which the window reads in these encodings. */
class Cursor extends ByteCursor {
  /**
   * @param data - the file.
   * @param at - where reading starts.
   */
  constructor(override readonly data: Buffer, at = 0) {
    super(data, at)
  }

  /** The text of the next bytes. */
  text(bytes: number, encoding: 'latin1' | 'utf8'): string {
    const start = this.at
    this.skip(bytes)
    return this.data.toString(encoding, start, start + bytes)
  }
}

/** Bytes the loader's objects take for each node of a binary FBX file: the node and its property list. */
const FBX_NODE_BYTES = 200

/** Memory a text FBX file's parse takes for each of its bytes. */
const FBX_TEXT_BYTES_PER_BYTE = 8

/** Bytes of each element of the FBX array property types. */
const FBX_ELEMENT_BYTES: Readonly<Record<string, number>> = { b: 1, c: 1, d: 8, f: 4, i: 4, l: 8 }

/** The binary header, `Kaydara FBX Binary  ` and a NUL. */
const FBX_MAGIC = 'Kaydara FBX Binary  \0'

/**
 * Walk a binary FBX file's nodes as three.js's FBXLoader reads them: the memory its nodes, arrays, raw properties, and
 * strings take, as their records state them, and its `Objects` › `Video` nodes, the images its textures load: a file
 * name, and embedded bytes when the file holds them.
 */
function fbxBinary(data: Buffer): { memory: number; videos: { name: string; content?: Buffer }[] } {
  const read = new Cursor(data, 23)
  const version = read.u32()
  if (version < 6400) return { memory: 0, videos: [] }
  const wide = version >= 7500
  let memory = 0
  const videos: { name: string; content?: Buffer }[] = []
  // The nodes whose children are being read, innermost last: their end offsets and names.
  const open: { end: number; name: string }[] = []
  let video: { relative?: string; file?: string; content?: Buffer } | undefined
  let videoDepth = -1
  // The loader stops before the footer: 160 bytes and up to 16 of padding before the end.
  const endOfContent = (): boolean => (data.byteLength % 16 === 0
    ? ((read.at + 160 + 16) & ~0xf) >= data.byteLength
    : read.at + 160 + 16 >= data.byteLength)
  for (;;) {
    const parent = open.at(-1)
    if (parent === undefined ? endOfContent() : parent.end <= read.at) {
      if (parent === undefined) break
      open.pop()
      if (open.length === videoDepth && video !== undefined) {
        const name = video.relative !== undefined && video.relative !== '' ? video.relative : video.file
        if (name !== undefined) videos.push(video.content === undefined ? { name } : { name, content: video.content })
        video = undefined
        videoDepth = -1
      }
      continue
    }
    const end = wide ? read.u64() : read.u32()
    const properties = wide ? read.u64() : read.u32()
    if (wide) read.u64()
    else read.u32()
    const name = read.text(read.u8(), 'latin1')
    if (end === 0) continue
    memory += FBX_NODE_BYTES
    const isVideo = name === 'Video' && open.length === 1 && open[0]?.name === 'Objects'
    const inVideo = video !== undefined && open.length === videoDepth + 1
    for (let index = 0; index < properties; index++) {
      const type = String.fromCharCode(read.u8())
      const scalar = { C: 1, Y: 2, F: 4, I: 4, D: 8, L: 8 }[type]
      if (scalar !== undefined) {
        read.skip(scalar)
      } else if (type === 'R' || type === 'S') {
        const length = read.u32()
        memory += type === 'S' ? length * 2 : length
        const start = read.at
        read.skip(length)
        if (inVideo && index === 0 && video !== undefined) {
          if (type === 'S' && name === 'RelativeFilename') video.relative = data.toString('utf8', start, read.at)
          else if (type === 'S' && name === 'Filename') video.file = data.toString('utf8', start, read.at)
          else if (type === 'R' && name === 'Content' && length > 0) video.content = data.subarray(start, read.at)
        }
      } else {
        const element = FBX_ELEMENT_BYTES[type]
        if (element === undefined) throw new Error(`an FBX property of the unknown type ${type}`)
        const length = read.u32()
        const encoding = read.u32()
        const compressed = read.u32()
        read.skip(encoding === 0 ? length * element : compressed)
        memory += (encoding === 0 ? 0 : compressed + length * element) + length * 8
      }
    }
    open.push({ end, name })
    if (isVideo) {
      video = {}
      videoDepth = open.length - 1
    }
  }
  return { memory, videos }
}

/**
 * The `Objects` › `Video` nodes of a text FBX file: each one's `RelativeFilename`, else its `Filename`, and whether it
 * holds embedded content.
 */
function fbxText(text: string): { name: string; embedded: boolean }[] {
  const openings: number[] = []
  for (let at = text.indexOf('Video:'); at >= 0; at = text.indexOf('Video:', at + 1)) {
    if (!firstOnLine(text, at)) continue
    // The node's `{` ends its header line.
    let brace = at + 'Video:'.length
    while (brace < text.length && text[brace] !== '{' && text[brace] !== '\n') brace++
    if (text[brace] !== '{') continue
    openings.push(brace)
    at = brace
  }
  // Each node's body runs to its matching `}`, found for every node in one pass; braces in quotes do not count.
  const wanted = new Set(openings)
  const ends = new Map<number, number>()
  const open: number[] = []
  let quoted = false
  for (let at = 0; at < text.length && ends.size < wanted.size; at++) {
    const character = text[at]
    if (character === '"') quoted = !quoted
    else if (!quoted && character === '{') open.push(at)
    else if (!quoted && character === '}') {
      const start = open.pop()
      if (start !== undefined && wanted.has(start)) ends.set(start, at)
    }
  }
  const videos: { name: string; embedded: boolean }[] = []
  for (const [index, brace] of openings.entries()) {
    // A body ends at the next node's header too, so bodies never overlap and reading them all takes linear time; a
    // file's Video nodes never nest, and one that never closes ends there or at the end of the file.
    const body = text.slice(brace + 1, Math.min(ends.get(brace) ?? text.length, openings[index + 1] ?? text.length))
    // The loader takes the relative name unless it is empty.
    const relativeName = quotedValue(body, 'RelativeFilename')
    const name = relativeName !== undefined && relativeName !== '' ? relativeName : quotedValue(body, 'Filename')
    if (name !== undefined && name !== '') videos.push({ name, embedded: hasContent(body) })
  }
  return videos
}

/**
 * The quoted value of the first `key: "value"` line of a text FBX node's body, as `^\s*key:\s*"([^"]*)"` finds it in
 * multiline mode, in linear time.
 */
function quotedValue(body: string, key: string): string | undefined {
  const label = `${key}:`
  for (let at = body.indexOf(label); at >= 0; at = body.indexOf(label, at + 1)) {
    if (!firstOnLine(body, at)) continue
    const quote = skipWhitespace(body, at + label.length)
    if (body[quote] !== '"') continue
    // Without a closing quote here, no later value has one either.
    const close = body.indexOf('"', quote + 1)
    return close < 0 ? undefined : body.slice(quote + 1, close)
  }
  return undefined
}

/** Whether a text FBX node's body has embedded content: a `Content:` line whose value starts a non-empty string. */
function hasContent(body: string): boolean {
  const label = 'Content:'
  for (let at = body.indexOf(label); at >= 0; at = body.indexOf(label, at + 1)) {
    if (!firstOnLine(body, at)) continue
    let quote = skipWhitespace(body, at + label.length)
    if (body[quote] === ',') quote = skipWhitespace(body, quote + 1)
    if (body[quote] === '"' && quote + 1 < body.length && body[quote + 1] !== '"') return true
  }
  return false
}

/** An FBX file's textures in files of their own, its embedded images, and the memory its parse takes. */
async function fbxFindings(file: ModelCostFile): Promise<ModelFindings> {
  const data = await readFile(file.path)
  const named = (name: string): Named[] => {
    // The loader keeps a file name's last segment after a backslash, and loads it from the model's folder.
    const path = namedPath(file.root, file.path, name.split('\\').pop() ?? name)
    return path === undefined ? [] : [{ path, texture: true }]
  }
  if (data.byteLength < FBX_MAGIC.length || data.toString('latin1', 0, FBX_MAGIC.length) !== FBX_MAGIC) {
    const videos = fbxText(data.toString('utf8'))
    const external = videos.filter(video => !video.embedded)
    return { named: external.flatMap(video => named(video.name)), memory: data.byteLength * FBX_TEXT_BYTES_PER_BYTE }
  }
  const { memory, videos } = fbxBinary(data)
  let embedded = 0
  for (const video of videos) if (video.content !== undefined) embedded += textureBytes(video.content, video.name)
  return { named: videos.filter(video => video.content === undefined).flatMap(video => named(video.name)), memory: memory + embedded }
}

/** Bytes a voxel mesh's quad takes while it is built and once it is geometry, as the window counts it. */
const VOX_QUAD_BYTES = 384

/** The longest side of a model the window meshes, and the cells it sweeps for one file. */
const VOX_MAX_SIDE = 256
const VOX_MAX_CELLS = VOX_MAX_SIDE ** 3

/**
 * The memory the window's VOX loader takes to mesh a file: a byte for each cell of each mesh's box and a quad for each
 * exposed face, a model counted once for each placement its scene graph makes. A file the window refuses, as larger
 * than MagicaVoxel makes, or cannot read, counts nothing.
 */
function voxMemory(data: Buffer): number {
  if (data.byteLength < 8 || data.toString('latin1', 0, 4) !== 'VOX ') return 0
  const models: { x: number; y: number; z: number; voxels: Buffer }[] = []
  const nodes = new Map<number, { models: number[]; children: number[]; transform?: number }>()
  const read = new Cursor(data, 8)
  const dict = (): void => {
    for (let count = read.u32(); count > 0; count--) {
      read.skip(read.u32())
      read.skip(read.u32())
    }
  }
  while (read.at < data.byteLength) {
    const id = read.text(4, 'latin1')
    const size = read.u32()
    read.u32()
    if (id === 'SIZE') {
      models.push({ x: read.u32(), y: read.u32(), z: read.u32(), voxels: Buffer.alloc(0) })
      read.skip(size - 12)
    } else if (id === 'XYZI') {
      const model = models.at(-1)
      if (model === undefined) return 0
      const count = read.u32()
      const start = read.at
      read.skip(count * 4)
      model.voxels = data.subarray(start, read.at)
    } else if (id === 'nTRN') {
      const node = read.u32()
      dict()
      const child = read.u32()
      read.skip(8)
      for (let frames = read.u32(); frames > 0; frames--) dict()
      nodes.set(node, { models: [], children: [], transform: child })
    } else if (id === 'nGRP') {
      const node = read.u32()
      dict()
      const children: number[] = []
      for (let count = read.u32(); count > 0; count--) children.push(read.u32())
      nodes.set(node, { models: [], children })
    } else if (id === 'nSHP') {
      const node = read.u32()
      dict()
      const shapes: number[] = []
      for (let count = read.u32(); count > 0; count--) {
        shapes.push(read.u32())
        dict()
      }
      nodes.set(node, { models: shapes, children: [] })
    } else {
      read.skip(size)
    }
  }
  const meshed = (id: number): { models: readonly number[]; children: readonly number[] } => {
    const node = nodes.get(id)
    if (node === undefined) throw new Error('a VOX node that the file does not hold')
    if (node.transform === undefined) return node
    const child = nodes.get(node.transform)
    return child !== undefined && child.transform === undefined && child.children.length === 0 && child.models.length === 1
      ? { models: child.models, children: [] }
      : { models: [], children: [node.transform] }
  }
  // Each node's sum over the meshes one build of it makes, its children summed first, without recursion.
  const sum = (value: (model: number) => number): number => {
    if (nodes.size === 0) return models.reduce((total, _, index) => total + value(index), 0)
    const sums = new Map<number, number>()
    const expanded = new Set<number>()
    const stack = [0]
    while (stack.length > 0) {
      const id = stack.at(-1) as number
      if (sums.has(id)) {
        stack.pop()
        continue
      }
      const { models: own, children } = meshed(id)
      if (!expanded.has(id)) {
        expanded.add(id)
        for (const child of children) {
          if (expanded.has(child) && !sums.has(child)) throw new Error('a VOX scene graph that leads back into itself')
          if (!sums.has(child)) stack.push(child)
        }
        continue
      }
      let total = 0
      for (const model of own) total += value(model)
      for (const child of children) total += sums.get(child) as number
      sums.set(id, total)
      stack.pop()
    }
    return sums.get(0) as number
  }
  const model = (index: number): { x: number; y: number; z: number; voxels: Buffer } => {
    const found = models[index]
    if (found === undefined) throw new Error('a VOX model that the file does not hold')
    if (Math.max(found.x, found.y, found.z) > VOX_MAX_SIDE) throw new RangeError('a VOX model larger than the window meshes')
    return found
  }
  const cells = sum((index) => {
    const { x, y, z } = model(index)
    return x * y * z
  })
  if (cells > VOX_MAX_CELLS) return 0
  const faces = new Map<number, number>()
  return cells + sum((index) => {
    let known = faces.get(index)
    if (known === undefined) {
      known = exposedFaces(model(index))
      faces.set(index, known)
    }
    return known * VOX_QUAD_BYTES
  })
}

/** A VOX file's meshes; a file the window cannot mesh fails there before it allocates, and finds nothing here. */
async function voxFindings(file: ModelCostFile): Promise<ModelFindings> {
  return { named: [], memory: voxMemory(await readFile(file.path)) }
}

/**
 * The pixels an image's header states, for the formats the window decodes models' textures in: PNG, JPEG, GIF, WebP,
 * and BMP by their content, and TGA by its name.
 * @param head - the image's first bytes.
 * @param name - its name; a `.tga` name reads the TGA header.
 * @returns width and height, or undefined for a header this reader does not read, which the window does not decode.
 */
export function imagePixels(head: Buffer, name: string): { width: number; height: number } | undefined {
  const sized = (width: number, height: number): { width: number; height: number } | undefined => (
    width >= 1 && height >= 1 ? { width, height } : undefined)
  if (/\.tga$/iu.test(name)) return head.byteLength >= 18 ? sized(head.readUInt16LE(12), head.readUInt16LE(14)) : undefined
  if (head.byteLength >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.toString('latin1', 12, 16) === 'IHDR') return sized(head.readUInt32BE(16), head.readUInt32BE(20))
  if (head.byteLength >= 10 && /^GIF8[79]a$/u.test(head.toString('latin1', 0, 6))) return sized(head.readUInt16LE(6), head.readUInt16LE(8))
  if (head.byteLength >= 26 && head.toString('latin1', 0, 2) === 'BM') return sized(Math.abs(head.readInt32LE(18)), Math.abs(head.readInt32LE(22)))
  if (head.byteLength >= 30 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = head.toString('latin1', 12, 16)
    if (chunk === 'VP8 ') return sized(head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L') {
      const bits = head.readUInt32LE(21)
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return sized(head.readUIntLE(24, 3) + 1, head.readUIntLE(27, 3) + 1)
    return undefined
  }
  if (head.byteLength >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let at = 2
    while (at + 9 <= head.byteLength) {
      if (head[at] !== 0xff) {
        at += 1
        continue
      }
      const marker = head[at + 1] ?? 0
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += marker === 0xff ? 1 : 2
        continue
      }
      // A start-of-frame marker; 0xC4, 0xC8, and 0xCC are tables in the same range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sized(head.readUInt16BE(at + 7), head.readUInt16BE(at + 5))
      }
      at += 2 + head.readUInt16BE(at + 2)
    }
  }
  return undefined
}

/**
 * The memory a texture takes decoded, from its first bytes.
 * @param head - the image's first bytes.
 * @param name - its name, whose extension picks TGA.
 * @returns the bytes; 0 for a header this reader does not read.
 */
function textureBytes(head: Buffer, name: string): number {
  const pixels = imagePixels(head, name)
  return pixels === undefined ? 0 : pixels.width * pixels.height * (/\.tga$/iu.test(name) ? BYTES_PER_PIXEL.tga : BYTES_PER_PIXEL.image)
}

/** Read a path's file information, or undefined when nothing readable is there. */
async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch {
    // ENOENT, ENOTDIR, or EACCES: nothing readable at the path.
    return undefined
  }
}

/** Whether a real path lies inside a real folder. */
function inside(folder: string, path: string): boolean {
  const within = relative(folder, path)
  return within !== '' && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)
}

/** A kept finding, by the version of the file it was found in. */
interface Kept<T> {
  readonly size: number
  readonly mtimeMs: number
  readonly value: Promise<T>
}

/** A map that keeps its last `entries` entries, the most recently used last. */
class Recent<T> {
  private readonly map = new Map<string, Kept<T>>()

  constructor(private readonly entries: number) {}

  get(key: string, size: number, mtimeMs: number): Promise<T> | undefined {
    const kept = this.map.get(key)
    if (kept === undefined) return undefined
    this.map.delete(key)
    if (kept.size !== size || kept.mtimeMs !== mtimeMs) return undefined
    this.map.set(key, kept)
    return kept.value
  }

  set(key: string, size: number, mtimeMs: number, value: Promise<T>): void {
    this.map.delete(key)
    this.map.set(key, { size, mtimeMs, value })
    for (const oldest of this.map.keys()) {
      if (this.map.size <= this.entries) break
      this.map.delete(oldest)
    }
  }
}

/**
 * Wait for a shared promise, or for the caller's signal.
 * @returns the promise's value; rejects with the signal's reason once it aborts.
 */
async function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([promise, aborted.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** The costs of the models the asset tools draw, with the findings of the files they read. */
export class ModelCosts {
  private readonly models: Recent<ModelFindings>
  private readonly textures: Recent<number>
  private running = 0
  private readonly waiting: (() => void)[] = []

  /** @param limits - findings kept and model files read at once. */
  constructor(private readonly limits: ModelCostLimits) {
    this.models = new Recent(limits.entries)
    this.textures = new Recent(limits.entries)
  }

  /**
   * What a window's draw of a model costs beyond its own file.
   * @param file - the model and the folder the window reads from.
   * @param signal - the call's cancellation; a file being read for another call goes on being read.
   * @returns the named files and the memory, nothing for a model whose file the window refuses or cannot read.
   */
  async cost(file: ModelCostFile, signal: AbortSignal): Promise<ModelCost> {
    if (file.size > file.maxBytes) return { named: 0, namedBytes: 0, memory: 0 }
    const key = `${file.decoder}\0${file.root}\0${file.path}`
    let findings = this.models.get(key, file.size, file.mtimeMs)
    if (findings === undefined) {
      findings = this.read(file)
      this.models.set(key, file.size, file.mtimeMs, findings)
    }
    const found = await until(findings, signal)
    const realRoot = await realpath(file.root).catch(() => file.root)
    const named = new Map<string, boolean>()
    for (const entry of found.named) named.set(entry.path, (named.get(entry.path) ?? false) || entry.texture)
    const counted = [...named].slice(0, MAX_NAMED_FILES)
    let namedBytes = 0
    let memory = found.memory
    for (let start = 0; start < counted.length; start += STAT_CONCURRENCY) {
      signal.throwIfAborted()
      const batch = counted.slice(start, start + STAT_CONCURRENCY)
      const sizes = await Promise.all(batch.map(async ([path, texture]) => await this.namedCost(path, texture, realRoot, file.maxBytes)))
      for (const size of sizes) {
        namedBytes += size.bytes
        memory += size.decoded
      }
    }
    return { named: named.size, namedBytes, memory }
  }

  /** One named file's size, and the memory it takes decoded when it is a texture; nothing for a file the window cannot read. */
  private async namedCost(path: string, texture: boolean, realRoot: string, maxBytes: number): Promise<{ bytes: number; decoded: number }> {
    const real = await realpath(path).catch(() => undefined)
    const info = real === undefined || !inside(realRoot, real) ? undefined : await statOf(real)
    if (real === undefined || info === undefined || !info.isFile() || info.size > maxBytes) return { bytes: 0, decoded: 0 }
    if (!texture) return { bytes: info.size, decoded: 0 }
    let decoded = this.textures.get(`${real}\0${path}`, info.size, info.mtimeMs)
    if (decoded === undefined) {
      decoded = readHead(real).then(head => textureBytes(head, path), () => 0)
      this.textures.set(`${real}\0${path}`, info.size, info.mtimeMs, decoded)
    }
    return { bytes: info.size, decoded: await decoded }
  }

  /** Read a model file's findings, at most {@link ModelCostLimits.parses} at once; a file that cannot be read finds nothing. */
  private async read(file: ModelCostFile): Promise<ModelFindings> {
    if (this.running >= this.limits.parses) await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    else this.running += 1
    try {
      switch (file.decoder) {
        case 'gltf': return await gltfFindings(file)
        case 'obj': return await objFindings(file)
        case 'fbx': return await fbxFindings(file)
        case 'dae': return await daeFindings(file)
        case 'vox': return await voxFindings(file)
        case 'stl':
        case 'ply':
          return NOTHING
        default: {
          const decoder: never = file.decoder
          throw new Error(`a model of the unknown decoder ${String(decoder)}`)
        }
      }
    } catch {
      // ENOENT, EACCES, SyntaxError, or RangeError: the window reports a file it cannot read, which costs it nothing.
      return NOTHING
    } finally {
      const next = this.waiting.shift()
      if (next === undefined) this.running -= 1
      else next()
    }
  }
}

/** A file's first {@link HEADER_BYTES}. */
async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path)
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
