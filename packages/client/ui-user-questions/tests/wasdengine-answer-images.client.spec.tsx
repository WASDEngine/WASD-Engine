// @vitest-environment jsdom
/**
 * Images the user attaches to an ask_user_question answer: the card's image
 * drafts, the composer's attach, paste, and drop intake, the steered message
 * that carries the images before the answer batch, and the Session-bound
 * verbs the plugin injects.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment/types'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWaterfallRequest, PendingQuestion, type QuestionComposerProps } from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { en } from '../src/client/locales.ts'
import {
  answerImageIntake, QuestionImageDrafts, QuestionImageRegistry, reasonFeedback,
  type QuestionImageSend, type QuestionImageUpload,
} from '../src/client/question-images.ts'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'

afterEach(cleanup)

const SID = 'session-images' as SessionId
const MB = 1024 * 1024
const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10 * MB,
  maxImagesPerMessage: 3,
  maxMessageImageBytes: 12 * MB,
  maxImagePixels: 40_000_000,
  maxImageDimension: 8000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const png = (name: string, bytes = 4): File => new File([new Uint8Array(bytes)], name, { type: 'image/png' })

const t: QuestionComposerProps['t'] = (key, params) => {
  const dictionary: Record<string, string> = { ...commonEn, ...en }
  const template = dictionary[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** One upload the test settles by hand. */
interface PendingUpload {
  readonly file: File
  readonly signal: AbortSignal
  readonly resolve: (receiptId: string) => void
  readonly refuse: (reason: string) => void
}

/** An upload fake whose calls the test settles. */
function uploads() {
  const calls: PendingUpload[] = []
  const upload: QuestionImageUpload = (file, _mediaType, signal) => new Promise((resolve) => {
    calls.push({
      file,
      signal,
      resolve: (receiptId) => {
        resolve({
          ok: true,
          value: {
            receiptId: receiptId as never,
            image: { attachmentId: `sha256:${receiptId}` as never, mediaType: 'image/png', bytes: file.size, width: 8, height: 8 },
          },
        })
      },
      refuse: (reason) => {
        resolve({
          ok: false,
          error: { code: 'session/attachment-invalid', message: 'refused', details: { reason } } as never,
        })
      },
    })
  })
  return { calls, upload }
}

const drafts = (revoked: string[] = []) => new QuestionImageDrafts(file => `blob:${file.name}`, (url) => { revoked.push(url) })

