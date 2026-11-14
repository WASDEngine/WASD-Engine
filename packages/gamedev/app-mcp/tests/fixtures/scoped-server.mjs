/**
 * App MCP server fixture with Session-scoped tools: a plain-Node entry, started like a package's built server entry,
 * whose one tool, `whoami`, answers with the Session that the Host's MCP client named in the call's `_meta`, or
 * `shared` for a call that named none. It registers tsx first, so the TypeScript sources resolve as they do in the
 * specs, and it ignores its server options.
 */
import { fileURLToPath } from 'node:url'
import { register } from 'tsx/esm/api'

register({ tsconfig: fileURLToPath(new URL('../../../../../tsconfig.json', import.meta.url)) })
const { serveAppMcp } = await import('../../src/index.ts')

const whoami = session => ({
  name: 'whoami', description: 'Name the calling Session.', input: {}, run: async () => ({ text: session ?? 'shared' }),
})

await serveAppMcp({
  name: 'scoped-app',
  version: '1.0.0',
  instructions: 'Session-scoped fixture tools for the specs.',
  tools: [whoami(undefined)],
  scopedTools: session => new Map([['whoami', whoami(session)]]),
})
