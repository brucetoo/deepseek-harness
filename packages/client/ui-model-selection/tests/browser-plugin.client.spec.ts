/**
 * ui-model-selection browser half on a real cordis Context with fake command/slots/
 * connection faces and real session scopes: the plugin mounts ModelDirectoryResolver
 * as `models`, the /model contribution and the conversation.input.model
 * seat both register, and BOTH entries resolve the SAME per-session
 * directory through the service — a selection submitted through the seat's
 * inject face is the current the popup's next options pass marks active
 * (and the reverse), the one-shared-state contract of the dual entry.
 * Scope disposal drops the directory (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelSelectionIntent, ResolvedModelRoute } from '@deepseek-ai/dsh-api-remotes/client'
import type { CommandContribution, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ModelSelectInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { ModelDirectory } from '../src/client/directory.ts'
import { zh } from '../src/client/locales.ts'

const sid = (k: string): SessionId => k as SessionId

const GROUPS = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
  ],
}]

/** Boot the plugin over fake faces + a stateful fake host (current moves on selectModel). */
async function bench() {
  const ctx = new Context()
  let current: ModelSelectionIntent = {
    kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash',
  }
  let lastRoute: ResolvedModelRoute | undefined = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
  }
  const calls = { models: 0, select: 0 }
  ctx.provide('connection', { api: { sessions: {
    models: () => {
      calls.models += 1
      return Promise.resolve({
        result: { ok: true as const, value: { current, lastRoute, routable, groups: GROUPS, failures: [] } },
      })
    },
    selectModel: (payload: { selection: ModelSelectionIntent }) => {
      calls.select += 1
      current = payload.selection
      if (current.kind === 'model') {
        lastRoute = {
          provider: current.provider,
          model: current.model,
          ...current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort },
        }
      }
      return Promise.resolve({
        result: { ok: true as const, value: { selected: current, lastRoute, routable } },
      })
    },
  } } })
  // Whether the Host reports an adapter for the current route; the composer
  // block follows this, never catalog membership.
  let routable = true
  const blocks = new Map<SessionId, { reason: string } | undefined>()
  ctx.provide('conversation', {
    blocks: {
      set: (id: SessionId, block: { reason: string } | undefined) => { blocks.set(id, block) },
    },
  })
  let contribution: CommandContribution | undefined
  ctx.provide('commandUi', {
    register(c: CommandContribution) {
      contribution = c
      return () => { contribution = undefined }
    },
  })
  const seats = new Map<string, {
    inject: ((sessionId: SessionId) => ModelSelectInjected) | undefined
    locale: string | undefined
  }>()
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(options: { name: string; locale?: string; inject?: (sessionId: SessionId) => ModelSelectInjected }) {
      seats.set(options.name, { inject: options.inject, locale: options.locale })
      return () => { seats.delete(options.name) }
    },
  })
  const localeRuntime = new LocaleRuntime(ctx)
  // This spec asserts the shipped Chinese copy. There is no jsdom `window` in
  // this lane, so browser-language detection never runs and the locale comes
  // from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  localeRuntime.setLocale('zh')
  ctx.provide('locale', localeRuntime)
  const scopes = new Map<SessionId, Context>()
  const addressed = new Set<SessionId>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id),
    subagentAddress: (id: SessionId) => addressed.has(id)
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  new TestRemote(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await ctx.plugin(function probe() {}).await()
  const mint = (key: string) => {
    const handle = createScope(ctx, sid(key))
    scopes.set(sid(key), handle.ctx)
    return handle
  }
  return {
    ctx, fiber, mint, calls,
    contribution: () => contribution!,
    seat: () => seats.get('conversation.input.model')!,
    hostCurrent: () => current,
    setHostCurrent: (selection: ModelSelectionIntent) => { current = selection },
    setLastRoute: (route: ResolvedModelRoute | undefined) => { lastRoute = route },
    address: (id: SessionId) => { addressed.add(id) },
    setRoutable: (next: boolean) => { routable = next },
    blockOf: (key: string) => blocks.get(sid(key)),
  }
}

const projection = (id: string) => ({ sessionId: sid(id) })

