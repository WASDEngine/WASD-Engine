/**
 * Plain text of SuperCollider's SCDoc help files (`.schelp`) for the agent: the header tags become labeled lines,
 * section and method tags become headings, inline markup becomes its text, and code blocks keep their lines.
 *
 * @module
 */

/** Tags whose line the condensed text leaves out: they carry no reading text. */
const DROPPED = new Set(['private', 'copymethod', 'keyword', 'anchor', 'image', 'classtree', 'redirect'])

/** Section tags and the heading each one becomes. */
const SECTIONS: Readonly<Record<string, string>> = {
  description: 'Description:',
  classmethods: 'Class methods:',
  instancemethods: 'Instance methods:',
  examples: 'Examples:',
}

/** Tags that open a list or table, which a `::` line closes. */
const LISTS = new Set(['list', 'numberedlist', 'definitionlist', 'table', 'tree'])

/** Text of a link target: its label, or the last part of its path and its anchor, such as `Osc` or `Env.perc`. */
function linkText(target: string): string {
  const [path = '', anchor, label] = target.split('#')
  if (label !== undefined && label !== '') return label
  const name = path.split('/').pop() ?? path
  return anchor === undefined || anchor === '' ? name : name === '' ? anchor.replace(/^[-*.]/u, '') : `${name}.${anchor.replace(/^[-*.]/u, '')}`
}

/** A line with its inline markup replaced by text. */
function inline(line: string): string {
  return line
    .replace(/\blink::(.*?)::/giu, (_match, target: string) => linkText(target))
    .replace(/\b(?:code|emphasis|strong|soft|teletype|math)::(.*?)::/giu, '$1')
    .replace(/\b(?:note|warning)::(.*?)::/giu, 'Note: $1')
    .replace(/\bfootnote::(.*?)::/giu, '($1)')
    .replace(/\b(?:note|warning)::/giu, 'Note: ')
    .replace(/^\s*##\s*/u, '- ')
    .replaceAll('||', ' | ')
}

/** A tag that starts a line, such as `method::` or `Description::`, and the text after it. */
function lineTag(line: string): { readonly tag: string; readonly rest: string } | undefined {
  const match = /^\s*([A-Za-z]+)::(.*)$/u.exec(line)
  return match === null ? undefined : { tag: (match[1] ?? '').toLowerCase(), rest: (match[2] ?? '').trim() }
}

/**
 * The summary line of a help file.
 * @param text - the help file.
 * @returns its `summary::` text without markup, or undefined when it has none.
 */
export function helpSummary(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const tag = lineTag(line)
    if (tag?.tag === 'summary' && tag.rest !== '') return inline(tag.rest).trim()
  }
  return undefined
}

/**
 * Plain text of a help file, at most `limit` characters.
 * @param text - the help file.
 * @param limit - most characters returned, including the notice that counts what was cut.
 * @returns the condensed text; a longer text ends with `[help truncated: <n> more characters]`.
 */
export function condenseHelp(text: string, limit: number): string {
  const out: string[] = []
  let code = false
  for (const raw of text.split(/\r?\n/u)) {
    if (code) {
      if (raw.trim() === '::') code = false
      else out.push(`  ${raw}`)
      continue
    }
    const tag = lineTag(raw)
    if (tag === undefined) {
      out.push(raw.trim() === '::' ? '' : inline(raw.trim()))
      continue
    }
    const rest = inline(tag.rest)
    switch (tag.tag) {
      case 'class':
      case 'title':
        out.push(rest)
        break
      case 'summary':
        out.push(`Summary: ${rest}`)
        break
      case 'related':
        out.push(`Related: ${tag.rest.split(',').map(target => linkText(target.trim())).join(', ')}`)
        break
      case 'categories':
        out.push(`Categories: ${rest}`)
        break
      case 'section':
      case 'subsection':
        out.push('', `${rest}:`)
        break
      case 'method':
        out.push('', rest)
        break
      case 'argument':
        out.push(`  ${rest}:`)
        break
      case 'returns':
        out.push(`  Returns: ${rest}`)
        break
      case 'discussion':
        out.push(`  Discussion: ${rest}`)
        break
      case 'code':
        // A code tag alone on its line opens a block that a `::` line closes.
        if (tag.rest === '') code = true
        else out.push(inline(raw.trim()))
        break
      default:
        if (DROPPED.has(tag.tag)) break
        if (Object.hasOwn(SECTIONS, tag.tag)) out.push('', SECTIONS[tag.tag] ?? '')
        else if (LISTS.has(tag.tag)) out.push(rest)
        else out.push(inline(raw.trim()))
    }
  }
  const condensed = out.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
  if (condensed.length <= limit) return condensed
  const notice = (omitted: number): string => `\n[help truncated: ${String(omitted)} more characters]`
  const kept = Math.max(0, limit - notice(condensed.length).length)
  return condensed.slice(0, kept) + notice(condensed.length - kept)
}
