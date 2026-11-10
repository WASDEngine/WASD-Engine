/**
 * Copy of the WASD Engine Discord row at the sidebar foot, owned by the locale dictionaries (fork-owned;
 * `wasdengine/FORK.md` lists the fork changes).
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace of the fork's brand occupants. */
export const NS = 'wasdengineBrand'

/** English copy; its keys define {@link WasdengineBrandKey}. */
export const en = {
  'discord.join': 'Join Discord',
} satisfies Record<string, string>

/** Keys of the fork's brand copy. */
export type WasdengineBrandKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The WASD Engine Discord row at the sidebar foot. */
    wasdengineBrand: WasdengineBrandKey
  }
}

/** Chinese copy. */
export const zh = {
  'discord.join': '加入 Discord',
} satisfies Record<WasdengineBrandKey, string>

/** Japanese copy. */
export const ja = {
  'discord.join': 'Discord に参加',
} satisfies Record<WasdengineBrandKey, string>

/** Spanish copy. */
export const es = {
  'discord.join': 'Unirse a Discord',
} satisfies Record<WasdengineBrandKey, string>

/** French copy. */
export const fr = {
  'discord.join': 'Rejoindre Discord',
} satisfies Record<WasdengineBrandKey, string>

/** German copy. */
export const de = {
  'discord.join': 'Discord beitreten',
} satisfies Record<WasdengineBrandKey, string>

/** Russian copy. */
export const ru = {
  'discord.join': 'Присоединиться к Discord',
} satisfies Record<WasdengineBrandKey, string>

/** Portuguese copy. */
export const pt = {
  'discord.join': 'Entrar no Discord',
} satisfies Record<WasdengineBrandKey, string>
