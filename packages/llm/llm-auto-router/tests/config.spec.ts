import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import type { Config as RouterConfig } from '../src/index.ts'

const expectedDefaults = {
  virtualProvider: 'auto',
  virtualModel: 'auto',
  pools: {
    default: {
      include: ['*/*'],
      exclude: [],
    },
  },
  models: [],
  maxFailoversPerStep: 2,
  tokenSafetyReserve: 1_024,
  ewmaAlpha: 0.2,
  failureThreshold: 3,
  baseCooldownMs: 5_000,
  maxCooldownMs: 120_000,
  halfOpenConcurrency: 1,
  explorationWeight: 0.05,
  scoring: {
    latency: 0.35,
    load: 0.35,
    failure: 0.3,
  },
} as const

describe('resolveConfig', () => {
  it('resolves the complete default policy', () => {
    expect(resolveConfig({})).toEqual(expectedDefaults)
  })

  it.each([
    [{ virtualProvider: '' }, 'virtualProvider'],
    [{ virtualModel: '' }, 'virtualModel'],
    [{ models: { 'provider/model': { pool: 'missing', concurrencyLimit: 1 } } }, 'unknown pool'],
    [{ pools: { default: { include: ['provider'], exclude: [] } } }, 'route pattern'],
    [{ models: { '/model': { pool: 'default', concurrencyLimit: 1 } } }, 'route'],
    [{ models: { 'provider/': { pool: 'default', concurrencyLimit: 1 } } }, 'route'],
    [{ models: { 'provider/model': { pool: 'default' } } }, 'concurrencyLimit'],
    [{ models: { 'provider/model': { pool: 'default', concurrencyLimit: 0 } } }, 'concurrencyLimit'],
    [{ halfOpenConcurrency: 0 }, 'halfOpenConcurrency'],
    [{ baseCooldownMs: 10, maxCooldownMs: 9 }, 'baseCooldownMs'],
    [{ ewmaAlpha: 0 }, 'ewmaAlpha'],
    [{ ewmaAlpha: 1.01 }, 'ewmaAlpha'],
    [{ scoring: { latency: -0.1, load: 0.5, failure: 0.6 } }, 'scoring'],
    [{ scoring: { latency: 0.2, load: 0.2, failure: 0.2 } }, 'sum to 1'],
  ] satisfies readonly [unknown, string][])('rejects invalid config %#', (config, message) => {
    expect(() => resolveConfig(config as RouterConfig)).toThrow(message)
  })

  it('parses route-keyed model overrides through the exported schema', () => {
    const parsed = Config({
      models: {
        'provider/model': { pool: 'default', concurrencyLimit: 3 },
      },
    })
    expect(parsed.models).toEqual({
      'provider/model': { pool: 'default', concurrencyLimit: 3 },
    })
    expect(resolveConfig(parsed).models).toEqual([{
      route: 'provider/model',
      pool: 'default',
      enabled: true,
      preferenceMultiplier: 1,
      concurrencyLimit: 3,
    }])
  })

  it('returns detached immutable policy data', () => {
    const raw: RouterConfig = { pools: { default: { include: ['p/*'] } } }
    const resolved = resolveConfig(raw)
    raw.pools!.default!.include!.push('other/*')
    expect(resolved.pools.default!.include).toEqual(['p/*'])
    expect(Object.isFrozen(resolved.pools.default!.include)).toBe(true)
    expect(Object.isFrozen(resolved)).toBe(true)
  })
})
