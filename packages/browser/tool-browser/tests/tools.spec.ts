import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserRuntime, {
  BrowserPreparedActionId,
  type BrowserElementAction,
  type BrowserObservation,
  type BrowserOpenRequest,
  type BrowserPreparedAction,
  type BrowserPreparedActionId as BrowserPreparedActionIdType,
  type BrowserWaitRequest,
} from '@deepseek-ai/dsh-browser'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService, {
  type ApprovalOutcome,
  type ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval'
import * as ToolBrowser from '../src/index.ts'
import {
  assertOwner,
  assertPositiveInteger,
  validateTarget,
} from '../src/tool-support.ts'

const fullObservation: BrowserObservation = {
  url: 'https://example.com/form',
  title: 'Public form',
  snapshot: '- textbox "Query"\n- button "Submit"',
}

class StubBrowserRuntime extends BrowserRuntime {
  readonly calls: string[] = []
  readonly prepared: BrowserPreparedAction = {
    id: BrowserPreparedActionId('prepared-1'),
    owner: undefined as unknown as Agent,
    pageUrl: fullObservation.url,
    action: {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    },
    fingerprint: {
      tagName: 'button',
      role: 'button',
      accessibleName: 'Submit',
      formAction: 'https://example.com/submit',
    },
  }

  async open(_owner: Agent, request: BrowserOpenRequest): Promise<BrowserObservation> {
    this.calls.push(`open:${request.url}`)
    return fullObservation
  }

  async snapshot(): Promise<BrowserObservation> {
    this.calls.push('snapshot')
    return fullObservation
  }

  async prepare(owner: Agent, action: BrowserElementAction): Promise<BrowserPreparedAction> {
    this.calls.push(`prepare:${action.kind}`)
    return { ...this.prepared, owner, action }
  }

  async commit(_owner: Agent, id: BrowserPreparedActionIdType): Promise<BrowserObservation> {
    this.calls.push(`commit:${id}`)
    return fullObservation
  }

  async release(_owner: Agent, id: BrowserPreparedActionIdType): Promise<void> {
    this.calls.push(`release:${id}`)
  }

  async wait(_owner: Agent, request: BrowserWaitRequest): Promise<BrowserObservation> {
    this.calls.push(`wait:${request.durationMs}`)
    return fullObservation
  }

  async close(): Promise<void> {
    this.calls.push('close')
  }
}

interface Harness {
  readonly ctx: Context
  readonly browser: StubBrowserRuntime
  readonly agent: Agent
  readonly requests: ApprovalRequest[]
  setOutcome(outcome: ApprovalOutcome): void
  call(name: string, args: unknown): Promise<ToolExecutionResult>
}

const createHarness = async (
  config: ToolBrowser.Config = {},
): Promise<Harness> => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(StubBrowserRuntime)
  const browser = ctx.browser as StubBrowserRuntime
  await ctx.plugin(ToolBrowser, config)
  const session = Session.create(SessionId('browser-owner'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session } as unknown as Agent
  const requests: ApprovalRequest[] = []
  let outcome: ApprovalOutcome = 'allowed-once'
  ctx.on('approval/request', (request) => {
    requests.push(request)
    return Promise.resolve(outcome)
  })
  let nextCall = 0
  return {
    ctx,
    browser,
    agent,
    requests,
    setOutcome: (value) => {
      outcome = value
    },
    call: (name, args) => ctx.tools.execute({
      agent,
      arguments: args,
      callId: CallId(`browser-call-${++nextCall}`),
      name,
      signal: new AbortController().signal,
    }),
  }
}

describe('tool-browser registration and observation', () => {
  it('registers the seven desktop browser tools', async () => {
    const harness = await createHarness()

    expect(harness.ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([
      'browser_click',
      'browser_close',
      'browser_fill',
      'browser_open',
      'browser_select',
      'browser_snapshot',
      'browser_wait',
    ])
  })

  it('publishes stable presentation intent for every browser command', async () => {
    const harness = await createHarness()
    const presentations = [
      ['browser_open', { url: 'https://example.com/' }],
      ['browser_snapshot', {}],
      ['browser_click', { role: 'button', name: 'Submit' }],
      ['browser_fill', { role: 'textbox', name: 'Query', value: 'value' }],
      ['browser_select', { role: 'combobox', name: 'Region', option: 'Europe' }],
      ['browser_wait', { duration_ms: 250 }],
      ['browser_close', {}],
    ] as const

    expect(presentations.map(([name, args]) =>
      harness.ctx.tools.get(name)?.presentCall?.(args))).toEqual([
      {
        card: 'generic',
        title: 'https://example.com/',
        kind: 'search',
        rawInput: 'https://example.com/',
      },
      { card: 'generic', title: 'Observe browser', kind: 'read' },
      {
        card: 'generic',
        title: 'Click Submit',
        kind: 'other',
        rawInput: { role: 'button', name: 'Submit' },
      },
      {
        card: 'generic',
        title: 'Fill Query',
        kind: 'other',
        rawInput: { role: 'textbox', name: 'Query', value: 'value' },
      },
      {
        card: 'generic',
        title: 'Select Region',
        kind: 'other',
        rawInput: { role: 'combobox', name: 'Region', option: 'Europe' },
      },
      {
        card: 'generic',
        title: 'Wait 250 ms',
        kind: 'other',
        rawInput: 250,
      },
      { card: 'generic', title: 'Close browser', kind: 'other' },
    ])
  })

  it('opens only after one-shot approval and returns bounded structured state', async () => {
    const harness = await createHarness({ maxOutputBytes: 512 })

    const result = await harness.call('browser_open', {
      url: 'https://example.com/form',
    })

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      url: fullObservation.url,
      title: fullObservation.title,
      snapshot: fullObservation.snapshot,
      truncated: false,
    })
    expect(harness.browser.calls).toEqual(['open:https://example.com/form'])
    expect(harness.requests[0]).toMatchObject({
      toolName: 'browser_open',
      callId: 'browser-call-1',
    })
    expect(harness.requests[0]?.reason).toContain('https://example.com/form')
    expect(harness.requests[0]?.reason).toContain('Session history')
  })

  it.each<ApprovalOutcome>([
    'rejected',
    'cancelled',
    'unavailable',
  ])('does not open after the %s approval outcome', async (outcome) => {
    const harness = await createHarness()
    harness.setOutcome(outcome)

    const result = await harness.call('browser_open', {
      url: 'https://example.com/',
    })

    expect(result.isError).toBe(true)
    expect(harness.browser.calls).toEqual([])
  })

  it('caps the complete rendered result by UTF-8 bytes and marks truncation', async () => {
    const harness = await createHarness({ maxOutputBytes: 160 })
    const original = fullObservation.snapshot
    Object.assign(fullObservation, { snapshot: '页面'.repeat(300) })
    try {
      const result = await harness.call('browser_snapshot', {})
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ truncated: true })
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(160)
      expect(text).toContain('URL:')
      expect(text).toContain('Title:')
      expect(text).toContain('Truncated: yes')
    } finally {
      Object.assign(fullObservation, { snapshot: original })
    }
  })

  it('closes every still-owned browser while disposing the tool plugin', async () => {
    const harness = await createHarness()
    await harness.call('browser_open', { url: 'https://example.com/' })
    const close = vi.spyOn(harness.browser, 'close').mockRejectedValueOnce(
      new Error('already gone'),
    )

    await harness.ctx.fiber.dispose()

    expect(close).toHaveBeenCalledWith(harness.agent)
  })
})

