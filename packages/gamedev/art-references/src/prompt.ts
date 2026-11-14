/**
 * The `art-references` system prompt section and the MCP server's instructions: the agent gathers references before it
 * makes any art, asks the user which direction they want when the references disagree, saves the references it uses,
 * and works from them. The section names a tool only while the Session has it.
 * @module @deepseek-ai/dsh-art-references/src/prompt
 */

/** The tools the section's steps name, by whether the Session has them. */
export interface PromptTools {
  /** `ask_user_question`. */
  readonly ask: boolean
  /** `image_generate`. */
  readonly imageGenerate: boolean
}

/**
 * The section's text.
 * @param tools - the tools the Session has.
 * @returns the section, starting with its heading.
 */
export function artReferencesPrompt(tools: PromptTools): string {
  const ask = tools.ask
    ? 'ask with ask_user_question which direction they want: one option per direction, labeled with its look and the numbers of the references that show it; the user can also answer with images of their own'
    : 'ask the user which direction they want, one direction per line with the numbers of the references that show it, and end your turn to wait for the answer'
  const uses = [
    ...tools.imageGenerate
      ? ['pass the one to three references closest to the chosen direction to image_generate in images, and say in the prompt what to take from each, such as the proportions and palette of the first image']
      : [],
    'compare what you make in Blender or GIMP with them',
    'for an animation, follow the frame count and timing of the frames sheet reference_save makes for a GIF',
  ]
  return `# Art references

Art made from good references comes out much better. Before you make any art asset, such as a sprite, character, creature, item, icon, tile, texture, background, UI piece, 3D model, animation, or effect, gather references for it with reference_search without waiting to be asked. Skip this only when the user already gave references for it, asks you not to search, or the asset repeats art the game already has, such as another color of an existing item.

- Search for the subject and its look in two to four short queries, such as "armored knight pixel art sprite", "knight sprite sheet walk cycle", and "medieval plate armor". For an animation, search for the motion too, such as "sword slash animation gif" or "walk cycle reference". Pass pages to take the images of a page the user linked or a gallery a search found.
- Always show the user the contact sheet, whether or not you ask them anything: put the Markdown image line the result gives you in your next message, so they see what the art will be based on.
- When the game already has art, keep its style, and take only the subject from the references: its shape, details, colors, and motion.
- Otherwise compare how the references look, not only what they show: art style (pixel art, painted, flat, 3D), pixel size or detail (a 16-pixel sprite against a 64-pixel one), proportions (cute against heroic or realistic), palette and mood, and view (side, top-down, isometric). When they differ in any of these and the request does not say which, ${ask}. Art direction is the user's choice, and a game's first art sets the look of the whole game, so ask even in the middle of a longer request. When the references agree, pick the ones that fit and go on without asking.
- Images the user gives you, with an answer or in a message, are references they chose, and each comes with its file path. Follow them first, and keep only the found references that agree with them.
- Save the references you use with reference_save, the user's images by their file paths. It keeps them in references/, out of the game, so it adds no asset and needs no approval; keep the art you make out of that folder.
- Work from the saved references: ${uses.join('; ')}.

References guide shape, proportions, colors, mood, and motion. Describe your own design and never copy a reference: do not reproduce someone else's character, logo, or artwork, and never put a reference image into the game.`
}

/** How connected agents use the reference tools, which the MCP server adds to its instructions under the provider's title. */
export const MCP_INSTRUCTIONS = 'The reference tools find reference images on the web for art you are about to make and save the ones you use into the user\'s game project. '
  + 'reference_search runs a web search for each query and takes the main image of every page found, including GIF animations and video posters, or every image of pages you name, and returns them numbered on one contact sheet image with each image\'s source. '
  + 'reference_save saves images by address, or image files on this computer by absolute path, into <project>/references/<subject>/, where project is the game project\'s folder as an absolute path, with their sources in SOURCES.md and a sheet of each animation\'s frames with their timing; Godot leaves references/ out of the game. '
  + 'Gather references before you make a sprite, texture, model, or animation, and show the user the contact sheet. When the references differ in style, pixel size or detail, proportions, palette, or view, and the request does not say which, ask the user which direction they want. Images the user gives you are references they chose: follow them first and save them too. '
  + 'Then work from the saved images, for example as images of image_generate with the prompt saying what to take from each. Never copy a reference into the game or reproduce someone else\'s character, logo, or artwork.'
