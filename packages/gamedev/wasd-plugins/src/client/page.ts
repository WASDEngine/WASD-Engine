/**
 * Scripts the window runs in the page of a Browser tab for the agent's Browser tools. Each script is one function that
 * runs in the page's main world from its source text, through {@link pageScript}, so it reads nothing outside its own
 * body and its JSON argument. The page text numbers the controls it lists and keeps them, in that order, in a page
 * property the window names, so later scripts find control n of the latest text.
 */

/** Options of {@link snapshotPage}. */
export interface SnapshotOptions {
  /** Page property that keeps the numbered controls. */
  readonly key: string
  /** Most characters of text. */
  readonly maxChars: number
  /** Most elements visited. */
  readonly maxElements: number
  /** Whether the page has layout, so hidden elements can be told apart; false in tests without a renderer. */
  readonly layout: boolean
}

/** A page as text. */
export interface PageSnapshot {
  /** The page's title. */
  readonly title: string
  /** The page's address. */
  readonly url: string
  /** The visible text, with links as `[text](url)` and controls as `[n: kind "label"]`. */
  readonly text: string
  /** Whether a limit cut the text. */
  readonly truncated: boolean
}

/**
 * Render the page as text and number its controls. Links with an http(s) address appear as Markdown links; buttons,
 * fields, other links, and elements with a control role appear as `[n: kind "label"]`, with a field's value; headings,
 * list items, table rows, and preformatted blocks keep their structure.
 * @param options - the snapshot options.
 * @returns the page as text.
 */
