import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { FeishuSettingsController, type NotifierConfiguration } from '../src/client/controller.ts'

const saved: NotifierConfiguration = {
  enabled: true,
  webBaseUrl: 'http://127.0.0.1:3080',
  summaryMaxChars: 240,
  includeSessionTitle: true,
  recipients: [{ type: 'email', id: 'operator@example.com' }],
}

function setup() {
  const bound = stubConfigForm<{ configuration: NotifierConfiguration }>()
  const mutate = bound.mutate
  const testRecipient = vi.fn()
  const controller = new FeishuSettingsController(bound.scope, testRecipient)
  bound.publish({ status: 'ready', writable: true, revision: 7, value: { configuration: saved } })
  return { bound, mutate, testRecipient, controller }
}

describe('FeishuSettingsController', () => {
  it('captures the first-edit revision and saves configuration with exactly one set op', async () => {
    const { controller, mutate, bound } = setup()
    controller.editWebBaseUrl('https://dsh.example')
    mutate.mockImplementation(() => {
      bound.publish({ revision: 8, value: { configuration: { ...saved, webBaseUrl: 'https://dsh.example' } } })
      return Promise.resolve(true)
    })

    await controller.save()

    expect(mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['configuration'], value: { ...saved, webBaseUrl: 'https://dsh.example' } }],
      7,
    )
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
    [new Error('<b>conflict</b>'), 'conflict'],
    [new Error('<script>transport</script>'), 'transport'],
  ])('preserves the draft and sanitizes a failed save', async (outcome, expected) => {
    const { controller, mutate } = setup()
    controller.editWebBaseUrl('https://draft.example')
    mutate.mockRejectedValue(outcome)
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
