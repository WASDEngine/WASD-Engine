/**
 * The question composer's answer images: the attach button, paste and drop
 * intake onto the card, the shown question's thumbnails, and the steered
 * message that carries the images just before the answer batch.
 */
import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { IconPaperclipOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingQuestion, QuestionComposerProps } from './contract/slots.ts'
import {
  reasonFeedback, refusalFeedback, type ImageFeedback, type QuestionImage, type QuestionImagesSnapshot,
} from './question-images.ts'
import { QuestionImages, type QuestionImagesLabels } from './QuestionImages.tsx'
import css from './QuestionImages.module.css'

const NO_IMAGES: readonly QuestionImage[] = []

/**
 * Stand-in for a composition that injects no answer images: it reads no
 * source, so the card renders the plain question flow.
 * @param _key - the card's key.
 * @param selector - reads the image list from an absent snapshot.
 * @returns the selector's value for no images.
 */
function useNoImages<Selected>(_key: string, selector: (snapshot: QuestionImagesSnapshot | undefined) => Selected): Selected {
  return selector(undefined)
}

/** What the composer hands the answer images. */
export interface AnswerImagesInput {
  /** The card. */
  readonly pending: PendingQuestion
  /** Index of the shown question, which takes new images. */
  readonly index: number
  /** Whether a submission or a read-only card froze the answer. */
  readonly locked: boolean
  /** The `question` namespace translator. */
  readonly t: QuestionComposerProps['t']
  /** Reads the deployment's image limits. */
  readonly useProjection: QuestionComposerProps['useProjection']
  /** Reads the card's images; absent when the composition injects none. */
  readonly useQuestionImages: QuestionComposerProps['useQuestionImages']
  /** The Session-bound image verbs; absent when the composition injects none. */
  readonly intake: QuestionComposerProps['questionImageIntake']
  /** Called after images were attached to the shown question. */
  readonly onAttached: () => void
  /** Shows one line in the card's feedback area. */
  readonly onFeedback: (feedback: ImageFeedback) => void
}

/** Drag-and-drop handlers for the card, which take file drags away from the conversation's own drop target. */
export interface AnswerImagesDropTarget {
  /** Class that marks the card while files are dragged over it. */
  readonly className: string | undefined
  readonly onDragEnter: (event: DragEvent<HTMLElement>) => void
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void
  readonly onDrop: (event: DragEvent<HTMLElement>) => void
}

/** The answer images of one rendered card. */
export interface AnswerImages {
  /**
   * Count the images attached to one question's answer, failed ones excluded.
   * @param question - index of the question.
   * @returns the count.
   */
  count(question: number): number
  /** Why the images keep the batch from being submitted now, or `undefined`. */
  readonly blocker: ImageFeedback | undefined
  /** Whether uploaded images wait for the message that carries them. */
  readonly unsent: boolean
  /**
   * Steer the uploaded images as one message, each question's images after its heading.
   * @param heading - text placed before one question's images.
   * @returns failure feedback, or `undefined` once the Host accepted the message or no image waited.
   */
  send(heading: (question: number) => string): Promise<ImageFeedback | { text: string } | undefined>
  /**
   * Drop one question's unsent images, as skipping the question does.
   * @param question - index of the question.
   */
  clear(question: number): void
  /** Drag-and-drop handlers for the card. */
  readonly drop: AnswerImagesDropTarget
  /** Paste handler for the answer surface: pasted images attach to the shown question. */
  readonly onPaste: (event: ClipboardEvent<HTMLElement>) => void
  /** The shown question's thumbnails. */
  readonly strip: ReactNode
  /** The attach button, or nothing when the card takes no images. */
  readonly button: ReactNode
}

/**
 * Bind the answer images of one rendered card. A card takes images while the
 * composition injects the image verbs, the Session reports its image limits,
 * and the card is not a read-only review.
 * @param input - the card, its shown question, and the composer's seats.
 * @returns the images' handlers and rendered parts.
 */
