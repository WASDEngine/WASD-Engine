/**
 * Render the WASDEngine Desktop icons from their vector sources beside them in `wasdengine/`,
 * and the blank-home animation atlas from the keycaps of the Windows icon source.
 *
 * The 1024 px application icons are rasterized from `icon-macos.svg` and `icon-windows.svg`,
 * and the multi-size Windows tray icon from the `tray-glyph` group of `icon-windows.svg`
 * with the upstream tray renderer. The home atlas replaces the frame atlas that the
 * `ui-brand-official` frame layer plays on a blank-home click: A, S, and D rise from below and W
 * drops in from above, W, A, S, D, and W press in turn, and the keycaps leave the way they came.
 * The Web install icons render from `icon-windows.svg` through
 * `apps/web/scripts/wasdengine-app-icons.ts`. The PNG, ICO, and WebP files are committed outputs;
 * rerun `pnpm exec tsx scripts/wasdengine-render-icons.ts` in `apps/desktop` after changing a source.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { packIco, renderTrayIconEntries } from './render-tray-icon.ts'
import { wasdengineBrandFile } from './wasdengine-builder-config.mjs'
import { WASDENGINE_DESKTOP_BRAND } from '../src/wasdengine-brand.ts'

/** Edge length of the application icons; electron-builder derives the macOS icon set from it. */
export const WASDENGINE_ICON_EDGE = 1024

/** Frame geometry of the home atlas; it must equal the `ATLAS` constant of the `ui-brand-official` renderer. */
export const WASDENGINE_HOME_ATLAS = { width: 192, height: 108, columns: 12, frames: 137 } as const

/** The frame atlas the `ui-brand-official` home frame layer imports. */
export const WASDENGINE_HOME_ATLAS_FILE = fileURLToPath(
  new URL('../../../packages/client/ui-brand-official/src/client/assets/breach-atlas.webp', import.meta.url))

/**
 * Atlas cells per icon-source unit, the source point drawn at the frame anchor (the outlined keycap cluster centre), and
 * that anchor as fractions of the frame. The renderer scales each frame to cover the whole home, so the keycaps keep
 * about the size and height of upstream's capped scene and enter at the window's edges.
 */
const HOME_SCALE = 0.1
const HOME_CENTER = { x: 557.5, y: 535 } as const
const HOME_ANCHOR = { x: 0.5, y: 0.43 } as const

/** Edge of one keycap body in icon-source units; its outline reaches a little beyond. */
const HOME_KEY_EDGE = 225

/**
 * Keyframes in atlas frames, per keycap in W, A, S, D order; offsets are atlas cells downwards.
 * W enters from above and leaves upwards, so it never crosses S.
 */
const HOME_RISE = { start: [15, 6, 9, 12], frames: 18, depth: 70 } as const
const HOME_PRESS = { keys: [[44, 0], [55, 1], [66, 2], [77, 3], [88, 0]], frames: 9, depth: 2.4 } as const
const HOME_SINK = { start: [106, 104, 102, 100], frames: 14, depth: 75 } as const
const HOME_ENTRY = [-1, 1, 1, 1] as const

/** Keycap luminance below the floor is empty; the remaining range maps onto the dot opacity up to the ceiling. */
const HOME_INK = { floor: 0.12, range: 0.6, ceiling: 0.68 } as const

/** One keycap group of the icon source: its origin and its shadow, body, and outline markup. */
interface HomeKey {
  readonly x: number
  readonly y: number
  readonly body: string
}

/** One dust particle, in atlas cells and frames. */
interface HomeParticle {
  readonly frame: number
  readonly x: number
  readonly y: number
  readonly dx: number
  readonly dy: number
  readonly life: number
  readonly radius: number
}

/**
 * Rasterize one application icon source at {@link WASDENGINE_ICON_EDGE} pixels.
 * @param svg - SVG document with a square viewBox of {@link WASDENGINE_ICON_EDGE} units.
 * @returns PNG bytes.
 */
