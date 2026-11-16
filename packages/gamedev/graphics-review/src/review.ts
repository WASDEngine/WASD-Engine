/**
 * One review: the image saved as an attachment and sent, with the reviewer's instructions and the agent's description,
 * to the model route of the WASD Engine account, which pays for it as for any model call, and the reply's text
 * returned. Failures become messages for the agent that name no model or provider: a used-up account's message passes
 * on where the user pays, a missing sign-in asks for one, and other failures ask to try again.
 * @module @deepseek-ai/dsh-graphics-review/src/review
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, LlmError, type GenerateOptions, type LlmFailure, type LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReviewImage } from './image.ts'
import { reviewerPrompt, type ReviewAddon } from './prompt.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'graphics-review': true
  }
}

/** The model route and output limit of every review. */
export interface ReviewSettings {
  /** Provider route of the WASD Engine account. */
  readonly provider: string
  /** Model of that route; absent, the first listed model that takes images. */
  readonly model?: string
  /** Most tokens of one reply. */
  readonly maxTokens: number
}

/** What one review sends. */
export interface ReviewRequest {
  readonly image: ReviewImage
  /** What the image shows and what it is for. */
  readonly subject: string
  /** The look the game is going for. */
  readonly goal?: string
  /** What to look at most. */
  readonly focus?: string
  /** The add-ons the reviewer may suggest. */
  readonly addons: readonly ReviewAddon[]
  /** The calling Session, for the route's request identity; absent for a connected agent's call without one. */
  readonly sessionId?: NonNullable<GenerateOptions['sessionId']>
}

/** A review that could not be made; the message is for the agent. */
export class ReviewFailure extends Error {
  override name = 'ReviewFailure'
}

/** What an account's refusal for used-up usage says when it carries no message of its own. */
const USED_UP = 'Usage limit reached: the AI usage of the WASD Engine account is used up.'

/** What the agent does with a used-up account's message. */
const PASS_ON = 'Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.'

/** A missing or rejected sign-in. */
const SIGN_IN = 'The graphics reviewer needs WASD Engine to be signed in. Ask the user to sign in to WASD Engine, then try again.'

/**
 * The agent's message for a failed review.
 * @param failure - the route's failure code and message.
 * @returns a message that names no model or provider.
 */
export function failureMessage(failure: Pick<LlmFailure, 'code' | 'message'>): string {
  switch (failure.code) {
    case 'QUOTA':
    case 'ACCOUNT_QUOTA': {
      // The account service's own words say where the user pays; the provider's prefix, if any, stays behind.
      const at = failure.message.search(/usage limit reached/iu)
      return `${at < 0 ? USED_UP : failure.message.slice(at)} ${PASS_ON}`
    }
    case 'AUTH':
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'ACCOUNT_TOKEN_INVALID':
      return SIGN_IN
    case 'RATE_LIMIT':
      return 'The graphics reviewer is busy. Wait a few seconds, then try again.'
    default:
      return 'The graphics reviewer could not review this image right now. Try again in a minute.'
  }
}

/**
 * The text that the reviewer reads beside the image.
 * @param request - the review.
 * @returns the description.
 */
export function describeRequest(request: Pick<ReviewRequest, 'image' | 'subject' | 'goal' | 'focus'>): string {
  const { image } = request
  return [
    `Image: ${image.name}, ${String(image.width)}x${String(image.height)} px${image.sentWidth === image.width ? '' : `, shown at ${String(image.sentWidth)}x${String(image.sentHeight)} px`}.`,
    `What it shows: ${request.subject}`,
    `The look the game is going for: ${request.goal ?? 'not given; judge it against the style the image itself sets.'}`,
    ...request.focus === undefined ? [] : [`Look most at: ${request.focus}`],
  ].join('\n')
}

/**
 * The route's model that takes images.
 * @param llm - the model service.
 * @param settings - the route.
 * @param signal - cancellation.
 * @returns the model id.
 * @throws ReviewFailure when the route lists none, as while signed out, or none takes images.
 */
async function reviewerModel(llm: LlmRuntime, settings: ReviewSettings, signal: AbortSignal): Promise<string> {
  if (settings.model !== undefined) return settings.model
  let models
  try {
    models = await llm.listModels(settings.provider)
  } catch (error) {
    signal.throwIfAborted()
    throw new ReviewFailure(SIGN_IN, { cause: error })
  }
  if (models.length === 0) throw new ReviewFailure(SIGN_IN)
  for (const model of models) {
    const info = await llm.resolveModelInfo(settings.provider, model.id, signal)
    if (info.inputModalities?.includes('image') === true) return model.id
  }
  throw new ReviewFailure('The graphics reviewer is not available in this WASD Engine. Try again after WASD Engine updates.')
}

/**
 * Read the reply: its text blocks, after any reasoning, once the stream stops or reaches its output limit.
 * @param stream - the route's stream.
 * @param signal - cancellation, which ends the review with the caller's abort.
 * @returns the reply's text.
 * @throws ReviewFailure when the route fails or replies with no text.
 */
async function readReply(stream: AsyncIterable<StreamChunk>, signal: AbortSignal): Promise<string> {
  const assembler = new BlockAssembler()
  let finished: StreamChunk | undefined
  try {
    for await (const chunk of stream) {
      assembler.push(chunk)
      if (chunk.type === 'finish') finished = chunk
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof LlmError) throw new ReviewFailure(failureMessage({ code: error.code, message: error.message }), { cause: error })
    throw new ReviewFailure(failureMessage({ code: 'SERVER', message: '' }), { cause: error })
  }
  signal.throwIfAborted()
  if (finished?.type !== 'finish') throw new ReviewFailure(failureMessage({ code: 'SERVER', message: '' }))
  const { reason } = finished
  if (reason.kind === 'error' || reason.kind === 'aborted') throw new ReviewFailure(failureMessage(reason.failure))
  const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
  if (text === '') throw new ReviewFailure('The graphics reviewer returned no review. Try again.')
  return reason.kind === 'max-tokens' ? `${text}\n\n(The review stops here: it reached its length limit.)` : text
}

/**
 * Review one image.
 * @param ctx - context with the optional model and attachment services.
 * @param settings - the route and output limit.
 * @param request - the image and what the agent says about it.
 * @param signal - cancellation; a reply the route already began is still paid for.
 * @returns the review, in Markdown.
 * @throws ReviewFailure when the review cannot be made, with the message for the agent.
 */
export async function reviewImage(ctx: Context, settings: ReviewSettings, request: ReviewRequest, signal: AbortSignal): Promise<string> {
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  if (llm === undefined || attachments === undefined) {
    throw new ReviewFailure('The graphics reviewer is not available in this WASD Engine. Try again after WASD Engine updates.')
  }
  const model = await reviewerModel(llm, settings, signal)
  const { image } = request
  const saved = await attachments.saveImages([{ data: image.data, mediaType: image.mediaType, name: image.name }])
  const [attachment] = saved as [ImageAttachmentRef]
  signal.throwIfAborted()
  const options: GenerateOptions = {
    provider: settings.provider,
    model,
    system: reviewerPrompt(request.addons),
    messages: [{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: describeRequest(request) }] }],
    maxTokens: settings.maxTokens,
    temperature: 0.3,
    purpose: 'graphics-review',
    signal,
    ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
  }
  return await readReply(llm.stream(options), signal)
}
