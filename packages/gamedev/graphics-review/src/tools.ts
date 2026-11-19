/**
 * The model-facing `graphics_review` tool: one image that the agent captured or made, what it shows, and the look the
 * game is going for, reviewed by the graphics reviewer. One definition serves the Session's own agent, whose paths are
 * relative to its working directory or absolute, and agents connected through WASD Engine's MCP server, which name the
 * image by absolute path. Its texts call the reviewer a specialized graphics expert reviewer model and never mention a
 * cost.
 * @module @deepseek-ai/dsh-graphics-review/src/tools
 */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readReviewImage, type ImageLimits } from './image.ts'
import { TOOL_NAME } from './prompt.ts'
import type { ReviewRequest } from './review.ts'

/** What the tool needs from the plugin on one surface. */
export interface GraphicsReviewHost {
  /** The limits of the image sent. */
  readonly limits: ImageLimits
  /** Time limit of one call. */
  readonly timeoutMs: number
  /**
   * The image file of a call.
   * @param requested - the `image` argument.
   * @param exec - the call's execution.
   * @returns the file's absolute path.
   * @throws Error when the surface cannot resolve the path.
   */
  image(requested: string, exec: ToolRunContext): Promise<string>
  /**
   * Review one image.
   * @param request - the image and what the agent says about it, without the add-ons, which the host adds.
   * @param signal - cancellation.
   * @returns the review.
   * @throws ReviewFailure with the message for the agent.
   */
  review(request: Omit<ReviewRequest, 'addons'>, signal: AbortSignal): Promise<string>
}

/** How one surface's description names the image file. */
export interface GraphicsReviewWording {
  /** Description of the `image` parameter. */
  readonly image: string
}

/** Wording of the Session's own tool. */
export const SESSION_WORDING: GraphicsReviewWording = {
  image: 'Path of the PNG, JPEG, or WebP image to review, relative to the working directory or absolute: a game screenshot that '
    + 'godot_screenshot or godot_view saved with save set to true, a render, a generated image, a texture, or a sprite sheet.',
}

const STRING = { type: 'string', required: true } as const

/** Most reviews one piece of graphics work gets, counted by the Session and the subject a call names. */
export const MAX_REVIEWS = 4

/** Pieces of work whose review counts the tool keeps, the oldest dropped first. */
const REMEMBERED_WORKS = 1000

/**
 * Build the `graphics_review` tool definition for one surface.
 * @param host - the image resolution, the limits, and the review of this surface.
 * @param wording - how the description names the image file.
 * @returns the definition, not registered.
 */
export function graphicsReviewToolDefinition(host: GraphicsReviewHost, wording: GraphicsReviewWording): ToolDefinition {
  // Reviews given so far, by Session and subject: a piece of work gets at most MAX_REVIEWS, as the description says.
  const given = new Map<string, number>()
  return defineTool({
    name: TOOL_NAME,
    description: 'Have a specialized graphics expert reviewer model critique an image of the game\'s graphics, the way a game art director '
      + 'and technical artist would: readability, art direction, lighting, materials, shapes, composition, UI, and technical flaws. It gives '
      + 'notes on how to make the image look better and names the WASD Engine tools and add-ons to consider. Use it only for graphics you '
      + 'build, draw, or generate, never for assets you download, such as from Poly Haven or the web, or for work that only adds them to the '
      + 'game. Call it at least twice and at most four times for each piece of graphics work, each time with a new image of the result: after '
      + 'the work, then after acting on each review, up to four reviews, passing previous with what you changed and which notes you left; '
      + 'when the second or third review has nothing useful for that work, such as notes that repeat the last review\'s or ask for what you '
      + 'cannot change, you may stop there. Act on the fourth review too, then move on. Returns the notes that would make a visible '
      + 'difference, the most important first, each with where it applies and how, and the tools and add-ons to consider, each with what to '
      + 'do with it.',
    parameters: {
      image: { type: 'string', required: true, description: wording.image },
      subject: {
        type: 'string',
        required: true,
        description: 'What the image shows and what it is for, such as "the forest level at dusk from the player\'s camera" or "the '
          + 'knight\'s walk cycle sprite sheet".',
      },
      goal: {
        type: 'string',
        description: 'The look the game is going for: art style, mood, and references, such as the user\'s request. Default: the style the '
          + 'image itself sets.',
      },
      focus: { type: 'string', description: 'What to look at most, such as the lighting, the character\'s silhouette, or the HUD\'s legibility.' },
      previous: {
        type: 'string',
        description: 'For a second, third, or fourth review of the same work: what you changed since its last review, and which of its '
          + 'notes you left and why, such as a stock character\'s face that you cannot remodel.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { image: STRING, review: STRING } },
      render: (_args, value) => [{ type: 'text', text: `Graphics review of ${value.image}:\n\n${value.review}` }],
    },
    timeoutMs: host.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subject = args.subject.trim()
      if (subject === '') throw new Error('Pass subject: what the image shows and what it is for.')
      const work = `${exec.agent?.session.id ?? ''}\n${subject.toLowerCase().replaceAll(/\s+/gu, ' ')}`
      if ((given.get(work) ?? 0) >= MAX_REVIEWS) {
        throw new Error(`This work has had ${String(MAX_REVIEWS)} graphics reviews, the most one piece of work gets. Act on the last review, then move on.`)
      }
      const path = await host.image(args.image, exec)
      const image = await readReviewImage(path, host.limits, exec.signal)
      exec.signal.throwIfAborted()
      const goal = args.goal?.trim()
      const focus = args.focus?.trim()
      const previous = args.previous?.trim()
      const review = await host.review({
        image,
        subject,
        ...goal === undefined || goal === '' ? {} : { goal },
        ...focus === undefined || focus === '' ? {} : { focus },
        ...previous === undefined || previous === '' ? {} : { previous },
        ...exec.agent === undefined ? {} : { sessionId: exec.agent.session.id },
      }, exec.signal)
      // The pieces of work reviewed longest ago leave first, so a long Session's counts stay bounded.
      const count = (given.get(work) ?? 0) + 1
      given.delete(work)
      given.set(work, count)
      const oldest = given.keys().next()
      if (given.size > REMEMBERED_WORKS && oldest.done !== true) given.delete(oldest.value)
      return { image: path, review }
    },
  })
}
