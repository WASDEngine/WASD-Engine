/**
 * WASD Engine's extension point of the sign-in dialog (fork-owned; `wasdengine/FORK.md` lists the fork changes):
 * another way to start than signing in, which another plugin contributes. While the dialog offers sign-in, it
 * renders the occupant as an offer beside its Sign in button; after the user takes the offer, it renders the
 * occupant as a panel in place of its welcome copy and buttons, under the logo and the close button. Each dialog
 * owner declares its own slot, because a slot has one declaring entry: the Get started dialog's sign-in step
 * declares `settings.account.onboarding.alternative`, and the account menu `settings.account.menu.alternative`.
 * Types only.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Classes of the dialog's own elements, which the occupant uses to look like the dialog. */
export interface SignInAlternativeClassNames {
  /** The dialog's copy column. */
  readonly content: string
  /** The dialog's title. */
  readonly title: string
  /** The dialog's description paragraph. */
  readonly description: string
  /** The dialog's stacked button row, which shows its first child at the bottom. */
  readonly actions: string
  /** The dialog's primary button inside its button row. */
  readonly primaryButton: string
  /** The dialog's secondary button inside its button row. */
  readonly secondaryButton: string
}

/** What the dialog passes to its sign-in alternative. */
export interface SignInAlternativeOwner {
  /** `offer`: one button among the dialog's buttons; `panel`: the alternative's own content and buttons. */
  readonly view: 'offer' | 'panel'
  /** Show the panel; the offer's button calls it. */
  readonly open: () => void
  /** Return from the panel to sign-in. */
  readonly back: () => void
  /** Close the dialog, as its close button does. */
  readonly close: () => void
  /** The dialog's classes. */
  readonly classNames: SignInAlternativeClassNames
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The sign-in alternative of the Get started dialog's sign-in step; without an occupant the dialog offers sign-in alone. */
    'settings.account.onboarding.alternative': { kind: 'single'; scope: 'root'; owner: SignInAlternativeOwner }
    /** The sign-in alternative of the account menu's sign-in dialog; without an occupant the dialog offers sign-in alone. */
    'settings.account.menu.alternative': { kind: 'single'; scope: 'root'; owner: SignInAlternativeOwner }
  }
}