export async function renderWasdengineIcon(svg: Buffer): Promise<Buffer> {
  return sharp(svg, { density: 72 }).resize(WASDENGINE_ICON_EDGE, WASDENGINE_ICON_EDGE).png({ compressionLevel: 9 }).toBuffer()
}

function homeKeys(source: string): readonly HomeKey[] {
  const glyph = source.indexOf('<g id="tray-glyph">')
  const keys = glyph < 0 ? [] : [...source.slice(glyph).matchAll(/<g transform="translate\((\d+) (\d+)\)">([\s\S]*?)<\/g>/gu)]
    .map(([, x, y, body]) => ({ x: Number(x), y: Number(y), body: body ?? '' }))
  if (keys.length !== 4) throw new Error('home atlas: the icon source needs four keycap groups in its tray-glyph group')
  return keys
}

function homeParticles(keys: readonly HomeKey[]): readonly HomeParticle[] {
  let seed = 0x9e3779b9
  const random = (from: number, to: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return from + (to - from) * seed / 0x1_0000_0000
  }
  const burst = (frame: number, key: HomeKey, count: number): HomeParticle[] => {
    const left = WASDENGINE_HOME_ATLAS.width * HOME_ANCHOR.x + (key.x - HOME_CENTER.x) * HOME_SCALE
    const bottom = WASDENGINE_HOME_ATLAS.height * HOME_ANCHOR.y + (key.y + HOME_KEY_EDGE - HOME_CENTER.y) * HOME_SCALE - 1
    return Array.from({ length: count }, (_, index) => {
      const side = index % 2 === 0 ? -1 : 1
      return {
        frame,
        x: side < 0 ? left + 1 : left + HOME_KEY_EDGE * HOME_SCALE - 1,
        y: bottom,
        dx: side * random(0.4, 1.3),
        dy: -random(0.2, 0.9),
        life: Math.floor(random(10, 15)),
        radius: random(0.55, 0.9),
      }
    })
  }
  return [
    ...keys.flatMap((key, index) => burst(HOME_RISE.start[index]! + HOME_RISE.frames - 4, key, 8)),
    ...HOME_PRESS.keys.flatMap(([frame, index]) => burst(frame + 2, keys[index]!, 6)),
  ]
}

/** Vertical offset and opacity of one keycap in one frame; undefined before it enters and after it leaves. */
function homeKeyState(index: number, frame: number): { offset: number; opacity: number } | undefined {
  const rise = (frame - HOME_RISE.start[index]!) / HOME_RISE.frames
  const sink = (frame - HOME_SINK.start[index]!) / HOME_SINK.frames
  if (rise < 0 || sink >= 1) return undefined
  // Ease out with a slight overshoot while entering; ease in while leaving.
  const settle = rise >= 1 ? 1 : 1 + 2.5 * (rise - 1) ** 3 + 1.5 * (rise - 1) ** 2
  const press = Math.max(0, ...HOME_PRESS.keys.filter(([, key]) => key === index)
    .map(([start]) => (frame - start) / HOME_PRESS.frames)
    .map(progress => progress > 0 && progress < 1 ? Math.sin(Math.PI * progress) : 0))
  return {
    offset: HOME_ENTRY[index]! * (HOME_RISE.depth * (1 - settle) + HOME_SINK.depth * Math.max(0, sink) ** 3) + HOME_PRESS.depth * press,
    opacity: 0.72 + 0.14 * press,
  }
}

