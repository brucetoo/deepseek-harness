import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { Attempts } from '../src/attempts.ts'
import { RouteKey } from '../src/brand.ts'
import { AutoModelRouter } from '../src/policy.ts'
import { AutoCatalogError, Routing } from '../src/routing.ts'
import type { AutoRouterPolicy } from '../src/types.ts'

const policy: AutoRouterPolicy = {
  virtualProvider: 'auto', virtualModel: 'auto',
  pools: { default: { include: ['*/*'], exclude: [] } }, models: [],
  maxFailoversPerStep: 2, tokenSafetyReserve: 0, ewmaAlpha: 0.5,
  failureThreshold: 2, baseCooldownMs: 10, maxCooldownMs: 100,
  halfOpenConcurrency: 1, explorationWeight: 0,
  scoring: { latency: 1, load: 0, failure: 0 },
}

function agent(header?: EpochHeader): Agent {
  return {
    session: { requestHeader: () => header, events: [] },
  } as unknown as Agent
}

function measurement(totalTokens: number): TokenMeasurement {
  return {
    logRevision: 0,
    baseline: { kind: 'none', tokens: 0 },
    surfaceDeltaTokens: 0,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes: [],
  }
}

function dependencies() {
  return {
    llm: {
      listProviders: vi.fn(() => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]),
      listModels: vi.fn(async (provider: string) => [{ provider, id: 'm', name: 'M', inputModalities: ['text'] as const }]),
      resolveModelInfo: vi.fn(async (provider: string, model: string) => ({
        provider, id: model, name: model, inputModalities: ['text'] as const,
        context: { contextWindow: 10_000 }, defaultMaxTokens: 500,
      })),
    },
    tokenMeter: {
      measure: vi.fn((_session: Session, _header?: EpochHeader) => measurement(100)),
    },
  }
}

