/**
 * What a web page offers as reference images: the images it names for link previews (Open Graph, Twitter card,
 * `image_src`, and schema.org images), the video it plays, its title and site name, and the other images it shows.
 * The reader scans tags with regular expressions instead of building a document, which covers a head's meta tags and
 * a body's image tags, and reads only the HTML the server sent, before any script runs.
 * @module @deepseek-ai/dsh-art-references/src/html
 */

/** What one page offers. */
export interface PageMedia {
  /** The page's title, without extra white space; empty without one. */
  readonly title: string
  /** The site name the page gives; empty without one. */
  readonly site: string
  /** Images the page names for link previews, most important first. */
  readonly preview: readonly string[]
  /** Address of the video the page plays, when it names one. */
  readonly video?: string
  /** Other images the page shows, in page order: image tags, picture sources, video posters, and links to images. */
  readonly shown: readonly string[]
}

/** Longest title kept, in characters. */
const MAX_TITLE = 160

/** Extensions of linked files that are images. */
const IMAGE_LINK = /\.(?:png|jpe?g|gif|webp|avif)$/iu

/** Character references that pages use in addresses and titles. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
}

/**
 * Replace HTML character references with the characters they stand for.
 * @param text - attribute or element text.
 * @returns the text; unknown references stay as written.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole
  })
}

/**
 * The attributes of one start tag.
 * @param text - the tag's text after its name.
 * @returns the attributes by lowercase name; the first of a repeated name wins, and a bare attribute is empty.
 */
function attributes(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of text.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    const name = (match[1] as string).toLowerCase()
    if (!found.has(name)) found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''))
  }
  return found
}

/**
 * The address a `srcset` offers at the largest width or density.
 * @param srcset - the attribute.
 * @returns the address, or undefined for an empty set.
 */
export function largestSource(srcset: string): string | undefined {
  let best: { url: string; size: number } | undefined
  let at = 0
  // The HTML candidate grammar: an address runs to white space, and a comma ends an address only at its end, so
  // addresses that hold commas, such as image CDN transforms, stay whole.
  while (at < srcset.length) {
    while (at < srcset.length && /[\s,]/u.test(srcset.charAt(at))) at++
    if (at >= srcset.length) break
    const start = at
    while (at < srcset.length && !/\s/u.test(srcset.charAt(at))) at++
    let url = srcset.slice(start, at)
    let descriptor = ''
    if (url.endsWith(',')) {
      url = url.replace(/,+$/u, '')
    } else {
      const from = at
      while (at < srcset.length && srcset.charAt(at) !== ',') at++
      descriptor = srcset.slice(from, at).trim()
    }
    if (url === '') continue
    const parsed = Number.parseFloat(descriptor)
    // A set uses widths or densities, never both; a candidate without a descriptor is density 1.
    const size = descriptor === '' ? 1000 : descriptor.endsWith('w') ? parsed : parsed * 1000
    if (best === undefined || (Number.isFinite(size) && size > best.size)) best = { url, size: Number.isFinite(size) ? size : 0 }
  }
  return best?.url
}

/**
 * Resolve an address a page names against the page's base.
 * @param value - the address as written.
 * @param base - the page's base address.
 * @returns the absolute http or https address without its fragment, or undefined for any other address.
 */
function resolveAddress(value: string, base: URL): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || /^(?:data|blob|javascript):/iu.test(trimmed)) return undefined
  if (!URL.canParse(trimmed, base)) return undefined
  const url = new URL(trimmed, base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.hash = ''
  return url.href
}

/** Whether an image tag declares a size too small to be a reference, such as an icon or a tracking pixel. */
function declaredTiny(attrs: Map<string, string>): boolean {
  const width = Number.parseInt(attrs.get('width') ?? '', 10)
  const height = Number.parseInt(attrs.get('height') ?? '', 10)
  return (Number.isFinite(width) && width < 48) || (Number.isFinite(height) && height < 48)
}

/** Whether an address names a vector or icon file, which the tools never offer as a reference. */
function iconLike(address: string): boolean {
  const path = new URL(address).pathname.toLowerCase()
  return path.endsWith('.svg') || path.endsWith('.ico') || path.includes('favicon')
}

/** Most characters of one tag that the scan reads; a longer or unclosed tag is skipped. */
const MAX_TAG_CHARS = 8192

/** Elements whose content is text up to their end tag, never tags. */
const RAW_TEXT = new Set(['script', 'style', 'template', 'textarea', 'title', 'xmp'])

/** One start tag the scan found. */
interface StartTag {
  /** The tag's name, lowercased. */
  readonly name: string
  /** The tag's text after its name. */
  readonly attributes: string
  /** The text up to the element's end tag, for a raw-text element such as `title`; empty otherwise. */
  readonly content: string
}

/**
 * The start tags of an HTML text, in order, in one pass that reads each character a bounded number of times, so no
 * page can make the scan slow: comments and the content of raw-text elements such as scripts are skipped, and a tag
 * longer than {@link MAX_TAG_CHARS} or never closed is skipped along with the text it covers.
 * @param html - the text.
 * @returns the start tags.
 */
