// @vitest-environment jsdom
/**
 * The page scripts of the agent's Browser, run against a document without layout: the page text with its numbered
 * controls, finding, clicking, and filling control n afterwards, and refusing password and payment fields. Each script
 * also runs from its source text alone, as the window sends it to a page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clickControl, focusedSecretField, locateControl, pageScript, prepareField, snapshotPage, viewportSize, type PageSnapshot,
  type SnapshotOptions,
} from '../src/client/page.ts'

const KEY = '__wasdBrowserControlsTest'
const OPTIONS: SnapshotOptions = { key: KEY, maxChars: 10_000, maxElements: 10_000, layout: false }

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
  Reflect.deleteProperty(window, KEY)
  vi.restoreAllMocks()
})

/** Run a page script from its source text, as `executeJavaScript` does. */
function fromSource<A>(script: (argument: A) => unknown, argument?: A): unknown {
  // oxlint-disable-next-line typescript/no-implied-eval -- The test runs the script text the window sends to pages.
  const run = new Function(`return ${pageScript(script, argument)}`) as () => unknown
  return run()
}

const PAGE = `
  <header><nav><a href="https://godotengine.org/">Godot</a> <a href="/docs/" title="Docs title">Docs</a></nav></header>
  <main>
    <h1>Search   results</h1>
    <p>Found <b>3</b> results for <i>shaders</i>.</p>
    <ul><li>First <a href="javascript:void(0)">more</a></li><li hidden>Hidden item</li></ul>
    <form>
      <label for="q">Search games</label><input id="q" value="godot">
      <input type="hidden" name="token" value="secret">
      <input type="password" placeholder="Password" value="hunter2">
      <label><input type="checkbox" checked> Free only</label>
      <select aria-label="Sort"><option>Popular</option><option selected>Newest</option></select>
      <button type="submit">Search</button>
      <div role="button" aria-hidden="true">Ghost</div>
    </form>
    <table><tr><th>Name</th><th>Size</th></tr><tr><td>Trees</td><td>2 MB</td></tr></table>
    <pre>func _ready():
    print("hi")</pre>
    <img alt="Pixel tree" src="https://cdn.example/tree.png"><img src="https://cdn.example/spacer.gif">
    <script>window.secret = 1</script><style>p { color: red }</style>
  </main>`

describe('snapshotPage', () => {
  it('renders the visible text with links, numbered controls, and structure', () => {
    document.title = 'Results'
    document.body.innerHTML = PAGE
    const snapshot = snapshotPage(OPTIONS)
    expect(snapshot).toEqual({
      title: 'Results',
      url: window.location.href,
      truncated: false,
      text: [
        `[Godot](https://godotengine.org/) [Docs](${new URL('/docs/', window.location.href).href})`,
        '# Search results',
        'Found 3 results for shaders.',
        '- First [1: link "more"]',
        'Search games [2: textbox "Search games" value="godot"] [3: password "Password"] [4: checkbox "Free only" checked] Free only [5: select "Sort" value="Newest" options=["Popular","Newest"]] [6: button "Search"]',
        'Name | Size',
        'Trees | 2 MB',
        '```\nfunc _ready():\n    print("hi")\n```',
        '![Pixel tree](https://cdn.example/tree.png)',
      ].join('\n'),
    })
    const controls: unknown = Reflect.get(window, KEY)
    expect(Array.isArray(controls) ? controls.map(element => (element as Element).tagName) : controls)
      .toEqual(['A', 'INPUT', 'INPUT', 'INPUT', 'SELECT', 'BUTTON'])
  })

  it('stops at its character and element limits and says so', () => {
    document.body.innerHTML = '<p>alpha beta</p><p>gamma delta</p><p>epsilon</p>'
    expect(snapshotPage({ ...OPTIONS, maxChars: 24 })).toMatchObject({ text: 'alpha beta\ngamma delta', truncated: true })
    expect(snapshotPage({ ...OPTIONS, maxElements: 2 })).toMatchObject({ truncated: true })
  })

  it('runs from its source text alone', () => {
    document.body.innerHTML = PAGE
    const snapshot = fromSource(snapshotPage, OPTIONS) as PageSnapshot
    expect(snapshot.text).toBe(snapshotPage(OPTIONS).text)
  })
})

