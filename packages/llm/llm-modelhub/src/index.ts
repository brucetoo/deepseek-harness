/**
 * ModelHub LLM provider plugin. It registers one fixed Harness provider route
 * and delegates Chat Completions conversion to the pi-ai adapter while owning
 * ModelHub's exact target, query authentication, request id, and redaction.
 * @module @deepseek-ai/dsh-llm-modelhub
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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

const NS = settingsNamespace('llm-modelhub')

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
    retryPolicy: resolved.retryPolicy,
    configuredMaxTokens: resolved.configuredMaxTokens,
    piProvider: buildProvider(resolved),
  }
}

/**
 * Register the ModelHub route and its settings section.
 * @param ctx - Cordis context carrying the LLM runtime.
 * @param config - composition-layer ModelHub configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let readConfig: () => Config = () => config
  let cache: {
    source: Config
    value: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  } | undefined
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const source = readConfig()
    if (cache?.source === source) return cache.value
    const value = new Map([[MODELHUB_PROVIDER, resolvedProfile(source)]])
    cache = { source, value }
    return value
  }
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
    settingsNs: NS,
    settingsPath: [],
  }])
  const registration = ctx.llm.registerAdapter([MODELHUB_PROVIDER], adapter)
  let registeredRetryPolicy: ResolvedModelHubConfig['retryPolicy'] = resolveConfig(config).retryPolicy
  const ensureRegistrationFacts = (): void => {
    const profile = profiles().get(MODELHUB_PROVIDER)
    if (profile === undefined || deepEqualJson(profile.retryPolicy, registeredRetryPolicy)) return
    registration.replace([MODELHUB_PROVIDER])
    registeredRetryPolicy = profile.retryPolicy
  }

  installSettingsSection(ctx, NS, Config, config, {
    validate: assertServiceable,
    setSource: (source) => {
      readConfig = source
    },
    onChange: ensureRegistrationFacts,
  })
}
