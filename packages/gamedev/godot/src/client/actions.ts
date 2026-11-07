/** Game tab actions the Host refused or could not run, as the tab reports them. */
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../types.ts'

/**
 * Why an action failed; each issue has its own copy, and `failed` shows the Host's message. `sessionInUse` means
 * that Play could not resume the Session because another Host process writes it.
 */
export type GameIssue = 'noProject' | 'runtimeUnavailable' | 'notRunning' | 'staleRun' | 'tooManyRuns' | 'sessionInUse' | 'failed'

/** A refused or failed Game tab action: why it failed, the Host's explanation, and the run limit of `tooManyRuns`. */
export type GameFailure =
  | { readonly issue: 'tooManyRuns'; readonly message: string; readonly limit: number }
  | { readonly issue: Exclude<GameIssue, 'tooManyRuns'>; readonly message: string }

/**
 * Classify the outcome of one Game tab Remote call.
 * @param result - the call's result.
 * @returns undefined on success, else the failure the tab shows.
 */
export function failureOf(result: RemoteResult<unknown>): GameFailure | undefined {
  if (result.ok) return undefined
  const { error } = result
  switch (error.code) {
    case 'godot/no-project': return { issue: 'noProject', message: error.message }
    case 'godot/runtime-unavailable': return { issue: 'runtimeUnavailable', message: error.details.message }
    case 'godot/not-running': return { issue: 'notRunning', message: error.message }
    case 'godot/stale-run': return { issue: 'staleRun', message: error.message }
    case 'godot/too-many-runs': return { issue: 'tooManyRuns', message: error.message, limit: error.details.limit }
    case 'session/writer-held': return { issue: 'sessionInUse', message: error.message }
    // Gateway, cancellation, and codes of newer Hosts keep the Host's own message.
    default: return { issue: 'failed', message: error.message }
  }
}