describe('control scripts', () => {
  it('finds a control\'s center after scrolling it into view, and what covers it', () => {
    document.body.innerHTML = '<button id="go">Go</button><div id="banner">Accept cookies</div>'
    snapshotPage(OPTIONS)
    const button = document.getElementById('go')!
    const scroll = vi.fn()
    Object.assign(Element.prototype, { scrollIntoView: scroll })
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 50, bottom: 40, width: 40, height: 20, toJSON: () => ({}) })
    let hit: Element | null = button
    Object.assign(document, { elementFromPoint: vi.fn(() => hit) })
    expect(locateControl({ key: KEY, element: 1 })).toEqual({ found: true, x: 30, y: 30, select: false })
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'center', behavior: 'instant' })
    hit = document.getElementById('banner')
    expect(fromSource(locateControl, { key: KEY, element: 1 })).toEqual({ found: true, x: 30, y: 30, select: false, covered: '<div> "Accept cookies"' })
    expect(locateControl({ key: KEY, element: 2 })).toEqual({ found: false, reason: 'missing' })
    button.remove()
    expect(locateControl({ key: KEY, element: 1 })).toEqual({ found: false, reason: 'missing' })
  })

  it('reports a control without a box as hidden', () => {
    document.body.innerHTML = '<button>Go</button>'
    snapshotPage(OPTIONS)
    Object.assign(Element.prototype, { scrollIntoView: vi.fn() })
    expect(locateControl({ key: KEY, element: 1 })).toEqual({ found: false, reason: 'hidden' })
  })

  it('clicks a control by script', () => {
    document.body.innerHTML = '<button>Go</button>'
    snapshotPage(OPTIONS)
    const clicked = vi.fn()
    document.querySelector('button')!.addEventListener('click', clicked)
    expect(fromSource(clickControl, { key: KEY, element: 1 })).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
    expect(clickControl({ key: KEY, element: 9 })).toBe(false)
  })

  it('selects a field\'s text for replacement, chooses a select\'s option, and refuses other controls', () => {
    document.body.innerHTML = '<input value="old"><select><option value="p">Popular</option><option value="n">Newest</option></select><button>Go</button>'
    snapshotPage(OPTIONS)
    Object.assign(Element.prototype, { scrollIntoView: vi.fn() })
    const input = document.querySelector('input')!
    expect(prepareField({ key: KEY, element: 1, text: 'new' })).toEqual({ ready: true, mode: 'insert' })
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3])
    const select = document.querySelector('select')!
    const changed = vi.fn()
    select.addEventListener('change', changed)
    expect(fromSource(prepareField, { key: KEY, element: 2, text: 'newest' })).toEqual({ ready: true, mode: 'chosen', choice: 'Newest' })
    expect(select.value).toBe('n')
    expect(changed).toHaveBeenCalledOnce()
    expect(prepareField({ key: KEY, element: 2, text: 'Oldest' })).toEqual({ ready: false, reason: 'no-such-option' })
    expect(prepareField({ key: KEY, element: 3, text: 'x' })).toEqual({ ready: false, reason: 'not-a-field' })
    expect(prepareField({ key: KEY, element: 4, text: 'x' })).toEqual({ ready: false, reason: 'missing' })
  })

  it('refuses password and payment fields untouched, by type or by autocomplete', () => {
    document.body.innerHTML = '<input type="password" value="kept"><input autocomplete="current-password">'
      + '<input autocomplete="section-pay billing cc-number"><input autocomplete="one-time-code">'
      + '<select autocomplete="cc-exp-month"><option value="1">01</option><option value="2">02</option></select>'
      + '<input autocomplete="email"><textarea autocomplete="new-password"></textarea>'
    snapshotPage(OPTIONS)
    Object.assign(Element.prototype, { scrollIntoView: vi.fn() })
    for (const element of [1, 2, 3, 4, 5, 7]) {
      expect(fromSource(prepareField, { key: KEY, element, text: '02' })).toEqual({ ready: false, reason: 'secret' })
    }
    expect(document.activeElement).toBe(document.body)
    expect(document.querySelector('select')!.value).toBe('1')
    expect(prepareField({ key: KEY, element: 6, text: 'me@example.test' })).toEqual({ ready: true, mode: 'insert' })
  })

  it('tells whether the focus is on a password or payment field, inside open shadow roots too', () => {
    document.body.innerHTML = '<input aria-label="Name"><input type="password"><div id="host"></div>'
    const [name, password] = document.querySelectorAll('input')
    const host = document.querySelector('#host')!.attachShadow({ mode: 'open' })
    host.innerHTML = '<input autocomplete="cc-csc">'
    expect(fromSource(focusedSecretField)).toBe(false)
    name!.focus()
    expect(fromSource(focusedSecretField)).toBe(false)
    password!.focus()
    expect(fromSource(focusedSecretField)).toBe(true)
    host.querySelector('input')!.focus()
    expect(fromSource(focusedSecretField)).toBe(true)
  })

  it('reports the viewport size', () => {
    expect(fromSource(viewportSize)).toEqual({ width: window.innerWidth, height: window.innerHeight })
  })
})
