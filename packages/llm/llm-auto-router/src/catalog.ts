/** Candidate catalog assembly from advertised and explicit routes. */

import type { CandidateRoute, RouteOverride, RoutePool } from './types.ts'

function matches(pattern: string, route: string): boolean {
  const [patternProvider, patternModel] = pattern.split('/')
  const [provider, model] = route.split('/')
  return (patternProvider === '*' || patternProvider === provider)
    && (patternModel === '*' || patternModel === model)
}

function poolIncludes(pool: RoutePool, key: string): boolean {
  return pool.include.some(pattern => matches(pattern, key))
    && !pool.exclude.some(pattern => matches(pattern, key))
}

function explicitCandidate(override: RouteOverride): CandidateRoute {
  const [provider = '', model = ''] = override.route.split('/')
  return {
    key: override.route,
    provider,
    model,
    advertised: false,
    enabled: override.enabled ?? true,
    pool: override.pool,
    preferenceMultiplier: override.preferenceMultiplier ?? 1,
    concurrencyLimit: override.concurrencyLimit,
  }
}

/**
 * Build stable pool-owned candidates without treating the advisory catalog as a whitelist.
 * @param advertised - exact routes reported by adapters.
 * @param pools - validated named pattern sets.
 * @param overrides - validated explicit route owners and tuning.
 * @returns detached candidates sorted by pool and route identity.
 */
export function buildCandidateCatalog(
  advertised: readonly CandidateRoute[],
  pools: Readonly<Record<string, RoutePool>>,
  overrides: readonly RouteOverride[],
): readonly CandidateRoute[] {
  const explicitKeys = new Set(overrides.map(override => override.route))
  const result: CandidateRoute[] = []
  for (const [poolName, pool] of Object.entries(pools)) {
    for (const route of advertised) {
      if (explicitKeys.has(route.key) || !poolIncludes(pool, route.key)) continue
      result.push({ ...route, pool: poolName, advertised: true })
    }
  }
  const advertisedByKey = new Map(advertised.map(route => [route.key, route]))
  for (const override of overrides) {
    const source = advertisedByKey.get(override.route)
    result.push(source === undefined
      ? explicitCandidate(override)
      : {
        ...source,
        pool: override.pool,
        enabled: override.enabled ?? source.enabled,
        preferenceMultiplier: override.preferenceMultiplier ?? source.preferenceMultiplier,
        concurrencyLimit: override.concurrencyLimit,
      })
  }
  return result.toSorted((left, right) =>
    left.pool.localeCompare(right.pool) || left.key.localeCompare(right.key))
}
