// @vitest-environment jsdom
/**
 * WASDEngine fork guard for the Join Discord row: the link to the WASD Engine Discord invite with the Discord symbol,
 * its copy in every language, its registration once the locale service is available, and the row at the foot of the
 * shipped Web client's sidebar. `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { makeTranslate, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { applyWasdengineBrand } from '../src/client/wasdengine-brand.tsx'
import {
  DISCORD_BLURPLE, DISCORD_SYMBOL_PATH, WASDENGINE_DISCORD_INVITE, WasdengineDiscordLink,
} from '../src/client/wasdengine/discord.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh } from '../src/client/wasdengine/locales.ts'

usePinnedBrowserLanguages('en-US')

afterEach(cleanup)

const DICTIONARIES = { zh, en, ja, es, fr, de, ru, pt } as const

const assembled = createClientTest({ roster: webApp }, { mount: true })

/** Check one rendered link: its target, how it opens, its name, and the Blurple symbol at the requested size. */
function expectDiscordLink(link: HTMLElement, symbolSize: number): void {
  expect(link.tagName).toBe('A')
  expect(link.getAttribute('href')).toBe('https://discord.gg/BC8fF2nr4y')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  const symbol = link.querySelector('svg')
  expect(symbol?.getAttribute('width')).toBe(String(symbolSize))
  expect(symbol?.getAttribute('height')).toBe(String(symbolSize))
  expect(symbol?.getAttribute('viewBox')).toBe('0 0 24 24')
  expect(symbol?.getAttribute('aria-hidden')).toBe('true')
  expect(symbol?.getAttribute('fill')).toBe('#5865F2')
  expect(symbol?.querySelector('path')?.getAttribute('d')).toBe(DISCORD_SYMBOL_PATH)
}

describe('WASDEngine Join Discord row', () => {
  it('links to the WASD Engine Discord invite with the symbol and the label in the wide sidebar', () => {
    expect(WASDENGINE_DISCORD_INVITE).toBe('https://discord.gg/BC8fF2nr4y')
    expect(DISCORD_BLURPLE).toBe('#5865F2')
    render(<WasdengineDiscordLink wide t={makeTranslate(en)} />)
    const link = screen.getByRole('link', { name: 'Join Discord' })
    expectDiscordLink(link, 16)
    expect(link.textContent).toBe('Join Discord')
    expect(link.getAttribute('data-collapsed')).toBe('false')
  })

  it('shows the symbol alone in the rail and keeps the link\'s name', () => {
    render(<WasdengineDiscordLink wide={false} t={makeTranslate(en)} />)
    const link = screen.getByRole('link', { name: 'Join Discord' })
    expectDiscordLink(link, 18)
    expect(link.textContent).toBe('')
    expect(link.getAttribute('data-collapsed')).toBe('true')
  })

  it.each(Object.keys(DICTIONARIES))('names Discord in the %s copy', (language) => {
    const dictionary = DICTIONARIES[language as keyof typeof DICTIONARIES]
    expect(Object.keys(dictionary)).toEqual(Object.keys(en))
    expect(dictionary['discord.join']).toContain('Discord')
  })

  it('joins the sidebar foot once the locale service is available and leaves with the plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    const fiber = ctx.plugin({ inject: ['slots'], apply: applyWasdengineBrand })
    await fiber.await()
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)

    const locale = new LocaleRuntime(ctx)
    locale.setLocale('en')
    ctx.provide('locale', locale)
    await expect.poll(() => slots.entries('sidebar.footer.action').map(entry => entry.component)).toEqual([WasdengineDiscordLink])
    const [entry] = slots.entries('sidebar.footer.action')
    expect([entry?.options.id, entry?.locale]).toEqual(['wasdengine-discord', NS])
    expect(locale.bind(NS)('discord.join')).toBe('Join Discord')

    await fiber.dispose()
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(locale.bind(NS)('discord.join')).toBe('discord.join')
  })
})

assembled('shows the Join Discord row above the account row at the foot of the shipped Web client\'s sidebar', async ({ start }) => {
  await start()
  const link = await screen.findByRole('link', { name: 'Join Discord' })
  expectDiscordLink(link, 16)
  const account = screen.getByRole('button', { name: 'Account menu' })
  const position = link.closest('[data-slot="sidebar.footer.action"]')?.compareDocumentPosition(account) ?? 0
  expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
}, 60_000)