describe('QuestionImageDrafts', () => {
  it('uploads each attached image and marks it ready once the Host stores it, or failed with the Host\'s reason', async () => {
    const images = drafts()
    const { calls, upload } = uploads()

    expect(images.add(0, [png('a.png'), png('b.png')], LIMITS, upload)).toBeUndefined()
    expect(images.getSnapshot().images.map(image => [image.name, image.question, image.status, image.previewUrl]))
      .toEqual([['a.png', 0, 'uploading', 'blob:a.png'], ['b.png', 0, 'uploading', 'blob:b.png']])
    calls[0]!.resolve('receipt-a')
    calls[1]!.refuse('IMAGE_TOO_MANY_PIXELS')
    await vi.waitFor(() => { expect(images.getSnapshot().images.map(image => image.status)).toEqual(['ready', 'failed']) })
    expect(images.getSnapshot().images[1]?.reason).toBe('IMAGE_TOO_MANY_PIXELS')
  })

  it('refuses a whole set that holds a file other than an accepted image or breaks a limit', () => {
    const images = drafts()
    const { calls, upload } = uploads()

    expect(images.add(0, [png('a.png'), new File(['x'], 'notes.txt', { type: 'text/plain' })], LIMITS, upload)).toEqual({ kind: 'type' })
    expect(images.add(0, [png('a.png'), png('b.png'), png('c.png'), png('d.png')], LIMITS, upload)).toEqual({ kind: 'count', max: 3 })
    expect(images.add(0, [png('big.png', 11 * MB)], LIMITS, upload)).toEqual({ kind: 'size', max: 10 * MB })
    expect(images.add(0, [png('a.png', 7 * MB)], LIMITS, upload)).toBeUndefined()
    expect(images.add(1, [png('b.png', 6 * MB)], LIMITS, upload)).toEqual({ kind: 'total', max: 12 * MB })
    expect(calls).toHaveLength(1)
  })

  it('removing an image aborts its upload and releases its thumbnail; a late result changes nothing', async () => {
    const revoked: string[] = []
    const images = drafts(revoked)
    const { calls, upload } = uploads()
    images.add(0, [png('a.png')], LIMITS, upload)
    const [image] = images.getSnapshot().images

    images.remove(image!.id)
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(revoked).toEqual(['blob:a.png'])
    calls[0]!.resolve('late')
    await Promise.resolve()
    expect(images.getSnapshot().images).toEqual([])
  })

  it('sends every uploaded image in one message, each question\'s images after its heading, and never sends them twice', async () => {
    const images = drafts()
    const { calls, upload } = uploads()
    images.add(1, [png('b.png')], LIMITS, upload)
    images.add(0, [png('a.png'), png('c.png')], LIMITS, upload)
    calls[0]!.resolve('receipt-b')
    calls[1]!.resolve('receipt-a')
    calls[2]!.resolve('receipt-c')
    await vi.waitFor(() => { expect(images.getSnapshot().images.every(image => image.status === 'ready')).toBe(true) })
    const sent: PromptContentPart[][] = []
    const send: QuestionImageSend = async (content) => {
      sent.push(content)
      return { ok: true, value: { accepted: true } }
    }

    await expect(images.send(question => `Images for question ${String(question)}:`, send)).resolves.toMatchObject({ ok: true })
    expect(sent).toEqual([[
      { type: 'text', text: 'Images for question 0:' },
      { type: 'file', receiptId: 'receipt-a' },
      { type: 'file', receiptId: 'receipt-c' },
      { type: 'text', text: 'Images for question 1:' },
      { type: 'file', receiptId: 'receipt-b' },
    ]])
    expect(images.getSnapshot().images.map(image => image.status)).toEqual(['sent', 'sent', 'sent'])
    await images.send(question => String(question), send)
    expect(sent).toHaveLength(1)
    // A sent image stays: no message can take it back.
    images.remove(images.getSnapshot().images[0]!.id)
    images.clear(0)
    expect(images.getSnapshot().images).toHaveLength(3)
  })

  it('keeps the images ready when the Host refuses the message', async () => {
    const images = drafts()
    const { calls, upload } = uploads()
    images.add(0, [png('a.png')], LIMITS, upload)
    calls[0]!.resolve('receipt-a')
    await vi.waitFor(() => { expect(images.getSnapshot().images[0]?.status).toBe('ready') })

    const refused = await images.send(() => 'heading', async () => ({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'no', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } } as never,
    }))
    expect(refused.ok).toBe(false)
    expect(images.getSnapshot().images[0]?.status).toBe('ready')
  })
})

describe('QuestionImageRegistry', () => {
  it('drops a card\'s drafts with the card, and sends nothing for a card without images', async () => {
    const revoked: string[] = []
    const registry = new QuestionImageRegistry(() => drafts(revoked))
    const { upload } = uploads()
    const send = vi.fn<QuestionImageSend>()
    const intake = registry.intake(upload, send)

    expect(intake.add('card', 0, [png('a.png')], LIMITS)).toBeUndefined()
    expect(registry.ensure('card').getSnapshot().images).toHaveLength(1)
    await expect(intake.send('other-card', () => 'heading')).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(send).not.toHaveBeenCalled()
    registry.drop('card')
    expect(revoked).toEqual(['blob:a.png'])
    expect(registry.ensure('card').getSnapshot().images).toEqual([])
  })
})

