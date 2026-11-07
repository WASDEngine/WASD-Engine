/**
 * WASDEngine running icon (fork-owned; `wasdengine/FORK.md` lists the fork changes): the four keycaps of the
 * WASD Engine mark in purple, pressed W, A, S, and D in turn, each with its top face white while it is down, which
 * `RunningStatus` shows instead of the whale tail. Its stylesheet also turns the running status's text purple.
 */
import css from './wasdengine-running-keys.module.css'

type Tone = 'top' | 'side' | 'front' | 'ink' | 'lit'

/**
 * The parts of one keycap of the brand mark (`WASDENGINE_KEYCAP` in `ui-brand-official`) in its 225-unit frame,
 * back to front, with the mark's outline split in three: the rim and the corner diagonals stay with the base, and
 * the ring around the top face moves with the cap.
 */
const BASE: readonly (readonly [Tone, string])[] = [
  ['side', 'M36 0H189A36 36 0 0 1 225 36V189A36 36 0 0 1 189 225H36A36 36 0 0 1 0 189V36A36 36 0 0 1 36 0Z'],
  ['ink', 'M10.5525 10.5525A36 36 0 0 1 36 0H189A36 36 0 0 1 214.4475 10.5525L184.6575 17.8425L40.3425 17.8425Z'],
  ['side', 'M10.5525 214.4475A36 36 0 0 1 0 189V36A36 36 0 0 1 10.5525 10.5525L40.3425 17.8425L40.3425 157.6575Z'],
  ['side', 'M214.4475 10.5525A36 36 0 0 1 225 36V189A36 36 0 0 1 214.4475 214.4475L184.6575 157.6575L184.6575 17.8425Z'],
  ['front', 'M214.4475 214.4475A36 36 0 0 1 189 225H36A36 36 0 0 1 10.5525 214.4475L40.3425 157.6575L184.6575 157.6575Z'],
  ['ink', 'M36 -7.875H189A43.875 43.875 0 0 1 232.875 36V189A43.875 43.875 0 0 1 189 232.875H36A43.875 43.875 0 0 1 -7.875 189V36A43.875 43.875 0 0 1 36 -7.875ZM36 7.875A28.125 28.125 0 0 0 7.875 36V189A28.125 28.125 0 0 0 36 217.125H189A28.125 28.125 0 0 0 217.125 189V36A28.125 28.125 0 0 0 189 7.875Z'],
  ['ink', 'M3.5775 210.8025L33.3675 154.0125L47.3175 161.325L17.5275 218.115ZM207.4725 218.115L177.6825 161.325L191.6325 154.0125L221.4225 210.8025ZM12.42 2.9025L42.21 10.1925L38.475 25.4925L8.6625 18.2025ZM216.3375 18.2025L186.525 25.4925L182.79 10.1925L212.58 2.9025Z'],
]

const CAP: readonly (readonly [Tone, string])[] = [
  ['top', 'M56.25 11.25H168.75A22.5 22.5 0 0 1 191.25 33.75V141.75A22.5 22.5 0 0 1 168.75 164.25H56.25A22.5 22.5 0 0 1 33.75 141.75V33.75A22.5 22.5 0 0 1 56.25 11.25Z'],
  ['ink', 'M56.25 3.375H168.75A30.375 30.375 0 0 1 199.125 33.75V141.75A30.375 30.375 0 0 1 168.75 172.125H56.25A30.375 30.375 0 0 1 25.875 141.75V33.75A30.375 30.375 0 0 1 56.25 3.375ZM56.25 19.125A14.625 14.625 0 0 0 41.625 33.75V141.75A14.625 14.625 0 0 0 56.25 156.375H168.75A14.625 14.625 0 0 0 183.375 141.75V33.75A14.625 14.625 0 0 0 168.75 19.125Z'],
]

/** The cap of a pressed key: its top face white, under the same ring. */
const LIT_CAP: readonly (readonly [Tone, string])[] = CAP.map(([tone, d]) => [tone === 'top' ? 'lit' : tone, d])

/** One keycap frame, including the outline that reaches 7.875 units beyond the 225-unit body. */
const KEY_FRAME = '-7.875 -7.875 240.75 240.75'

/** The keys in pressing order; the sheet places each one where the brand mark draws it. */
const KEYS = ['w', 'a', 's', 'd'] as const

function KeyParts({ parts }: { readonly parts: readonly (readonly [Tone, string])[] }) {
  return (
    <svg className={css.layer} viewBox={KEY_FRAME} fill="none">
      {parts.map(([tone, d]) => <path key={d} className={css[tone]} d={d} />)}
    </svg>
  )
}

/**
 * Render the decorative running icon. Each key's cap is its own element, so the press is a transform animation
 * that the browser's compositor can run without repainting, and the white top of a pressed key is a copy of the cap
 * whose opacity the compositor animates; reduced motion leaves the keys at rest.
 * @returns the four keycaps, hidden from assistive technology.
 */
export function WasdengineRunningKeys() {
  return (
    <span className={css.keys} aria-hidden="true" data-wasdengine-running-keys="">
      {KEYS.map(key => (
        <span key={key} className={`${css.key} ${css[key]}`} data-key={key}>
          <KeyParts parts={BASE} />
          <span className={css.cap}>
            <KeyParts parts={CAP} />
            <span className={css.light}>
              <KeyParts parts={LIT_CAP} />
            </span>
          </span>
        </span>
      ))}
    </span>
  )
}
