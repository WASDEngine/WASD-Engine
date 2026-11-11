/**
 * Reads sclang's post output for the bridge: decodes it as UTF-8, splits it into lines, recognizes the worker class's
 * reply lines, and keeps the other lines as the output of the request that the next reply answers. A reply line
 * starts a line with the bridge's token: `<token> READY <JSON>` once after boot, and `<token> END <id> <JSON>` once per
 * request. The worker class writes a newline before each reply line, so the output it closes loses exactly one
 * trailing newline.
 *
 * @module
 */

import { StringDecoder } from 'node:string_decoder'

/** Most characters of output kept for one reply: the first and last halves, with the count of omitted characters between them. */
export const OUTPUT_LIMIT = 20_000

/** Lines that sclang posts whenever it creates a Server object, such as for a pattern render; they say nothing about the agent's code. */
const NOISE = /^\S+ : setting clientID to \d+\.$/u

/** Text of unbounded length kept as its first and last `limit / 2` characters. */
export class BoundedText {
  private head = ''
  private tail = ''
  private omitted = 0
  private readonly half: number

  /** @param limit - most characters kept. */
  constructor(limit: number) {
    this.half = Math.floor(limit / 2)
  }

  /**
   * Add text at the end.
   * @param text - the next text.
   */
  append(text: string): void {
    let rest = text
    if (this.omitted === 0 && this.tail === '' && this.head.length < this.half) {
      const room = this.half - this.head.length
      this.head += rest.slice(0, room)
      rest = rest.slice(room)
    }
    this.tail += rest
    if (this.tail.length > this.half) {
      this.omitted += this.tail.length - this.half
      this.tail = this.tail.slice(this.tail.length - this.half)
    }
  }

  /**
   * Hand over the text and start empty.
   * @returns the kept text, with a notice that counts the omitted characters between its halves.
   */
  take(): string {
    const text = this.omitted === 0 ? this.head + this.tail : `${this.head}\n[${String(this.omitted)} characters of output omitted]\n${this.tail}`
    this.head = ''
    this.tail = ''
    this.omitted = 0
    return text
  }
}

/** What the parser reports. */
export interface SclangOutputEvents {
  /**
   * The worker class booted.
   * @param payload - the JSON text after `READY`.
   */
  ready(payload: string): void
  /**
   * The worker class answered a request.
   * @param id - the request id.
   * @param payload - the JSON text of the reply.
   * @param output - the interpreter's output since the previous reply, bounded by {@link OUTPUT_LIMIT}.
   */
  reply(id: number, payload: string, output: string): void
  /**
   * sclang wrote a line that is not a reply, before the worker class booted.
   * @param line - the line without its newline.
   */
  startupLine(line: string): void
}

/** Splits sclang's post output into reply lines and the output between them. */
export class SclangOutputParser {
  private readonly decoder = new StringDecoder('utf8')
  private readonly output = new BoundedText(OUTPUT_LIMIT)
  private partial = ''
  private booted = false
  private readonly readyPrefix: string
  private readonly endPrefix: string

  /**
   * @param token - the bridge's token, which starts every reply line.
   * @param events - receives replies, the boot, and startup lines.
   */
  constructor(token: string, private readonly events: SclangOutputEvents) {
    this.readyPrefix = `${token} READY `
    this.endPrefix = `${token} END `
  }

  /**
   * Read the next bytes of sclang's stdout.
   * @param chunk - bytes as they arrived; a multibyte character may span chunks.
   */
  push(chunk: Buffer): void {
    const lines = (this.partial + this.decoder.write(chunk)).split('\n')
    this.partial = lines.pop() ?? ''
    // sclang on Windows writes its stdout in text mode, which ends each line with CR LF.
    for (const line of lines) this.line(line.endsWith('\r') ? line.slice(0, -1) : line)
  }

  private line(line: string): void {
    if (line.startsWith(this.readyPrefix)) {
      this.booted = true
      this.output.take()
      this.events.ready(line.slice(this.readyPrefix.length))
      return
    }
    const reply = this.booted && line.startsWith(this.endPrefix) ? /^(\d+) (.*)$/su.exec(line.slice(this.endPrefix.length)) : null
    if (reply !== null) {
      this.events.reply(Number(reply[1]), reply[2] ?? '', this.output.take().replace(/\n$/u, ''))
      return
    }
    if (!this.booted) {
      this.events.startupLine(line)
      return
    }
    if (!NOISE.test(line)) this.output.append(`${line}\n`)
  }
}
