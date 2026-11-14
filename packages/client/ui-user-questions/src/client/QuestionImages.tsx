import { IconCloseFillRegular, IconWarningOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionImage } from './question-images.ts'
import css from './QuestionImages.module.css'

/** Copy the thumbnail strip shows, resolved by the composer from the `question` namespace. */
export interface QuestionImagesLabels {
  /** Accessible name of the strip. */
  readonly group: string
  /**
   * Accessible name of one thumbnail.
   * @param image - the attached image.
   * @returns its name, with its upload state while it uploads.
   */
  readonly image: (image: QuestionImage) => string
  /**
   * Accessible label of one image's remove button.
   * @param image - the attached image.
   * @returns the label naming the image.
   */
  readonly remove: (image: QuestionImage) => string
  /**
   * Why one image failed to upload.
   * @param reason - the Host's refusal reason, when it gave one.
   * @returns the explanation shown on the failed thumbnail.
   */
  readonly failed: (reason: string | undefined) => string
}

/**
 * Thumbnails of the images attached to the shown question's answer, in the
 * look of the conversation composer's image drafts. An uploading image shows
 * an indeterminate bar, a failed one its reason, and every image no message
 * carried yet a remove button.
 * @param props.images - the shown question's images, in the order they were added.
 * @param props.locked - whether a submission or a read-only card froze the answer.
 * @param props.labels - resolved copy.
 * @param props.onRemove - removes one image.
 * @returns the strip, or nothing while the question has no images.
 */
export function QuestionImages({ images, locked, labels, onRemove }: {
  images: readonly QuestionImage[]
  locked: boolean
  labels: QuestionImagesLabels
  onRemove: (id: string) => void
}) {
  if (images.length === 0) return null
  return (
    <ul className={css.strip} aria-label={labels.group}>
      {images.map((image) => {
        const failure = image.status === 'failed' ? labels.failed(image.reason) : undefined
        return (
          <li key={image.id} className={css.item} data-status={image.status}>
            {failure === undefined
              ? (
                <span className={css.thumbnail} aria-busy={image.status === 'uploading'}>
                  <img src={image.previewUrl} alt={labels.image(image)} />
                </span>
              )
              : (
                <Tooltip label={failure} side="top" delayMs={300} portal openOnClick>
                  <button type="button" className={`${css.thumbnail} ${css.thumbnailFailed}`} aria-label={failure}>
                    <img src={image.previewUrl} alt={labels.image(image)} />
                    <span className={css.failureGlyph} aria-hidden><IconWarningOutlineRegular size={16} /></span>
                  </button>
                </Tooltip>
              )}
            {image.status === 'uploading' && (
              <span className={css.progressTrack} aria-hidden>
                <span className={css.progressBar} />
              </span>
            )}
            {image.status !== 'sent' && !locked && (
              <button
                type="button"
                className={css.remove}
                aria-label={labels.remove(image)}
                onClick={() => { onRemove(image.id) }}
              >
                <IconCloseFillRegular size={12} />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
