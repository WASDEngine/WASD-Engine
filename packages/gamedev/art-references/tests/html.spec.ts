/**
 * Reading what a page offers as reference images: preview images, the video, the title and site, and the images the
 * page shows, from the HTML a server sends.
 */
import { describe, expect, it } from 'vitest'
import { decodeEntities, decodeHtml, largestSource, readPageMedia } from '../src/html.ts'

const PAGE = new URL('https://art.example/gallery/knights?page=2#top')

describe('readPageMedia', () => {
  it('reads preview images in order of importance, resolved against the page and with character references decoded', () => {
    const media = readPageMedia(`<html><head>
      <meta property="og:image" content="/img/knight.png?w=1200&amp;h=630">
      <meta name="twitter:image" content="https://cdn.example/knight-card.jpg">
      <meta property="og:image" content="/img/knight.png?w=1200&amp;h=630">
      <link rel="image_src" href="//cdn.example/knight-src.png">
      <meta itemprop="image" content="schema.jpg">
      <meta property="og:title" content="Knight &amp; Squire — Pixel Art">
      <meta property="og:site_name" content="Art Example">
      <title>Ignored title</title>
    </head><body></body></html>`, PAGE, 10)
    expect(media.preview).toEqual([
      'https://art.example/img/knight.png?w=1200&h=630',
      'https://cdn.example/knight-card.jpg',
      'https://cdn.example/knight-src.png',
      'https://art.example/gallery/schema.jpg',
    ])
    expect(media.title).toBe('Knight & Squire — Pixel Art')
    expect(media.site).toBe('Art Example')
    expect(media.video).toBeUndefined()
  })

  it('collects each image once, and at most the limit of each kind, however many a page names', () => {
    const previews = Array.from({ length: 32_000 }, (_, index) => `<meta property="og:image" content="https://e.co/${String(index % 20_000).padStart(6, '0')}.png">`)
    const repeated = Array.from({ length: 2_000 }, () => '<meta itemprop="image" content="/same.png">')
    const shown = Array.from({ length: 5_000 }, (_, index) => `<img src="/shown/${index % 3_000}.png">`)
    const media = readPageMedia(`<html><head>${previews.join('')}${repeated.join('')}</head><body>${shown.join('')}</body></html>`, PAGE, 16)
    expect(media.preview).toEqual(Array.from({ length: 16 }, (_, index) => `https://e.co/${String(index).padStart(6, '0')}.png`))
    expect(media.shown).toEqual(Array.from({ length: 16 }, (_, index) => `https://art.example/shown/${index}.png`))
    const once = readPageMedia(`<head>${repeated.join('')}</head>`, PAGE, 16)
    expect(once.preview).toEqual(['https://art.example/same.png'])
  })

  it('falls back to the title element and names the page\'s video', () => {
    const media = readPageMedia(`<title>
      Walk   cycle &#8211; reference</title>
      <meta property="og:video:secure_url" content="https://video.example/embed/42">
      <meta property="og:video" content="https://video.example/other">`, PAGE, 10)
    expect(media.title).toBe('Walk cycle – reference')
    expect(media.video).toBe('https://video.example/embed/42')
    expect(media.preview).toEqual([])
  })

  it('lists the images a page shows, taking the largest srcset source and lazy-loading attributes', () => {
    const media = readPageMedia(`<base href="https://static.example/assets/">
      <body>
      <img src="tiny.png" width="16" height="16">
      <img src="icons/sprite.svg">
      <img src="data:image/png;base64,AAAA">
      <img src="favicon-32.png">
      <img src="small.jpg" srcset="small.jpg 320w, large.jpg 1280w, medium.jpg 640w">
      <img data-src="lazy.webp" src="placeholder.gif">
      <img src="https://cdn.example/w_300,h_200/a.png" srcset="https://cdn.example/w_300,h_200/a.png 1x, https://cdn.example/w_600,h_400/a.png 2x">
      <picture><source type="video/mp4" srcset="clip.mp4"><source srcset="pic.avif 1x, pic@2x.avif 2x"></picture>
      <video poster="poster.jpg"></video>
      <a href="sheet.png?download=1">Sprite sheet</a>
      <a href="page.html">Not an image</a>
      <!-- <img src="commented.png"> -->
      <script>document.write('<img src="scripted.png">')</script>
      <img src="small.jpg">
      </body>`, PAGE, 20)
    expect(media.shown).toEqual([
      'https://static.example/assets/large.jpg',
      'https://static.example/assets/lazy.webp',
      'https://cdn.example/w_600,h_400/a.png',
      'https://static.example/assets/pic@2x.avif',
      'https://static.example/assets/poster.jpg',
      'https://static.example/assets/sheet.png?download=1',
      'https://static.example/assets/small.jpg',
    ])
  })

  it('stops collecting shown images at the limit and keeps preview images out of the shown list', () => {
    const html = '<meta property="og:image" content="/a.png"><img src="/a.png"><img src="/b.png"><img src="/c.png"><img src="/d.png">'
    const media = readPageMedia(html, PAGE, 2)
    expect(media.preview).toEqual(['https://art.example/a.png'])
    expect(media.shown).toEqual(['https://art.example/b.png'])
  })

  it('ignores addresses that are not http or https and icons named as previews', () => {
    const media = readPageMedia(`<meta property="og:image" content="javascript:alert(1)">
      <meta property="og:image" content="ftp://files.example/a.png">
      <meta property="og:image" content="/favicon.ico">
      <meta property="og:image" content="/brand.svg">`, PAGE, 5)
    expect(media.preview).toEqual([])
  })

  it('reads a hostile page in linear time: unclosed quotes, tags, comments, and scripts', () => {
    const size = 2 * 1024 * 1024
    for (const filler of ['<a "', '<img src=\'', '<!--', '<script>', '<' + 'b'.repeat(64)]) {
      const html = `<meta property="og:image" content="/first.png">${filler.repeat(Math.floor(size / filler.length))}`
      const started = performance.now()
      const media = readPageMedia(html, PAGE, 16)
      expect(performance.now() - started, filler).toBeLessThan(2000)
      expect(media.preview, filler).toEqual(['https://art.example/first.png'])
    }
  })

  it('skips a tag longer than the scan reads and goes on after it', () => {
    const media = readPageMedia(`<img src="/a.png" data-x="${'x'.repeat(9000)}"><img src="/b.png">`, PAGE, 5)
    expect(media.shown).toEqual(['https://art.example/b.png'])
  })
})

describe('largestSource', () => {
  it('picks the widest or densest candidate and keeps commas inside addresses', () => {
    expect(largestSource('a.png 100w, b.png 300w, c.png 200w')).toBe('b.png')
    expect(largestSource('a.png, b.png 2x')).toBe('b.png')
    expect(largestSource('https://cdn.example/f_auto,w_300/a.png 300w, https://cdn.example/f_auto,w_900/a.png 900w')).toBe('https://cdn.example/f_auto,w_900/a.png')
    expect(largestSource('  ')).toBeUndefined()
  })
})

describe('decodeEntities and decodeHtml', () => {
  it('decodes named and numeric references and leaves unknown ones', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27; &unknown; &#xD800;')).toBe('a & b <c> \'d\' &unknown; &#xD800;')
  })

  it('decodes with the character set the header or the page names', () => {
    const latin1 = Buffer.from('<title>Café</title>', 'latin1')
    expect(decodeHtml(latin1, 'text/html; charset=ISO-8859-1')).toContain('Café')
    expect(decodeHtml(Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin1]), 'text/html')).toContain('Café')
    expect(decodeHtml(Buffer.from('<title>Café</title>'), 'text/html; charset=no-such-set')).toContain('Café')
  })
})
