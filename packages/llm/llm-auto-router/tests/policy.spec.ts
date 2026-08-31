import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { RouteKey } from '../src/brand.ts'
import { AutoModelRouter, AutoRoutingError } from '../src/policy.ts'
import type { AutoRouterPolicy, CandidateRoute } from '../src/types.ts'

const policy: AutoRouterPolicy = {
  virtualProvider: 'auto',
  virtualModel: 'auto',
  pools: { default: { include: ['*/*'], exclude: [] } },
  models: [],
  maxFailoversPerStep: 2,
  tokenSafetyReserve: 100,
  ewmaAlpha: 0.5,
  failureThreshold: 3,
  baseCooldownMs: 1_000,
  maxCooldownMs: 4_000,
  halfOpenConcurrency: 1,
  explorationWeight: 0.05,
  scoring: { latency: 0.35, load: 0.35, failure: 0.3 },
}

function route(key: string, patch: Partial<CandidateRoute> = {}): CandidateRoute {
  const [provider = '', model = ''] = key.split('/')
  return {
    key: RouteKey(key),
    provider,
    model,
    advertised: true,
    enabled: true,
    pool: 'default',
    preferenceMultiplier: 1,
    concurrencyLimit: 2,
    inputModalities: ['text'],
    contextWindow: 10_000,
    defaultMaxTokens: 1_000,
    ...patch,
  }
}

function request(patch: Record<string, unknown> = {}) {
  return {
    pool: 'default',
    requiredModalities: ['text'] as const,
    estimatedInputTokens: 1_000,
    attemptedRoutes: new Set<ReturnType<typeof RouteKey>>(),
    now: 0,
    ...patch,
  }
}

function withoutContext(candidate: CandidateRoute): CandidateRoute {
  const { contextWindow: _contextWindow, ...remaining } = candidate
  return remaining
}

function withoutOutputDefault(candidate: CandidateRoute): CandidateRoute {
  const { defaultMaxTokens: _defaultMaxTokens, ...remaining } = candidate
  return remaining
}

describe('AutoModelRouter eligibility', () => {
  it('checks availability without consuming tie rotation or reserving health', () => {
    const router = new AutoModelRouter(policy, { rotationSeed: 0 })
    router.replaceCatalog([route('a/m'), route('b/m')])
    const input = request()

    expect(router.canSelect(input)).toBe(true)
    expect(router.canSelect(input)).toBe(true)
    expect(router.snapshot()).toEqual(router.snapshot().map(status => ({ ...status, inFlight: 0 })))
    expect(router.select(input).route.key).toBe('a/m')
  })
  it('uses request-local token estimates per route', () => {
    const router = new AutoModelRouter(policy)
    router.replaceCatalog([
      route('small/m', { contextWindow: 2_000, preferenceMultiplier: 0.1 }),
      route('large/m', { contextWindow: 10_000, preferenceMultiplier: 10 }),
    ])

    expect(router.select(request({
      estimatedInputTokens: 0,
      estimatedInputTokensByRoute: new Map([
        [RouteKey('small/m'), 1_500],
        [RouteKey('large/m'), 100],
      ]),
    })).route.key).toBe('large/m')
    expect(router.snapshot().find(status => status.key === 'small/m')).toMatchObject({ sampleCount: 0 })
  })

  it.each([
    ['disabled', route('p/m', { enabled: false }), request()],
    ['attempted', route('p/m'), request({ attemptedRoutes: new Set([RouteKey('p/m')]) })],
    ['modality', route('p/m'), request({ requiredModalities: ['image'] })],
    ['reasoning', route('p/m'), request({ reasoningEffort: ReasoningEffortId('high') })],
    ['context-capacity', withoutContext(route('p/m')), request()],
    ['context-capacity', route('p/m', { contextWindow: 2_099 }), request()],
    ['output-capacity', withoutOutputDefault(route('p/m')), request()],
  ] as const)('reports stable %s rejection', (category, candidate, input) => {
    const router = new AutoModelRouter(policy)
    router.replaceCatalog([candidate])
    expect(() => router.select(input)).toThrow(AutoRoutingError)
    try {
      router.select(input)
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'AUTO_NO_CANDIDATE', rejectedCapabilities: [category] })
    }
  })

  it('uses explicit max tokens and the configured safety reserve', () => {
    const router = new AutoModelRouter(policy)
    router.replaceCatalog([
      route('small/model', { contextWindow: 3_000, defaultMaxTokens: 1_000 }),
      route('large/model', { contextWindow: 3_101, defaultMaxTokens: 1_000 }),
    ])
    expect(router.select(request({ estimatedInputTokens: 1_000, requestedMaxTokens: 2_000 })).route.key)
      .toBe('large/model')
  })

  it('enforces each route concurrency limit with one reservation owner', () => {
    const router = new AutoModelRouter(policy)
    router.replaceCatalog([route('p/m', { concurrencyLimit: 1 })])
    const reservation = router.begin(RouteKey('p/m'))
    expect(() => router.select(request())).toThrow(/AUTO_NO_CANDIDATE/)
    reservation.cancel()
    expect(router.select(request()).route.key).toBe('p/m')
    expect(() => { reservation.cancel() }).toThrow(/already settled/)
  })
})

