import { describe, expect, it } from 'vitest'
import { buildCandidateCatalog } from '../src/catalog.ts'
import { RouteKey } from '../src/brand.ts'
import type { CandidateRoute, RouteOverride } from '../src/types.ts'

function candidate(provider: string, model: string): CandidateRoute {
  return {
    key: RouteKey(`${provider}/${model}`),
    provider,
    model,
    advertised: true,
    enabled: true,
    pool: 'default',
    preferenceMultiplier: 1,
    concurrencyLimit: 8,
    inputModalities: ['text'],
    contextWindow: 16_000,
    defaultMaxTokens: 2_000,
  }
}

describe('buildCandidateCatalog', () => {
  it('includes advertised routes from the resolved default pool', () => {
    const routes = [candidate('b', 'two'), candidate('a', 'one')]
    expect(buildCandidateCatalog(routes, {
      default: { include: ['*/*'], exclude: [] },
    }, [])).toEqual([
      expect.objectContaining({ key: 'a/one', pool: 'default' }),
      expect.objectContaining({ key: 'b/two', pool: 'default' }),
    ])
  })

  it('does not invent a pool when none is passed', () => {
    expect(buildCandidateCatalog([candidate('a', 'one')], {}, [])).toEqual([])
  })

  it('applies pool patterns and adds explicit unadvertised routes', () => {
    const advertised = [candidate('fast', 'one'), candidate('slow', 'two')]
    const overrides: RouteOverride[] = [{
      route: RouteKey('private/hidden'),
      pool: 'preferred',
      preferenceMultiplier: 0.8,
      concurrencyLimit: 2,
    }]
    const pools = {
      default: { include: ['*/*'], exclude: ['slow/*'] },
      preferred: { include: ['fast/*'], exclude: [] },
    }
    expect(buildCandidateCatalog(advertised, pools, overrides).map(route => ({
      key: route.key,
      pool: route.pool,
      advertised: route.advertised,
    }))).toEqual([
      { key: 'fast/one', pool: 'default', advertised: true },
      { key: 'fast/one', pool: 'preferred', advertised: true },
      { key: 'private/hidden', pool: 'preferred', advertised: false },
    ])
  })

  it('assigns explicit route ownership instead of retaining pattern ownership', () => {
    const advertised = [candidate('fast', 'one')]
    const overrides: RouteOverride[] = [{
      route: RouteKey('fast/one'),
      pool: 'preferred',
      concurrencyLimit: 8,
    }]
    const pools = {
      default: { include: ['*/*'], exclude: [] },
      preferred: { include: [], exclude: [] },
    }
    expect(buildCandidateCatalog(advertised, pools, overrides)).toEqual([
      expect.objectContaining({ key: 'fast/one', pool: 'preferred' }),
    ])
  })
})
