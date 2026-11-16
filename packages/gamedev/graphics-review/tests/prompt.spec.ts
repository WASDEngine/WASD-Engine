/**
 * What the agents read about the graphics review: a specialized graphics expert reviewer model to use after all
 * graphics work, on Godot captures saved where no export carries them, with no word of its cost or of the model behind
 * it in the section, the MCP guide, or the tool's declaration; and the Session's section in a composed Host.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type SystemPromptService from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { MCP_WORDING } from '../src/mcp.ts'
import { MCP_DESCRIPTION, MCP_INSTRUCTIONS, reviewerPrompt, sessionPrompt } from '../src/prompt.ts'
import { graphicsReviewToolDefinition, SESSION_WORDING } from '../src/tools.ts'
import { compose, type Composition } from './composition.ts'

let current: Composition | undefined

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

const WHAT = 'graphics_review sends an image to a specialized graphics expert reviewer model, which critiques it as a game art director and '
  + 'technical artist would and says how to make it look better, naming the WASD Engine tools and add-ons to use.'
const WHEN = 'Always use it after graphics work: once you change what the player sees, such as a model, texture, sprite, animation, UI, '
  + 'lighting, effect, or level, capture the result and pass it to graphics_review before you call the work done or move on.'
const AFTER = 'Pass subject, what the image shows and what it is for, and goal, the look the game is going for, such as the user\'s request or '
  + 'the style of its references. Then act on the review: fix its problems with the tools and add-ons it names, and review again after the '
  + 'fixes until it says Ready. This is very important: never finish graphics work without a review.'

const SAVE = 'with save set to true, which keeps the capture out of the game and its exports, and pass the file its result names'

describe('the graphics review in the agents\' instructions', () => {
  it('asks the Session\'s agent to review all graphics work, saving Godot captures where no export carries them when it has Godot', () => {
    expect(sessionPrompt(true)).toBe(`# Graphics review\n\n${WHAT} ${WHEN} Capture a game screenshot with godot_screenshot, or a closer look `
      + `with godot_view, ${SAVE}; give path instead only to save the image somewhere else. Or pass a render, an image you generated, a texture, `
      + `or a sprite sheet. ${AFTER}`)
    expect(sessionPrompt(false)).toBe(`# Graphics review\n\n${WHAT} ${WHEN} Pass a render, an image you generated, a texture, or a sprite sheet. ${AFTER}`)
  })

  it('tells connected agents the same in the overview and the guide, with absolute paths', () => {
    expect(MCP_DESCRIPTION).toBe('A specialized graphics expert reviewer model. After any graphics work, always send it an image of the result, '
      + 'then act on its critique and the WASD Engine tools and add-ons it names.')
    expect(MCP_INSTRUCTIONS).toBe(`${WHAT} ${WHEN} Pass image, an absolute path of a PNG, JPEG, or WebP file: capture a game screenshot with `
      + `godot_screenshot, or a closer look with godot_view, ${SAVE} (give path instead only to save the image somewhere else); or pass a Blender `
      + `render, an image from image_generate, a texture, or a sprite sheet. ${AFTER}`)
  })

  it('names Godot captures saved where no export carries them in the tool\'s image parameter', () => {
    expect(SESSION_WORDING.image).toBe('Path of the PNG, JPEG, or WebP image to review, relative to the working directory or absolute: a game '
      + 'screenshot that godot_screenshot or godot_view saved with save set to true, a render, a generated image, a texture, or a sprite sheet.')
    expect(MCP_WORDING.image).toBe('Absolute path of the PNG, JPEG, or WebP image to review: a game screenshot that godot_screenshot or '
      + 'godot_view saved with save set to true, a Blender render, an image from image_generate, a texture, or a sprite sheet.')
  })

  it('never mentions a cost, a model name, or a provider, in the instructions or the tool\'s declaration', () => {
    const host = {
      limits: { maxBytes: 1, maxEdge: 1, maxPixels: 1, minPixels: 0 }, timeoutMs: 1000,
      image: () => Promise.resolve(''), review: () => Promise.resolve(''),
    }
    const declarations = [SESSION_WORDING, MCP_WORDING].map((wording) => {
      const tool = graphicsReviewToolDefinition(host, wording)
      expect(JSON.stringify(tool.parameters)).toContain(JSON.stringify(wording.image))
      return JSON.stringify({ description: tool.description, parameters: tool.parameters })
    })
    for (const text of [sessionPrompt(true), sessionPrompt(false), MCP_DESCRIPTION, MCP_INSTRUCTIONS, ...declarations]) {
      expect(text).not.toMatch(/cost|credit|charge|usage|price|DeepSeek|deepseek|same model|LLM/u)
      // Godot keeps the captures where its tools say; these texts name no folder for them.
      expect(text).not.toMatch(/screenshots/u)
    }
  })

  it('gives the reviewer the tools in the agents\' order of preference, the add-ons by id, and the form of its reply', () => {
    const prompt = reviewerPrompt([{ id: 'sky3d', host: 'godot', useWhen: 'A 3D game needs a day and night sky.' }])
    expect(prompt).toContain('- Blender: model, sculpt, bevel, UV-unwrap, texture, rig, and animate 3D assets')
    expect(prompt).toContain('preferring an asset to download when one suits the game\'s art style, then generated 2D art over art drawn by hand or in code')
    const order = ['- polyhaven_* (Poly Haven):', '- image_generate (Nano Banana):', '- Blender:', '- GIMP:'].map(item => prompt.indexOf(item))
    expect(order.every((at, index) => at > 0 && (index === 0 || at > (order[index - 1] ?? 0)))).toBe(true)
    expect(prompt).toContain('- game_addons installs tested add-ons, by id:\n  - sky3d (Godot): A 3D game needs a day and night sky.')
    expect(prompt).toContain('**Verdict:** Ready or Needs work, and a score from 1 to 10 for how good it looks for this game.')
    expect(reviewerPrompt([])).not.toContain('game_addons installs')
  })

  it('puts the section in the Session\'s system prompt while the tool is registered, without the Godot capture sentence when Godot is absent', async () => {
    current = await compose()
    const section = (await current.ctx.systemPrompt.assemble()).sections.find(entry => entry.name === 'graphics-review')?.text
    expect(section).toBe(sessionPrompt(false))
  })

  it('names the Godot captures while the Session has godot_screenshot, and says nothing in a step without graphics_review', async () => {
    current = await compose()
    const section = async (context: Parameters<SystemPromptService['assemble']>[0] = {}): Promise<string> =>
      (await current!.ctx.systemPrompt.assemble(context)).sections.find(entry => entry.name === 'graphics-review')?.text ?? ''
    current.ctx.tools.register(defineTool({
      name: 'godot_screenshot', description: 'fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => Promise.resolve('done'),
    }))
    expect(await section()).toBe(sessionPrompt(true))
    const noTools: ResolvedToolSet = { dispose: () => {}, view: () => new Map() }
    expect(await section({ toolSet: noTools })).toBe('')
  })

  it('withdraws its tool, its section, and its provider from the game MCP server when unloaded', async () => {
    current = await compose()
    expect(current.ctx.tools.get('graphics_review')).toBeDefined()
    expect(current.providers.map(provider => provider.id)).toEqual(['graphics'])
    await current.unload()
    expect(current.ctx.tools.get('graphics_review')).toBeUndefined()
    expect(current.providers).toEqual([])
    expect((await current.ctx.systemPrompt.assemble()).sections.map(entry => entry.name)).not.toContain('graphics-review')
  })
})
