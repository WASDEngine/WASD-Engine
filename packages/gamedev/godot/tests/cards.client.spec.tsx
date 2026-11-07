// @vitest-environment jsdom
/** Godot tool cards: the model of each call phase, screenshots through the image loader, and text fallbacks. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ToolCallPhaseProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { GODOT_CARD_TOOLS, GodotToolCard, toolCardModel, type GodotToolCardProps } from '../src/client/cards.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type ResultBlock = Extract<ToolCallPhaseProps, { readonly phase: 'result' }>['block']
type Content = ResultBlock['content'][number]

const t = makeTranslate(en)
const SHOT: ImageAttachmentRef = { attachmentId: brandString<AttachmentId>('a'.repeat(64)), mediaType: 'image/jpeg', bytes: 4096, width: 1280, height: 720 }
const SHOT_TEXT = 'Screenshot 1280x720 of a 1280x720 window at frame 42'

const HEAD = { callId: 'call-1', name: 'godot_screenshot', turn: 1, step: 1, time: 1, subCalls: [], args: PartialArguments.fromObject({}) }

function result(content: readonly Content[], overrides: Partial<ResultBlock> = {}): ToolCallPhaseProps {
  return {
    phase: 'result',
    block: {
      kind: 'tool-result', seq: 2, time: 2, callId: 'call-1', name: 'godot_screenshot', args: PartialArguments.fromObject({}),
      call: null, callTime: null, content, isError: false, subCalls: [], ...overrides,
    },
  }
}

const PREPARING: ToolCallPhaseProps = { phase: 'preparing', block: { phase: 'preparing', ...HEAD } }
const STARTED: ToolCallPhaseProps = { phase: 'start', block: { phase: 'start', argsRaw: '{}', ...HEAD } }

function image(attachment: ImageAttachmentRef): Content {
  return { type: 'image', attachment }
}

describe('toolCardModel', () => {
  it('shows nothing but the running state before the result', () => {
    for (const view of [PREPARING, STARTED]) expect(toolCardModel(view)).toEqual({ state: 'running', images: [], invalidImages: false, text: '' })
  })

  it('collects the screenshots and text of a result', () => {
    const view = result([{ type: 'text', text: SHOT_TEXT }, image(SHOT), { type: 'text', text: 'paused' }, { type: 'reasoning', text: 'hidden' }])
    expect(toolCardModel(view)).toEqual({ state: 'ok', images: [SHOT], invalidImages: false, text: `${SHOT_TEXT}\npaused` })
  })

  it('classifies failed and interrupted calls', () => {
    expect(toolCardModel(result([{ type: 'text', text: 'Godot is not running. Call godot_run first.' }], { isError: true })).state).toBe('error')
    expect(toolCardModel(result([], { isError: true, error: { name: 'AbortError', code: 'interrupted' } })).state).toBe('stopped')
    expect(toolCardModel(result([], { isError: true, error: { name: 'Error', code: 'failed' } })).state).toBe('error')
  })

  it.each([
    ['a missing reference', null],
    ['an empty id', { ...SHOT, attachmentId: brandString<AttachmentId>('') }],
    ['a foreign id', { ...SHOT, attachmentId: 42 }],
    ['an unknown media type', { ...SHOT, mediaType: 'image/jpg' }],
    ['a fractional width', { ...SHOT, width: 1.5 }],
    ['a zero height', { ...SHOT, height: 0 }],
    ['no bytes', { ...SHOT, bytes: 0 }],
  ])('counts an image with %s as undisplayable', (_label, attachment) => {
    const view = result([{ type: 'image', attachment } as never, image(SHOT)])
    expect(toolCardModel(view)).toMatchObject({ images: [SHOT], invalidImages: true })
  })

  it('skips blocks of an unexpected form', () => {
    expect(toolCardModel(result([null as never, { type: 'text', text: 7 } as never, { type: 'text', text: 'kept' }])))
      .toEqual({ state: 'ok', images: [], invalidImages: false, text: 'kept' })
  })
})

function useDisclosure() {
  const [expanded, setExpanded] = useState(false)
  return { expanded, setExpanded, toggle: () => { setExpanded(open => !open) } }
}

function card(view: ToolCallPhaseProps, options: { toolName?: string; peek?: string; inspect?: () => void } = {}) {
  const load = vi.fn(async (_attachment: ImageAttachmentRef) => 'blob:shot')
  const peek = vi.fn((_attachment: ImageAttachmentRef) => options.peek)
  const props: GodotToolCardProps = {
    ...view,
    callId: 'call-1',
    toolName: options.toolName ?? 'godot_screenshot',
    openFile: vi.fn(),
    loadImage: Object.assign(load, { peek }),
    useDisclosure,
    ...options.inspect === undefined ? {} : { inspect: options.inspect },
    t,
  }
  const rendered = render(<GodotToolCard {...props} />)
  const row = (): HTMLElement => {
    const found = rendered.container.querySelector<HTMLElement>('[data-disclosure-row]')
    if (found === null) throw new Error('the card has no disclosure row')
    return found
  }
  return { rendered, load, peek, row }
}

describe('GodotToolCard', () => {
  it('names each Godot tool', () => {
    expect(GODOT_CARD_TOOLS).toEqual(['godot_screenshot', 'godot_input', 'godot_wait'])
    for (const [toolName, title] of [['godot_screenshot', 'card.screenshot'], ['godot_input', 'card.input'], ['godot_wait', 'card.wait']] as const) {
      const c = card(PREPARING, { toolName })
      expect(c.rendered.container.querySelector(`[data-tool="${toolName}"]`)?.textContent).toContain(en[title])
      cleanup()
    }
  })

  it('shows a running call without a body', () => {
    const c = card(STARTED)
    expect(c.rendered.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(c.row().getAttribute('role')).toBeNull()
  })

  it('summarizes a screenshot by its size and loads it when expanded', async () => {
    const c = card(result([{ type: 'text', text: SHOT_TEXT }, image(SHOT)]))
    expect(c.row().textContent).toContain('1280 × 720')
    expect(c.load).not.toHaveBeenCalled()
    fireEvent.click(c.row())
    expect(screen.getByText(en['card.loading'])).toBeTruthy()
    const shot = await screen.findByRole('img', { name: en['card.screenshot'] })
    expect(shot.getAttribute('src')).toBe('blob:shot')
    expect(c.load).toHaveBeenCalledWith(SHOT)
    expect(screen.getByText(SHOT_TEXT).tagName).toBe('PRE')
    fireEvent.click(screen.getByRole('button', { name: en['card.open'] }))
    const dialog = screen.getByRole('dialog', { name: en['card.preview'] })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:shot')
    fireEvent.click(screen.getByRole('button', { name: en['card.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('draws a cached screenshot at once', () => {
    const c = card(result([image(SHOT)]), { peek: 'blob:cached' })
    fireEvent.click(c.row())
    expect(screen.getByRole('img', { name: en['card.screenshot'] }).getAttribute('src')).toBe('blob:cached')
  })

  it('offers a retry when the screenshot cannot load', async () => {
    const c = card(result([image(SHOT)]))
    c.load.mockRejectedValueOnce(new Error('expired'))
    fireEvent.click(c.row())
    fireEvent.click(await screen.findByRole('button', { name: en['card.loadFailed'] }))
    expect(await screen.findByRole('img', { name: en['card.screenshot'] })).toBeTruthy()
    expect(c.load).toHaveBeenCalledTimes(2)
  })

  it('ignores a load that finishes after the card closed', async () => {
    const pending = Promise.withResolvers<string>()
    const c = card(result([image(SHOT)]))
    c.load.mockReturnValueOnce(pending.promise)
    fireEvent.click(c.row())
    fireEvent.click(c.row())
    pending.resolve('blob:late')
    await waitFor(() => { expect(c.load).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('img')).toBeNull()
    const failed = Promise.withResolvers<string>()
    c.load.mockReturnValueOnce(failed.promise)
    fireEvent.click(c.row())
    fireEvent.click(c.row())
    failed.reject(new Error('late failure'))
    await waitFor(() => { expect(c.load).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('button', { name: en['card.loadFailed'] })).toBeNull()
  })

  it('falls back to the result text for an input or wait call without a screenshot', () => {
    const c = card(result([{ type: 'text', text: 'Sent 2 events over 3 frames\nNo new errors' }]), { toolName: 'godot_input' })
    expect(c.row().textContent).toContain('Sent 2 events over 3 frames')
    expect(c.row().textContent).not.toContain('No new errors')
    fireEvent.click(c.row())
    expect(screen.getByText(/No new errors/u).tagName).toBe('PRE')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('reports failed, interrupted, and undisplayable results', () => {
    const failed = card(result([{ type: 'text', text: 'Godot is not running.' }], { isError: true }), { toolName: 'godot_wait' })
    expect(failed.row().textContent).toContain(en['card.failed'])
    fireEvent.click(failed.row())
    expect(screen.getByText('Godot is not running.')).toBeTruthy()
    cleanup()
    const stopped = card(result([], { isError: true, error: { name: 'AbortError', code: 'interrupted' } }))
    expect(stopped.row().textContent).toContain(en['card.stopped'])
    cleanup()
    const invalid = card(result([{ type: 'image', attachment: null } as never]))
    fireEvent.click(invalid.row())
    expect(screen.getByText(en['card.invalid'])).toBeTruthy()
  })

  it('stays collapsed without content and offers the inspector when available', () => {
    const empty = card(result([]))
    expect(empty.row().getAttribute('role')).toBeNull()
    expect(empty.row().textContent).toBe(en['card.screenshot'])
    cleanup()
    const inspect = vi.fn()
    const inspectable = card(result([]), { inspect })
    fireEvent.click(inspectable.row())
    fireEvent.click(screen.getByRole('button', { name: en['card.inspect'] }))
    expect(inspect).toHaveBeenCalledOnce()
  })
})