describe('Routing', () => {
  it('leaves concrete selection proposals unchanged', async () => {
    const deps = dependencies()
    const routing = new Routing(deps, policy, new AutoModelRouter(policy), new Attempts())
    const proposal = { provider: 'fixed', model: 'one', temperature: 0.3 }

    await expect(routing.resolve({
      agent: agent(), turn: 1, step: 1, signal: new AbortController().signal,
      intent: { kind: 'model', provider: 'fixed', model: 'one' }, proposal,
    })).resolves.toBe(proposal)
    expect(deps.llm.listProviders).not.toHaveBeenCalled()
  })

  it('measures a full candidate header and preserves request controls', async () => {
    const deps = dependencies()
    deps.llm.listProviders.mockReturnValue([{ id: 'a', name: 'A' }])
    const router = new AutoModelRouter(policy)
    const attempts = new Attempts()
    const routing = new Routing(deps, policy, router, attempts)
    const current: EpochHeader = {
      config: { provider: 'auto', model: 'auto' },
      system: 'system', tools: [{ name: 'tool', description: 'd', parameters: {} }],
    }
    const subject = agent(current)
    const proposal = { provider: 'previous', model: 'physical', temperature: 0.2, stop: ['x'], maxTokens: 700 }

    await expect(routing.resolve({
      agent: subject, turn: 1, step: 1, signal: new AbortController().signal,
      intent: { kind: 'auto' }, proposal,
    })).resolves.toEqual({ provider: 'a', model: 'm', temperature: 0.2, stop: ['x'], maxTokens: 700 })
    expect(deps.tokenMeter.measure).toHaveBeenCalledWith(subject.session, {
      config: { provider: 'a', model: 'm', temperature: 0.2, stop: ['x'], maxTokens: 700 },
      system: 'system', tools: current.tools,
    })
    expect(attempts.match(subject, 1, 1, 'a', 'm')).toBeDefined()
  })

  it('clears an inherited physical reasoning effort for Auto', async () => {
    const deps = dependencies()
    deps.llm.listProviders.mockReturnValue([{ id: 'a', name: 'A' }])
    const routing = new Routing(deps, policy, new AutoModelRouter(policy), new Attempts())
    const resolved = await routing.resolve({ agent: agent(), turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' },
      proposal: { provider: 'old', model: 'old', reasoningEffort: 'high' as never, temperature: 0.1 } })
    expect(resolved).toEqual({ provider: 'a', model: 'm', temperature: 0.1 })
  })

  it('uses each candidate header measurement for its own context eligibility without rewriting catalog capacity', async () => {
    const deps = dependencies()
    deps.llm.resolveModelInfo.mockImplementation(async (provider: string, model: string) => ({
      provider, id: model, name: model, inputModalities: ['text'] as const,
      context: { contextWindow: provider === 'a' ? 1_000 : 10_000 }, defaultMaxTokens: 100,
    }))
    deps.tokenMeter.measure.mockImplementation((_session, header) =>
      measurement(header?.config.provider === 'a' ? 950 : 100))
    const router = new AutoModelRouter(policy)
    const replaceCatalog = vi.spyOn(router, 'replaceCatalog')
    const routing = new Routing(deps, policy, router, new Attempts())
    const resolved = await routing.resolve({ agent: agent(), turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' },
      proposal: { provider: 'old', model: 'old' } })
    expect(resolved.provider).toBe('b')
    expect(replaceCatalog).toHaveBeenCalledTimes(1)
    expect(replaceCatalog.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ provider: 'a', contextWindow: 1_000 }),
      expect.objectContaining({ provider: 'b', contextWindow: 10_000 }),
    ])
  })

  it('checks failover capability without consuming route selection rotation', async () => {
    const deps = dependencies()
    const router = new AutoModelRouter(policy, { rotationSeed: 0 })
    const attempts = new Attempts()
    const routing = new Routing(deps, policy, router, attempts)
    const subject = agent()
    const first = await routing.resolve({ agent: subject, turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' },
      proposal: { provider: 'seed', model: 'seed' } })
    expect(first.provider).toBe('a')
    expect(await routing.canFailover({ agent: subject, turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' }, proposal: first })).toBe(true)
    expect(router.snapshot().every(status => status.inFlight <= 1)).toBe(true)
  })

  it('invalidates the candidate catalog and observes later provider updates', async () => {
    const deps = dependencies()
    deps.llm.listProviders.mockReturnValue([{ id: 'a', name: 'A' }])
    const routing = new Routing(deps, policy, new AutoModelRouter(policy), new Attempts())
    const input = { agent: agent(), turn: 1, step: 1, signal: new AbortController().signal,
      intent: { kind: 'auto' as const }, proposal: { provider: 'auto', model: 'auto' } }
    expect((await routing.resolve(input)).provider).toBe('a')
    routing.release(input.agent)
    deps.llm.listProviders.mockReturnValue([{ id: 'b', name: 'B' }])
    routing.invalidateCatalog()
    expect((await routing.resolve({ ...input, step: 2 })).provider).toBe('b')
  })

  it('keeps healthy advertised models when another model metadata resolution fails', async () => {
    const deps = dependencies()
    deps.llm.resolveModelInfo.mockImplementation(async (provider: string, model: string) => {
      if (provider === 'a') throw new Error('invalid advertised model')
      return {
        provider, id: model, name: model, inputModalities: ['text'] as const,
        context: { contextWindow: 10_000 }, defaultMaxTokens: 500,
      }
    })
    const routing = new Routing(deps, policy, new AutoModelRouter(policy), new Attempts())

    await expect(routing.resolve({ agent: agent(), turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' },
      proposal: { provider: 'auto', model: 'auto' } })).resolves.toMatchObject({ provider: 'b', model: 'm' })
  })

  it('fails loudly when an explicit configured route cannot resolve metadata', async () => {
    const deps = dependencies()
    deps.llm.listProviders.mockReturnValue([])
    deps.llm.resolveModelInfo.mockRejectedValue(new Error('invalid explicit route'))
    const explicitPolicy = {
      ...policy,
      models: [{ route: RouteKey('missing/model'), pool: 'default', concurrencyLimit: 1 }],
    } satisfies AutoRouterPolicy
    const routing = new Routing(deps, explicitPolicy, new AutoModelRouter(explicitPolicy), new Attempts())

    await expect(routing.resolve({ agent: agent(), turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' },
      proposal: { provider: 'auto', model: 'auto' } })).rejects.toThrow('invalid explicit route')
  })

  it('keeps healthy provider catalogs when another provider listing fails', async () => {
    const deps = dependencies()
    deps.llm.listModels.mockImplementation(async (provider: string) => {
      if (provider === 'a') throw new Error('catalog down')
      return [{ provider, id: 'm', name: 'M', inputModalities: ['text'] as const }]
    })
    const routing = new Routing(deps, policy, new AutoModelRouter(policy), new Attempts())
    const resolved = await routing.resolve({ agent: agent(), turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' },
      proposal: { provider: 'auto', model: 'auto' } })
    expect(resolved.provider).toBe('b')
  })

  it('fails loudly when every provider catalog fails', async () => {
    const deps = dependencies()
    deps.llm.listModels.mockRejectedValue(new Error('catalog down'))
    const routing = new Routing(deps, policy, new AutoModelRouter(policy), new Attempts())
    await expect(routing.resolve({ agent: agent(), turn: 1, step: 1,
      signal: new AbortController().signal, intent: { kind: 'auto' },
      proposal: { provider: 'auto', model: 'auto' } })).rejects.toBeInstanceOf(AutoCatalogError)
  })
})
