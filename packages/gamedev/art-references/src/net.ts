/**
 * Web requests of the reference tools: one GET of a public web address, following redirects, within a time limit and a
 * size limit. The first address and every redirect's must resolve only to public internet addresses, so a page found
 * on the web cannot make the tools reach the user's computer or local network. Requests carry no cookies or other
 * credentials. The address check resolves the host before the request, so a host whose records change between the
 * check and the connection can still reach the address it changed to.
 * @module @deepseek-ai/dsh-art-references/src/net
 */
import { BlockList, isIP } from 'node:net'

/** One address a host name resolves to. */
export interface LookupAddress {
  readonly address: string
  /** 4 or 6. */
  readonly family: number
}

/** How the reference tools reach the web. */
export interface ReferenceWeb {
  /**
   * Resolve a host name to every address it has.
   * @param hostname - the host, without brackets for an IPv6 literal.
   * @param signal - cancellation.
   * @returns the addresses.
   */
  lookup(hostname: string, signal: AbortSignal): Promise<readonly LookupAddress[]>
  /**
   * Send one request without following redirects.
   * @param url - the address.
   * @param init - headers, the manual redirect mode, and cancellation.
   * @returns the response.
   */
  fetch(url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }): Promise<Response>
  /** `User-Agent` of every request. */
  readonly userAgent: string
}

/** A request that failed; the message completes "<address> ...". */
export class WebRequestError extends Error {
  override name = 'WebRequestError'
}

/** Longest address the tools request. */
export const MAX_URL_LENGTH = 2048

/** Most redirects one request follows. */
export const MAX_REDIRECTS = 5

