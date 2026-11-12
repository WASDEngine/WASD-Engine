/**
 * WASDEngine fork (`wasdengine/FORK.md`): the origin that receives account notification requests, which carry the
 * signed-in platform's token. Upstream defaults it to DeepSeek's Harness API, which is right only for DeepSeek's own
 * platform: under any other platform, a profile patch that replaces the account row's configuration without restating
 * `harnessOrigin` would send that platform's token to DeepSeek, whose 401 then signs the user out.
 */
import { platformOrigin } from './protocol.ts'

/** DeepSeek's Harness API origin, the notification origin of DeepSeek's own platform. */
export const DEEPSEEK_HARNESS_ORIGIN = 'https://harness.deepseek.com'

/**
 * Whether a host name belongs to DeepSeek's domain.
 * @param hostname - URL host name, lowercase as `URL` normalizes it.
 * @returns true for `deepseek.com` and its subdomains.
 */
function deepSeekHost(hostname: string): boolean {
  return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')
}

/**
 * Resolve the notification origin for a platform: the configured one, or by default DeepSeek's Harness API under
 * DeepSeek's platform and the platform origin itself under any other.
 * @param platform - normalized platform origin (`platformOrigin`).
 * @param configured - `harnessOrigin` as configured, absent when no layer sets it.
 * @param allowLoopbackHttp - development-only opt-in for loopback HTTP.
 * @returns the normalized notification origin.
 * @throws {Error} When the configured value is not a valid origin, or names a DeepSeek origin while the platform is
 *   another one, because the notification requests would carry that platform's token to DeepSeek.
 */
export function harnessOriginFor(platform: string, configured: string | undefined, allowLoopbackHttp: boolean): string {
  const deepSeekPlatform = deepSeekHost(new URL(platform).hostname)
  if (configured === undefined) return deepSeekPlatform ? DEEPSEEK_HARNESS_ORIGIN : platform
  const origin = platformOrigin(configured, allowLoopbackHttp, 'harnessOrigin')
  if (!deepSeekPlatform && deepSeekHost(new URL(origin).hostname)) {
    throw new Error(`account: harnessOrigin ${origin} is a DeepSeek origin, but platformOrigin ${platform} is not; `
      + 'notification requests carry the platform\'s sign-in token, so leave harnessOrigin unset to use the platform origin')
  }
  return origin
}
