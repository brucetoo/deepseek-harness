import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import type { FeishuCardFace, NotifierConfiguration } from '../src/client/controller.ts'

const configuration: NotifierConfiguration = {
  enabled: true,
  webBaseUrl: 'http://127.0.0.1:3080',
  summaryMaxChars: 240,
  includeSessionTitle: true,
  recipients: [{ type: 'email', id: 'operator@example.com' }],
}

function bench() {
  const ctx = new Context()
  const scope = stubSettingsScope()
  const mountDispose = vi.fn()
  const testRecipient = vi.fn(() => Promise.resolve({ ok: true, value: { status: 'sent' } }))
  const mount = vi.fn(() => {
    const disposeNamespace = ctx.provide('remote.feishuHitlNotifier', { testRecipient })
    mountDispose.mockImplementation(disposeNamespace)
    return Promise.resolve(mountDispose)
  })
  class RemoteService extends Service {
    constructor() { super(ctx, 'remote') }
    $mount = mount
  }
  new SlotRegistry(ctx)
  new RemoteService()
  ctx.provide('settingsScope', { bind: vi.fn(() => scope.scope), describe: () => ({ acceptView: vi.fn() }) } as never)
  ctx.provide('connection', { api: { settings: { mutate: vi.fn() } } } as never)
  scope.publish({
    status: 'ready', writable: true, revision: 1, value: { configuration },
  })
  return { ctx, scope, slots: ctx.slots, mount, mountDispose, testRecipient }
}

describe('Feishu browser apply', () => {
  it('declares its runtime services', () => {
    expect(inject).toEqual(['slots', 'connection', 'remote', 'settingsScope'])
  })

  it('mounts its generated remote and contributes the keyed settings card', async () => {
    const { ctx, slots, mount } = bench()
    const root = slots.register({ name: 'root', children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(mount).toHaveBeenCalledOnce()
    expect(slots.entries('settings.plugin.item')[0]?.options.key).toBe('feishu-hitl-notifier')
    root()
  })

  it('invokes the mounted Remote namespace from an injected context', async () => {
    const { ctx, slots, testRecipient } = bench()
    slots.register({ name: 'root', children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('settings.plugin.item')[0]
    const face = entry?.inject?.() as unknown as FeishuCardFace

    await face.test('recipient-0')

    expect(testRecipient).toHaveBeenCalledWith(configuration.recipients[0])
    expect(face.hooks.feishuCard.getSnapshot().rows[0]?.testStatus).toBe('sent')
  })

  it('removes the card and generated remote on disposal', async () => {
    const { ctx, slots, mountDispose } = bench()
    slots.register({ name: 'root', children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(slots.entries('settings.plugin.item')).toHaveLength(0)
    expect(mountDispose).toHaveBeenCalledOnce()
  })
})
