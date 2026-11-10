/**
 * WASD Engine Discord row (fork-owned; `wasdengine/FORK.md` lists the fork changes): a link at the sidebar foot, above
 * the account row, to the invite of the WASD Engine Discord server. The Desktop app's window-open handler opens it in
 * the default browser, and the Web UI in a new tab.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Also pulls the sidebar's slot declarations, `sidebar.footer.action` among them.
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './discord.module.css'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

/** Invite to the WASD Engine Discord server. */
export const WASDENGINE_DISCORD_INVITE = 'https://discord.gg/BC8fF2nr4y'

/** Discord's Blurple, the color the row draws the symbol in. */
export const DISCORD_BLURPLE = '#5865F2'

/**
 * The Discord symbol in a 24-unit frame: Simple Icons' `discord` path (simple-icons 16.31.0, CC0-1.0). Discord Inc. owns
 * the mark; its brand guidelines (https://discord.com/branding) allow it unaltered in Blurple, black, or white.
 */
export const DISCORD_SYMBOL_PATH = 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z'

/** Props the Discord row reads: the sidebar foot's column state and the brand copy. */
export type WasdengineDiscordLinkProps = SidebarFooterActionOwnerProps & PropsLocale<'wasdengineBrand'>

/**
 * Render the Discord symbol in Blurple.
 * @param props.size - rendered edge in pixels.
 * @returns the decorative symbol svg.
 */
export function DiscordSymbol({ size }: { readonly size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={DISCORD_BLURPLE} aria-hidden="true">
      <path d={DISCORD_SYMBOL_PATH} />
    </svg>
  )
}

/**
 * Render the Join Discord link: the symbol and the label in the wide sidebar, and the symbol alone, named by a tooltip,
 * in the rail.
 * @param props - composed slot props.
 * @returns the link element.
 */
export function WasdengineDiscordLink({ wide, t }: WasdengineDiscordLinkProps) {
  const label = t('discord.join')
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <a
        className={css.link}
        data-collapsed={!wide}
        href={WASDENGINE_DISCORD_INVITE}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
      >
        <DiscordSymbol size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{label}</span>}
      </a>
    </Tooltip>
  )
}

/**
 * Register the brand dictionaries and put {@link WasdengineDiscordLink} at the sidebar foot. The registration waits for
 * the slot's declaration, and both leave with the caller's fiber.
 * @param ctx - Client context that injects the slot registry and the locale service.
 */
export function applyWasdengineDiscord(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-brand-official: WASD Engine dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'wasdengine-discord',
    locale: NS,
  }, WasdengineDiscordLink))
}