/** Address ranges that are not on the public internet: private, loopback, link-local, shared, reserved, and multicast. */
const NOT_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv4')
// ::/96 holds the unspecified and loopback addresses and the deprecated IPv4-compatible ones; IPv4-mapped addresses
// (::ffff:0:0/96) are checked by the IPv4 address they carry.
for (const [network, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:2::', 48],
  ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv6')

/**
 * The eight 16-bit words of an IPv6 address.
 * @param address - an address `isIP` reports as IPv6, possibly ending in a dotted IPv4 address.
 * @returns the words.
 */
function ipv6Words(address: string): number[] {
  let text = address.toLowerCase()
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
  if (dotted !== null) {
    const [a, b, c, d] = (dotted[1] as string).split('.').map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const front = head === '' ? [] : head.split(':')
  const back = tail === undefined || tail === '' ? [] : tail.split(':')
  const middle = tail === undefined ? [] : Array<string>(8 - front.length - back.length).fill('0')
  return [...front, ...middle, ...back].map(word => Number.parseInt(word, 16))
}

/**
 * The IPv4 address an IPv4-mapped IPv6 address carries, such as `::ffff:127.0.0.1` or `::ffff:7f00:1`.
 * @param address - an IPv6 address.
 * @returns the IPv4 address, or undefined when the address is not IPv4-mapped.
 */
function mappedIpv4(address: string): string | undefined {
  const words = ipv6Words(address)
  if (words.length !== 8 || words.slice(0, 5).some(word => word !== 0) || words[5] !== 0xffff) return undefined
  const high = words[6] as number
  const low = words[7] as number
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/**
 * Whether an address is on the public internet.
 * @param address - an IPv4 or IPv6 address.
 * @returns false for private, loopback, link-local, shared, reserved, documentation, and multicast addresses, and for
 *   anything that is not an IP address.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NOT_PUBLIC.check(address, 'ipv4')
  if (family !== 6) return false
  const mapped = mappedIpv4(address)
  if (mapped !== undefined) return isPublicAddress(mapped)
  return !NOT_PUBLIC.check(address, 'ipv6')
}

/**
 * Parse a web address the tools may request: HTTP or HTTPS, without a user name or password, at most
 * {@link MAX_URL_LENGTH} characters.
 * @param value - the address.
 * @returns the parsed address, without its fragment.
 * @throws WebRequestError when the address is not one the tools request.
 */
export function parseWebUrl(value: string): URL {
  if (value.length > MAX_URL_LENGTH) throw new WebRequestError(`is longer than ${MAX_URL_LENGTH} characters.`)
  if (!URL.canParse(value)) throw new WebRequestError('is not a web address.')
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebRequestError('is not an http or https address.')
  if (url.username !== '' || url.password !== '') throw new WebRequestError('carries a user name or password.')
  url.hash = ''
  return url
}

/**
 * Check that a host resolves only to public internet addresses.
 * @param web - how the tools reach the web.
 * @param url - the address to request.
 * @param signal - cancellation.
 * @throws WebRequestError when the host does not resolve, or resolves to any address that is not public.
 */
export async function assertPublicHost(web: ReferenceWeb, url: URL, signal: AbortSignal): Promise<void> {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
  let addresses: readonly LookupAddress[]
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  } else {
    try {
      addresses = await web.lookup(hostname, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new WebRequestError(`names a host that does not resolve (${hostname}).`, { cause: error })
    }
  }
  if (addresses.length === 0) throw new WebRequestError(`names a host that does not resolve (${hostname}).`)
  if (!addresses.every(entry => isPublicAddress(entry.address))) {
    throw new WebRequestError('is on this computer or a local network, which the reference tools never request.')
  }
}

/** Limits and headers of one GET. */
export interface GetOptions {
  /** `Accept` header. */
  readonly accept: string
  /** Most bytes of the body. */
  readonly maxBytes: number
  /** Whether a longer body is cut at `maxBytes` instead of failing the request. */
  readonly truncate: boolean
  /** Time limit of the request, its redirects, and its body. */
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** A successful GET. */
export interface GetResult {
  /** Address of the final response, after redirects. */
  readonly url: URL
  /** `Content-Type` header, lowercased without parameters; empty without one. */
  readonly mediaType: string
  /** `Content-Type` header as sent; empty without one. */
  readonly contentType: string
  readonly body: Buffer
  /** Whether the body was cut at `maxBytes`. */
  readonly truncated: boolean
}

/**
 * A byte count as people read it.
 * @param bytes - the count.
 * @returns text such as `512 KB` or `16 MB`.
 */
function sizeText(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${Math.round(bytes / (1024 * 1024))} MB`
}

/**
 * Read a response body up to a byte limit.
 * @returns the bytes and whether the body was longer.
 * @throws WebRequestError when the body is longer and `truncate` is false.
 */
async function readBody(response: Response, options: GetOptions): Promise<{ body: Buffer; truncated: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (!options.truncate && Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel()
    throw new WebRequestError(`is larger than ${sizeText(options.maxBytes)}.`)
  }
  if (response.body === null) return { body: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = options.maxBytes - total
    if (value.byteLength > room) {
      await reader.cancel()
      if (!options.truncate) throw new WebRequestError(`is larger than ${sizeText(options.maxBytes)}.`)
      chunks.push(Buffer.from(value.buffer, value.byteOffset, room))
      return { body: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    total += value.byteLength
  }
  return { body: Buffer.concat(chunks), truncated: false }
}

/**
 * GET one public web address, following up to {@link MAX_REDIRECTS} redirects, each checked like the first address.
 * @param web - how the tools reach the web.
 * @param address - the address.
 * @param options - limits, headers, and cancellation.
 * @returns the final response's address, type, and body.
 * @throws WebRequestError when the address is refused, the request fails or times out, the server answers with an
 *   error, or the body is too large; the caller's cancellation rethrows its reason.
 */
export async function getPublic(web: ReferenceWeb, address: string, options: GetOptions): Promise<GetResult> {
  options.signal.throwIfAborted()
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  let url = parseWebUrl(address)
  try {
    for (let redirects = 0; ; redirects++) {
      await assertPublicHost(web, url, signal)
      signal.throwIfAborted()
      const response = await web.fetch(url.href, {
        headers: { 'user-agent': web.userAgent, 'accept': options.accept },
        redirect: 'manual',
        signal,
      })
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (location === null) throw new WebRequestError(`answered HTTP ${response.status} without a new address.`)
        if (redirects >= MAX_REDIRECTS) throw new WebRequestError(`redirected more than ${MAX_REDIRECTS} times.`)
        url = parseWebUrl(new URL(location, url).href)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new WebRequestError(`answered HTTP ${response.status}.`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      const { body, truncated } = await readBody(response, options)
      return { url, contentType, mediaType: contentType.split(';')[0]?.trim().toLowerCase() ?? '', body, truncated }
    }
  } catch (error) {
    options.signal.throwIfAborted()
    if (error instanceof WebRequestError) throw error
    if (signal.aborted) throw new WebRequestError(`did not answer within ${options.timeoutMs < 1000 ? `${options.timeoutMs} ms` : `${Math.round(options.timeoutMs / 1000)} s`}.`, { cause: error })
    throw new WebRequestError(`could not be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
