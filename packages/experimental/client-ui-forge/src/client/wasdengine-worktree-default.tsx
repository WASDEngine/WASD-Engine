/**
 * WASD Engine worktree default (fork-owned; `wasdengine/FORK.md` lists the fork changes): a
 * new Session in a game project that already has another Session asks for its own worktree,
 * as if the user had checked New worktree, so that parallel Sessions never change the same
 * checkout. The first Session of a project keeps working in the project folder. The option
 * is asked for once per Session in this Client, so unchecking New worktree keeps the Session
 * in the project folder.
 */

import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { GlobalStandardProps, HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgePanelState } from '../types.ts'
import type { PanelSnapshot } from './source.ts'

/** Business face of the renderless New Session occupant. */
export interface WorktreeDefaultInjected {
  /** Panel snapshot of the Session; the renderer binds it as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /** The new Session. */
  readonly sessionId: SessionId
  /** @returns true the first time this Client decides the Session's worktree, false afterwards. */
  readonly claim: () => boolean
  /**
   * Request a worktree from a base branch.
   * @param from - base branch, or null for HEAD.
   * @returns whether the Host accepted it.
   */
  readonly request: (from: string | null) => Promise<boolean>
}

/** Props the renderless occupant reads: the standard Workspace and Session list hooks, and its business face. */
export type WorktreeDefaultProps = Pick<GlobalStandardProps, 'useWorkspaces' | 'useSessions'> & InjectFace<WorktreeDefaultInjected>

/**
 * What the default decides for a panel state: `request` from the current branch while a
 * Session that has not started could still check New worktree, `decided` once it has a
 * request, a worktree, or a started turn, and nothing while the option is unusable or unknown.
 */
function decisionOf(state: ForgePanelState | null): { readonly kind: 'request'; readonly from: string | null } | { readonly kind: 'decided' } | undefined {
  if (state === null) return undefined
  const worktree = state.worktree
  if (worktree.request !== null || worktree.created !== null || worktree.creation !== null) return { kind: 'decided' }
  if (!worktree.editable) return { kind: 'decided' }
  if (worktree.blocker !== null || state.checkout.state !== 'ready') return undefined
  return { kind: 'request', from: state.checkout.checkout.branch }
}

/**
 * Request the Session's worktree once, when its game project already has another Session.
 * The project test follows the Workspace and Session lists, so a list that arrives after the
 * panel state still counts.
 * @param props - panel snapshot hook, the standard list hooks, the once-per-Session claim, and the request.
 * @returns nothing; the New worktree option shows the request.
 */
export function WorktreeDefault({ usePanel, useWorkspaces, useSessions, sessionId, claim, request }: WorktreeDefaultProps): null {
  const state = usePanel(snapshot => snapshot.state)
  const workspaces = useWorkspaces(snapshot => snapshot)
  const sessions = useSessions(snapshot => snapshot)
  const shared = sharesProject(workspaces, sessions, sessionId)
  const decision = decisionOf(state)
  const kind = decision?.kind
  const from = decision?.kind === 'request' ? decision.from : null
  useEffect(() => {
    if (kind === 'decided') claim()
    else if (kind === 'request' && shared && claim()) void request(from)
  }, [kind, from, shared, claim, request])
  return null
}

/**
 * Whether a visible Session other than `sessionId` belongs to its game project: not blank,
 * not archived, and not a subagent's.
 * @param workspaces - the Workspace list.
 * @param sessions - the Session list.
 * @param sessionId - the new Session.
 * @returns false while the Session's project is unknown.
 */
export function sharesProject(workspaces: WorkspaceSnapshot, sessions: SessionListState, sessionId: SessionId): boolean {
  const cwd = sessions.byId[sessionId]?.cwd
  const project = workspaces.items.find(item => item.sessionIds.includes(sessionId))
    ?? workspaces.items.find(item => cwd !== undefined && item.path === cwd)
  if (project === undefined) return false
  const archived = new Set(workspaces.archivedSessionIds)
  return project.sessionIds.some((id) => {
    const summary = sessions.byId[id]
    return id !== sessionId && !archived.has(id) && summary !== undefined && !summary.blank && summary.origin !== 'subagent'
  })
}

/**
 * Register the renderless occupant beside New worktree in the New Session options.
 * @param ctx - forge panel plugin context.
 * @param worktree - the New worktree option's business face for a Session.
 */
export function registerWorktreeDefault(
  ctx: Context,
  worktree: (sessionId: SessionId) => { readonly hooks: WorktreeDefaultInjected['hooks']; readonly request: WorktreeDefaultInjected['request'] },
): void {
  const claimed = new Set<SessionId>()
  ctx.effect(() => () => { claimed.clear() }, 'forge-panel: worktree default claims')
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'forge-panel.worktree-default',
    inject: (sessionId: SessionId): WorktreeDefaultInjected => {
      const face = worktree(sessionId)
      return {
        hooks: face.hooks,
        sessionId,
        request: face.request,
        claim: () => {
          if (claimed.has(sessionId)) return false
          claimed.add(sessionId)
          return true
        },
      }
    },
  }, WorktreeDefault))
}