export function useAnswerImages(input: AnswerImagesInput): AnswerImages {
  const { pending, index, locked, t, intake } = input
  const useImages = input.useQuestionImages ?? useNoImages
  const images = useImages(pending.key, snapshot => snapshot?.images ?? NO_IMAGES)
  const limits = input.useProjection('imageLimits')
  const takesImages = intake !== undefined && limits !== undefined && pending.review === undefined
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dropping, setDropping] = useState(false)

  const attach = (files: readonly File[]): void => {
    if (intake === undefined || limits === undefined || !takesImages || locked || files.length === 0) return
    const refusal = intake.add(pending.key, index, files, limits)
    if (refusal === undefined) input.onAttached()
    else input.onFeedback(refusalFeedback(refusal))
  }

  const carriesFiles = (event: DragEvent<HTMLElement>): boolean => takesImages && event.dataTransfer.types.includes('Files')

  const nameOf = (image: QuestionImage): string => image.name === '' ? t('images.unnamed') : image.name
  const labels: QuestionImagesLabels = {
    group: t('images.group'),
    image: image => image.status === 'uploading' ? t('images.uploading', { name: nameOf(image) }) : nameOf(image),
    remove: image => t('images.remove', { name: nameOf(image) }),
    failed: (reason) => {
      const feedback = reasonFeedback(reason, limits)
      return t(feedback.key, feedback.params)
    },
  }

  const shown = images.filter(image => image.question === index)
  return {
    count: question => images.filter(image => image.question === question && image.status !== 'failed').length,
    blocker: images.some(image => image.status === 'uploading')
      ? { key: 'images.pending' }
      : images.some(image => image.status === 'failed') ? { key: 'images.failedPresent' } : undefined,
    unsent: images.some(image => image.status === 'ready'),
    send: async (heading) => {
      if (intake === undefined) return undefined
      let result: Awaited<ReturnType<typeof intake.send>>
      try {
        result = await intake.send(pending.key, heading)
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error) }
      }
      if (result.ok) return undefined
      const failure = result.error
      if (failure.code !== 'session/attachment-invalid') return { text: failure.message }
      return reasonFeedback(failure.details.reason, limits)
    },
    clear: (question) => { intake?.clear(pending.key, question) },
    drop: {
      className: dropping ? css.dropping : undefined,
      onDragEnter: (event) => {
        if (!carriesFiles(event)) return
        // The conversation's own document listeners would add the files to the hidden composer draft.
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current += 1
        if (!locked) setDropping(true)
      },
      onDragOver: (event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = locked ? 'none' : 'copy'
      },
      onDragLeave: (event) => {
        if (!carriesFiles(event)) return
        event.stopPropagation()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropping(false)
      },
      onDrop: (event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current = 0
        setDropping(false)
        attach([...event.dataTransfer.files])
      },
    },
    onPaste: (event) => {
      if (!takesImages || locked) return
      const pasted = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'))
      if (pasted.length === 0) return
      event.preventDefault()
      attach(pasted)
    },
    strip: (
      <QuestionImages
        images={shown}
        locked={locked}
        labels={labels}
        onRemove={(id) => { intake?.remove(pending.key, id) }}
      />
    ),
    button: !takesImages ? null : (
      <>
        <input
          ref={fileInput}
          type="file"
          accept={limits.mediaTypes.join(',')}
          multiple
          hidden
          onChange={(event) => {
            const picked = event.target.files === null ? [] : [...event.target.files]
            // Reset so picking the same file again fires the change event.
            event.target.value = ''
            attach(picked)
          }}
        />
        <Tooltip label={t('images.add')} side="top" delayMs={500} portal>
          <button
            type="button"
            className={css.attach}
            aria-label={t('images.add')}
            disabled={locked}
            onClick={() => { fileInput.current?.click() }}
          >
            <IconPaperclipOutlineRegular />
          </button>
        </Tooltip>
      </>
    ),
  }
}
