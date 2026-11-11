/**
 * The ElevenLabs tools for agents connected through WASD Engine's MCP server: the Session's own tool definitions,
 * which need no Session, with each file named by absolute path. The audio is charged to the account WASD Engine is
 * signed in to, like the Session's own calls. A clone needs `consent: true`, which the agent may pass only after its
 * user confirmed the consent statement; WASD Engine's approval prompt does not reach these calls.
 * @module @deepseek-ai/dsh-elevenlabs/src/mcp
 */
import { isAbsolute } from 'node:path'
import type { GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CONSENT_STATEMENT } from './consent.ts'
import { elevenLabsToolDefinitions, type ElevenLabsToolHost, type ElevenLabsToolSurface } from './tools.ts'

/** How connected agents use the ElevenLabs tools. */
export const MCP_INSTRUCTIONS = 'ElevenLabs makes voices, sound effects, and music for the user\'s game, charged to the AI usage of the WASD Engine account the app is signed in to. '
  + 'elevenlabs_voices finds voices for characters in ElevenLabs\' Voice Library by description, gender, age, accent, and use case, or lists ElevenLabs\' default voices; it is free. '
  + 'elevenlabs_speech speaks one line in a voice with Eleven v4 Turbo, elevenlabs_sound_effect makes a sound effect with SFX v3, and elevenlabs_music composes music with Music v2.5. '
  + 'Each saves one file at path, an absolute path such as <game project>/audio/voices/guard_halt.mp3, and refuses to overwrite a file unless replace is true. '
  + 'Prefer .wav for sound effects and .mp3 for speech and music, give each character one voice, and save and reuse audio instead of making it again, since every generation costs the user\'s plan. '
  + 'elevenlabs_clone_voice clones a voice from 1 to 5 recordings of one speaker for the user\'s account alone; Pro and Max accounts keep up to 3, and elevenlabs_delete_voice frees one. '
  + `Before a clone, show your user this statement and pass consent: true only if they confirm it: "${CONSENT_STATEMENT}"`

/** The connected agents' surface: absolute paths, and consent that `prepare` checked before the call ran. */
const MCP_SURFACE: ElevenLabsToolSurface = {
  pathDescription: 'Absolute path of the file to write, such as <game project>/audio/voices/guard_halt.mp3.',
  samplesDescription: 'Recordings to clone, each an absolute path, such as <game project>/recordings/rhea-1.wav.',
  consentChannel: 'mcp',
  consentInstruction: 'show your user the consent statement and pass consent: true only if they confirm it',
  confirmClone: () => Promise.resolve('confirmed'),
}

/** The `consent` parameter connected agents pass to a clone. */
const CONSENT_PARAMETER = { type: 'boolean', description: `true only once your user confirmed: "${CONSENT_STATEMENT}"` } as const

function absolute(value: unknown): boolean {
  return typeof value === 'string' && isAbsolute(value)
}

/**
 * Offer one ElevenLabs tool definition to connected agents.
 * @param definition - the tool, built with the connected agents' path wording.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition): GameMcpTool {
  switch (definition.name) {
    case 'elevenlabs_voices':
      return { name: definition.name, definition, readOnly: true }
    case 'elevenlabs_delete_voice':
      return { name: definition.name, definition, readOnly: false }
    case 'elevenlabs_clone_voice': {
      // `defineTool` writes an object schema whose properties and required list describe the arguments.
      const { properties, required } = definition.parameters as {
        readonly properties: Readonly<Record<string, JsonObject>>
        readonly required: readonly string[]
      }
      return {
        name: definition.name,
        definition,
        inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties, consent: CONSENT_PARAMETER }, required: [...required, 'consent'] },
        readOnly: false,
        prepare(args) {
          const { consent, ...rest } = args
          if (consent !== true) return Promise.reject(new Error('Pass consent: true only after your user confirmed the consent statement; nothing was cloned.'))
          const samples = rest.samples
          if (!Array.isArray(samples) || !samples.every(absolute)) return Promise.reject(new Error('samples must be absolute paths.'))
          return Promise.resolve({ args: rest })
        },
      }
    }
    default:
      return {
        name: definition.name,
        definition,
        readOnly: false,
        prepare(args) {
          if (!absolute(args.path)) return Promise.reject(new Error('path must be an absolute path.'))
          return Promise.resolve({ args })
        },
      }
  }
}

/**
 * The ElevenLabs provider of WASD Engine's MCP server.
 * @param host - plugin operations the tools call.
 * @returns the provider.
 */
export function elevenLabsMcpProvider(host: ElevenLabsToolHost): GameMcpProvider {
  const tools = elevenLabsToolDefinitions(host, MCP_SURFACE).map(mcpTool)
  return {
    id: 'elevenlabs',
    title: 'ElevenLabs',
    description: 'Make character voices, sound effects, and music with ElevenLabs, saved into the user\'s game project, and clone the user\'s own voices.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
