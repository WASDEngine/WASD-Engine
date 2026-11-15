/**
 * Images the user attaches to the answers of one question card. They live in
 * the Client only: each image uploads to the Session as soon as it is added,
 * and the card sends the uploaded ones as one steered user message just
 * before it submits the answer batch. The agent waits inside the
 * `ask_user_question` call until that batch arrives, so its next model
 * request carries the answers and the images together. The message's source
 * marks it as part of the answer (`answersQuestion`), so plugins that react
 * to the user steering a turn, such as the todo continuation, tell it apart
 * from a new instruction.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentLimits, ImageMediaType } from '@deepseek-ai/dsh-attachment/types'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
// Type-only: the `fileUpload` service's Context merge.
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { ImageUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { QuestionKey } from './locales.ts'

/** One attached image and the state of its upload. */
export interface QuestionImage {
  /** Card-local identity. */
  readonly id: string
  /** Index of the question whose answer the image belongs to. */
  readonly question: number
  /** The picked file's name; empty for a pasted image without one. */
  readonly name: string
  /** Browser object URL of the picked file, shown as the thumbnail. */
  readonly previewUrl: string
  /**
   * `uploading` until the Host stores the image, `ready` to send, `sent` once a
   * steered message carried it, and `failed` when the upload did not store it.
   */
  readonly status: 'uploading' | 'ready' | 'sent' | 'failed'
  /** The Host's refusal reason (`details.reason` of an attachment error), when it gave one. */
  readonly reason?: string
}

/** Every image attached to one card, in the order the user added them. */
export interface QuestionImagesSnapshot {
  readonly images: readonly QuestionImage[]
}

/** Why a set of picked files was not attached. */
export type QuestionImageRefusal =
  | { readonly kind: 'type' }
  | { readonly kind: 'count'; readonly max: number }
  | { readonly kind: 'size'; readonly max: number }
  | { readonly kind: 'total'; readonly max: number }

/**
 * Store one image for the Session that owns the card.
 * @param file - the picked or pasted image.
 * @param mediaType - its accepted media type.
 * @param signal - aborts the upload when the user removes the image.
 * @returns the upload receipt, or the Host's refusal.
 */
export type QuestionImageUpload = (file: File, mediaType: ImageMediaType, signal: AbortSignal) => Promise<RemoteResult<ImageUploadValue>>

/**
 * Steer one user message into the Session that owns the card, marked as part
 * of the answer to the card's question.
 * @param content - text headings and upload receipts, in order.
 * @returns the Host's acceptance, or its refusal.
 */
export type QuestionImageSend = (content: PromptContentPart[]) => Promise<RemoteResult<{ accepted: true }>>

/** The Session-bound verbs a card's images use, injected into the composer. */
export interface QuestionImageIntake {
  /**
   * Attach files to one question's answer and start their uploads. Files that
   * are not accepted images, or that break a limit, refuse the whole set.
   * @param key - the card's key.
   * @param question - index of the question the files answer.
   * @param files - picked, pasted, or dropped files.
   * @param limits - the deployment's image limits.
   * @returns why the set was refused, or `undefined` when it was attached.
   */
  add(key: string, question: number, files: readonly File[], limits: ImageAttachmentLimits): QuestionImageRefusal | undefined
  /**
   * Remove one image that no message carried yet, aborting its upload.
   * @param key - the card's key.
   * @param id - the image's identity.
   */
  remove(key: string, id: string): void
  /**
   * Remove every image of one question that no message carried yet.
   * @param key - the card's key.
   * @param question - index of the question.
   */
  clear(key: string, question: number): void
  /**
   * Steer the uploaded images of a card as one user message: each question's
   * images follow the heading the caller writes for it. Sent images are marked
   * `sent`, so a second submission of the same card does not send them again.
   * @param key - the card's key.
   * @param heading - text placed before one question's images.
   * @returns the Host's acceptance, also when no image waited to be sent.
   */
  send(key: string, heading: (question: number) => string): Promise<RemoteResult<{ accepted: true }>>
}

