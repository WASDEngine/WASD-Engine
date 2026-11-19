/**
 * Ends the user's first prompt for a new game with the deployment's guidance. When the first message from the user
 * in a top-level Session enters a step while the Session's project folder holds nothing yet, only hidden entries, such
 * as the `.git` folder of a new game project, and system files, the plugin enters the configured text as its own
 * message right after that prompt, so the model reads it at the end of the prompt. The message's `new-game-guidance`
 * source lets the conversation leave it out; the Session log keeps it like every other model-visible input.
 * @module @deepseek-ai/dsh-new-game-guidance
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FileSystem, FsDirEntry } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The guidance that follows the user's first prompt for a new game. */
    'new-game-guidance': { kind: 'new-game-guidance' }
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'new-game-guidance'

/** The Session projections that remember whether the user prompted, and the filesystem that lists the project folder. */
export const inject = ['sessionProjections', 'fs']

/** Plugin configuration. */
export interface Config {
  /** The guidance, exactly as the model reads it after the first prompt; text that is only whitespace fails at load. */
  text: string
}

/** Schemastery configuration; the deployment chooses the guidance. */
export const Config: z<Config> = z.object({
  text: z.string().required(),
})

/** Files that Windows leaves in folders, which a game project holds without anyone adding them. */
const SYSTEM_FILES: ReadonlySet<string> = new Set(['Thumbs.db', 'desktop.ini'])

/** Host-only projection key of whether the Session logged a message from the user. */
const PROMPTED = 'newGameGuidancePrompted'

/**
 * Whether a message came from the user, as the composer sends it.
 * @param message - a message entering the step.
 * @returns true for the user's own message.
 */
function fromUser(message: UserMessage): boolean {
  return message.source.kind === 'user'
}

/**
 * Fold one committed event into whether the Session logged a message from the user; a forked Session's inherited
 * history counts.
 * @param prompted - whether an earlier event was a message from the user.
 * @param event - the next committed event.
 * @returns true once the log holds a message from the user, the same value otherwise.
 */
function foldPrompted(prompted: boolean, event: SessionEvent): boolean {
  return prompted || (event.type === 'user/message' && event.data.source.kind === 'user')
}

/**
 * Whether a project folder holds nothing yet: only hidden entries, such as the `.git` folder a new game project gets,
 * and system files.
 * @param fs - the filesystem of the Session's execution world.
 * @param folder - the absolute project folder.
 * @param signal - the step's cancellation.
 * @returns false for a folder that cannot be listed.
 * @throws the signal's reason once the step is cancelled.
 */
async function holdsNothing(fs: FileSystem, folder: string, signal: AbortSignal): Promise<boolean> {
  let entries: FsDirEntry[]
  try {
    entries = await fs.listDir(await fs.resolve(folder, { signal }), signal)
  } catch (_unlisted) {
    signal.throwIfAborted()
    // A folder that was moved or deleted after the Session started, or that cannot be read, is not known to be new.
    return false
  }
  return entries.every(entry => entry.name.startsWith('.') || SYSTEM_FILES.has(entry.name))
}

/**
 * Register the projection that remembers whether the user prompted, then the listener that adds the guidance.
 * @param ctx - plugin context with every {@link inject} service; the listener leaves with its fiber.
 * @param config - validated {@link Config}.
 * @returns after the projection is registered and the listener installed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const text = config.text
  if (text.trim() === '') throw new TypeError('new-game-guidance: text must not be blank')
  const prompted = await ctx.sessionProjections.register({
    key: PROMPTED,
    stateVersion: 1,
    stateSchema: zod.boolean(),
    init: () => false,
    apply: foldPrompted,
  })

  // Prepended, so it runs around the listeners that add other context to the step and can place the guidance right
  // after the prompt, ahead of that context.
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const { session } = agent
    // A subagent's first message comes from its parent agent, not from the user.
    if (session.header.origin === 'subagent') return decision
    const prompt = decision.messages.findLastIndex(fromUser)
    if (prompt < 0 || prompted.stateOf(session)) return decision
    const folder = session.header.cwd
    if (folder === undefined || !await holdsNothing(ctx.fs, folder, signal)) return decision
    const guidance = createUserMessage({ content: [{ type: 'text', text }], source: { kind: name } })
    return { ...decision, messages: decision.messages.toSpliced(prompt + 1, 0, guidance) }
  }, { prepend: true })
}