describe('tool-browser prepared mutations', () => {
  it('commits the exact prepared click after approval', async () => {
    const harness = await createHarness()

    const result = await harness.call('browser_click', {
      role: 'button',
      name: 'Submit',
    })

    expect(result.isError).toBe(false)
    expect(harness.browser.calls).toEqual([
      'prepare:click',
      'commit:prepared-1',
    ])
    expect(harness.requests[0]?.reason).toContain('button "Submit"')
    expect(harness.requests[0]?.reason).toContain('https://example.com/submit')
  })

  it('includes the complete fill value in approval and releases on rejection', async () => {
    const harness = await createHarness()
    harness.setOutcome('rejected')

    const result = await harness.call('browser_fill', {
      role: 'textbox',
      name: 'Query',
      value: 'exact public value',
    })

    expect(result.isError).toBe(true)
    expect(harness.requests[0]?.reason).toContain('"exact public value"')
    expect(harness.browser.calls).toEqual([
      'prepare:fill',
      'release:prepared-1',
    ])
  })

  it('includes the selected option in approval and releases when approval is unavailable', async () => {
    const harness = await createHarness()
    harness.setOutcome('unavailable')

    const result = await harness.call('browser_select', {
      role: 'combobox',
      name: 'Region',
      option: 'Europe',
    })

    expect(result.isError).toBe(true)
    expect(harness.requests[0]?.reason).toContain('"Europe"')
    expect(harness.browser.calls).toEqual([
      'prepare:select',
      'release:prepared-1',
    ])
  })

  it('commits indexed fill and select actions with complete fingerprint context', async () => {
    const harness = await createHarness()
    Object.assign(harness.browser.prepared, {
      fingerprint: {
        tagName: 'input',
        role: 'textbox',
        accessibleName: 'Query',
        inputType: 'text',
        href: 'https://example.com/help',
      },
    })

    const fill = await harness.call('browser_fill', {
      role: 'textbox',
      name: 'Query',
      index: 1,
      value: 'exact value',
    })
    const select = await harness.call('browser_select', {
      role: 'combobox',
      name: 'Region',
      index: 2,
      option: 'Europe',
    })

    expect(fill.isError).toBe(false)
    expect(select.isError).toBe(false)
    expect(harness.requests[0]?.reason).toContain('at index 1')
    expect(harness.requests[0]?.reason).toContain('type="text"')
    expect(harness.requests[0]?.reason).toContain(
      'link destination=https://example.com/help',
    )
    expect(harness.browser.calls).toEqual([
      'prepare:fill',
      'commit:prepared-1',
      'prepare:select',
      'commit:prepared-1',
    ])
  })

  it('includes an explicit index in a click action', async () => {
    const harness = await createHarness()

    const result = await harness.call('browser_click', {
      role: 'button',
      name: 'Submit',
      index: 3,
    })

    expect(result.isError).toBe(false)
    expect(harness.requests[0]?.reason).toContain('at index 3')
  })

  it('waits, snapshots, and closes without requesting approval', async () => {
    const harness = await createHarness()

    await harness.call('browser_wait', { duration_ms: 250 })
    await harness.call('browser_snapshot', {})
    await harness.call('browser_close', {})

    expect(harness.requests).toHaveLength(0)
    expect(harness.browser.calls).toEqual(['wait:250', 'snapshot', 'close'])
  })

  it('rejects waits above the configured limit', async () => {
    const harness = await createHarness({ maxWaitMs: 500 })

    const result = await harness.call('browser_wait', { duration_ms: 501 })

    expect(result.isError).toBe(true)
    expect(harness.browser.calls).toEqual([])
  })
})

