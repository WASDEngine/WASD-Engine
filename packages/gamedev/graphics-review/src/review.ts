/**
 * One review: the image saved as an attachment and sent, with the reviewer's instructions and the agent's description,
 * to the model route of the WASD Engine account, which pays for it as for any model call, and the reply's text
 * returned. The request asks for a low reasoning effort and leaves room for the reasoning, which the output limit
 * counts. Failures become messages for the agent that name no model or provider and ask for another call only when one
 * can help: a used-up account's message passes on where the user pays, and the account's own refusal what the user must
 * do; a missing sign-in asks for one; a route without a usable reviewer, a reviewer that needs a newer WASD Engine, and
 * a request that fails the same way on every try say to go on without a review; a reply without a review asks for a
 * closer view or one more call; and other failures ask to try again once.
 * @module @deepseek-ai/dsh-graphics-review/src/review
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import {
  BlockAssembler, LlmError,
  type FinishReason, type GenerateOptions, type LlmFailure, type LlmResolvedModelInfo, type LlmRuntime, type PreparedLlmCall,
  type ReasoningEffortId, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ReviewImage } from './image.ts'
import { reviewerPrompt, type ReviewAddon } from './prompt.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'graphics-review': true
  }
}

/** The model route, output limit, and reasoning effort of every review. */
export interface ReviewSettings {
  /** Provider route of the WASD Engine account. */
  readonly provider: string
  /** Model of that route; absent, the first listed model that takes images. */
  readonly model?: string
  /** Most tokens of one reply, its reasoning included. */
  readonly maxTokens: number
  /** Reasoning effort when the model offers it; otherwise the model's least effort. */
  readonly reasoningEffort: string
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
  /** For a later review of the same work: what changed since the last one, and which of its notes were left and why. */
  readonly previous?: string
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

/** What the agent does with the account's own refusal, such as an unconfirmed email address or the waitlist. */
const PASS_ON_REFUSAL = 'Pass this on to the user, and go on without a review until they have done what it says.'

/** A missing or rejected sign-in. */
const SIGN_IN = 'The graphics reviewer needs WASD Engine to be signed in. Ask the user to sign in to WASD Engine, then try again.'

/** A route that offers no model that reviews images, or that cannot serve the review. */
const UNAVAILABLE = 'The graphics reviewer is not available in this WASD Engine, and calling it again will not help. Go on without a review '
  + 'and tell the user; updating WASD Engine may bring it back.'

/** A route that holds its reviewer back until WASD Engine updates. */
const UPDATE = 'The graphics reviewer needs a newer version of WASD Engine, and calling it again will not help. Ask the user to update WASD '
  + 'Engine, and go on without a review until then.'

/** A request that fails the same way on every try. */
const REFUSED = 'The graphics reviewer cannot review this image: its request fails the same way on every try. Send another image, such as a '
  + 'fresh screenshot saved as PNG, or go on without a review and tell the user.'

/** A busy route. */
const BUSY = 'The graphics reviewer is busy. Wait a few seconds, then try again.'

/** Any other failure, which a later call may not repeat. */
const TRY_AGAIN = 'The graphics reviewer could not review this image right now. Try again in a minute; if it fails again, go on without a '
  + 'review and tell the user.'

/** A reply that spent its output limit on reasoning. */
const NO_ROOM = 'The graphics reviewer reached its length limit before it wrote a review, so the same call would likely stop again. Send a '
  + 'closer view of one part of the image, or a focus that names one thing to look at; if that stops too, go on without a review and tell '
  + 'the user.'

/** A reply that ended without text. */
const EMPTY = 'The graphics reviewer finished without writing a review. Check that the image shows the graphics to review and that subject '
  + 'describes it, then call it once more; if it again writes none, go on without a review and tell the user.'

/**
 * The agent's message for a failed review. Failure codes outside the ones named here, including unclassified HTTP
 * statuses, ask to try again once.
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
      // The account route refuses a signed-in account that cannot use WASD Engine yet in words for the user that name only WASD Engine.
      return /WASD Engine/u.test(failure.message) && !/deepseek/iu.test(failure.message) ? `${failure.message} ${PASS_ON_REFUSAL}` : SIGN_IN
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'ACCOUNT_TOKEN_INVALID':
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return SIGN_IN
    case 'CLIENT_UPGRADE_REQUIRED':
    case 'MODEL_UNSUPPORTED':
      return UPDATE
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_CONTENT':
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'IMAGE_OFFLOAD_REQUIRED':
      return REFUSED
    case 'NO_ADAPTER':
    case 'UNKNOWN_MODEL':
    case 'UNSUPPORTED_REASONING_EFFORT':
    case 'UNSUPPORTED_OPTION':
    case 'INVALID_CONFIG':
    case 'INVALID_MODEL_INFO':
    case 'INVALID_MODEL_CONTEXT':
    case 'INVALID_MODEL_MAX_TOKENS':
    case 'INVALID_MODEL_REASONING':
    case 'INVALID_PREPARED_CALL':
      return UNAVAILABLE
    case 'RATE_LIMIT':
      return BUSY
    default:
      return TRY_AGAIN
  }
}

/**
 * The agent's message for a route step that threw.
 * @param error - what it threw.
 * @returns the message for its failure code, or the retry message for anything but an `LlmError`.
 */
function thrownMessage(error: unknown): string {
  return error instanceof LlmError ? failureMessage(error) : TRY_AGAIN
}

/**
 * The text that the reviewer reads beside the image.
 * @param request - the review.
 * @returns the description.
 */
export function describeRequest(request: Pick<ReviewRequest, 'image' | 'subject' | 'goal' | 'focus' | 'previous'>): string {
  const { image } = request
  return [
    `Image: ${image.name}, ${String(image.width)}x${String(image.height)} px${image.sentWidth === image.width ? '' : `, shown at ${String(image.sentWidth)}x${String(image.sentHeight)} px`}.`,
    `What it shows: ${request.subject}`,
    `The look the game is going for: ${request.goal ?? 'not given; judge it against the style the image itself sets.'}`,
    ...request.focus === undefined ? [] : [`Look most at: ${request.focus}`],
    ...request.previous === undefined ? [] : [`Since the last review of this work: ${request.previous}`],
  ].join('\n')
}

/**
 * Whether WASD Engine's account service holds no sign-in; without the service, no sign-in is missing.
 * @param ctx - context with the optional account service.
 * @returns true while no one is signed in, or when the sign-in cannot be read.
 */
async function signedOut(ctx: Context): Promise<boolean> {
  const account = ctx.get('deepseekAccount')
  if (account === undefined) return false
  try {
    return (await account.getState()).status !== 'credential-stored'
  } catch (_unreadable) {
    // A sign-in that cannot be read cannot sign the review's requests either.
    return true
  }
}

/**
 * The route's model that takes images.
 * @param ctx - context with the optional account service.
 * @param llm - the model service.
 * @param settings - the route.
 * @param signal - cancellation.
 * @returns the model id.
 * @throws ReviewFailure when the route lists none, as while signed out, or none takes images.
 */
async function reviewerModel(ctx: Context, llm: LlmRuntime, settings: ReviewSettings, signal: AbortSignal): Promise<string> {
  if (settings.model !== undefined) return settings.model
  try {
    const models = await llm.listModels(settings.provider)
    for (const model of models) {
      const info = await llm.resolveModelInfo(settings.provider, model.id, signal)
      if (info.inputModalities?.includes('image') === true) return model.id
    }
    // The account route lists no model while no one is signed in.
    throw new ReviewFailure(models.length === 0 && await signedOut(ctx) ? SIGN_IN : UNAVAILABLE)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ReviewFailure) throw error
    throw new ReviewFailure(thrownMessage(error), { cause: error })
  }
}