/** One feedback line about images: a `question` dictionary key and its parameters. */
export interface ImageFeedback {
  readonly key: Extract<QuestionKey, `images.${string}`>
  readonly params?: Readonly<Record<string, string | number>>
}

/**
 * Byte count as megabytes, as the conversation composer names image limits.
 * @param bytes - the byte count.
 * @returns the rounded megabyte text, such as `10MB` or `2.5MB`.
 */
export function imageSizeText(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  return `${Number.isInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1)}MB`
}

/**
 * The feedback line for files that were not attached.
 * @param refusal - why the set was refused.
 * @returns the line naming the broken limit.
 */
export function refusalFeedback(refusal: QuestionImageRefusal): ImageFeedback {
  switch (refusal.kind) {
    case 'type': return { key: 'images.type' }
    case 'count': return { key: 'images.count', params: { count: refusal.max } }
    case 'size': return { key: 'images.size', params: { size: imageSizeText(refusal.max) } }
    case 'total': return { key: 'images.total', params: { size: imageSizeText(refusal.max) } }
    default: return assertNever(refusal, 'image refusal')
  }
}

/**
 * The feedback line for an image the Host refused to store or send.
 * @param reason - the Host's refusal reason (`details.reason` of an attachment error), when it gave one.
 * @param limits - the deployment's image limits, which name the broken limit when known.
 * @returns the line for the user.
 */
export function reasonFeedback(reason: string | undefined, limits: ImageAttachmentLimits | undefined): ImageFeedback {
  switch (reason) {
    case 'MODEL_DOES_NOT_SUPPORT_IMAGES': return { key: 'images.modelUnsupported' }
    case 'FILE_NOT_STAGED': return { key: 'images.notStaged' }
    case 'IMAGE_TOO_MANY_PIXELS': return { key: 'images.pixels' }
    case 'INVALID_IMAGE':
    case 'IMAGE_TYPE_MISMATCH':
    case 'UNSUPPORTED_IMAGE_TYPE':
      return { key: 'images.type' }
    case 'IMAGE_DIMENSION_TOO_LARGE':
      return limits === undefined ? { key: 'images.pixels' } : { key: 'images.dimensions', params: { size: limits.maxImageDimension } }
    case 'IMAGE_TOO_LARGE':
      return limits === undefined ? { key: 'images.failed' } : refusalFeedback({ kind: 'size', max: limits.maxImageBytes })
    case 'TOO_MANY_IMAGES':
      return limits === undefined ? { key: 'images.failed' } : refusalFeedback({ kind: 'count', max: limits.maxImagesPerMessage })
    case 'IMAGES_TOO_LARGE':
      return limits === undefined ? { key: 'images.failed' } : refusalFeedback({ kind: 'total', max: limits.maxMessageImageBytes })
    default: return { key: 'images.failed' }
  }
}

const ACCEPTED: RemoteResult<{ accepted: true }> = { ok: true, value: { accepted: true } }

/** Read the refusal reason a Host attaches to an attachment error. */
function refusalReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : undefined
}

/**
 * The images of one card: an observable list whose uploads it owns, so
 * removing an image or dropping the card aborts what is still uploading and
 * releases the thumbnails' object URLs.
 */
export class QuestionImageDrafts {
  #snapshot: QuestionImagesSnapshot = { images: [] }
  #nextId = 0
  readonly #listeners = new Set<() => void>()
  readonly #uploads = new Map<string, AbortController>()
  readonly #receipts = new Map<string, ImageUploadValue['receiptId']>()
  readonly #sizes = new Map<string, number>()

  /**
   * @param createUrl - object URL factory for thumbnails.
   * @param revokeUrl - releases a thumbnail's object URL.
   */
  constructor(
    private readonly createUrl: (file: File) => string = file => URL.createObjectURL(file),
    private readonly revokeUrl: (url: string) => void = (url) => { URL.revokeObjectURL(url) },
  ) {}

  /** Subscribe to list changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Read the current list. */
  readonly getSnapshot = (): QuestionImagesSnapshot => this.#snapshot

