/**
 * The text of a Web check in the results of `wasd_export_web` and `wasd_release_game`: what the check did, what it
 * measured, the errors and warnings, the findings and the problems that stop a release of the Godot plugin's report,
 * and where its screenshot is.
 * @module @deepseek-ai/dsh-wasd-plugins/src/web-check-text
 */
import type { GodotWebCheck } from '@deepseek-ai/dsh-godot'

/** A Web check report whose message levels are plain strings, as tool results carry it. */
export type WebCheckView = Omit<GodotWebCheck, 'messages'> & {
  readonly messages: readonly { readonly level: string; readonly text: string; readonly count: number }[]
}

/**
 * Describe a Web check: what it did, what it measured, the errors and warnings, the findings, the problems that stop a
 * release, and the screenshot's file.
 * @param check - the report.
 * @returns the text, one paragraph or list item per line.
 */
export function formatWebCheck(check: WebCheckView): string {
  const measured = [
    `longest freeze ${String(check.longestFreezeSeconds)} s${check.freezes > 0 ? ` (${String(check.freezes)} of a second or more)` : ''}`,
    ...check.fps === undefined ? [] : [`${String(check.fps)} fps, slowest frame ${String(check.slowestFrameMs ?? 0)} ms`],
    ...check.drawCalls === undefined ? [] : [`${String(check.drawCalls.median)} draw calls per frame (median, up to ${String(check.drawCalls.max)})`],
    `${String(check.programs)} shader programs`,
    ...check.crashed === undefined ? [] : [`the page's process ended (${check.crashed})`],
  ].join('; ')
  let opening: string
  if (!check.started) opening = 'Web check: a browser opened the build, and the game did not start'
  else if (check.readySeconds === undefined) opening = `Web check: a browser opened the build, Godot started the game after ${String(check.startSeconds ?? 0)} s, and it never drew frames steadily`
  else opening = `Web check: a browser opened the build, Godot started the game after ${String(check.startSeconds ?? 0)} s, it drew frames steadily from ${String(check.readySeconds)} s on, and the check watched it run for ${String(check.seconds)} s without input`
  const lines = [`${opening}: ${measured}.`]
  if (check.messages.length === 0) {
    lines.push('The build printed no errors or warnings.')
  } else {
    lines.push('Errors and warnings the build printed:', ...check.messages.map(message => `- ${message.text}${message.count > 1 ? ` (${String(message.count)} times)` : ''}`))
    if (check.moreMessages > 0) lines.push(`- … and ${String(check.moreMessages)} more.`)
  }
  if (check.findings.length > 0) lines.push('Findings:', ...check.findings.map(finding => `- ${finding}`))
  if (check.problems.length > 0) lines.push(`Problems that stop a release: ${check.problems.join('; ')}.`)
  if (check.screenshot !== undefined) {
    lines.push(`Screenshot of the page as the check last saw it (${String(check.screenshot.width)}x${String(check.screenshot.height)}): ${check.screenshot.path}`)
  }
  return lines.join('\n')
}
