/** Copy that the Plugins page tab and its notice toast derive from Host answers: lock reasons and switch outcomes. */
import type { ManagementError, ReadOnlyReason, RestartReason } from '@deepseek-ai/dsh-api-remotes/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { GameToolNotice } from './controller.ts'
import type { Translate } from './GameToolCard.tsx'
import type { GameToolsLocaleKey } from './locales.ts'

/** Why the Host refuses to switch a tool. */
const LOCKED_KEYS = {
  'management-required': 'lockedManagement',
  'unaddressable': 'lockedUnaddressable',
} as const satisfies Record<ReadOnlyReason, GameToolsLocaleKey>

/** Why a change waits for a restart. */
const RESTART_KEYS = {
  'no-hmr': 'restartNoHmr',
  'package-moved': 'restartPackageMoved',
  'host-module': 'restartHostModule',
  'unmanaged-plugin': 'restartUnmanagedPlugin',
  'module-comparison': 'restartModuleComparison',
} as const satisfies Record<RestartReason, GameToolsLocaleKey>

/** The Host refusals a switch can meet that read as a sentence of their own; any other refusal shows the Host's diagnostic. */
const REFUSAL_KEYS: Partial<Record<ManagementError['code'], GameToolsLocaleKey>> = {
  ...LOCKED_KEYS,
  'unknown-plugin': 'reasonUnknownPlugin',
}

/**
 * Say why the Host refuses to switch a tool.
 * @param reason - the Host's reason.
 * @param t - the `gameTools` copy seat.
 * @returns the sentence, which the locked switch shows as its hover text.
 */
export function lockedText(reason: ReadOnlyReason, t: Translate): string {
  return t(LOCKED_KEYS[reason])
}

/** Why a switch failed: the refusal's sentence, else the diagnostic as the Host or the Remote gave it. */
function failureReason(notice: Extract<GameToolNotice, { kind: 'failed' }>, t: Translate): string {
  const key = notice.code === undefined ? undefined : REFUSAL_KEYS[notice.code]
  if (key !== undefined) return t(key)
  return notice.message === '' ? t('reasonUnknown') : notice.message
}

/**
 * Say what a switch write left to say.
 * @param notice - the write's outcome, its tool, and the direction it was switched.
 * @param name - the tool's title in the current locale.
 * @param t - the `gameTools` copy seat.
 * @returns the toast text.
 */
export function noticeText(notice: GameToolNotice, name: string, t: Translate): string {
  switch (notice.kind) {
    case 'restart':
      // A Host that names no reason still asks for the restart.
      return notice.reason === undefined
        ? t('restartNotice', { name })
        : t('restartNoticeWithReason', { name, reason: t(RESTART_KEYS[notice.reason]) })
    case 'overridden':
      return t('overriddenNotice', { name })
    case 'failed':
      return t(notice.enabled ? 'enableFailed' : 'disableFailed', { name, reason: failureReason(notice, t) })
    /* v8 ignore next -- GameToolOutcome declares exactly these kinds. */
    default: return assertNever(notice, 'GameToolNotice')
  }
}