  /**
   * Attach accepted images to one question and start their uploads.
   * @param question - index of the question.
   * @param files - the files to attach.
   * @param limits - the deployment's image limits; every image of the card counts, since one message carries them all.
   * @param upload - stores one image for the card's Session.
   * @returns why the set was refused, or `undefined` when it was attached.
   */
  add(
    question: number,
    files: readonly File[],
    limits: ImageAttachmentLimits,
    upload: QuestionImageUpload,
  ): QuestionImageRefusal | undefined {
    if (files.length === 0) return undefined
    const accepted = limits.mediaTypes as readonly string[]
    if (files.some(file => !accepted.includes(file.type))) return { kind: 'type' }
    // One message carries the images no message carried yet.
    const kept = this.#snapshot.images.filter(image => image.status === 'uploading' || image.status === 'ready')
    if (kept.length + files.length > limits.maxImagesPerMessage) return { kind: 'count', max: limits.maxImagesPerMessage }
    if (files.some(file => file.size > limits.maxImageBytes)) return { kind: 'size', max: limits.maxImageBytes }
    const total = files.reduce((sum, file) => sum + file.size, this.#bytes(kept))
    if (total > limits.maxMessageImageBytes) return { kind: 'total', max: limits.maxMessageImageBytes }
    const added = files.map((file): QuestionImage & { file: File } => {
      this.#nextId += 1
      return {
        id: `image-${String(this.#nextId)}`,
        question,
        name: file.name,
        previewUrl: this.createUrl(file),
        status: 'uploading',
        file,
      }
    })
    this.#publish([...this.#snapshot.images, ...added.map(({ file: _file, ...image }) => image)])
    for (const image of added) this.#upload(image.id, image.file, upload)
    return undefined
  }

  /**
   * Remove one image that no message carried yet.
   * @param id - the image's identity.
   */
  remove(id: string): void {
    const image = this.#snapshot.images.find(item => item.id === id)
    if (image === undefined || image.status === 'sent') return
    this.#release(image)
    this.#publish(this.#snapshot.images.filter(item => item !== image))
  }

  /**
   * Remove every unsent image of one question.
   * @param question - index of the question.
   */
  clear(question: number): void {
    const removed = this.#snapshot.images.filter(image => image.question === question && image.status !== 'sent')
    if (removed.length === 0) return
    for (const image of removed) this.#release(image)
    this.#publish(this.#snapshot.images.filter(image => !removed.includes(image)))
  }

  /**
   * Steer every uploaded image as one user message, each question's images
   * after its heading, and mark them sent once the Host accepts it.
   * @param heading - text placed before one question's images.
   * @param send - steers one message into the card's Session.
   * @returns the Host's acceptance, also when no image waited to be sent.
   */
  async send(heading: (question: number) => string, send: QuestionImageSend): Promise<RemoteResult<{ accepted: true }>> {
    const ready = this.#snapshot.images.filter(image => image.status === 'ready')
    if (ready.length === 0) return ACCEPTED
    const questions = [...new Set(ready.map(image => image.question))].sort((left, right) => left - right)
    const content: PromptContentPart[] = questions.flatMap(question => [
      { type: 'text' as const, text: heading(question) },
      ...ready.filter(image => image.question === question).map(image => ({
        type: 'file' as const,
        // Only an image whose upload returned a receipt is ready.
        receiptId: this.#receipts.get(image.id) as ImageUploadValue['receiptId'],
      })),
    ])
    const result = await send(content)
    if (!result.ok) return result
    this.#publish(this.#snapshot.images.map(image => ready.includes(image) ? { ...image, status: 'sent' } : image))
    return result
  }

  /** Abort every upload and release every thumbnail; the card is gone. */
  dispose(): void {
    for (const image of this.#snapshot.images) this.#release(image)
    this.#publish([])
  }

  #bytes(images: readonly QuestionImage[]): number {
    return images.reduce((sum, image) => sum + (this.#sizes.get(image.id) ?? 0), 0)
  }

  #upload(id: string, file: File, upload: QuestionImageUpload): void {
    const controller = new AbortController()
    this.#uploads.set(id, controller)
    this.#sizes.set(id, file.size)
    const settle = (status: 'ready' | 'failed', reason?: string): void => {
      if (this.#uploads.get(id) !== controller) return
      this.#uploads.delete(id)
      this.#publish(this.#snapshot.images.map(image => image.id === id
        ? { ...image, status, ...reason === undefined ? {} : { reason } }
        : image))
    }
    // The type check in add() admitted only accepted media types.
    void upload(file, file.type as ImageMediaType, controller.signal).then((result) => {
      if (!result.ok) {
        settle('failed', refusalReason(result.error.details))
        return
      }
      if (this.#uploads.get(id) === controller) this.#receipts.set(id, result.value.receiptId)
      settle('ready')
    }, () => { settle('failed') })
  }

  #release(image: QuestionImage): void {
    this.#uploads.get(image.id)?.abort()
    this.#uploads.delete(image.id)
    this.#receipts.delete(image.id)
    this.#sizes.delete(image.id)
    this.revokeUrl(image.previewUrl)
  }

  #publish(images: readonly QuestionImage[]): void {
    this.#snapshot = { images }
    for (const listener of this.#listeners) listener()
  }
}

/**
 * The image drafts of every live card, keyed like the cards. A card's drafts
 * are created when its composer first reads them and dropped with the card.
 */
export class QuestionImageRegistry {
  readonly #drafts = new Map<string, QuestionImageDrafts>()