describe('reasonFeedback', () => {
  it('names the limit a Host refusal broke, and falls back to a plain failure', () => {
    expect(reasonFeedback('IMAGE_TOO_LARGE', LIMITS)).toEqual({ key: 'images.size', params: { size: '10MB' } })
    expect(reasonFeedback('IMAGES_TOO_LARGE', LIMITS)).toEqual({ key: 'images.total', params: { size: '12MB' } })
    expect(reasonFeedback('TOO_MANY_IMAGES', LIMITS)).toEqual({ key: 'images.count', params: { count: 3 } })
    expect(reasonFeedback('IMAGE_DIMENSION_TOO_LARGE', LIMITS)).toEqual({ key: 'images.dimensions', params: { size: 8000 } })
    expect(reasonFeedback('FILE_NOT_STAGED', LIMITS)).toEqual({ key: 'images.notStaged' })
    expect(reasonFeedback('IMAGE_TOO_LARGE', undefined)).toEqual({ key: 'images.failed' })
    expect(reasonFeedback(undefined, LIMITS)).toEqual({ key: 'images.failed' })
  })
})

const QUESTIONS: PendingQuestion['questions'] = [{
  id: 'look',
  question: 'Which look should the tavern have?',
  options: [{ label: 'Firelit and moody' }, { label: 'Warm and golden' }],
}, {
  id: 'size',
  question: 'How large is the room?',
}]

/** Render one waterfall card with the image verbs the plugin would inject. */
function card(options: { send?: QuestionImageSend; intake?: false; limits?: false } = {}) {
  const carrier = new PendingQuestion(SID, QUESTIONS)
  const request = createWaterfallRequest(undefined, undefined, (channel) => { carrier.detachWaterfall(channel) })
  carrier.attachWaterfall(request.channel)
  void request.result.catch(() => {})
  const answer = vi.spyOn(carrier, 'answer')
  const order: string[] = []
  answer.mockImplementation(async () => { order.push('answer') })
  const registry = new QuestionImageRegistry(() => drafts())
  const { calls, upload } = uploads()
  const send = vi.fn<QuestionImageSend>(async (content) => {
    order.push('images')
    return options.send === undefined ? { ok: true, value: { accepted: true } } : options.send(content)
  })
  const instance = createQuestionDraftStore().create(SID)
  const useStore: QuestionComposerProps['useStore'] = selector => useSyncExternalStore(
    listener => instance.subscribe(listener),
    () => selector(instance.getSnapshot()),
  )
  const useQuestionCard = ((_key: string, selector?: (value: unknown) => unknown) => {
    const value = useSyncExternalStore(carrier.subscribe, carrier.getSnapshot)
    return selector === undefined ? value : selector(value)
  }) as QuestionComposerProps['useQuestionCard']
  const useQuestionImages = ((key: string, selector?: (value: unknown) => unknown) => {
    const images = registry.ensure(key)
    const value = useSyncExternalStore(images.subscribe, images.getSnapshot)
    return selector === undefined ? value : selector(value)
  }) as NonNullable<QuestionComposerProps['useQuestionImages']>
  const useProjection = ((key: string) => key === 'imageLimits' && options.limits !== false ? LIMITS : undefined) as QuestionComposerProps['useProjection']
  const props = {
    matched: carrier,
    t,
    useStore,
    actions: instance.actions,
    useQuestionCard,
    useProjection,
    renderSlot: () => null,
    ...options.intake === false ? {} : { useQuestionImages, questionImageIntake: registry.intake(upload, send) },
  } as QuestionComposerProps
  const view = render(<QuestionComposer {...props} />)
  return { carrier, answer, send, calls, order, view }
}

const attach = (...files: File[]): void => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  fireEvent.change(input, { target: { files } })
}