export function snapshotPage(options: SnapshotOptions): PageSnapshot {
  const controls: Element[] = []
  const lines: string[] = []
  let line = ''
  let size = 0
  let visited = 0
  let truncated = false
  const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'CANVAS', 'AUDIO',
    'VIDEO', 'OBJECT', 'EMBED', 'MAP', 'IFRAME', 'FRAME', 'DATALIST', 'OPTION', 'TITLE'])
  const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV',
    'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'HR', 'LEGEND', 'MAIN', 'MENU', 'NAV',
    'OL', 'P', 'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'UL'])
  const ROLES: Record<string, string> = {
    button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio', switch: 'switch', tab: 'tab',
    menuitem: 'menuitem', menuitemcheckbox: 'menuitem', menuitemradio: 'menuitem', option: 'option',
    combobox: 'combobox', textbox: 'textbox', searchbox: 'searchbox', slider: 'slider',
  }
  const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'time',
    'datetime-local', 'month', 'week'])
  const collapse = (value: string): string => value.replace(/\s+/gu, ' ').trim()
  const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value
  const quote = (value: string): string => JSON.stringify(clip(collapse(value), 100))
  const push = (done: string): void => {
    if (done === '' || truncated) return
    if (size + done.length + 1 > options.maxChars) {
      truncated = true
      return
    }
    lines.push(done)
    size += done.length + 1
  }
  const flush = (): void => {
    push(collapse(line))
    line = ''
  }
  const token = (text: string): void => {
    if (line !== '' && !line.endsWith(' ')) line += ' '
    line += text
  }
  const visible = (element: Element): boolean => {
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false
    if (element instanceof HTMLInputElement && element.type === 'hidden') return false
    if (!options.layout) return true
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    return style.display === 'contents' || element.getClientRects().length > 0
  }
  const textOf = (element: Element): string =>
    collapse(options.layout && element instanceof HTMLElement ? element.innerText : element.textContent)
  const attribute = (element: Element, names: readonly string[]): string => {
    for (const name of names) {
      const value = element.getAttribute(name)
      if (value !== null && collapse(value) !== '') return value
    }
    return ''
  }
  const labelOf = (element: Element): string => {
    const aria = attribute(element, ['aria-label'])
    if (aria !== '') return aria
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const text = labelledBy.split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
      if (collapse(text) !== '') return text
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const labels = [...element.labels ?? []].map(label => label.textContent).join(' ')
      if (collapse(labels) !== '') return labels
      if (!(element instanceof HTMLSelectElement) && element.placeholder !== '') return element.placeholder
      if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) && element.value !== '') return element.value
      return attribute(element, ['title', 'alt', 'name'])
    }
    const text = textOf(element)
    if (text !== '') return text
    const named = attribute(element, ['title', 'alt'])
    if (named !== '') return named
    return element.querySelector('img[alt]')?.getAttribute('alt') ?? ''
  }
  const kindOf = (element: Element): string | undefined => {
    const role = element.getAttribute('role')
    if (role !== null && ROLES[role] !== undefined) return ROLES[role]
    if (element instanceof HTMLButtonElement || element.tagName === 'SUMMARY') return 'button'
    if (element instanceof HTMLSelectElement) return 'select'
    if (element instanceof HTMLTextAreaElement) return 'textbox'
    if (element instanceof HTMLInputElement) {
      if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button'
      if (element.type === 'checkbox' || element.type === 'radio') return element.type
      if (element.type === 'password') return 'password'
      if (element.type === 'range') return 'slider'
      if (element.type === 'file') return 'file'
      if (element.type === 'color') return 'color'
      return TEXT_INPUTS.has(element.type) ? 'textbox' : 'input'
    }
    if (element instanceof HTMLElement && element.isContentEditable && element.parentElement?.isContentEditable !== true) return 'textbox'
    if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) return 'link'
    return undefined
  }
  const control = (element: Element, kind: string): void => {
    controls.push(element)
    let text = `[${String(controls.length)}: ${kind} ${quote(labelOf(element))}`
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      if (element.checked) text += ' checked'
    } else if (element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true'
      || element.getAttribute('aria-pressed') === 'true') {
      text += ' selected'
    } else if (element instanceof HTMLSelectElement) {
      const choices = [...element.options].slice(0, 12).map(choice => collapse(choice.text))
      text += ` value=${quote(element.selectedOptions[0]?.text ?? '')} options=${JSON.stringify(choices)}`
    } else if (kind === 'textbox' || kind === 'searchbox' || kind === 'input') {
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element instanceof HTMLElement && element.isContentEditable ? element.innerText : ''
      text += ` value=${quote(value)}`
    }
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') text += ' disabled'
    token(`${text}]`)
  }
  const walk = (node: Node): void => {
    if (truncated) return
    if (node.nodeType === Node.TEXT_NODE) {
      line += (node.nodeValue ?? '').replace(/\s+/gu, ' ')
      return
    }
    if (!(node instanceof Element)) {
      if (node instanceof DocumentFragment) for (const child of [...node.childNodes]) walk(child)
      return
    }
    if (++visited > options.maxElements) {
      truncated = true
      return
    }
    const tag = node.tagName.toUpperCase()
    if (SKIPPED.has(tag) || !visible(node)) return
    if (tag === 'BR') {
      flush()
      return
    }
    if (tag === 'IMG') {
      const alt = collapse(node.getAttribute('alt') ?? '')
      if (alt === '') return
      const source = node instanceof HTMLImageElement ? node.currentSrc || node.src : ''
      token(/^https?:/u.test(source) && source.length <= 300 ? `![${clip(alt, 100)}](${source})` : `![${clip(alt, 100)}]`)
      return
    }
    if (tag === 'PRE') {
      flush()
      const code = options.layout && node instanceof HTMLElement ? node.innerText : node.textContent
      push(`\`\`\`\n${code.replace(/\n+$/u, '')}\n\`\`\``)
      return
    }
    const kind = kindOf(node)
    if (kind === 'link' && node instanceof HTMLAnchorElement && /^https?:/u.test(node.href) && node.getAttribute('role') === null) {
      const label = clip(collapse(labelOf(node)), 200)
      if (label !== '') token(`[${label.replace(/[[\]]/gu, '')}](${node.href})`)
      return
    }
    if (kind !== undefined) {
      control(node, kind)
      return
    }
    const heading = /^H([1-6])$/u.exec(tag)
    const block = heading !== null || BLOCKS.has(tag) || tag === 'LI' || tag === 'TR'
    if (block) flush()
    if (heading !== null) line = `${'#'.repeat(Number(heading[1]))} `
    else if (tag === 'LI') line = '- '
    if (tag === 'TR') {
      const cells = [...node.children].filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH')
      cells.forEach((cell, index) => {
        if (index > 0) line += ' | '
        for (const child of [...cell.childNodes]) walk(child)
      })
    } else if (tag === 'SLOT' && node instanceof HTMLSlotElement && node.assignedNodes({ flatten: true }).length > 0) {
      for (const child of node.assignedNodes({ flatten: true })) walk(child)
    } else {
      const root = node.shadowRoot
      for (const child of [...(root ?? node).childNodes]) walk(child)
    }
    if (block) flush()
  }
  // An XML or SVG document has no body.
  walk(document.querySelector('body') ?? document.documentElement)
  flush()
  Object.defineProperty(window, options.key, { value: controls, configurable: true, enumerable: false, writable: true })
  return { title: document.title, url: location.href, text: lines.join('\n'), truncated }
}

/** Where a control is, after scrolling it into view. */
export type ControlLocation =
  | { readonly found: false; readonly reason: 'missing' | 'hidden' }
  | {
    readonly found: true
    /** Horizontal CSS pixel of the control's center in the viewport. */
    readonly x: number
    /** Vertical CSS pixel of the control's center in the viewport. */
    readonly y: number
    /** Whether the control is a select, which a click would open as a native menu. */
    readonly select: boolean
    /** What covers that point instead of the control, when something does. */
    readonly covered?: string
  }