describe('AutoModelRouter scoring and health', () => {
  it('updates EWMA from the first sample and then alpha', () => {
    const router = new AutoModelRouter(policy)
    router.replaceCatalog([route('p/m')])
    router.recordSuccess(router.begin(RouteKey('p/m')), { ttftMs: 100, totalLatencyMs: 200 })
    router.recordSuccess(router.begin(RouteKey('p/m')), { ttftMs: 300, totalLatencyMs: 400 })
    expect(router.snapshot()).toEqual([
      expect.objectContaining({ key: 'p/m', ewmaTtftMs: 200, sampleCount: 2, recentFailureRate: 0 }),
    ])
  })

  it('scores normalized latency, load, failure, preference, and bounded exploration', () => {
    const router = new AutoModelRouter(policy, { rotationSeed: 0 })
    router.replaceCatalog([
      route('a/model', { preferenceMultiplier: 2 }),
      route('b/model'),
      route('c/model'),
    ])
    router.recordSuccess(router.begin(RouteKey('a/model')), { ttftMs: 100, totalLatencyMs: 100 })
    router.recordSuccess(router.begin(RouteKey('b/model')), { ttftMs: 200, totalLatencyMs: 200 })
    router.recordFailure(router.begin(RouteKey('b/model')), { code: 'RATE_LIMIT', message: 'limited' })
    const held = router.begin(RouteKey('a/model'))
    expect(router.select(request()).route.key).toBe('c/model')
    held.cancel()
  })

  it('uses pool medians for unsampled routes', () => {
    const router = new AutoModelRouter({ ...policy, explorationWeight: 0 })
    router.replaceCatalog([route('a/model'), route('b/model'), route('c/model')])
    router.recordSuccess(router.begin(RouteKey('a/model')), { ttftMs: 100, totalLatencyMs: 100 })
    router.recordSuccess(router.begin(RouteKey('c/model')), { ttftMs: 300, totalLatencyMs: 300 })
    expect(router.snapshot().find(status => status.key === 'b/model')?.effectiveTtftMs).toBe(200)
  })

  it('rotates stable ties from an injected seed', () => {
    const router = new AutoModelRouter({ ...policy, explorationWeight: 0 }, { rotationSeed: 1 })
    router.replaceCatalog([route('a/model'), route('b/model'), route('c/model')])
    expect(router.select(request()).route.key).toBe('b/model')
    expect(router.select(request()).route.key).toBe('c/model')
  })

  it('opens after the failure threshold', () => {
    const now = 10
    const router = new AutoModelRouter(policy, { now: () => now })
    router.replaceCatalog([route('p/m')])
    for (let index = 0; index < 3; index += 1) {
      router.recordFailure(router.begin(RouteKey('p/m')), { code: 'ERR', message: 'failed' })
    }
    expect(router.snapshot()[0]).toMatchObject({ circuit: 'open', cooldownUntil: 1_010 })
  })

  it('does not authorize a probe before cooldown expiry', () => {
    const router = new AutoModelRouter({ ...policy, failureThreshold: 1 }, { now: () => 0 })
    router.replaceCatalog([route('p/m')])
    router.recordFailure(router.begin(RouteKey('p/m')), { code: 'ERR', message: 'failed' })

    expect(() => router.select(request({ now: 999 }))).toThrow(/AUTO_NO_CANDIDATE/)
    expect(() => router.begin(RouteKey('p/m'))).toThrow(/not authorized/)
  })

  it('authorizes exactly one probe after cooldown expiry', () => {
    const router = new AutoModelRouter({ ...policy, failureThreshold: 1 }, { now: () => 1_000 })
    router.replaceCatalog([route('p/m')])
    router.recordFailure(router.begin(RouteKey('p/m')), { code: 'ERR', message: 'failed' })

    expect(router.select(request({ now: 2_000 }))).toMatchObject({ route: { key: 'p/m' }, reason: 'probe' })
    expect(() => router.select(request({ now: 2_000 }))).toThrow(/AUTO_NO_CANDIDATE/)
    const probe = router.begin(RouteKey('p/m'))
    expect(() => router.begin(RouteKey('p/m'))).toThrow(/not authorized/)
    router.recordSuccess(probe, { ttftMs: 50, totalLatencyMs: 60 })
    expect(router.snapshot()[0]).toMatchObject({ circuit: 'closed', consecutiveFailures: 0 })
  })

  it('permits the configured number of concurrent half-open probes', () => {
    const router = new AutoModelRouter({ ...policy, failureThreshold: 1, halfOpenConcurrency: 2 }, { now: () => 1_000 })
    router.replaceCatalog([route('p/m', { concurrencyLimit: 3 })])
    router.recordFailure(router.begin(RouteKey('p/m')), { code: 'ERR', message: 'failed' })

    const firstDecision = router.select(request({ now: 2_000 }))
    const first = router.begin(firstDecision.route.key)
    const secondDecision = router.select(request({ now: 2_000 }))
    const second = router.begin(secondDecision.route.key)
    expect(firstDecision.reason).toBe('probe')
    expect(secondDecision.reason).toBe('probe')
    expect(router.snapshot()[0]).toMatchObject({ circuit: 'half-open', inFlight: 2 })
    expect(() => router.select(request({ now: 2_000 }))).toThrow(/AUTO_NO_CANDIDATE/)

    router.recordSuccess(first, { ttftMs: 10, totalLatencyMs: 20 })
    second.cancel()
    expect(router.snapshot()[0]).toMatchObject({ circuit: 'closed', inFlight: 0 })
  })

  it('reopens a failed half-open probe with exponential cooldown', () => {
    let now = 0
    const router = new AutoModelRouter({ ...policy, failureThreshold: 1 }, { now: () => now })
    router.replaceCatalog([route('p/m')])
    router.recordFailure(router.begin(RouteKey('p/m')), { code: 'ERR', message: 'failed' })
    expect(router.snapshot()[0]?.cooldownUntil).toBe(1_000)

    now = 1_000
    router.select(request({ now }))
    router.recordFailure(router.begin(RouteKey('p/m')), { code: 'ERR', message: 'probe failed' })
    expect(router.snapshot()[0]).toMatchObject({ circuit: 'open', cooldownUntil: 3_000 })
  })

  it('does not change health for user cancellation', () => {
    const router = new AutoModelRouter(policy)
    router.replaceCatalog([route('p/m')])
    router.begin(RouteKey('p/m')).cancel()
    expect(router.snapshot()[0]).toMatchObject({ inFlight: 0, sampleCount: 0, consecutiveFailures: 0 })
  })
})
