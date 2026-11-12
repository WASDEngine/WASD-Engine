/**
 * WASDEngine fork (`wasdengine/FORK.md`): the origins that receive the signed-in platform's token. Upstream defaults the
 * notification origin to DeepSeek's Harness API and the inference origin to DeepSeek's API, which is right only for
 * DeepSeek's own platform: under any other platform, a profile patch that replaces the account row's configuration
 * without restating them would send that platform's token to DeepSeek, on notification requests, whose 401 then signs
 * the user out, and on model, file, and web search requests, such as web-search-deepseek's, whose default endpoint is
 * DeepSeek's API.
 */
import { platformOrigin } from './protocol.ts'

/** DeepSeek's Harness API origin, the notification origin of DeepSeek's own platform. */
export const DEEPSEEK_HARNESS_ORIGIN = 'https://harness.deepseek.com'

/** DeepSeek's API origin, the inference origin of DeepSeek's own platform. */
export const DEEPSEEK_API_ORIGIN = 'https://api.deepseek.com'

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

/**
 * Resolve the inference origin, which may receive the token on model and file requests, for a platform: the configured
 * one, or by default DeepSeek's API under DeepSeek's platform and the platform origin itself under any other.
 * @param platform - normalized platform origin (`platformOrigin`).
 * @param configured - `inferenceOrigin` as configured, absent or null when no layer sets it.
 * @returns the inference origin, which the account provider then validates.
 */
export function inferenceOriginFor(platform: string, configured: string | undefined): string {
  return configured ?? (deepSeekHost(new URL(platform).hostname) ? DEEPSEEK_API_ORIGIN : platform)
}

/**
 * Whether a request would carry a token that another platform issued to DeepSeek. `resolveToken` withholds such a token
 * whatever the configured inference origin, so it reaches DeepSeek only when DeepSeek's own platform issued it.
 * @param destination - request destination.
 * @param issuer - origin that issued the stored grant.
 * @returns true for a destination on DeepSeek's domain and an issuer outside it, a loopback one included.
 */
export function carriesForeignGrantToDeepSeek(destination: URL, issuer: URL): boolean {
  return deepSeekHost(destination.hostname) && !deepSeekHost(issuer.hostname)
}
