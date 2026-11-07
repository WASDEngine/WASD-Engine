/**
 * Transcript cards of the Godot tools: `godot_screenshot`, and `godot_input`
 * and `godot_wait`, which show their screenshot when the result carries one.
 * A card owns every call of its tool, so running, failed, interrupted, and
 * image-free results render as a row whose body shows the result text.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { DisclosureRow, ImageLightbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { ToolCallOwnerProps, ToolCallPhaseProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { GameControllerIcon } from './icon.tsx'
import type { GodotUiKey, NS } from './locales.ts'
import css from './cards.module.css'

/** Tool names whose calls render as Godot cards. */
export const GODOT_CARD_TOOLS = ['godot_screenshot', 'godot_input', 'godot_wait'] as const

/** Props a Godot tool card reads: the tool view's owner share and the copy. */
export type GodotToolCardProps = ToolCallOwnerProps & PropsLocale<typeof NS>

type Translate = GodotToolCardProps['t']

/** What a card shows of one call. */
export interface ToolCardModel {
  /** Call state: running until the result arrives, then its outcome. */
  readonly state: 'running' | 'ok' | 'error' | 'stopped'
  /** Displayable screenshots of the result, in result order. */
  readonly images: readonly ImageAttachmentRef[]
  /** Whether the result carried an image block that cannot be displayed. */
  readonly invalidImages: boolean
  /** The result's text blocks, joined by newlines. */
  readonly text: string
}

const RUNNING: ToolCardModel = { state: 'running', images: [], invalidImages: false, text: '' }

/** Media types a durable image block may claim (the attachment service's `ImageMediaType`). */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Derive what the card shows from the call's phase data. Result content comes
 * from the Session log, so a block of an unexpected form is skipped and an
 * image reference that cannot load is counted instead of rendered.
 * @param view - the call phase and its block.
 * @returns the card model.
 */
export function toolCardModel(view: ToolCallPhaseProps): ToolCardModel {
  if (view.phase !== 'result') return RUNNING
  const { block } = view
  const images: ImageAttachmentRef[] = []
  const texts: string[] = []
  let invalidImages = false
  for (const part of block.content) {
    const value: unknown = part
    if (typeof value !== 'object' || value === null) continue
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (part.type === 'image') {
      if (displayable(part.attachment)) images.push(part.attachment)
      else invalidImages = true
    }
  }
  const state = block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  return { state, images, invalidImages, text: texts.join('\n') }
}

function displayable(attachment: ImageAttachmentRef): boolean {
  const value: unknown = attachment
  if (typeof value !== 'object' || value === null) return false
  const { attachmentId, mediaType, bytes, width, height } = attachment
  return typeof attachmentId === 'string' && attachmentId !== '' && IMAGE_MEDIA_TYPES.has(mediaType)
    && positive(bytes) && positive(width) && positive(height)
}

function positive(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function titleKey(toolName: string): GodotUiKey {
  switch (toolName) {
    case 'godot_screenshot': return 'card.screenshot'
    case 'godot_input': return 'card.input'
    default: return 'card.wait'
  }
}

function summaryOf(model: ToolCardModel, t: Translate): string | undefined {
  switch (model.state) {
    case 'running': return undefined
    case 'stopped': return t('card.stopped')
    case 'error': return t('card.failed')
    case 'ok': {
      const [first] = model.images
      if (first !== undefined) return t('card.size', { width: first.width, height: first.height })
      const line = model.text.split('\n', 1)[0]
      return line === '' ? undefined : line
    }
    /* v8 ignore next -- closed ToolCardModel state union exhaustiveness guard */
    default: return assertNever(model.state, 'ToolCardModel.state')
  }
}

/**
 * Render one Godot tool call as a collapsible row whose body shows the screenshots and the result text.
 * @param props - the tool call, the image loader, the disclosure hook, and copy.
 * @returns the card.
 */
export function GodotToolCard(props: GodotToolCardProps): ReactNode {
  const { toolName, loadImage, useDisclosure, inspect, t } = props
  const { expanded, toggle } = useDisclosure()
  const model = toolCardModel(props)
  const summary = summaryOf(model, t)
  const expandable = model.images.length > 0 || model.invalidImages || model.text !== '' || inspect !== undefined
  return (
    <div className={css.card} data-tool={toolName} data-state={model.state}>
      <DisclosureRow
        title={t(titleKey(toolName))}
        icon={<GameControllerIcon size={14} />}
        running={model.state === 'running'}
        open={expanded && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        collapsedContent={summary === undefined ? undefined : <span className={css.summary}>{summary}</span>}
      >
        <div className={css.body}>
          {model.images.map((image, index) => (
            <Screenshot key={`${image.attachmentId}:${String(index)}`} image={image} loadImage={loadImage} t={t} />
          ))}
          {model.invalidImages && <p className={css.invalid}>{t('card.invalid')}</p>}
          {model.text !== '' && <pre className={css.text}>{model.text}</pre>}
          {inspect !== undefined && <button type="button" className={css.inspect} onClick={inspect}>{t('card.inspect')}</button>}
        </div>
      </DisclosureRow>
    </div>
  )
}

function Screenshot({ image, loadImage, t }: {
  readonly image: ImageAttachmentRef
  readonly loadImage: ToolCallOwnerProps['loadImage']
  readonly t: Translate
}): ReactNode {
  const [url, setUrl] = useState<string | null>(() => loadImage.peek?.(image) ?? null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    setFailed(false)
    void loadImage(image).then((loaded) => { if (live) setUrl(loaded) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [image, loadImage, attempt])
  if (failed) {
    return (
      <button type="button" className={css.retry} onClick={() => { setAttempt(count => count + 1) }}>
        {t('card.loadFailed')}
      </button>
    )
  }
  const ratio = { '--godot-shot-ratio': `${String(image.width)} / ${String(image.height)}` } as CSSProperties
  return (
    <>
      <button type="button" className={css.shot} style={ratio} aria-label={t('card.open')} disabled={url === null}
        onClick={() => { setOpen(true) }}>
        {url === null ? <span className={css.loading}>{t('card.loading')}</span> : <img className={css.image} src={url} alt={t('card.screenshot')} />}
      </button>
      {open && url !== null && (
        <ImageLightbox src={url} alt={t('card.screenshot')} labels={{ dialog: t('card.preview'), close: t('card.close') }}
          onClose={() => { setOpen(false) }} />
      )}
    </>
  )
}
