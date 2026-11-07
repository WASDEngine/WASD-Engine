/**
 * App MCP server fixture in TypeScript, the form of a server entry in a source
 * checkout. It imports this package by its workspace name, which only the
 * repository's tsconfig `paths` map to the sources, and declares a parameter
 * property, which Node's own type stripping rejects, so it runs only when the
 * registered command line loads tsx with the repository configuration.
 */
import { decodeServerOptions, serveAppMcp } from '@deepseek-ai/dsh-app-mcp'

class Greeting {
  constructor(private readonly text: string) {}

  reply(): { text: string } {
    return { text: this.text }
  }
}

const options = decodeServerOptions(process.argv)
const greeting = new Greeting(typeof options.greeting === 'string' ? options.greeting : 'no greeting option')

await serveAppMcp({
  name: 'source-app',
  version: '1.0.0',
  instructions: 'Source fixture tools for the specs.',
  tools: [{ name: 'greet', description: 'Return the greeting from the server options.', input: {}, run: async () => greeting.reply() }],
})
