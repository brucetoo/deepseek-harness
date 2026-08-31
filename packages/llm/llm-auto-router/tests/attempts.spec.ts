import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Attempts } from '../src/attempts.ts'
import { RouteKey } from '../src/brand.ts'
import { AutoModelRouter } from '../src/policy.ts'
import type { AutoRouterPolicy, CandidateRoute } from '../src/types.ts'

const policy: AutoRouterPolicy = {
  virtualProvider: 'auto', virtualModel: 'auto',
  pools: { default: { include: ['*/*'], exclude: [] } }, models: [],
  maxFailoversPerStep: 2, tokenSafetyReserve: 0, ewmaAlpha: 0.5,
  failureThreshold: 2, baseCooldownMs: 10, maxCooldownMs: 100,
  halfOpenConcurrency: 1, explorationWeight: 0,
  scoring: { latency: 1, load: 0, failure: 0 },
}

const route: CandidateRoute = {
  key: RouteKey('p/m'), provider: 'p', model: 'm', advertised: true, enabled: true,
  pool: 'default', preferenceMultiplier: 1, concurrencyLimit: 1,
  inputModalities: ['text'], contextWindow: 10_000, defaultMaxTokens: 100,
}

function setup() {
  const router = new AutoModelRouter(policy)
  router.replaceCatalog([route])
  return { router, attempts: new Attempts(), agent: {} as Agent }
}

describe('Attempts', () => {
  it('numbers attempts per Agent step and tracks the active physical route', () => {
    const { router, attempts, agent } = setup()
    const first = attempts.begin(agent, 2, 3, 'default', router.select({
      pool: 'default', requiredModalities: ['text'], estimatedInputTokens: 1,
      attemptedRoutes: new Set(), now: 0,
    }), router.begin(RouteKey('p/m')))

    expect(first).toMatchObject({ turn: 2, step: 3, attempt: 1, route: { key: 'p/m' } })
    expect(attempts.match(agent, 2, 3, 'p', 'm')).toBe(first)
    first.reservation.cancel()
  })

  it('pins exactly one delegated retry to the same route', () => {
    const { router, attempts, agent } = setup()
    const first = attempts.begin(agent, 1, 1, 'default', {
      route, reason: 'normal', candidateCount: 1,
    }, router.begin(RouteKey('p/m')))
    attempts.pinRetry(first)

    expect(attempts.peekPin(agent, 1, 1)).toBe('p/m')
    attempts.commitPin(agent, 1, 1, RouteKey('p/m'))
    expect(attempts.peekPin(agent, 1, 1)).toBeUndefined()
    first.reservation.cancel()
  })

  it('retains a retry pin until its replacement reservation commits', () => {
    const { router, attempts, agent } = setup()
    const first = attempts.begin(agent, 1, 1, 'default', {
      route, reason: 'normal', candidateCount: 1,
    }, router.begin(RouteKey('p/m')))
    attempts.pinRetry(first)

    expect(attempts.peekPin(agent, 1, 1)).toBe('p/m')
    expect(attempts.peekPin(agent, 1, 1)).toBe('p/m')
    attempts.commitPin(agent, 1, 1, RouteKey('p/m'))
    expect(attempts.peekPin(agent, 1, 1)).toBeUndefined()
    first.reservation.cancel()
  })

  it('releases and removes an undispatched attempt after preparation failure', () => {
    const { router, attempts, agent } = setup()
    const reserved = attempts.begin(agent, 1, 1, 'default', {
      route, reason: 'normal', candidateCount: 1,
    }, router.begin(RouteKey('p/m')))

    expect(attempts.releaseUndispatched(agent, 1, 1)).toBe(true)
    expect(reserved.settled).toBe(true)
    expect(attempts.latest(agent, 1, 1)).toBeUndefined()
    expect(router.snapshot()[0]).toMatchObject({ inFlight: 0, sampleCount: 0 })
  })

  it('does not release ownership after stream dispatch starts', () => {
    const { router, attempts, agent } = setup()
    const reserved = attempts.begin(agent, 1, 1, 'default', {
      route, reason: 'normal', candidateCount: 1,
    }, router.begin(RouteKey('p/m')))
    attempts.dispatch(reserved)

    expect(attempts.releaseUndispatched(agent, 1, 1)).toBe(false)
    expect(router.snapshot()[0]).toMatchObject({ inFlight: 1 })
    reserved.reservation.cancel()
  })

  it('releases every outstanding reservation when an Agent is disposed', () => {
    const { router, attempts, agent } = setup()
    attempts.begin(agent, 1, 1, 'default', {
      route, reason: 'normal', candidateCount: 1,
    }, router.begin(RouteKey('p/m')))

    attempts.disposeAgent(agent)

    expect(router.snapshot()[0]).toMatchObject({ inFlight: 0, sampleCount: 0 })
    expect(attempts.match(agent, 1, 1, 'p', 'm')).toBeUndefined()
  })
})
