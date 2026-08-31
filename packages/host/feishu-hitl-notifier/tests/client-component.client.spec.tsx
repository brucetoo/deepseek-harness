// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, render as renderComponent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { FeishuSettingsCard } from '../src/client/FeishuSettingsCard.tsx'
import type { FeishuSettingsCardProps } from '../src/client/FeishuSettingsCard.tsx'
import type { FeishuCardFace, FeishuCardState } from '../src/client/controller.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const state: FeishuCardState = {
  available: true,
  writable: true,
  dirty: true,
  saving: false,
  invalid: false,
  error: null,
  draft: {
    enabled: false,
    webBaseUrl: 'http://localhost:3080',
    summaryMaxChars: 240,
    includeSessionTitle: true,
    recipients: [{ type: 'email', id: 'a@example.com' }],
  },
  rows: [{ key: 'r1', type: 'email', id: 'a@example.com', testStatus: 'idle' }],
}

function render(overrides: Partial<FeishuCardState> = {}) {
  const current = { ...state, ...overrides }
  const store = createSnapshotStore(current)
  const face: FeishuCardFace = {
    hooks: { feishuCard: store },
    setEnabled: vi.fn(),
    editWebBaseUrl: vi.fn(),
    editSummaryMaxChars: vi.fn(),
    setIncludeSessionTitle: vi.fn(),
    addRecipient: vi.fn(),
    removeRecipient: vi.fn(),
    editRecipient: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    test: vi.fn(),
    canTest: vi.fn(() => ({ allowed: true, warning: true })),
  }
  const props = {
    ...face,
    useFeishuCard: bindSnapshotSelector(store),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
  } as unknown as FeishuSettingsCardProps
  return { ...renderComponent(<FeishuSettingsCard {...props} />), face }
}

describe('FeishuSettingsCard', () => {
  it('uses native labelled controls and exposes disabled-send test warning', () => {
    const { container } = render()
    const labels = [...container.querySelectorAll('label')].map(label => label.textContent?.trim())
    expect(labels).toEqual(expect.arrayContaining([
      'Enabled', 'Web URL', 'Summary max chars', 'Include title', 'ID',
    ]))
    expect(labels.some(label => label?.startsWith('Type'))).toBe(true)
    expect(container.textContent).toContain(
      'Testing sends a real Feishu message even while automatic notifications are disabled.',
    )
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  })

  it('retains unsaved/error indication when collapsed', () => {
    const { container } = render({ error: 'Revision conflict' })
    const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(header.textContent).toContain('Unsaved')
    expect(header.textContent).toContain('Error')
    act(() => { header.click() })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toContain('Unsaved')
  })

  it('disables edits, save, and test in read-only mode', () => {
    const { container } = render({ writable: false })
    const controls = [...container.querySelectorAll('input,select,button')]
    expect(controls.filter(element => !(element as HTMLButtonElement).disabled))
      .toEqual([container.querySelector('button[aria-expanded]')])
  })

  it('keeps the final recipient removal available only while disabled', () => {
    const enabled = render({ draft: { ...state.draft, enabled: true } }).container
    expect((enabled.querySelector('button[aria-label="Remove recipient"]') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const disabled = render().container
    expect((disabled.querySelector('button[aria-label="Remove recipient"]') as HTMLButtonElement).disabled).toBe(false)
  })
})
