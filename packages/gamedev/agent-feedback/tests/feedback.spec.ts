/**
 * The feedback tool as a Session's agent calls it: the real tool runtime and executor run each call against a fake WASD
 * Engine site with the account's token, naming WASD Engine's own agent and the model the Session runs on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as AgentFeedback from '../src/index.ts'
import { callTool, compose, ROUTE, text, TOKEN, type ComposeOptions, type Composition } from './composition.ts'
import { FEEDBACK_PATH } from './fixtures.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function composed(options: ComposeOptions = {}): Promise<Composition> {
  composition = await compose({ ...options, config: { usageReports: false, ...options.config } })
  return composition
}

describe('feedback_send', () => {
  it('sends the feedback for the signed-in account, as WASD Engine\'s own agent with its model', async () => {
    const current = await composed({ modelName: 'DeepSeek-V4.1-Flash', config: { appVersion: '0.1.3' } })
    const result = await callTool(current, 'feedback_send', {
      kind: 'bug',
      about: '  godot_run ',
      message: '  godot_run said the game was running,\nbut the main scene failed to compile.  ',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Sent your bug report about godot_run to the WASD Engine team. They read it but do not reply here, so carry on with the user\'s task.')
    expect(current.site.requests.map(request => [request.method, request.path, request.token])).toEqual([['POST', FEEDBACK_PATH, TOKEN]])
    expect(current.site.requests[0]?.body).toEqual({
      kind: 'bug',
      about: 'godot_run',
      message: 'godot_run said the game was running,\nbut the main scene failed to compile.',
      connected: false,
      agent: 'wasd-engine',
      agent_title: 'WASD Engine',
      model: 'DeepSeek-V4.1-Flash',
      app_version: '0.1.3',
      platform: process.platform,
    })
  })

  it('names the model by its id when no model service describes it, and words each kind', async () => {
    const current = await composed()
    const kinds = { missing_feature: 'request for a missing feature', confusing: 'report of something confusing', suggestion: 'suggestion' } as const
    for (const [kind, words] of Object.entries(kinds)) {
      const result = await callTool(current, 'feedback_send', { kind, message: 'Something.' })
      expect(text(result)).toBe(`Sent your ${words} to the WASD Engine team. They read it but do not reply here, so carry on with the user's task.`)
    }
    expect(current.site.requests.map(request => [request.body.kind, request.body.model, request.body.about, request.body.app_version]))
      .toEqual(Object.keys(kinds).map(kind => [kind, ROUTE.model, '', '']))
  })

  it('refuses feedback it cannot send, before any request', async () => {
    const current = await composed()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'praise', message: 'Nice.' }, 'kind'],
      [{ kind: 'bug', message: '   ' }, 'message must not be empty.'],
      [{ kind: 'bug', message: 'x'.repeat(4001) }, 'message must be at most 4000 characters; it has 4001.'],
      [{ kind: 'bug', message: 'Broken.', about: 'x'.repeat(121) }, 'about must be at most 120 characters; it has 121.'],
    ]
    for (const [args, message] of cases) {
      const result = await callTool(current, 'feedback_send', args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toContain(message)
    }
    expect(current.site.requests).toEqual([])
  })

  it('tells the agent what to do when WASD Engine is signed out or the site does not take the feedback', async () => {
    const current = await composed()
    current.account.signedIn = false
    const signedOut = await callTool(current, 'feedback_send', { kind: 'bug', message: 'Broken.' })
    expect(signedOut.isError).toBe(true)
    expect(text(signedOut)).toContain('WASD Engine is signed out, so the feedback was not sent. Ask the user to sign in to WASD Engine, then send it again.')
    expect(current.site.requests).toEqual([])

    current.account.signedIn = true
    const answers: Array<[number, string | undefined, string]> = [
      [401, 'Missing, invalid, or expired WASD Engine token.', 'WASD Engine\'s sign-in is no longer valid, so the feedback was not sent. Ask the user to sign in to WASD Engine again.'],
      [429, 'This account\'s agents have sent as much feedback as they may in a day. Try again tomorrow.', 'The WASD Engine site did not take the feedback: This account\'s agents have sent as much feedback as they may in a day. Try again tomorrow.'],
      [403, 'This account is on the WASD Engine waitlist.', 'The WASD Engine site did not take the feedback: This account is on the WASD Engine waitlist.'],
      [400, undefined, 'The WASD Engine site did not take the feedback: HTTP 400'],
      [503, undefined, 'The feedback could not be sent: the WASD Engine site answered HTTP 503. Try again later.'],
    ]
    for (const [status, message, expected] of answers) {
      current.site.failures.set(FEEDBACK_PATH, { status, ...message === undefined ? {} : { message } })
      const result = await callTool(current, 'feedback_send', { kind: 'bug', message: 'Broken.' })
      expect(result.isError, String(status)).toBe(true)
      expect(text(result)).toContain(expected)
    }
  })

  it('withdraws the tool when the plugin is disposed', async () => {
    const current = await composed()
    expect(current.ctx.tools.definitions().map(definition => definition.name)).toContain('feedback_send')
    await current.unload()
    expect(current.ctx.tools.definitions().map(definition => definition.name)).not.toContain('feedback_send')
  })

  it('validates its configuration, and names no app version the site would refuse', async () => {
    expect(AgentFeedback.Config({})).toEqual({ usageReports: true, reportIntervalMs: 60_000, requestTimeoutMs: 15_000, finalReportTimeoutMs: 3000, appVersion: '' })
    expect(() => AgentFeedback.Config({ reportIntervalMs: 10 })).toThrow()
    const current = await composed({ config: { appVersion: '0.1.3 (dev build)' } })
    const result = await callTool(current, 'feedback_send', { kind: 'bug', message: 'Broken.' })
    expect(result.isError).toBe(false)
    expect(current.site.requests[0]?.body.app_version).toBe('')
  })
})
