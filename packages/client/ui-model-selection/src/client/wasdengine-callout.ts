/**
 * Callouts beside the composer's model seat (fork-owned; `wasdengine/FORK.md` lists the fork changes). `ModelSelect`
 * renders the `conversation.input.model.callout` list after its trigger while the Session can select a model and has
 * one selected, so a plugin can point a card at the model and effort the seat shows. An occupant portals itself to the
 * document body and positions itself with the trigger's CSS anchor name.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** What the model seat tells each callout. */
export interface ModelCalloutOwner {
  /** CSS anchor name of the seat's trigger, a dashed ident for `position-anchor`. */
  anchor: string
  /** Whether the seat's menu is open. */
  menuOpen: boolean
  /** Whether the composer currently refuses selection changes. */
  locked: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Cards that point at the composer's model seat, rendered after its trigger while the Session can select a model
     * and has one selected. The composer contains its controls, so an occupant portals to the document body and
     * anchors to {@link ModelCalloutOwner.anchor}.
     */
    'conversation.input.model.callout': {
      kind: 'list'
      scope: 'session'
      owner: ModelCalloutOwner
    }
  }
}