describe('ModelDirectory ordering', () => {
  it('ignores a stale load that settles after a newer selection', async () => {
    let finishLoad!: (value: never) => void
    const sessions = {
      models: () => new Promise((resolve) => { finishLoad = resolve }),
      selectModel: () => Promise.resolve({
        result: {
          ok: true as const,
          value: { selected: { kind: 'auto' as const }, routable: true },
        },
      }),
    }
    const directory = new ModelDirectory(sessions as never, sid('s1'), () => true)
    const loading = directory.load()
    await directory.select({ kind: 'auto' })
    finishLoad({
      result: {
        ok: true,
        value: {
          current: { kind: 'model', provider: 'old', model: 'old' },
          lastRoute: { provider: 'old', model: 'old' },
          routable: true,
          groups: [],
          failures: [],
        },
      },
    } as never)
    await loading
    expect(directory.store.getSnapshot().current).toEqual({ kind: 'auto' })
  })

  it('ignores a stale selection that settles after a newer load', async () => {
    let finishSelection!: (value: never) => void
    const sessions = {
      models: () => Promise.resolve({
        result: {
          ok: true as const,
          value: {
            current: { kind: 'model' as const, provider: 'new', model: 'new' },
            lastRoute: { provider: 'new', model: 'new' },
            routable: true,
            groups: [],
            failures: [],
          },
        },
      }),
      selectModel: () => new Promise((resolve) => { finishSelection = resolve }),
    }
    const directory = new ModelDirectory(sessions as never, sid('s1'), () => true)
    const selecting = directory.select({ kind: 'auto' })
    await directory.load()
    finishSelection({
      result: {
        ok: true,
        value: { selected: { kind: 'auto' }, routable: true },
      },
    } as never)
    await selecting
    expect(directory.store.getSnapshot().current).toEqual({
      kind: 'model', provider: 'new', model: 'new',
    })
  })
})

