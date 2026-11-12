/** The Audio tab's waveform: the lowest and highest sample of every column of a decoded sound, drawn as one shape. */

/**
 * Find the lowest and highest sample of every channel in each column.
 * @param buffer - the decoded sound.
 * @param columns - columns across the waveform.
 * @returns `2 * columns` values: each column's lowest, then highest sample, from -1 to 1 for unclipped sound.
 */
export function waveformPeaks(buffer: Pick<AudioBuffer, 'length' | 'numberOfChannels' | 'getChannelData'>, columns: number): Float32Array {
  const peaks = new Float32Array(columns * 2)
  const frames = buffer.length
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const plane = buffer.getChannelData(channel)
    for (let column = 0; column < columns; column++) {
      const first = Math.floor(column * frames / columns)
      const last = Math.max(first + 1, Math.floor((column + 1) * frames / columns))
      let low = channel === 0 ? Infinity : peaks[column * 2] ?? 0
      let high = channel === 0 ? -Infinity : peaks[column * 2 + 1] ?? 0
      for (let frame = first; frame < last && frame < frames; frame++) {
        const value = plane[frame] ?? 0
        if (value < low) low = value
        if (value > high) high = value
      }
      peaks[column * 2] = Number.isFinite(low) ? low : 0
      peaks[column * 2 + 1] = Number.isFinite(high) ? high : 0
    }
  }
  return peaks
}

/** Half the thickness of the line a silent column draws, in full-scale units. */
const HAIRLINE = 0.006

/**
 * The SVG path of a waveform over the view box `0 -1 <columns> 2`: the highest samples left to right through the
 * columns' centers, then the lowest back, so the shape fills between them; a silent stretch draws a hairline.
 * @param peaks - the output of {@link waveformPeaks}.
 * @returns the path data; empty without columns.
 */
export function waveformPath(peaks: Float32Array): string {
  const columns = peaks.length / 2
  if (columns === 0) return ''
  const highs: number[] = []
  const lows: number[] = []
  for (let column = 0; column < columns; column++) {
    const low = Math.max(-1, peaks[column * 2] ?? 0)
    const high = Math.min(1, peaks[column * 2 + 1] ?? 0)
    const middle = (low + high) / 2
    highs.push(Math.max(high, middle + HAIRLINE))
    lows.push(Math.min(low, middle - HAIRLINE))
  }
  // SVG's y axis points down, so a positive sample has a negative y.
  const point = (x: number, value: number): string => `${x.toFixed(1)},${(-value).toFixed(4)}`
  const top = highs.map((value, column) => point(column + 0.5, value))
  const bottom = lows.map((value, column) => point(column + 0.5, value)).reverse()
  const last = columns - 1
  return `M${point(0, highs[0] ?? 0)}L${top.join('L')}L${point(columns, highs[last] ?? 0)}L${point(columns, lows[last] ?? 0)}L${bottom.join('L')}L${point(0, lows[0] ?? 0)}Z`
}
