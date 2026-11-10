/**
 * Setting WASD Engine up with another agent: the logos of the AI agents that can connect, the prompt to paste into one,
 * its copy button, and whether an agent connected. After sign-in, the Desktop introduction shows it as its last step
 * ({@link AgentSetupStep}), and Settings shows it as the Other agents section ({@link AgentSetupSection}).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button, IconCheckOutlineRegular, IconLinkOutlineMedium, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import chatgpt from './assets/ai-chatgpt.svg'
import claude from './assets/ai-claude.svg'
import deepseek from './assets/ai-deepseek.svg'
import gemini from './assets/ai-gemini.svg'
import glm from './assets/ai-glm.svg'
import grok from './assets/ai-grok.svg'
import kimi from './assets/ai-kimi.svg'
import minimax from './assets/ai-minimax.svg'
import type { NS } from './locales.ts'
import type { ServerSnapshot } from './source.ts'
import css from './AgentSetup.module.css'

/** How long the copy button says Copied, in milliseconds. */
const COPIED_MS = 2000

/**
 * The AI products whose agents connect to WASD Engine over MCP, in the website's order, as (name, key, logo). Each
 * logo file names its trademark owner and source; ChatGPT's carries its clear space, so its tile draws it larger.
 */
export const AGENT_LOGOS: readonly (readonly [name: string, key: string, src: string])[] = [
  ['ChatGPT', 'chatgpt', chatgpt], ['Claude', 'claude', claude], ['Gemini', 'gemini', gemini], ['Grok', 'grok', grok],
  ['MiniMax', 'minimax', minimax], ['DeepSeek', 'deepseek', deepseek], ['Kimi', 'kimi', kimi], ['GLM', 'glm', glm],
]

/** Registration-side dependencies of the setup's two places. */
export interface AgentSetupInjected {
  /** The followed server; the renderer binds it as `useServer`. */
  readonly hooks: { readonly server: HostObservable<ServerSnapshot> }
  /**
   * Put text on the clipboard.
   * @param text - the prompt.
   * @returns whether the host accepted the write.
   */
  readonly copyText: (text: string) => Promise<boolean>
}

/** Props of {@link AgentSetupStep}. */
export type AgentSetupStepProps = PropsRuntime<'settings.account.onboarding.agents'> & PropsLocale<typeof NS>
  & InjectFace<AgentSetupInjected>

/** Props of {@link AgentSetupSection}. */
export type AgentSetupSectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<AgentSetupInjected>

/** The setup's copy. */
type Translate = AgentSetupSectionProps['t']

/**
 * Draw the agents' logos on white tiles, as the website does, so the dark logos stay readable on dark themes.
 * @param props.label - the list's accessible name.
 * @returns the decorative list; each logo's alt text and tile title name its product.
 */
export function AgentLogos({ label }: { readonly label: string }) {
  return <ul className={css.logos} aria-label={label}>
    {AGENT_LOGOS.map(([name, key, src]) => <li key={key} className={css.logo} title={name}>
      <img src={src} alt={name} data-agent={key} draggable={false} />
    </li>)}
  </ul>
}

/** The status line under the prompt. */
function Status({ snapshot, t }: { snapshot: ServerSnapshot; t: Translate }) {
  const view = snapshot.view
  if (snapshot.disconnected) return <p className={css.status} role="status">{t('status.disconnected')}</p>
  if (view === null || view.state === 'starting') {
    return <p className={css.status} role="status"><IconLoadingOutlineRegular className={css.spinner} size={14} />{t('status.starting')}</p>
  }
  if (view.state === 'failed') return <p className={css.status} data-failed="" role="status">{t('status.failed', { message: view.message ?? '' })}</p>
  const client = view.clients[0]
  if (client !== undefined) {
    return <p className={css.status} data-connected="" role="status"><IconCheckOutlineRegular size={14} />{t('status.connected', { name: client.title })}</p>
  }
  return <p className={css.status} role="status"><IconLoadingOutlineRegular className={css.spinner} size={14} />{t('status.waiting')}</p>
}

/**
 * The read-only prompt with its copy button and the server's status.
 * @param props.snapshot - the followed server.
 * @param props.copyText - the clipboard write.
 * @param props.t - copy.
 * @returns the prompt box.
 */
function PromptBox({ snapshot, copyText, t }: { snapshot: ServerSnapshot; copyText: AgentSetupInjected['copyText']; t: Translate }) {
  const [copied, setCopied] = useState<'copied' | 'copyFailed' | null>(null)
  const promptArea: RefObject<HTMLTextAreaElement> = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => { setCopied(null) }, COPIED_MS)
    return () => { clearTimeout(timer) }
  }, [copied])
  const prompt = snapshot.view?.prompt
  const copy = (): void => {
    if (prompt === undefined) return
    void copyText(prompt).then((accepted) => {
      setCopied(accepted ? 'copied' : 'copyFailed')
      if (accepted) return
      // A host that refuses clipboard writes, such as an embedded browser, still copies a keyboard selection.
      promptArea.current?.focus()
      promptArea.current?.select()
    })
  }
  return <div className={css.box}>
    <textarea ref={promptArea} className={css.prompt} readOnly rows={5} value={prompt ?? ''} aria-label={t('prompt.label')}
      onFocus={(event) => { event.currentTarget.select() }} />
    <div className={css.boxFooter}>
      <Status snapshot={snapshot} t={t} />
      <Button variant="outline" size="sm" className={css.copy} disabled={prompt === undefined} onClick={copy}>{t(copied ?? 'copy')}</Button>
    </div>
  </div>
}

/**
 * The Desktop introduction's last step, after sign-in: the heading, the agents' logos, the prompt, and Continue,
 * which finishes the introduction whether or not an agent connected.
 * @param props - the introduction's heading, state, finish action, and classes, the followed server, and copy.
 * @returns the step's page.
 */
export function AgentSetupStep({ heading, headingId, busy, next, classNames, useServer, copyText, t }: AgentSetupStepProps) {
  const snapshot = useServer(value => value)
  return <div className={classNames.content}>
    <div className={classNames.copy}>
      <h1 id={headingId} ref={heading} tabIndex={-1}>{t('title')}</h1>
      <p className={classNames.subtitle}>{t('description')}</p>
    </div>
    <div className={css.step}>
      <AgentLogos label={t('logos.label')} />
      <PromptBox snapshot={snapshot} copyText={copyText} t={t} />
    </div>
    <div className={classNames.primaryAction}>
      <Button className={classNames.action} variant="primary" aria-disabled={busy} onClick={() => { if (!busy) next() }}>
        {t('continue')}
      </Button>
    </div>
  </div>
}

/**
 * The Other agents section of Settings: the same setup, for agents to connect later.
 * @param props - the followed server and copy.
 * @returns the section.
 */
export function AgentSetupSection({ useServer, copyText, t }: AgentSetupSectionProps) {
  const snapshot = useServer(value => value)
  return <section className={css.section} aria-labelledby="game-mcp-agent-setup-title">
    <h2 id="game-mcp-agent-setup-title" className={css.heading}>{t('title')}</h2>
    <p className={css.intro}>{t('description')}</p>
    <AgentLogos label={t('logos.label')} />
    <PromptBox snapshot={snapshot} copyText={copyText} t={t} />
  </section>
}

/**
 * The Other agents section's icon in the Settings navigation: a link, for the agents that connect.
 * @param props.size - the navigation's icon size.
 * @returns the icon.
 */
export function AgentSetupIcon({ size }: PropsRuntime<'settings.section.icon'>) {
  return <IconLinkOutlineMedium size={size} />
}
