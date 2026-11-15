/**
 * Edits of `project.godot`, Godot's ConfigFile text, that enable and disable an add-on the way the editor's plugin
 * switch does: the `enabled` list of `[editor_plugins]`, the add-on's `[autoload]` entries, and its project settings.
 * Every other line, comment, and value stays byte for byte; values that span lines, such as input maps, are kept
 * whole. Godot reads keys and sections in any order, so new keys go at the end of their section and new sections at
 * the end of the file. An edit can be undone later in the file as it is then, keeping what others changed meanwhile.
 * @module @deepseek-ai/dsh-game-addons/src/project-file
 */

/** Section of the editor plugin list. */
const PLUGINS_SECTION = 'editor_plugins'

/** Key of the editor plugin list in {@link PLUGINS_SECTION}. */
const PLUGINS_KEY = 'enabled'

/** One `key=value` item with the lines its value spans. */
interface KeySpan {
  readonly key: string
  /** Index of the key's first line. */
  readonly start: number
  /** Index after the value's last line. */
  readonly end: number
  /** Value text after `=`, its lines joined with `\n`. */
  readonly value: string
}

/** One `[section]` and its keys; the empty name is the part before the first header. */
interface SectionSpan {
  readonly name: string
  /** Index of the `[section]` line, or -1 for the part before the first header. */
  readonly header: number
  /** Index after the section's last line. */
  end: number
  readonly keys: KeySpan[]
}

const SECTION_LINE = /^\[([^\]\r\n]+)\]\s*$/u
const KEY_LINE = /^([^=;\s[][^=]*?)\s*=(.*)$/u

/**
 * The bracket depth and string state after one more piece of value text.
 * @returns the depth, and whether the text ends inside a string.
 */
function track(text: string, depth: number, inString: boolean): { depth: number; inString: boolean } {
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth = Math.max(0, depth - 1)
  }
  return { depth, inString }
}

function scan(lines: readonly string[]): SectionSpan[] {
  const sections: SectionSpan[] = [{ name: '', header: -1, end: 0, keys: [] }]
  let index = 0
  while (index < lines.length) {
    const line = (lines[index] as string).replace(/\r$/u, '')
    const current = sections[sections.length - 1] as SectionSpan
    const header = SECTION_LINE.exec(line)
    if (header !== null) {
      current.end = index
      sections.push({ name: (header[1] as string).trim(), header: index, end: index + 1, keys: [] })
      index += 1
      continue
    }
    const item = KEY_LINE.exec(line)
    if (item === null) {
      index += 1
      current.end = index
      continue
    }
    const valueLines = [item[2] as string]
    let state = track(item[2] as string, 0, false)
    let end = index + 1
    while ((state.depth > 0 || state.inString) && end < lines.length) {
      const next = (lines[end] as string).replace(/\r$/u, '')
      valueLines.push(next)
      state = track(`\n${next}`, state.depth, state.inString)
      end += 1
    }
    current.keys.push({ key: (item[1] as string).trim(), start: index, end, value: valueLines.join('\n') })
    index = end
    current.end = end
  }
  return sections
}

/**
 * Godot's string literal for one text.
 * @param text - the text.
 * @returns the quoted literal, with backslashes and double quotes escaped.
 */
export function godotString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * The strings of a `PackedStringArray(...)` value.
 * @param value - the value text.
 * @returns its strings in order; empty for another kind of value.
 */
export function packedStrings(value: string): string[] {
  const match = /^\s*PackedStringArray\(([\s\S]*)\)\s*$/u.exec(value)
  if (match === null) return []
  const strings: string[] = []
  const literal = /"((?:[^"\\]|\\.)*)"/gu
  for (const found of (match[1] as string).matchAll(literal)) strings.push((found[1] as string).replace(/\\(.)/gu, '$1'))
  return strings
}

function packedStringArray(strings: readonly string[]): string {
  return `PackedStringArray(${strings.map(godotString).join(', ')})`
}

/** One entry of a Godot Dictionary literal: its key and value as their text. */
export interface DictionaryEntry {
  /** The key's literal, such as `"import_script/path"`. */
  readonly key: string
  /** The value's literal. */
  readonly value: string
}

/**
 * Split text at the characters a test picks outside strings and brackets.
 * @returns the parts between those characters.
 */
