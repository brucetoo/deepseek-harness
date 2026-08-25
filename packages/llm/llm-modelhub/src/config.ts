/**
 * ModelHub plugin configuration and resolution.
 * @module @deepseek-ai/dsh-llm-modelhub/config
 */

import type { Model } from '@earendil-works/pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Provider route registered by this plugin. */
export const MODELHUB_PROVIDER = 'bytedance-modelhub'

/** Provider label shown by model selectors and settings. */
export const MODELHUB_DISPLAY_NAME = 'ByteDance ModelHub'

/** Credential reference used when configuration omits one. */
export const DEFAULT_API_KEY_ENV = 'AIDP_MODELHUB_AK'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Default request-level bound on base64-encoded image payload. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** Context capacity used when a configured model omits one. */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** Output capability used when a configured model omits one. */
export const DEFAULT_MAX_TOKENS = 32_768

/** One input modality accepted by a configured ModelHub model. */
export type ModelHubModality = Model<'openai-completions'>['input'][number]

/** Configuration for one ModelHub model. */
export interface ModelHubModelConfig {
  /** Model id sent to ModelHub. */
  id: string
  /** Display name; defaults to {@link id}. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens and default request cap when configured. */
  maxTokens?: number
  /** Request modalities; defaults to text. */
  input?: ModelHubModality[]
}

/** ModelHub plugin configuration and `llm-modelhub` settings-section value. */
export interface Config {
  /** Exact HTTP(S) POST target; the plugin never appends `/chat/completions`. */
  endpoint?: string
  /** Credential reference resolved per request. */
  apiKeyEnv?: string
  /** Models exposed on the fixed `bytedance-modelhub` route. */
  models?: ModelHubModelConfig[]
  /** Context capacity used when a model entry omits one. */
  defaultContextWindow?: number
  /** Output capability used when a model entry omits one. */
  defaultMaxTokens?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated base64 image payload per request. */
  maxRequestImageBytes?: number
  /** Provider-owned model-request retry policy. */
  retryPolicy?: RetryPolicyConfig
}

const MODALITIES: readonly ModelHubModality[] = ['text', 'image']

const modelConfig: z<ModelHubModelConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(MODALITIES)).min(1).default(['text']),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  models: z.array(modelConfig),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  retryPolicy: RetryPolicySchema,
})

/** Validated model entry captured by one adapter snapshot. */
export interface ResolvedModelHubModelConfig {
  /** Model id sent to ModelHub. */
  id: string
  /** Display name when configured. */
  name?: string
  /** Resolved context capacity. */
  contextWindow: number
  /** Resolved output capability. */
  maxTokens: number
  /** Detached request modalities. */
  input: ModelHubModality[]
}

/** Validated configuration captured by one adapter snapshot. */
export interface ResolvedModelHubConfig {
  /** Normalized exact request target. */
  endpoint: string
  /** Validated credential reference. */
  apiKeyEnv: CredentialRef
  /** Detached model configuration in selector order. */
  models: readonly ResolvedModelHubModelConfig[]
  /** Per-request output caps explicitly configured on model entries. */
  configuredMaxTokens: ReadonlyMap<string, number>
  /** Context capacity used when a model entry omits one. */
  defaultContextWindow: number
  /** Output capability used when a model entry omits one. */
  defaultMaxTokens: number
  /** Positive finite provider-idle interval. */
  streamIdleTimeoutMs: number
  /** Positive request-level image payload bound. */
  maxRequestImageBytes: number
  /** Immutable retry policy captured with the route registration. */
  retryPolicy: ResolvedRetryPolicy
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`llm-modelhub: ${name} must be a positive safe integer`)
  }
  return value
}

function resolveEndpoint(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) throw new Error('llm-modelhub: endpoint is required')
  let endpoint: URL
  try {
    endpoint = new URL(raw)
  } catch (cause: unknown) {
    throw new Error('llm-modelhub: endpoint must be an absolute URL', { cause })
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('llm-modelhub: endpoint must use HTTP or HTTPS')
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error('llm-modelhub: endpoint must not contain credentials')
  }
  if (endpoint.hash.length > 0) throw new Error('llm-modelhub: endpoint must not include a fragment')
  if (endpoint.searchParams.has('ak')) {
    throw new Error('llm-modelhub: endpoint must not contain the credential query parameter "ak"')
  }
  return endpoint.href
}

function resolveModels(
  models: readonly ModelHubModelConfig[] | undefined,
  defaultContextWindow: number,
  defaultMaxTokens: number,
): { models: ResolvedModelHubModelConfig[]; configuredMaxTokens: ReadonlyMap<string, number> } {
  if (models === undefined || models.length === 0) {
    throw new Error('llm-modelhub: models must list at least one model')
  }
  const seen = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const resolved = models.map((model) => {
    if (model.id.length === 0) throw new Error('llm-modelhub: model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`llm-modelhub: duplicate model "${model.id}"`)
    seen.add(model.id)
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-modelhub: model "${model.id}" has an empty name`)
    }
    const input = [...model.input ?? ['text']]
    if (input.length === 0) throw new Error(`llm-modelhub: model "${model.id}" input must not be empty`)
    if (input.some(modality => !MODALITIES.includes(modality))) {
      throw new Error(`llm-modelhub: model "${model.id}" input must contain only "text" and "image"`)
    }
    if (new Set(input).size !== input.length) {
      throw new Error(`llm-modelhub: model "${model.id}" input must not contain duplicates`)
    }
    if (model.maxTokens !== undefined) configuredMaxTokens.set(model.id, model.maxTokens)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      contextWindow: positiveInteger(
        `model "${model.id}" contextWindow`,
        model.contextWindow ?? defaultContextWindow,
      ),
      maxTokens: positiveInteger(`model "${model.id}" maxTokens`, model.maxTokens ?? defaultMaxTokens),
      input,
    }
  })
  return { models: resolved, configuredMaxTokens }
}

/**
 * Resolve raw plugin configuration into one immutable request snapshot.
 * @param config - composition entry or resolved settings section.
 * @returns validated and detached ModelHub configuration.
 */
export function resolveConfig(config: Config): ResolvedModelHubConfig {
  const defaultContextWindow = positiveInteger(
    'defaultContextWindow',
    config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
  )
  const defaultMaxTokens = positiveInteger('defaultMaxTokens', config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-modelhub: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestImageBytes = positiveInteger(
    'maxRequestImageBytes',
    config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  )
  const catalog = resolveModels(config.models, defaultContextWindow, defaultMaxTokens)
  return {
    endpoint: resolveEndpoint(config.endpoint),
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    models: catalog.models,
    configuredMaxTokens: catalog.configuredMaxTokens,
    defaultContextWindow,
    defaultMaxTokens,
    streamIdleTimeoutMs,
    maxRequestImageBytes,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-modelhub: retryPolicy'),
  }
}

/**
 * Reject a settings section the plugin cannot serve.
 * @param config - resolved settings section.
 */
export function assertServiceable(config: Config): void {
  resolveConfig(config)
}
