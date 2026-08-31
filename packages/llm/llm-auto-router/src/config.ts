/** Validated automatic-routing loader configuration. */

import type { Config } from './index.ts'
import { RouteKey } from './brand.ts'
import type { AutoRouterPolicy, RoutePool } from './types.ts'

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`llm-auto-router: ${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`llm-auto-router: ${name} must be a non-negative safe integer`)
  }
  return value
}

function validatePattern(pattern: string): void {
  const parts = pattern.split('/')
  if (parts.length !== 2 || parts.some(part => part.length === 0 || (part.includes('*') && part !== '*'))) {
    throw new Error(`llm-auto-router: invalid route pattern ${JSON.stringify(pattern)}`)
  }
}

function freezePolicy(policy: AutoRouterPolicy): AutoRouterPolicy {
  for (const pool of Object.values(policy.pools)) {
    Object.freeze(pool.include)
    Object.freeze(pool.exclude)
    Object.freeze(pool)
  }
  Object.freeze(policy.pools)
  for (const model of policy.models) Object.freeze(model)
  Object.freeze(policy.models)
  Object.freeze(policy.scoring)
  return Object.freeze(policy)
}

/**
 * Resolve defaults once and reject inconsistent cross-field configuration.
 * @param config - raw Loader configuration.
 * @returns detached immutable policy used by request execution.
 */
export function resolveConfig(config: Config): AutoRouterPolicy {
  const virtualProvider = config.virtualProvider ?? 'auto'
  const virtualModel = config.virtualModel ?? 'auto'
  if (virtualProvider.length === 0) throw new Error('llm-auto-router: virtualProvider must be non-empty')
  if (virtualModel.length === 0) throw new Error('llm-auto-router: virtualModel must be non-empty')

  const rawPools = config.pools ?? { default: { include: ['*/*'], exclude: [] } }
  const pools: Record<string, RoutePool> = {}
  for (const [name, pool] of Object.entries(rawPools)) {
    if (name.length === 0) throw new Error('llm-auto-router: pool names must be non-empty')
    const include = [...pool.include ?? []]
    const exclude = [...pool.exclude ?? []]
    for (const pattern of [...include, ...exclude]) validatePattern(pattern)
    pools[name] = { include, exclude }
  }
  if (Object.keys(pools).length === 0) throw new Error('llm-auto-router: pools must not be empty')

  const models = Object.entries(config.models ?? {}).map(([route, model]) => {
    validatePattern(route)
    if (route.includes('*')) throw new Error(`llm-auto-router: explicit route ${JSON.stringify(route)} must not contain wildcards`)
    if (!(model.pool in pools)) throw new Error(`llm-auto-router: route ${route} names unknown pool ${model.pool}`)
    const concurrencyLimit = positiveInteger(`models[${route}].concurrencyLimit`, model.concurrencyLimit)
    const preferenceMultiplier = model.preferenceMultiplier ?? 1
    if (!Number.isFinite(preferenceMultiplier) || preferenceMultiplier < 0) {
      throw new Error(`llm-auto-router: models[${route}].preferenceMultiplier must be non-negative`)
    }
    return {
      route: RouteKey(route),
      pool: model.pool,
      enabled: model.enabled ?? true,
      preferenceMultiplier,
      concurrencyLimit,
    }
  })

  const maxFailoversPerStep = nonNegativeInteger('maxFailoversPerStep', config.maxFailoversPerStep ?? 2)
  const tokenSafetyReserve = nonNegativeInteger('tokenSafetyReserve', config.tokenSafetyReserve ?? 1_024)
  const failureThreshold = positiveInteger('failureThreshold', config.failureThreshold ?? 3)
  const baseCooldownMs = positiveInteger('baseCooldownMs', config.baseCooldownMs ?? 5_000)
  const maxCooldownMs = positiveInteger('maxCooldownMs', config.maxCooldownMs ?? 120_000)
  if (baseCooldownMs > maxCooldownMs) {
    throw new Error('llm-auto-router: baseCooldownMs must not exceed maxCooldownMs')
  }
  const halfOpenConcurrency = positiveInteger('halfOpenConcurrency', config.halfOpenConcurrency ?? 1)
  const ewmaAlpha = config.ewmaAlpha ?? 0.2
  if (!Number.isFinite(ewmaAlpha) || ewmaAlpha <= 0 || ewmaAlpha > 1) {
    throw new Error('llm-auto-router: ewmaAlpha must be within (0, 1]')
  }
  const explorationWeight = config.explorationWeight ?? 0.05
  if (!Number.isFinite(explorationWeight) || explorationWeight < 0) {
    throw new Error('llm-auto-router: explorationWeight must be non-negative')
  }
  const scoring = { ...config.scoring ?? { latency: 0.35, load: 0.35, failure: 0.3 } }
  const weights = [scoring.latency, scoring.load, scoring.failure]
  if (weights.some(weight => !Number.isFinite(weight) || weight < 0)) {
    throw new Error('llm-auto-router: scoring weights must be non-negative finite numbers')
  }
  if (Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > 1e-9) {
    throw new Error('llm-auto-router: scoring weights must sum to 1')
  }

  return freezePolicy({
    virtualProvider,
    virtualModel,
    pools,
    models,
    maxFailoversPerStep,
    tokenSafetyReserve,
    ewmaAlpha,
    failureThreshold,
    baseCooldownMs,
    maxCooldownMs,
    halfOpenConcurrency,
    explorationWeight,
    scoring,
  })
}
