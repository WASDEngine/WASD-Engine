// @vitest-environment jsdom
/**
 * WASD Engine: the links of a web card go to the surrounding Markdown owner's `openExternalLink` on an ordinary click, as
 * Markdown links do, so the Chat opens them where its link preference says, such as the right Sidebar's Browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MarkdownDelegateProvider, WebBlock } from '../src/index.ts'
import { webBlockLabels } from './labels.client.ts'

afterEach(cleanup)

const SOURCES = [{ url: 'https://example.com/a', title: 'Titled' }]

describe('WebBlock links', () => {
  it('hand an ordinary click on a source or fetch link to the owner', () => {
    const open = vi.fn()
    const search = render(
      <MarkdownDelegateProvider openExternalLink={open}>
        <WebBlock kind="search" sources={SOURCES} truncated={false} labels={webBlockLabels} />
      </MarkdownDelegateProvider>,
    )
    const source = search.getByRole('link', { name: 'Titled' })
    expect(fireEvent.click(source)).toBe(false)
    expect(open).toHaveBeenCalledWith('https://example.com/a')
    search.unmount()
    const fetched = render(
      <MarkdownDelegateProvider openExternalLink={open}>
        <WebBlock kind="fetch" url="https://example.com/page" statusCode={200} truncated={false} labels={webBlockLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(fireEvent.click(fetched.getByRole('link', { name: 'https://example.com/page' }))).toBe(false)
    expect(open).toHaveBeenLastCalledWith('https://example.com/page')
  })

  it('keep the native anchor for modified clicks and outside an owner', () => {
    const open = vi.fn()
    const owned = render(
      <MarkdownDelegateProvider openExternalLink={open}>
        <WebBlock kind="search" sources={SOURCES} truncated={false} labels={webBlockLabels} />
      </MarkdownDelegateProvider>,
    )
    const link = owned.getByRole('link', { name: 'Titled' })
    link.addEventListener('click', (event) => { event.preventDefault() })
    fireEvent.click(link, { metaKey: true })
    fireEvent.click(link, { button: 1 })
    expect(open).not.toHaveBeenCalled()
    owned.unmount()
    const bare = render(<WebBlock kind="search" sources={SOURCES} truncated={false} labels={webBlockLabels} />)
    const native = bare.getByRole('link', { name: 'Titled' })
    expect(native.getAttribute('target')).toBe('_blank')
    native.addEventListener('click', (event) => { event.preventDefault() })
    expect(fireEvent.click(native)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