function* startTags(html: string): Generator<StartTag> {
  const lower = html.toLowerCase()
  let at = 0
  while (at < html.length) {
    const open = html.indexOf('<', at)
    if (open === -1) return
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4)
      if (close === -1) return
      at = close + 3
      continue
    }
    let cursor = open + 1
    const closing = html.charAt(cursor) === '/'
    if (closing) cursor++
    const nameStart = cursor
    while (cursor < html.length && /[a-z0-9-]/u.test(lower.charAt(cursor))) cursor++
    if (cursor === nameStart || !/[a-z]/u.test(lower.charAt(nameStart))) {
      at = open + 1
      continue
    }
    const name = lower.slice(nameStart, cursor)
    const limit = Math.min(html.length, cursor + MAX_TAG_CHARS)
    let quote = ''
    let end = cursor
    for (; end < limit; end++) {
      const character = html.charAt(end)
      if (quote !== '') {
        if (character === quote) quote = ''
      } else if (character === '"' || character === '\'') {
        quote = character
      } else if (character === '>') {
        break
      }
    }
    if (end >= limit) {
      // Unclosed or too long: skip the text read, so no character is read again from another start.
      at = limit
      continue
    }
    at = end + 1
    if (closing) continue
    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, at)
      const content = html.slice(at, close === -1 ? html.length : close)
      yield { name, attributes: html.slice(cursor, end), content }
      if (close === -1) return
      at = close
      continue
    }
    yield { name, attributes: html.slice(cursor, end), content: '' }
  }
}

/**
 * Read what a page offers as reference images.
 * @param html - the page's HTML.
 * @param page - the page's address, the base of relative addresses unless the page names another.
 * @param maxShown - most shown images to collect.
 * @returns the page's media.
 */
export function readPageMedia(html: string, page: URL, maxShown: number): PageMedia {
  let base = page
  let title = ''
  let headTitle = ''
  let site = ''
  let video: string | undefined
  const preview: string[] = []
  const schemaImages: string[] = []
  const shown: string[] = []
  const addShown = (value: string | undefined): void => {
    if (value === undefined || shown.length >= maxShown) return
    const address = resolveAddress(value, base)
    if (address !== undefined && !iconLike(address) && !shown.includes(address)) shown.push(address)
  }
  for (const tag of startTags(html)) {
    const attrs = attributes(tag.attributes)
    switch (tag.name) {
      case 'title':
        if (headTitle === '') headTitle = decodeEntities(tag.content)
        break
      case 'base': {
        const href = attrs.get('href')
        if (href !== undefined && URL.canParse(href, page) && base === page) base = new URL(href, page)
        break
      }
      case 'meta': {
        const key = (attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop') ?? '').toLowerCase()
        const content = attrs.get('content') ?? ''
        if (content === '') break
        if (['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key)) {
          const address = resolveAddress(content, base)
          if (address !== undefined && !preview.includes(address)) preview.push(address)
        } else if (key === 'image' || key === 'thumbnailurl') {
          const address = resolveAddress(content, base)
          if (address !== undefined) schemaImages.push(address)
        } else if (video === undefined && ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player'].includes(key)) {
          video = resolveAddress(content, base)
        } else if (title === '' && (key === 'og:title' || key === 'twitter:title')) {
          title = content
        } else if (site === '' && key === 'og:site_name') {
          site = content
        }
        break
      }
      case 'link': {
        const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/u)
        const href = attrs.get('href')
        if (href !== undefined && (rel.includes('image_src') || (attrs.get('itemprop') ?? '').toLowerCase() === 'image')) {
          const address = resolveAddress(href, base)
          if (address !== undefined) schemaImages.push(address)
        }
        break
      }
      case 'img': {
        if (declaredTiny(attrs)) break
        const srcset = attrs.get('srcset') ?? attrs.get('data-srcset')
        addShown((srcset === undefined ? undefined : largestSource(srcset))
          ?? attrs.get('data-src') ?? attrs.get('data-lazy-src') ?? attrs.get('data-original') ?? attrs.get('src'))
        break
      }
      case 'source': {
        const srcset = attrs.get('srcset') ?? attrs.get('data-srcset')
        if (srcset !== undefined && !(attrs.get('type') ?? '').startsWith('video/')) addShown(largestSource(srcset))
        break
      }
      case 'video':
        addShown(attrs.get('poster'))
        break
      case 'a': {
        const href = attrs.get('href')
        if (href !== undefined && IMAGE_LINK.test(href.split(/[?#]/u)[0] ?? '')) addShown(href)
        break
      }
      default:
        break
    }
  }
  for (const address of schemaImages) if (!preview.includes(address)) preview.push(address)
  const clean = (value: string): string => {
    const collapsed = value.replace(/\s+/gu, ' ').trim()
    return collapsed.length <= MAX_TITLE ? collapsed : `${collapsed.slice(0, MAX_TITLE - 1).trimEnd()}…`
  }
  return {
    title: clean(title === '' ? headTitle : title),
    site: clean(site),
    preview: preview.filter(address => !iconLike(address)),
    ...video === undefined ? {} : { video },
    shown: shown.filter(address => !preview.includes(address)),
  }
}

/**
 * Decode an HTML body with the character set its `Content-Type` header or its first bytes name.
 * @param body - the bytes.
 * @param contentType - the `Content-Type` header; empty without one.
 * @returns the text, decoded as UTF-8 when the named set is unknown.
 */
export function decodeHtml(body: Buffer, contentType: string): string {
  const named = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/iu.exec(body.subarray(0, 2048).toString('latin1'))?.[1]
  try {
    return new TextDecoder(named ?? 'utf-8').decode(body)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    // RangeError: the page names a character set TextDecoder does not know.
    return new TextDecoder('utf-8').decode(body)
  }
}