describe('QuestionComposer answer images', () => {
  it('shows an attach button in the footer and the shown question\'s thumbnails while they upload', () => {
    const { calls } = card()
    expect(screen.getByRole('button', { name: 'Add images' })).toBeTruthy()
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe('image/png,image/jpeg,image/webp,image/gif')

    attach(png('tavern.png'))
    expect(calls).toHaveLength(1)
    expect(screen.getByRole('list', { name: 'Attached images' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'tavern.png, uploading' })).toBeTruthy()
    // Another question has none of this question's images.
    fireEvent.click(screen.getByLabelText('Next question'))
    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull()
  })

  it('sends an answer of images alone after its images, with a line that keeps it from reading as a skip', async () => {
    const { answer, send, calls, order } = card()
    attach(png('tavern.png'))
    await act(async () => { calls[0]!.resolve('receipt-tavern') })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByPlaceholderText(en['custom.placeholder']), { target: { value: 'About 8 by 6 meters' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await vi.waitFor(() => { expect(answer).toHaveBeenCalledOnce() })
    expect(order).toEqual(['images', 'answer'])
    expect(send).toHaveBeenCalledWith([
      { type: 'text', text: 'Images for my answer to "Which look should the tavern have?":' },
      { type: 'file', receiptId: 'receipt-tavern' },
    ])
    expect(answer).toHaveBeenCalledWith({
      answers: [
        { id: 'look', selected: [], custom: 'See the images I attached.' },
        { id: 'size', selected: [], custom: 'About 8 by 6 meters' },
      ],
    })
  })

  it('keeps a chosen option beside its images', async () => {
    const { answer, calls } = card()
    fireEvent.click(screen.getByRole('radio', { name: 'Firelit and moody' }))
    fireEvent.click(screen.getByLabelText('Previous question'))
    attach(png('lamp.png'))
    await act(async () => { calls[0]!.resolve('receipt-lamp') })
    fireEvent.click(screen.getByLabelText('Next question'))
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    await vi.waitFor(() => { expect(answer).toHaveBeenCalledOnce() })
    expect(answer).toHaveBeenCalledWith({
      answers: [{ id: 'look', selected: ['Firelit and moody'] }, { id: 'size', selected: [] }],
    })
  })

  it('holds the batch while an image uploads, and until a failed image is removed', async () => {
    const { answer, send, calls } = card()
    attach(png('a.png'))
    fireEvent.click(screen.getByRole('radio', { name: 'Warm and golden' }))
    fireEvent.change(screen.getByPlaceholderText(en['custom.placeholder']), { target: { value: 'Small' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByText(en['images.pending'])).toBeTruthy()

    await act(async () => { calls[0]!.refuse('IMAGE_TOO_MANY_PIXELS') })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByText(en['images.failedPresent'])).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Previous question'))
    expect(screen.getByRole('button', { name: en['images.pixels'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove image a.png' }))
    fireEvent.click(screen.getByLabelText('Next question'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await vi.waitFor(() => { expect(answer).toHaveBeenCalledOnce() })
    expect(send).not.toHaveBeenCalled()
    expect(answer).toHaveBeenCalledWith({
      answers: [{ id: 'look', selected: ['Warm and golden'] }, { id: 'size', selected: [], custom: 'Small' }],
    })
  })

  it('counts a question whose only image failed as unanswered', async () => {
    const { answer, calls } = card()
    attach(png('a.png'))
    await act(async () => { calls[0]!.refuse('INVALID_IMAGE') })
    fireEvent.click(screen.getByLabelText('Next question'))
    fireEvent.change(screen.getByPlaceholderText(en['custom.placeholder']), { target: { value: 'Small' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(await screen.findByText(en['error.incomplete'])).toBeTruthy()
    expect(screen.getByText('1 / 2')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
  })

  it('leaves the batch unsent and names the reason when the Host refuses the images', async () => {
    const { answer, calls } = card({
      send: async () => ({
        ok: false,
        error: { code: 'session/attachment-invalid', message: 'no', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } } as never,
      }),
    })
    attach(png('a.png'))
    await act(async () => { calls[0]!.resolve('receipt-a') })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    expect(await screen.findByText(en['images.modelUnsupported'])).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
    // The card is free again, so the user can remove the images and submit.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Skip' }).disabled).toBe(false)
  })

  it('names the limit a picked set breaks and attaches none of it', () => {
    const { calls } = card()
    attach(png('a.png'), new File(['x'], 'notes.txt', { type: 'text/plain' }))
    expect(screen.getByText(en['images.type'])).toBeTruthy()
    attach(png('a.png'), png('b.png'), png('c.png'), png('d.png'))
    expect(screen.getByText('An answer can include up to 3 images.')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('skipping a question drops its images', async () => {
    const { answer, send, calls } = card()
    attach(png('a.png'))
    await act(async () => { calls[0]!.resolve('receipt-a') })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(calls[0]!.signal.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    await vi.waitFor(() => { expect(answer).toHaveBeenCalledOnce() })
    expect(send).not.toHaveBeenCalled()
    expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'look', selected: [] }, { id: 'size', selected: [] }] })
  })

  it('takes dropped and pasted images itself, so the conversation\'s drop target never sees them', () => {
    const { calls, view } = card()
    const documentDrop = vi.fn()
    document.addEventListener('drop', documentDrop)
    document.addEventListener('dragenter', documentDrop)
    try {
      const section = view.container.querySelector('section')!
      const dataTransfer = { types: ['Files'], files: [png('dropped.png')], dropEffect: 'none' }
      fireEvent.dragEnter(section, { dataTransfer })
      fireEvent.dragOver(section, { dataTransfer })
      expect(dataTransfer.dropEffect).toBe('copy')
      fireEvent.drop(section, { dataTransfer })
      expect(documentDrop).not.toHaveBeenCalled()
      expect(calls.map(call => call.file.name)).toEqual(['dropped.png'])

      fireEvent.paste(screen.getByPlaceholderText(en['custom.placeholder']), { clipboardData: { files: [png('pasted.png')] } })
      expect(calls.map(call => call.file.name)).toEqual(['dropped.png', 'pasted.png'])
      // A text paste is the field's own.
      fireEvent.paste(screen.getByPlaceholderText(en['custom.placeholder']), { clipboardData: { files: [] } })
      expect(calls).toHaveLength(2)
    } finally {
      document.removeEventListener('drop', documentDrop)
      document.removeEventListener('dragenter', documentDrop)
    }
  })

  it('renders the plain question flow without the image verbs or the Session\'s image limits', () => {
    card({ intake: false })
    expect(screen.queryByRole('button', { name: 'Add images' })).toBeNull()
    cleanup()
    card({ limits: false })
    expect(screen.queryByRole('button', { name: 'Add images' })).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})

describe('answerImageIntake', () => {
  it('uploads through the browser upload service and steers the message into the card\'s Session as part of the answer', async () => {
    const ctx = new Context()
    const uploadImage = vi.fn(async () => ({
      ok: true as const,
      value: { receiptId: 'receipt-a' as never, image: { attachmentId: 'sha256:a' as never, mediaType: 'image/png' as const, bytes: 4, width: 8, height: 8 } },
    }))
    const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    ctx.provide('fileUpload', { uploadImage } as never)
    ctx.provide('sessions', { binding: (id: SessionId) => id === SID ? { session: { prompt } } : undefined } as never)
    const registry = new QuestionImageRegistry(() => drafts())
    const { questionImageIntake } = answerImageIntake(ctx, registry, SID)

    expect(questionImageIntake?.add('card', 0, [png('a.png')], LIMITS)).toBeUndefined()
    expect(uploadImage).toHaveBeenCalledWith(SID, expect.any(File), 'image/png', 'a.png', expect.any(AbortSignal))
    await vi.waitFor(() => { expect(registry.ensure('card').getSnapshot().images[0]?.status).toBe('ready') })
    await expect(questionImageIntake?.send('card', () => 'Images:')).resolves.toMatchObject({ ok: true })
    // The source records that the message answers the question, so the agent's turn keeps its own course.
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: 'Images:' }, { type: 'file', receiptId: 'receipt-a' }], 'steer', undefined, undefined, { answersQuestion: true })
  })

  it('offers no image verbs while the composition has no browser upload service', () => {
    expect(answerImageIntake(new Context(), new QuestionImageRegistry(), SID)).toEqual({})
  })
})
