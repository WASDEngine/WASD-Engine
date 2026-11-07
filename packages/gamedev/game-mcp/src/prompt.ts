/**
 * The prompt that sets another agent up to use the server: the user pastes it into Claude Code, Codex, or another
 * agent on the same computer, which then adds the server to its own MCP configuration.
 * @module @deepseek-ai/dsh-game-mcp/src/prompt
 */

/** Name under which the prompt asks agents to configure the server. */
export const SERVER_KEY = 'wasd-engine'

/**
 * Write the setup prompt.
 * @param url - the MCP endpoint.
 * @param token - the access token.
 * @returns the prompt, in English, with the commands for Claude Code and Codex.
 */
export function setupPrompt(url: string, token: string): string {
  const claude = JSON.stringify({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } })
  return [
    'Set up the WASD Engine MCP server, so you can use the game tools of WASD Engine, the game development app open on this computer: '
    + 'Godot to run, test, and play my game, Blender for 3D models, and GIMP for textures and sprites.',
    '',
    `Server name: ${SERVER_KEY}`,
    'Transport: Streamable HTTP',
    `URL: ${url}`,
    `Header: Authorization: Bearer ${token}`,
    '',
    'Add it to your own MCP configuration, for every project:',
    `- Claude Code: run claude mcp add-json ${SERVER_KEY} '${claude}' --scope user`,
    '- Codex: add to ~/.codex/config.toml:',
    `  [mcp_servers.${SERVER_KEY}]`,
    `  url = "${url}"`,
    `  http_headers = { "Authorization" = "Bearer ${token}" }`,
    '- Another agent: add a Streamable HTTP MCP server with this URL and header.',
    '',
    'Then load the server; if you load MCP servers only when you start, tell me to restart you. Call search_game_tools to see the tools '
    + 'and whether each one is ready. Games you start with godot_run play inside the WASD Engine window, where I can watch and play them, '
    + 'so keep using godot_screenshot to see them yourself. WASD Engine must stay open while you use its tools.',
  ].join('\n')
}