describe('ui-model-selection dual entry', () => {
  it('registers the /model contribution and the composer model seat', async () => {
    const b = await bench()
    expect(b.contribution().name).toBe('model')
    expect(b.contribution().ui.kind).toBe('popupSelect')
    expect(b.seat().inject).toBeTypeOf('function')
    // Copy rides the standard locale seat.
    expect(b.seat().locale).toBe('model')
  })

  it('puts one Auto row before physical groups and activates only the logical intent', async () => {
    const b = await bench()
    b.mint('s1')
    let options = await b.contribution().ui.options(projection('s1'), new AbortController().signal)
    expect(options.map((o: SelectOption) => o.label)).toEqual(['自动', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'])
    expect(options[0]?.active).toBeUndefined()
    expect(options[1]).toMatchObject({ active: true, detail: 'DeepSeek' })

    b.setHostCurrent({ kind: 'auto' })
    b.setLastRoute({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    options = await b.contribution().ui.options(projection('s1'), new AbortController().signal)
    expect(options[0]).toMatchObject({ active: true })
    expect(options[1]?.active).toBeUndefined()

    await b.contribution().ui.onSelect(options[0]!, projection('s1'))
    expect(b.hostCurrent()).toEqual({ kind: 'auto' })
  })

  it('a seat selection is the current the popup marks active next — one shared state', async () => {
    const b = await bench()
    b.mint('s1')
    const seatFace = b.seat().inject!(sid('s1'))
    // Switch through the SEAT entry.
    expect(await seatFace.select({
      kind: 'model',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })).toBe(true)
    expect(b.hostCurrent()).toEqual({
      kind: 'model',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
    expect(seatFace.directory.getSnapshot().current).toEqual({
      kind: 'model',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
    // The POPUP's next options pass reflects it without a seat-side reload.
    const options = await b.contribution().ui.options(projection('s1'), new AbortController().signal)
    expect(options.find((o: SelectOption) => o.label === 'DeepSeek-V4-Pro')).toMatchObject({ active: true })
  })

  it('a popup selection lands on the seat store — the reverse direction of the same state', async () => {
    const b = await bench()
    b.mint('s1')
    const seatFace = b.seat().inject!(sid('s1'))
    const options = await b.contribution().ui.options(projection('s1'), new AbortController().signal)
    const pro = options.find((o: SelectOption) => o.label === 'DeepSeek-V4-Pro')!
    await b.contribution().ui.onSelect(pro, projection('s1'))
    expect(seatFace.directory.getSnapshot().current).toEqual({
      kind: 'model',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })
  })

  it('both entries share one directory instance per session, isolated across sessions', async () => {
    const b = await bench()
    b.mint('a')
    b.mint('b')
    const faceA = b.seat().inject!(sid('a'))
    const faceA2 = b.seat().inject!(sid('a'))
    const faceB = b.seat().inject!(sid('b'))
    expect(faceA.directory).toBe(faceA2.directory)
    expect(faceA.directory).not.toBe(faceB.directory)
    // The service face resolves the same instance the seat inject handed out.
    expect(b.ctx.modelDirectories.directoryFor(sid('a')).store).toBe(faceA.directory)
  })

  it('drops an unconsumed local selection and restores the Host target after reconnect', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    await face.select({ kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    b.setHostCurrent({ kind: 'auto' })

    b.ctx.emit('connection/reset')
    expect(face.directory.getSnapshot()).toMatchObject({ current: null, status: 'loading' })
    await Promise.resolve()
    expect(face.directory.getSnapshot()).toMatchObject({
      current: { kind: 'auto' },
      status: 'ready',
    })
  })

  it('scope disposal drops the directory; a reborn scope gets a fresh one', async () => {
    const b = await bench()
    const first = b.mint('s1')
    const face1 = b.seat().inject!(sid('s1'))
    await first.fiber.dispose()
    b.mint('s1')
    const face2 = b.seat().inject!(sid('s1'))
    expect(face2.directory).not.toBe(face1.directory)
  })

  it('blocks the composer only once the Host reports the route unservable', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))

    // Before the first load nothing is known. `null` is not `false`: a slow
    // or unreachable Host must never lock a working composer.
    expect(b.blockOf('s1')).toBeUndefined()
    face.load()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')).toBeUndefined()

    b.setRoutable(false)
    b.ctx.remote.$dispatch('llm/adapters-updated', [])
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')?.reason).toBe(zh['blocked.composer'])

    // Recovering clears it without a reload of the surface.
    b.setRoutable(true)
    b.ctx.remote.$dispatch('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('never blocks on catalog membership alone', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    // A model the route serves but no longer advertises: the seat prompts for
    // a selection, the composer stays usable. Blocking here would break a
    // supported configuration (a narrowed `models` list over a live route).
    b.setHostCurrent({ kind: 'model', provider: 'deepseek-official', model: 'unlisted' })
    face.load()
    await Promise.resolve()
    await Promise.resolve()
    const snapshot = face.directory.getSnapshot()
    expect(snapshot.groups.flatMap(group => group.models.map(model => model.id))).not.toContain('unlisted')
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('clears its block when the session scope goes', async () => {
    const b = await bench()
    const scope = b.mint('s1')
    b.setRoutable(false)
    const face = b.seat().inject!(sid('s1'))
    face.load()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')).toBeDefined()

    await scope.fiber.dispose()
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('an unknown session fails loud at the seat inject', async () => {
    const b = await bench()
    expect(() => b.seat().inject!(sid('ghost'))).toThrow(/resolved no scope/)
  })

  it('withholds both model entries from addressed subagent sessions without Agent-bound RPCs', async () => {
    const b = await bench()
    b.mint('child')
    b.address(sid('child'))

    expect(b.contribution().available(projection('child'))).toBe(false)
    await expect(b.contribution().ui.options(
      projection('child'),
      new AbortController().signal,
    )).rejects.toThrow(/unavailable for addressed subagent/)

    const face = b.seat().inject!(sid('child'))
    expect(face.available).toBe(false)
    face.load()
    await expect(face.select({ kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' })).resolves.toBe(false)
    await expect(b.ctx.modelDirectories.directoryFor(sid('child')).load())
      .rejects.toThrow(/unavailable for addressed subagent/)
    await expect(b.ctx.modelDirectories.directoryFor(sid('child')).select({
      kind: 'model',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })).rejects.toThrow(/unavailable for addressed subagent/)
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.calls).toEqual({ models: 0, select: 0 })
  })
})