describe('tool-browser model-boundary validation', () => {
  it('requires an owner and positive integer configuration', () => {
    expect(() => assertOwner(undefined)).toThrow(
      expect.objectContaining({ code: 'BROWSER_OWNER_REQUIRED' }),
    )
    expect(() =>{  assertPositiveInteger('value', 0) }).toThrow(/at least 1/)
    expect(() =>{  assertPositiveInteger('value', 1.5) }).toThrow(/at least 1/)
    expect(() =>{  assertPositiveInteger('value', 127, 128) }).toThrow(/at least 128/)
  })

  it('rejects empty target fields and negative or fractional indexes', () => {
    expect(() =>{  validateTarget({ role: ' ', name: 'Submit' }) }).toThrow(
      expect.objectContaining({ code: 'BROWSER_INVALID_TARGET' }),
    )
    expect(() =>{  validateTarget({ role: 'button', name: ' ' }) }).toThrow(
      expect.objectContaining({ code: 'BROWSER_INVALID_TARGET' }),
    )
    expect(() =>{  validateTarget({
      role: 'button',
      name: 'Submit',
      index: -1,
    }) }).toThrow(expect.objectContaining({ code: 'BROWSER_INVALID_TARGET' }))
    expect(() =>{  validateTarget({
      role: 'button',
      name: 'Submit',
      index: 0.5,
    }) }).toThrow(expect.objectContaining({ code: 'BROWSER_INVALID_TARGET' }))
  })

  it('rejects invalid resolved plugin configuration at load', async () => {
    await expect(createHarness({ maxOutputBytes: 127 })).rejects.toThrow(
      /maxOutputBytes must be an integer of at least 128/,
    )
    await expect(createHarness({ timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs must be an integer of at least 1/,
    )
    await expect(createHarness({ maxWaitMs: 1.5 })).rejects.toThrow(
      /maxWaitMs must be an integer of at least 1/,
    )
  })
})