  /**
   * @param createDrafts - creates the drafts of one card.
   */
  constructor(private readonly createDrafts: () => QuestionImageDrafts = () => new QuestionImageDrafts()) {}

  /**
   * The drafts of one card, created on first read.
   * @param key - the card's key.
   * @returns the card's drafts.
   */
  ensure(key: string): QuestionImageDrafts {
    let drafts = this.#drafts.get(key)
    if (drafts === undefined) {
      drafts = this.createDrafts()
      this.#drafts.set(key, drafts)
    }
    return drafts
  }

  /**
   * The Session-bound verbs of every card of one Session.
   * @param upload - stores one image for the Session.
   * @param send - steers one message into the Session.
   * @returns the verbs the composer calls.
   */
  intake(upload: QuestionImageUpload, send: QuestionImageSend): QuestionImageIntake {
    return {
      add: (key, question, files, limits) => this.ensure(key).add(question, files, limits, upload),
      remove: (key, id) => { this.#drafts.get(key)?.remove(id) },
      clear: (key, question) => { this.#drafts.get(key)?.clear(question) },
      send: (key, heading) => this.#drafts.get(key)?.send(heading, send) ?? Promise.resolve(ACCEPTED),
    }
  }

  /**
   * Drop one card's drafts: abort its uploads and release its thumbnails.
   * @param key - the card's key.
   */
  drop(key: string): void {
    this.#drafts.get(key)?.dispose()
    this.#drafts.delete(key)
  }

  /** Drop every card's drafts. */
  dispose(): void {
    for (const key of [...this.#drafts.keys()]) this.drop(key)
  }
}

/**
 * The image verbs of one Session's cards: uploads go through the browser
 * upload service and the message through the Session's steer, which records
 * that it answers a question. A composition without the upload service gets
 * none, and its cards take no images.
 * @param ctx - the plugin's Client context.
 * @param registry - the drafts of every live card.
 * @param sessionId - the Session the cards belong to.
 * @returns the composer's `questionImageIntake` member, or nothing.
 */
export function answerImageIntake(
  ctx: Context,
  registry: QuestionImageRegistry,
  sessionId: SessionId,
): { questionImageIntake?: QuestionImageIntake } {
  if (ctx.get('fileUpload') === undefined) return {}
  return {
    questionImageIntake: registry.intake(
      async (file, mediaType, signal) => {
        const uploads = ctx.get('fileUpload')
        if (uploads === undefined) throw new Error('the image upload service stopped')
        return uploads.uploadImage(sessionId, file, mediaType, file.name === '' ? undefined : file.name, signal)
      },
      async (content) => {
        const session = ctx.get('sessions')?.binding(sessionId)?.session
        if (session === undefined) throw new Error(`session ${String(sessionId)} is not open`)
        return session.prompt(content, 'steer', undefined, undefined, { answersQuestion: true })
      },
    ),
  }
}
