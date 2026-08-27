import { describe, expect, it } from 'vitest'
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveConfig,
} from '../src/config.ts'
import type { Config } from '../src/config.ts'

const valid = (patch: Partial<Config> = {}): Config => ({
  endpoint: 'https://modelhub.test/api/modelhub/online/v2/crawl',
  models: [{ id: 'gpt', name: 'GPT' }],
  ...patch,
})

describe('ModelHub configuration', () => {
  it('resolves defaults and detaches model input', () => {
    const source = valid({ models: [{ id: 'gpt', name: 'GPT', input: ['text'] }] })
    const resolved = resolveConfig(source)
    expect(resolved).toMatchObject({
      endpoint: 'https://modelhub.test/api/modelhub/online/v2/crawl',
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
      models: [{
        id: 'gpt',
        name: 'GPT',
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        input: ['text'],
      }],
    })
    source.models?.[0]?.input?.push('image')
    expect(resolved.models[0]?.input).toEqual(['text'])
    expect(resolved.configuredMaxTokens.size).toBe(0)
  })

  it('keeps explicit model capacity as the request default', () => {
    const resolved = resolveConfig(valid({
      defaultContextWindow: 100,
      defaultMaxTokens: 20,
      streamIdleTimeoutMs: 30,
      maxRequestImageBytes: 40,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: [{ id: 'gpt', contextWindow: 90, maxTokens: 10, input: ['text', 'image'] }],
    }))
    expect(resolved.models[0]).toMatchObject({ contextWindow: 90, maxTokens: 10, input: ['text', 'image'] })
    expect(resolved.configuredMaxTokens).toEqual(new Map([['gpt', 10]]))
    expect(resolved.retryPolicy.mode).toBe('normal')
    if (resolved.retryPolicy.mode !== 'normal') throw new Error('expected normal retry policy')
    expect(resolved.retryPolicy.maxRetries).toBe(0)
  })

  it.each([
    [undefined, /endpoint is required/],
    ['', /endpoint is required/],
    ['relative/path', /absolute URL/],
    ['file:///tmp/modelhub', /HTTP or HTTPS/],
    ['https://user:password@modelhub.test/crawl', /must not contain credentials/],
    ['https://modelhub.test/crawl#fragment', /must not include a fragment/],
    ['https://modelhub.test/crawl?ak=literal', /must not contain the credential query parameter/],
  ])('rejects invalid endpoint %s', (endpoint, expected) => {
    const config = valid()
    if (endpoint === undefined) delete config.endpoint
    else config.endpoint = endpoint
    expect(() => resolveConfig(config)).toThrow(expected)
  })

  it.each([
    [[], /at least one model/],
    [[{ id: '' }], /ids must be non-empty/],
    [[{ id: 'gpt' }, { id: 'gpt' }], /duplicate model/],
    [[{ id: 'gpt', name: '' }], /empty name/],
    [[{ id: 'gpt', input: [] }], /input must not be empty/],
    [[{ id: 'gpt', input: ['audio'] }], /only "text" and "image"/],
    [[{ id: 'gpt', input: ['text', 'text'] }], /must not contain duplicates/],
    [[{ id: 'gpt', contextWindow: 0 }], /contextWindow must be a positive safe integer/],
    [[{ id: 'gpt', maxTokens: 0 }], /maxTokens must be a positive safe integer/],
  ] as const)('rejects invalid model catalogs', (models, expected) => {
    const config = valid()
    config.models = models as unknown as NonNullable<Config['models']>
    expect(() => resolveConfig(config)).toThrow(expected)
  })

  it.each([
    [{ defaultContextWindow: 0 }, /defaultContextWindow/],
    [{ defaultMaxTokens: Number.MAX_VALUE }, /defaultMaxTokens/],
    [{ streamIdleTimeoutMs: 0 }, /streamIdleTimeoutMs/],
    [{ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }, /streamIdleTimeoutMs/],
    [{ maxRequestImageBytes: 1.5 }, /maxRequestImageBytes/],
    [{ apiKeyEnv: 'not-a-variable!' }, /credential ref/],
  ] as const)('rejects invalid route configuration', (patch, expected) => {
    expect(() => resolveConfig(valid(patch))).toThrow(expected)
  })
})