/**
 * The reasoning effort of a review.
 * @param model - the reviewer model.
 * @param wanted - the configured effort.
 * @returns the configured effort when the model offers it, else its least effort; none for a model without efforts.
 */
function reviewEffort(model: Readonly<LlmResolvedModelInfo>, wanted: string): ReasoningEffortId | undefined {
  const efforts = model.reasoning?.efforts
  return efforts?.find(effort => effort.id === wanted)?.id ?? efforts?.[0]?.id
}

/**
 * Prepare the request of one review on the route.
 * @param llm - the model service.
 * @param settings - the route, output limit, and reasoning effort.
 * @param model - the reviewer model.
 * @param signal - cancellation.
 * @returns the prepared call.
 * @throws ReviewFailure when the route refuses the model or the model takes no images.
 */
async function prepareReview(llm: LlmRuntime, settings: ReviewSettings, model: string, signal: AbortSignal): Promise<PreparedLlmCall> {
  let call
  try {
    call = await llm.prepareCall({ provider: settings.provider, model, maxTokens: settings.maxTokens }, signal, (controls, info) => {
      const effort = reviewEffort(info, settings.reasoningEffort)
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
    })
  } catch (error) {
    signal.throwIfAborted()
    throw new ReviewFailure(thrownMessage(error), { cause: error })
  }
  if (call.inputModalities?.includes('image') !== true) throw new ReviewFailure(UNAVAILABLE)
  return call
}

