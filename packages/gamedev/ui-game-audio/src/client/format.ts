/** How the Audio tab writes times, lengths, and levels. */

/**
 * A playback position or length on a clock.
 * @param seconds - the time.
 * @returns minutes, seconds, and tenths, such as `0:01.2` or `12:05.0`, with hours from one hour, such as `1:02:03.4`.
 */
export function clockText(seconds: number): string {
  const tenths = Math.max(0, Math.floor(seconds * 10 + 1e-6))
  const hours = Math.floor(tenths / 36_000)
  const minutes = Math.floor(tenths / 600) % 60
  const rest = (tenths % 600) / 10
  const secondText = `${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${secondText}` : `${String(minutes)}:${secondText}`
}

/**
 * A length as a number to put in a unit.
 * @param seconds - the length.
 * @returns seconds with up to three decimals under ten seconds, such as `0.62`, one decimal under a minute, and the
 * clock above, such as `2:31.4`; the second element says whether the text is a number of seconds.
 */
export function lengthValue(seconds: number): readonly [text: string, inSeconds: boolean] {
  if (seconds >= 60) return [clockText(seconds), false]
  if (seconds >= 10) return [seconds.toFixed(1), true]
  return [String(Number(seconds.toFixed(3))), true]
}

/**
 * A linear amplitude as decibels relative to full scale.
 * @param amplitude - linear amplitude, where 1 is full scale.
 * @returns the level with one decimal and a true minus sign, such as `−6.0`; `−∞` for silence.
 */
export function decibelText(amplitude: number): string {
  if (amplitude <= 0) return '−∞'
  return (20 * Math.log10(amplitude)).toFixed(1).replace('-', '−')
}

/**
 * A sample rate in kilohertz.
 * @param rate - samples per second.
 * @returns the rate, such as `48` or `44.1`.
 */
export function kilohertzText(rate: number): string {
  return String(Number((rate / 1000).toFixed(rate % 100 === 0 ? 1 : 2)))
}
