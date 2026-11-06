import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import type { FeishuCardFace, NotifierConfiguration } from '../src/client/controller.ts'

const configuration: NotifierConfiguration = {
  enabled: true,
  webBaseUrl: 'http://127.0.0.1:3080',
  summaryMaxChars: 240,
  includeSessionTitle: true,
  recipients: [{ type: 'email', id: 'operator@example.com' }],
}

async function bench() {
  const ctx = new Context()
  const scope = stubConfigForm<{ configuration: NotifierConfiguration }>()
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
  await ctx.plugin(SlotRegistry).await()
  new RemoteService()
  ctx.provide('configForms', {
    get: vi.fn(() => scope.scope),
    whileServed: (_names: readonly string[], register: (served: ReadonlySet<string>) => () => void) =>
      register(new Set(['feishu-hitl-notifier'])),
  } as never)
  scope.publish({
    status: 'ready', writable: true, revision: 1, value: { configuration },
  })
  return { ctx, scope, slots: ctx.slots, mount, mountDispose, testRecipient }
}

describe('Feishu browser apply', () => {
  it('declares its runtime services', () => {
    expect(inject).toEqual(['slots', 'remote', 'configForms'])
  })

  it('mounts its generated remote and contributes the keyed settings card', async () => {
    const { ctx, slots, mount } = await bench()
    const root = slots.register({ name: 'root', children: { 'plugins.item': { kind: 'list', scope: 'root' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(mount).toHaveBeenCalledOnce()
    expect(slots.entries('plugins.item')[0]?.options.id).toBe('feishu-hitl-notifier')
    root()
  })

  it('invokes the mounted Remote namespace from an injected context', async () => {
    const { ctx, slots, testRecipient } = await bench()
    slots.register({ name: 'root', children: { 'plugins.item': { kind: 'list', scope: 'root' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('plugins.item')[0]
    const face = entry?.inject?.() as unknown as FeishuCardFace

    await face.test('recipient-0')

    expect(testRecipient).toHaveBeenCalledWith(configuration.recipients[0])
    expect(face.hooks.feishuCard.getSnapshot().rows[0]?.testStatus).toBe('sent')
  })

  it('removes the card and generated remote on disposal', async () => {
    const { ctx, slots, mountDispose } = await bench()
    slots.register({ name: 'root', children: { 'plugins.item': { kind: 'list', scope: 'root' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(mountDispose).toHaveBeenCalledOnce()
  })
})