function splitTopLevel(text: string, at: (char: string) => boolean): string[] {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[' || char === '(') {
      depth += 1
    } else if (char === '}' || char === ']' || char === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && at(char)) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/**
 * The entries of a Godot Dictionary literal, as `project.godot` stores one on one line or several.
 * @param value - a value's text.
 * @returns the entries in order, or undefined for a value that is not a Dictionary literal.
 */
export function dictionaryEntries(value: string): DictionaryEntry[] | undefined {
  const text = value.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined
  const entries: DictionaryEntry[] = []
  for (const part of splitTopLevel(text.slice(1, -1), char => char === ',')) {
    if (part.trim() === '') continue
    const [key, ...rest] = splitTopLevel(part, char => char === ':')
    if (key === undefined || rest.length === 0) return undefined
    entries.push({ key: key.trim(), value: rest.join(':').trim() })
  }
  return entries
}

/**
 * A Godot Dictionary literal as Godot writes one into `project.godot`: one entry a line between the braces.
 * @param entries - the entries in order.
 * @returns the literal; `{}` without entries.
 */
export function dictionaryLiteral(entries: readonly DictionaryEntry[]): string {
  return entries.length === 0 ? '{}' : `{\n${entries.map(entry => `${entry.key}: ${entry.value}`).join(',\n')}\n}`
}

/** One key of a `project.godot` and its value text. */
export interface ProjectKey {
  /** Section name; empty for a key before the first section header. */
  readonly section: string
  /** Key within the section. */
  readonly key: string
  /** Value text after `=`, its lines joined with `\n`. */
  readonly value: string
}

/** One key whose value an edit of `project.godot` changed. */
export interface ProjectChange {
  /** Section name; empty for a key before the first section header. */
  readonly section: string
  /** Key within the section. */
  readonly key: string
  /** Value text before the edit; undefined when the key was absent. */
  readonly before: string | undefined
  /** Value text after the edit; undefined when the edit removed the key. */
  readonly after: string | undefined
}

/** A parsed `project.godot` that collects edits and renders the file again. */
export class ProjectFile {
  private lines: string[]
  private readonly newline: string
  private readonly finalNewline: boolean

  /**
   * @param text - the file's current text.
   */
  constructor(text: string) {
    this.newline = text.includes('\r\n') ? '\r\n' : '\n'
    this.finalNewline = text.endsWith('\n')
    const body = this.finalNewline ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text
    this.lines = body === '' ? [] : body.split(/\r?\n/u)
  }

  /**
   * The file's text after the edits.
   * @returns the edited text, with the original line endings.
   */
  toString(): string {
    return this.lines.join(this.newline) + (this.finalNewline || this.lines.length > 0 ? this.newline : '')
  }

  /**
   * One key's value text.
   * @param section - section name.
   * @param key - key within it.
   * @returns the value after `=`, or undefined when the key is absent.
   */
  get(section: string, key: string): string | undefined {
    const found = this.find(section, key)
    return found?.span.value
  }

  /**
   * Every key in file order, with its value; a key that appears again later keeps its first value, as {@link get}
   * reads it.
   * @returns the keys of every section, the part before the first header included.
   */
  keys(): ProjectKey[] {
    const seen = new Set<string>()
    const keys: ProjectKey[] = []
    for (const section of scan(this.lines)) {
      for (const span of section.keys) {
        const id = `${section.name}\n${span.key}`
        if (seen.has(id)) continue
        seen.add(id)
        keys.push({ section: section.name, key: span.key, value: span.value })
      }
    }
    return keys
  }

  /**
   * Set one key, replacing its value where it is, or adding it at the end of its section.
   * @param section - section name; created at the end of the file when absent.
   * @param key - key within it.
   * @param value - Godot value literal; a value that spans lines, as {@link get} returns one, keeps its lines.
   */
  set(section: string, key: string, value: string): void {
    const lines = `${key}=${value}`.split('\n')
    const found = this.find(section, key)
    if (found !== undefined) {
      this.lines.splice(found.span.start, found.span.end - found.span.start, ...lines)
      return
    }
    const target = scan(this.lines).find(candidate => candidate.name === section && candidate.header >= 0)
    if (target === undefined) {
      while (this.lines.length > 0 && (this.lines[this.lines.length - 1] as string).trim() === '') this.lines.pop()
      if (this.lines.length > 0) this.lines.push('')
      this.lines.push(`[${section}]`, '', ...lines)
      return
    }
    const lastKey = target.keys[target.keys.length - 1]
    const at = lastKey === undefined ? target.header + 1 : lastKey.end
    if (lastKey === undefined) {
      this.lines.splice(at, 0, '', ...lines)
      return
    }
    this.lines.splice(at, 0, ...lines)
  }

  /**
   * Remove one key, and its section when no key or comment is left in it.
   * @param section - section name.
   * @param key - key within it.
   * @returns whether the key existed.
   */
  remove(section: string, key: string): boolean {
    const found = this.find(section, key)
    if (found === undefined) return false
    this.lines.splice(found.span.start, found.span.end - found.span.start)
    const target = scan(this.lines).find(candidate => candidate.name === section && candidate.header >= 0)
    if (target !== undefined && target.keys.length === 0 && this.lines.slice(target.header + 1, target.end).every(line => line.trim() === '')) {
      // The header goes with the blank lines after it; the blank line before it stays as the next section's separator.
      this.lines.splice(target.header, target.end - target.header)
      if (target.header >= this.lines.length) {
        while (this.lines.length > 0 && (this.lines[this.lines.length - 1] as string).trim() === '') this.lines.pop()
      }
    }
    return true
  }

  /**
   * The editor plugins the project enables.
   * @returns the `res://` plugin configurations in `[editor_plugins] enabled`.
   */
  editorPlugins(): string[] {
    return packedStrings(this.get(PLUGINS_SECTION, PLUGINS_KEY) ?? '')
  }

  /**
   * Add a plugin configuration to `[editor_plugins] enabled`, keeping the others.
   * @param path - `res://` path of its `plugin.cfg`.
   * @returns whether the list changed.
   */
  enablePlugin(path: string): boolean {
    const plugins = this.editorPlugins()
    if (plugins.includes(path)) return false
    this.set(PLUGINS_SECTION, PLUGINS_KEY, packedStringArray([...plugins, path]))
    return true
  }

  /**
   * Remove a plugin configuration from `[editor_plugins] enabled`, and the key when the list becomes empty.
   * @param path - `res://` path of its `plugin.cfg`.
   * @returns whether the list changed.
   */
  disablePlugin(path: string): boolean {
    const plugins = this.editorPlugins()
    if (!plugins.includes(path)) return false
    const rest = plugins.filter(plugin => plugin !== path)
    if (rest.length === 0) this.remove(PLUGINS_SECTION, PLUGINS_KEY)
    else this.set(PLUGINS_SECTION, PLUGINS_KEY, packedStringArray(rest))
    return true
  }

  /**
   * The script or scene path of an autoload.
   * @param name - autoload name.
   * @returns its `res://` path without the `*` singleton mark, or undefined when absent.
   */
  autoload(name: string): string | undefined {
    const value = this.get('autoload', name)
    if (value === undefined) return undefined
    const match = /^\s*"\*?((?:[^"\\]|\\.)*)"\s*$/u.exec(value)
    return match === null ? undefined : (match[1] as string).replace(/\\(.)/gu, '$1')
  }

  /**
   * Add an autoload as a global singleton, as the editor's plugin switch does.
   * @param name - autoload name.
   * @param path - `res://` path of its script or scene.
   */
  addAutoload(name: string, path: string): void {
    this.set('autoload', name, godotString(`*${path}`))
  }

  private find(section: string, key: string): { readonly span: KeySpan } | undefined {
    for (const candidate of scan(this.lines)) {
      if (candidate.name !== section || (section !== '' && candidate.header < 0)) continue
      const span = candidate.keys.find(item => item.key === key)
      if (span !== undefined) return { span }
    }
    return undefined
  }
}

