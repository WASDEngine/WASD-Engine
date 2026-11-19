/**
 * The WASD Engine site's one-time sign-in links (`POST /api/v1/app/sign-in-links`), through which the Play page's
 * site signs in as the app's account. The app asks with its account token for a link to a page of the site; the site
 * answers with an address on its own origin whose code rides in the fragment, works once within minutes, and signs
 * nothing in once the app's sign-in has ended. The call carries the token in `x-dsh-auth-token` and never follows
 * redirects.
 * @module @deepseek-ai/dsh-wasd-plugins/src/site-sign-in
 */
import { z } from 'zod'
import { SiteClient, type SiteAccess } from './site-client.ts'

/** The site's answer: the link and when it stops working. */
const LinkJson = z.object({ url: z.string(), expires_at: z.string() })

/** A path on the site: one slash, then anything but a second one. */
const SITE_PATH = /^\/(?!\/)/

/**
 * Ask the site for a one-time link that opens `next` signed in as the account of `access`.
 * @param access - the signed-in site.
 * @param next - the page the link opens, a path on the site such as `/explore`.
 * @param fetchUrl - HTTP client.
 * @param signal - cancellation.
 * @returns the link, an address on the site's origin, or undefined when the site no longer takes the app's sign-in.
 * @throws {Error} when `next` is no path on the site, the site cannot be reached, or it answers in an unexpected way.
 */
export async function signInLink(
  access: SiteAccess, next: string, fetchUrl: typeof fetch, signal: AbortSignal,
): Promise<string | undefined> {
  if (!SITE_PATH.test(next)) throw new Error('A sign-in link opens only a path on the WASD Engine site.')
  const site = new SiteClient(access, fetchUrl, signal, { error: message => new Error(message), again: 'open the page again' })
  const response = await site.call('POST', '/api/v1/app/sign-in-links', { data: JSON.stringify({ next }), type: 'application/json' })
  if (response.status === 401) {
    await response.body?.cancel()
    return undefined
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`WASD Engine could not sign the Play page in (HTTP ${String(response.status)}).`)
  }
  const parsed = LinkJson.safeParse(await response.json())
  if (!parsed.success) throw new Error('WASD Engine answered the Play page\'s sign-in in an unexpected way.')
  const link = new URL(parsed.data.url)
  // The Play page opens only addresses on the site, so a link elsewhere is refused here.
  if (link.origin !== new URL(access.origin).origin) throw new Error('WASD Engine answered with a sign-in link to another site.')
  return link.href
}
