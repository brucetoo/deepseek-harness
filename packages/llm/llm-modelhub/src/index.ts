/**
 * ModelHub LLM provider plugin. It registers one fixed Harness provider route
 * and delegates Chat Completions conversion to the pi-ai adapter while owning
 * ModelHub's exact target, query authentication, request id, and redaction.
 * @module @deepseek-ai/dsh-llm-modelhub
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_REQUEST_IMAGES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  PiAiAdapter,
  authContextFrom,
  credentialStoreFrom,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  assertServiceable,
  Config,
  MODELHUB_DISPLAY_NAME,
  MODELHUB_PROVIDER,
  resolveConfig,
} from './config.ts'
import type { ResolvedModelHubConfig } from './config.ts'
import { buildProvider } from './provider.ts'

export {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MODELHUB_DISPLAY_NAME,
  MODELHUB_PROVIDER,
  assertServiceable,
  resolveConfig,
} from './config.ts'
export type {
  Config as ModelHubConfig,
  ModelHubModelConfig,
  ModelHubModality,
  ResolvedModelHubConfig,
  ResolvedModelHubModelConfig,
} from './config.ts'

/** Cordis plugin name. */
export const name = 'llm-modelhub'

/** Required services. */
export const inject = ['llm']

type ModelHubProfile = ResolvedPiAiProviderProfile & {
  readonly apiKeyEnv: ResolvedModelHubConfig['apiKeyEnv']
}

function resolvedProfile(config: Config): ModelHubProfile {
  const resolved = resolveConfig(config)
  return {
    provider: MODELHUB_PROVIDER,
    displayName: MODELHUB_DISPLAY_NAME,
    api: 'openai-completions',
    baseURL: resolved.endpoint,
    apiKeyEnv: resolved.apiKeyEnv,
    streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
    maxRequestImageBytes: resolved.maxRequestImageBytes,
    maxRequestImages: DEFAULT_MAX_REQUEST_IMAGES,
    imageOffloadCountQuantum: DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolved.retryPolicy,
    configuredMaxTokens: resolved.configuredMaxTokens,
    modelErrors: new Map(),
    piProvider: buildProvider(resolved),
  }
}

/**
 * Register the ModelHub route.
 * @param ctx - Cordis context carrying the LLM runtime.
 * @param config - composition-layer ModelHub configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertServiceable(config)
  const profile = resolvedProfile(config)
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> =>
    new Map([[MODELHUB_PROVIDER, profile]])
  profiles()

  const resolveApiKey = async (
    _provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string> => {
    const { apiKeyEnv: ref } = profile as ModelHubProfile
    const credentials = ctx.get('credentials')
    const hit = credentials === undefined
      ? launchEnvironmentOf(ctx).get(ref)?.value
      : (await credentials.resolve(ref))?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-modelhub', ref)
    throw new LlmError(
      `llm-modelhub: no credential for provider route "${MODELHUB_PROVIDER}"; store ${ref} through the`
      + ` credentials service or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const resolveAttachments = (): AttachmentStore | undefined => ctx.get('attachments')
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth: {
      credentials: credentialStoreFrom(ctx),
      authContext: authContextFrom(ctx),
    },
    resolveAttachments,
    onReplayDegrade: ({ model, reason }) => {
      ctx.logger.warn(
        `llm-modelhub: unusable replay state for model "${model}"; sending provider-neutral content (${reason})`,
      )
    },
  })

  ctx.llm.registerConfigurableProviders([{
    provider: MODELHUB_PROVIDER,
    displayName: MODELHUB_DISPLAY_NAME,
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: [],
  }])
  ctx.llm.registerAdapter([MODELHUB_PROVIDER], adapter)
}