/**
 * Scroll control n of the latest page text into view and find its center.
 * @param options - the page property that keeps the controls, and the control's number from 1.
 * @returns where the control is, or why it is not on the page.
 */
export function locateControl(options: { readonly key: string; readonly element: number }): ControlLocation {
  const controls: unknown = Reflect.get(window, options.key)
  const element: unknown = Array.isArray(controls) ? controls[options.element - 1] : undefined
  if (!(element instanceof Element) || !element.isConnected) return { found: false, reason: 'missing' }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return { found: false, reason: 'hidden' }
  const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1)
  const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)
  const select = element instanceof HTMLSelectElement
  const hit = document.elementFromPoint(x, y)
  if (hit === null || hit === element || element.contains(hit) || hit.contains(element)) return { found: true, x, y, select }
  const label = (hit.getAttribute('aria-label') ?? hit.textContent).replace(/\s+/gu, ' ').trim().slice(0, 60)
  return { found: true, x, y, select, covered: `<${hit.tagName.toLowerCase()}>${label === '' ? '' : ` "${label}"`}` }
}

/**
 * Click control n with a script, for a control that something else covers.
 * @param options - the page property that keeps the controls, and the control's number from 1.
 * @returns whether the control was there to click.
 */
export function clickControl(options: { readonly key: string; readonly element: number }): boolean {
  const controls: unknown = Reflect.get(window, options.key)
  const element: unknown = Array.isArray(controls) ? controls[options.element - 1] : undefined
  if (!(element instanceof HTMLElement) || !element.isConnected) return false
  element.click()
  return true
}

/**
 * How a field takes text after {@link prepareField}. `secret` is a password or payment field: an `<input
 * type="password">`, or a field whose `autocomplete` names a password, a one-time code, or payment card details.
 */
export type FieldPreparation =
  | { readonly ready: false; readonly reason: 'missing' | 'not-a-field' | 'no-such-option' | 'secret' }
  | { readonly ready: true; readonly mode: 'insert' }
  | { readonly ready: true; readonly mode: 'chosen'; readonly choice: string }

/**
 * Prepare control n to take text: focus a text field and select what it holds, so typing replaces it, or choose the
 * option of a select whose text or value matches the text. A password or payment field is refused untouched.
 * @param options - the page property that keeps the controls, the control's number from 1, and the text.
 * @returns how the field takes the text, or why it cannot.
 */
export function prepareField(options: { readonly key: string; readonly element: number; readonly text: string }): FieldPreparation {
  const controls: unknown = Reflect.get(window, options.key)
  const element: unknown = Array.isArray(controls) ? controls[options.element - 1] : undefined
  if (!(element instanceof HTMLElement) || !element.isConnected) return { ready: false, reason: 'missing' }
  const secret = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/u
  if ((element instanceof HTMLInputElement && element.type === 'password')
    || secret.test((element.getAttribute('autocomplete') ?? '').toLowerCase())) return { ready: false, reason: 'secret' }
  if (element instanceof HTMLSelectElement) {
    const wanted = options.text.trim().toLowerCase()
    const choice = [...element.options].find(option => option.text.trim().toLowerCase() === wanted || option.value.toLowerCase() === wanted)
    if (choice === undefined) return { ready: false, reason: 'no-such-option' }
    element.value = choice.value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ready: true, mode: 'chosen', choice: choice.text.trim() }
  }
  const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
  if (!field && !element.isContentEditable) return { ready: false, reason: 'not-a-field' }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  element.focus()
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select()
  else {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  return { ready: true, mode: 'insert' }
}

/**
 * Whether the page's focus, followed into open shadow roots, is on a password or payment field as
 * {@link FieldPreparation} names them; typed text goes to the focus, which a page script may move after
 * {@link prepareField}.
 * @returns whether the focused element is such a field.
 */
export function focusedSecretField(): boolean {
  let focused = document.activeElement
  for (let inner = focused?.shadowRoot?.activeElement; inner !== null && inner !== undefined; inner = inner.shadowRoot?.activeElement) {
    focused = inner
  }
  if (focused === null) return false
  const secret = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/u
  return (focused instanceof HTMLInputElement && focused.type === 'password')
    || secret.test((focused.getAttribute('autocomplete') ?? '').toLowerCase())
}

/**
 * Measure the viewport, from which the tools map screenshot pixels to the page.
 * @returns the viewport's size in CSS pixels.
 */
export function viewportSize(): { readonly width: number; readonly height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * The source text of a call of one page script, for the page's `executeJavaScript`.
 * @param script - a self-contained page script.
 * @param argument - its JSON argument, or none.
 * @returns the source of an expression that calls the script.
 */
export function pageScript<A>(script: (argument: A) => unknown, argument?: A): string {
  return `(${script.toString()})(${argument === undefined ? '' : JSON.stringify(argument)})`
}
