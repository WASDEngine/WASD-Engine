/**
 * WASD Engine's model seat (fork-owned; `wasdengine/FORK.md` lists the fork changes): the account provider serves
 * WASD Engine's own model, which the user does not choose, so while it is selected the composer's model seat shows the
 * reasoning effort alone, and its menu offers the effort and the session options, such as agent teamwork, without the
 * Model row. `ModelSelect` asks {@link wasdengineEffortOnly}.
 */

/** The provider of WASD Engine's own model: the signed-in account, served through the WASD Engine gateway. */
export const WASDENGINE_MODEL_PROVIDER = 'deepseek-account'

/**
 * Whether the model seat shows the effort alone for the selected provider.
 * @param provider - id of the selected model's provider; undefined while nothing is selected.
 * @returns true for WASD Engine's own model.
 */
export function wasdengineEffortOnly(provider: string | undefined): boolean {
  return provider === WASDENGINE_MODEL_PROVIDER
}
