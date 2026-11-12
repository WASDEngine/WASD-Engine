/** WASD Engine: the guide cards that open from the More tools menu instead of the guide. */

/**
 * `kind:id` card ids that start unpinned, so the guide leaves them out and More tools lists them: New terminal
 * (`terminal:new`) and Code review and changes (`forge-panel:review`). Plugin reload restores this list.
 */
export const WASDENGINE_GUIDE_MORE_TOOLS: readonly string[] = ['terminal:new', 'forge-panel:review']
