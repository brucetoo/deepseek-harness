import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { FeishuSettingsController, type NotifierConfiguration } from '../src/client/controller.ts'

const saved: NotifierConfiguration = {
  enabled: true,
  webBaseUrl: 'http://127.0.0.1:3080',
  summaryMaxChars: 240,
  includeSessionTitle: true,
  recipients: [{ type: 'email', id: 'operator@example.com' }],
}

function setup() {
  const bound = stubSettingsScope<{ configuration: NotifierConfiguration }>()
  const mutate = vi.fn()
  const acceptView = vi.fn()
  const testRecipient = vi.fn()
  const controller = new FeishuSettingsController(bound.scope, { settings: { mutate } } as never, { acceptView }, testRecipient)
  bound.publish({ status: 'ready', writable: true, revision: 7, value: { configuration: saved } })
  return { bound, mutate, acceptView, testRecipient, controller }
}

describe('FeishuSettingsController', () => {
  it('captures the first-edit revision and saves configuration with exactly one set op', async () => {
    const { controller, mutate, acceptView } = setup()
    controller.editWebBaseUrl('https://dsh.example')
    mutate.mockResolvedValue({ result: { ok: true, value: { ns: 'feishu-hitl-notifier', revision: 8, value: { configuration: { ...saved, webBaseUrl: 'https://dsh.example' } } } } })

    await controller.save()

    expect(mutate).toHaveBeenCalledWith({ ns: 'feishu-hitl-notifier', expectedRevision: 7, ops: [{ op: 'set', path: ['configuration'], value: { ...saved, webBaseUrl: 'https://dsh.example' } }] })
    expect(acceptView).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().dirty).toBe(false)
  })

  it('retains a staged draft across external revisions and discard restores the latest saved value', () => {
    const { controller, bound } = setup()
    controller.editWebBaseUrl('https://draft.example')
    bound.publish({ revision: 8, value: { configuration: { ...saved, webBaseUrl: 'https://latest.example' } } })
    expect(controller.store.getSnapshot().draft.webBaseUrl).toBe('https://draft.example')
    controller.discard()
    expect(controller.store.getSnapshot().draft.webBaseUrl).toBe('https://latest.example')
  })

  it.each([
    [{ result: { ok: false, error: { code: 'settings-conflict', message: '<b>conflict</b>' } } }, 'conflict'],
    [new Error('<script>transport</script>'), 'transport'],
  ])('preserves the draft and sanitizes a failed save', async (outcome, expected) => {
    const { controller, mutate } = setup()
    controller.editWebBaseUrl('https://draft.example')
    if (outcome instanceof Error) mutate.mockRejectedValue(outcome)
    else mutate.mockResolvedValue(outcome)
    await controller.save()
    expect(controller.store.getSnapshot()).toMatchObject({ dirty: true })
    expect(controller.store.getSnapshot().error).toContain(expected)
    expect(controller.store.getSnapshot().error).not.toContain('<')
  })

  it('tests only a committed unchanged recipient and resets its status on edit', async () => {
    const { controller, testRecipient } = setup()
    testRecipient.mockResolvedValue({ ok: true, value: { status: 'sent' } })
    await controller.test('recipient-0')
    expect(testRecipient).toHaveBeenCalledWith(saved.recipients[0])
    expect(controller.store.getSnapshot().rows[0]?.testStatus).toBe('sent')
    controller.editRecipient('recipient-0', 'id', 'changed@example.com')
    expect(controller.store.getSnapshot().rows[0]?.testStatus).toBe('idle')
    expect(controller.canTest('recipient-0')).toEqual({ allowed: false, reason: 'Save this recipient before testing.' })
  })

  it('shows the precise Host test outcome instead of collapsing all non-sent results', async () => {
    const { controller, testRecipient } = setup()
    testRecipient.mockResolvedValue({ ok: true, value: { status: 'busy' } })
    await controller.test('recipient-0')
    expect(controller.store.getSnapshot().rows[0]?.testStatus).toBe('busy')
  })

  it('allows testing while notification delivery is disabled', () => {
    const { controller } = setup()
    controller.setEnabled(false)
    expect(controller.canTest('recipient-0')).toEqual({ allowed: true, warning: true })
  })

  it('disables all mutations for a read-only namespace', () => {
    const { controller, bound, mutate } = setup()
    bound.publish({ writable: false })
    controller.editWebBaseUrl('https://blocked.example')
    void controller.save()
    expect(controller.store.getSnapshot().draft.webBaseUrl).toBe(saved.webBaseUrl)
    expect(mutate).not.toHaveBeenCalled()
  })
})