/**
 * Read the reply: its text blocks, after any reasoning, once the stream stops or reaches its output limit.
 * @param open - opens the route's stream.
 * @param signal - cancellation, which ends the review with the caller's abort.
 * @returns the reply's text.
 * @throws ReviewFailure when the route fails or replies with no text.
 */
async function readReply(open: () => AsyncIterable<StreamChunk>, signal: AbortSignal): Promise<string> {
  const assembler = new BlockAssembler()
  let finished: FinishReason | undefined
  try {
    for await (const chunk of open()) {
      assembler.push(chunk)
      if (chunk.type === 'finish') finished = chunk.reason
    }
  } catch (error) {
    signal.throwIfAborted()
    throw new ReviewFailure(thrownMessage(error), { cause: error })
  }
  signal.throwIfAborted()
  if (finished === undefined) throw new ReviewFailure(TRY_AGAIN)
  if (finished.kind === 'error' || finished.kind === 'aborted') throw new ReviewFailure(failureMessage(finished.failure))
  const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
  const cut = finished.kind === 'max-tokens'
  if (text === '') throw new ReviewFailure(cut ? NO_ROOM : EMPTY)
  return cut ? `${text}\n\n(The review stops here: it reached its length limit.)` : text
}

/**
 * Review one image.
 * @param ctx - context with the optional model, attachment, and account services.
 * @param settings - the route, output limit, and reasoning effort.
 * @param request - the image and what the agent says about it.
 * @param signal - cancellation; a reply the route already began is still paid for.
 * @returns the review, in Markdown.
 * @throws ReviewFailure when the review cannot be made, with the message for the agent.
 */
export async function reviewImage(ctx: Context, settings: ReviewSettings, request: ReviewRequest, signal: AbortSignal): Promise<string> {
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  if (llm === undefined || attachments === undefined) throw new ReviewFailure(UNAVAILABLE)
  const call = await prepareReview(llm, settings, await reviewerModel(ctx, llm, settings, signal), signal)
  const { image } = request
  const saved = await attachments.saveImages([{ data: image.data, mediaType: image.mediaType, name: image.name }])
  const [attachment] = saved as [ImageAttachmentRef]
  signal.throwIfAborted()
  const options: GenerateOptions = {
    ...call.config,
    system: reviewerPrompt(request.addons),
    messages: [{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: describeRequest(request) }] }],
    purpose: 'graphics-review',
    signal,
    ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
  }
  return await readReply(() => call.stream(options), signal)
}