/**
 * The keys whose values differ between two texts of `project.godot`.
 * @param before - the text before an edit.
 * @param after - the text after it.
 * @returns each changed key with both values: the keys of `before` in its order, then the keys new in `after`.
 */
export function projectChanges(before: string, after: string): ProjectChange[] {
  const id = (item: ProjectKey): string => `${item.section}\n${item.key}`
  const old = new ProjectFile(before).keys()
  const next = new Map(new ProjectFile(after).keys().map(item => [id(item), item]))
  const changes: ProjectChange[] = []
  for (const item of old) {
    const value = next.get(id(item))?.value
    next.delete(id(item))
    if (value !== item.value) changes.push({ section: item.section, key: item.key, before: item.value, after: value })
  }
  for (const item of next.values()) changes.push({ section: item.section, key: item.key, before: undefined, after: item.value })
  return changes
}

/**
 * Undo an edit of `project.godot` in the file as it is now. When nobody changed the file since the edit, the text
 * before the edit comes back byte for byte. Otherwise only the keys that the edit changed go back, each only while it
 * still holds the value the edit gave it, and the editor plugin list loses the plugins that the edit added and regains
 * those it removed, whatever other plugins it holds; what others changed stays.
 * @param current - the file's current text.
 * @param before - the text before the edit.
 * @param after - the text the edit wrote.
 * @returns the text with the edit undone.
 */
export function revertEdit(current: string, before: string, after: string): string {
  if (current === after) return before
  const project = new ProjectFile(current)
  for (const change of projectChanges(before, after).reverse()) {
    if (change.section === PLUGINS_SECTION && change.key === PLUGINS_KEY) {
      const old = packedStrings(change.before ?? '')
      const edited = packedStrings(change.after ?? '')
      for (const plugin of edited) if (!old.includes(plugin)) project.disablePlugin(plugin)
      for (const plugin of old) if (!edited.includes(plugin)) project.enablePlugin(plugin)
      continue
    }
    if (project.get(change.section, change.key) !== change.after) continue
    if (change.before === undefined) project.remove(change.section, change.key)
    else project.set(change.section, change.key, change.before)
  }
  return project.toString()
}
