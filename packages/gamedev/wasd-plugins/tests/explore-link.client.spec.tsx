// @vitest-environment jsdom
/** Explore Games at the sidebar foot: labeled on the wide sidebar, a globe on the rail, and opening the Explore page. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ExploreLink, type ExploreLinkProps } from '../src/client/ExploreLink.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)

function link(wide: boolean) {
  const openExplore = vi.fn()
  const props: ExploreLinkProps = { ...({} as ExploreLinkProps), wide, t, openExplore }
  render(<ExploreLink {...props} />)
  return openExplore
}

describe('ExploreLink', () => {
  it('reads Explore Games on the wide sidebar and opens the Explore page', () => {
    const openExplore = link(true)
    const row = screen.getByRole('button', { name: 'Explore Games' })
    expect(row.textContent).toBe('Explore Games')
    fireEvent.click(row)
    expect(openExplore).toHaveBeenCalledOnce()
  })

  it('shows only its globe on the rail, still named for assistive technology', () => {
    link(false)
    expect(screen.getByRole('button', { name: 'Explore Games' }).textContent).toBe('')
  })
})