function homeFrameDocument(defs: string, keys: readonly HomeKey[], particles: readonly HomeParticle[], frame: number): string {
  const { width, height } = WASDENGINE_HOME_ATLAS
  const keycaps = keys.flatMap((key, index) => {
    const state = homeKeyState(index, frame)
    if (state === undefined) return []
    return [`<g opacity="${state.opacity.toFixed(3)}" transform="translate(0 ${(state.offset / HOME_SCALE).toFixed(2)})">`
      + `<g transform="translate(${String(key.x)} ${String(key.y)})">${key.body}</g></g>`]
  })
  const dust = particles.flatMap((particle) => {
    const age = frame - particle.frame
    if (age < 0 || age >= particle.life) return []
    return [`<circle cx="${(particle.x + particle.dx * age).toFixed(2)}" cy="${(particle.y + particle.dy * age + 0.06 * age * age).toFixed(2)}"`
      + ` r="${particle.radius.toFixed(2)}" fill="#fff" fill-opacity="${(0.6 * (1 - age / particle.life)).toFixed(3)}"/>`]
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" fill="none">`
    + `${defs}<g transform="translate(${String(width * HOME_ANCHOR.x)} ${String(height * HOME_ANCHOR.y)}) scale(${String(HOME_SCALE)}) translate(${String(-HOME_CENTER.x)} ${String(-HOME_CENTER.y)})">`
    + `${keycaps.join('')}</g>${dust.join('')}</svg>`
}

/**
 * Render the home animation atlas from the keycaps of an icon source. Each atlas cell stores the
 * dot radius in red and the dot opacity in green, both at 32 levels, as the `ui-brand-official`
 * renderer reads them; the keycap luminance sets the opacity, so the ink outlines and the faint
 * shadows stay empty, the white A, S, and D keys draw brightest, and the purple W draws dimmer.
 * @param svg - Icon source with a `tray-glyph` group of four keycap groups, W first.
 * @returns Lossless WebP bytes: {@link WASDENGINE_HOME_ATLAS} frames in rows of `columns`.
 */
export async function renderWasdengineHomeAtlas(svg: Buffer): Promise<Buffer> {
  const source = svg.toString('utf8')
  const defs = /<defs>[\s\S]*?<\/defs>/u.exec(source)?.[0] ?? ''
  const keys = homeKeys(source)
  const particles = homeParticles(keys)
  const { width, height, columns, frames } = WASDENGINE_HOME_ATLAS
  const stride = width * columns
  const atlas = Buffer.alloc(stride * height * Math.ceil(frames / columns) * 3)
  const level = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 31) * 255 / 31
  for (let frame = 0; frame < frames; frame++) {
    const pixels = await sharp(Buffer.from(homeFrameDocument(defs, keys, particles, frame))).ensureAlpha().raw().toBuffer()
    const left = (frame % columns) * width
    const top = Math.floor(frame / columns) * height
    for (let index = 0; index < width * height; index++) {
      const at = index * 4
      const luminance = (0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!) / 255 * pixels[at + 3]! / 255
      const opacity = Math.min(1, Math.max(0, (luminance - HOME_INK.floor) / HOME_INK.range)) * HOME_INK.ceiling
      if (opacity === 0) continue
      const cell = ((top + Math.floor(index / width)) * stride + left + index % width) * 3
      atlas[cell] = Math.round(level(0.28 + 0.14 * opacity / HOME_INK.ceiling))
      atlas[cell + 1] = Math.round(level(opacity))
    }
  }
  return sharp(atlas, { raw: { width: stride, height: height * Math.ceil(frames / columns), channels: 3 } })
    .webp({ lossless: true }).toBuffer()
}

async function main(): Promise<void> {
  const { macOS, windows, tray } = WASDENGINE_DESKTOP_BRAND.icons
  const source = (icon: string): Promise<Buffer> => readFile(wasdengineBrandFile(icon.replace(/\.png$/u, '.svg')))
  await writeFile(wasdengineBrandFile(macOS), await renderWasdengineIcon(await source(macOS)))
  await writeFile(wasdengineBrandFile(windows), await renderWasdengineIcon(await source(windows)))
  await writeFile(wasdengineBrandFile(tray), packIco(await renderTrayIconEntries(await source(windows))))
  await writeFile(WASDENGINE_HOME_ATLAS_FILE, await renderWasdengineHomeAtlas(await source(windows)))
  console.info(`wasdengine icons: wrote ${[macOS, windows, tray].join(', ')} and ${WASDENGINE_HOME_ATLAS_FILE}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
