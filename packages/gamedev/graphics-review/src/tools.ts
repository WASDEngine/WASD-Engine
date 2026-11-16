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

/**
 * Build the `graphics_review` tool definition for one surface.
 * @param host - the image resolution, the limits, and the review of this surface.
 * @param wording - how the description names the image file.
 * @returns the definition, not registered.
 */
export function graphicsReviewToolDefinition(host: GraphicsReviewHost, wording: GraphicsReviewWording): ToolDefinition {
  return defineTool({
    name: TOOL_NAME,
    description: 'Have a specialized graphics expert reviewer model critique an image of the game\'s graphics, the way a game art director '
      + 'and technical artist would: readability, art direction, lighting, materials, shapes, composition, UI, and technical flaws. It gives '
      + 'notes on how to make the image look better and names the WASD Engine tools and add-ons to consider. Call it exactly three times for '
      + 'each piece of graphics work, no more and no less: after the work, then after acting on the first review, then after acting on the '
      + 'second, each time with a new image of the result; act on the third review too, then move on. Returns the notes, the most important '
      + 'first, each with where it applies and how, and the tools and add-ons to consider, each with what to do with it.',
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
      const path = await host.image(args.image, exec)
      const image = await readReviewImage(path, host.limits, exec.signal)
      exec.signal.throwIfAborted()
      const goal = args.goal?.trim()
      const focus = args.focus?.trim()
      const review = await host.review({
        image,
        subject,
        ...goal === undefined || goal === '' ? {} : { goal },
        ...focus === undefined || focus === '' ? {} : { focus },
        ...exec.agent === undefined ? {} : { sessionId: exec.agent.session.id },
      }, exec.signal)
      return { image: path, review }
    },
  })
}
