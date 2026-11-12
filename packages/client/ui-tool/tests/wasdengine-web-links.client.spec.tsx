// @vitest-environment jsdom
/**
 * WASD Engine: the collapsed `web_fetch` link of a tool row goes to the surrounding Markdown owner's `openExternalLink` on
 * an ordinary click, as a message link does, so the Chat opens it where its link preference says, and the row stays
 * folded; the expanded web card's links do the same.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { ToolRow } from '../src/client/tool/components/ToolRow.tsx'
import type { GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'

afterEach(cleanup)

const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)

const URL_TEXT = 'https://example.com/page'

const rowProps = {
  useDisclosure, t, variant: 'read' as const, icon: <i />, title: 'Fetch', summary: URL_TEXT, state: 'ok' as const, href: URL_TEXT,
  web: { kind: 'search' as const, answer: undefined, truncated: false, sources: [{ url: 'https://example.com/a', title: 'Titled' }] },
}

describe('web tool row links', () => {
  it('hand an ordinary click on the collapsed link to the owner without unfolding the row', () => {
    const open = vi.fn()
    const view = render(<MarkdownDelegateProvider openExternalLink={open}><ToolRow {...rowProps} /></MarkdownDelegateProvider>)
    expect(fireEvent.click(view.getByRole('link', { name: URL_TEXT }))).toBe(false)
    expect(open).toHaveBeenCalledWith(URL_TEXT)
    expect(view.container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    fireEvent.click(view.getByRole('link', { name: 'Titled' }))
    expect(open).toHaveBeenLastCalledWith('https://example.com/a')
  })

  it('keep the native anchor for a modified click and outside an owner', () => {
    const open = vi.fn()
    const owned = render(<MarkdownDelegateProvider openExternalLink={open}><ToolRow {...rowProps} /></MarkdownDelegateProvider>)
    const link = owned.getByRole('link', { name: URL_TEXT })
    link.addEventListener('click', (event) => { event.preventDefault() })
    fireEvent.click(link, { ctrlKey: true })
    expect(open).not.toHaveBeenCalled()
    owned.unmount()
    const bare = render(<ToolRow {...rowProps} />)
    const native = bare.getByRole('link', { name: URL_TEXT })
    native.addEventListener('click', (event) => { event.preventDefault() })
    fireEvent.click(native)
    expect(open).not.toHaveBeenCalled()
    expect(bare.container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
  })
})
