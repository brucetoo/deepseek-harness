/**
 * pi-ai provider construction for ModelHub's exact Chat Completions target.
 * @module @deepseek-ai/dsh-llm-modelhub/provider
 */

import { randomUUID } from 'node:crypto'
import { createAssistantMessageEventStream, createProvider } from '@earendil-works/pi-ai'
import type {
  Api,
  ApiKeyAuth,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelCost,
  Provider,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { ResolvedModelHubConfig } from './config.ts'
import { MODELHUB_DISPLAY_NAME, MODELHUB_PROVIDER } from './config.ts'

const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function apiKeyAuth(): ApiKeyAuth {
  return {
    name: MODELHUB_DISPLAY_NAME,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: MODELHUB_DISPLAY_NAME,
    }),
  }
}

function redactCredential(value: string, credential: string): string {
  const formEncoded = new URLSearchParams({ credential }).toString().slice('credential='.length)
  return [...new Set([credential, encodeURIComponent(credential), formEncoded])]
    .reduce((redacted, candidate) => redacted.replaceAll(candidate, '[redacted]'), value)
}

function redactEvent(event: AssistantMessageEvent, credential: string): AssistantMessageEvent {
  if (event.type !== 'error') return event
  const terminal = event.error as AssistantMessage & { errorMessage: string }
  return {
    ...event,
    error: {
      ...terminal,
      errorMessage: redactCredential(terminal.errorMessage, credential),
    },
  }
}

function sanitizedStream(
  source: AssistantMessageEventStream,
  credential: string,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream()
  void (async () => {
    try {
      for await (const event of source) target.push(redactEvent(event, credential))
    } finally {
      target.end()
    }
  })()
  return target
}

function exactRequest<T extends StreamOptions | SimpleStreamOptions>(
  endpoint: string,
  model: Model<Api>,
  options: T | undefined,
): { model: Model<Api>; options: T; credential: string } {
  const credential = options?.apiKey
  if (credential === undefined) throw new Error(`No API key for provider: ${model.provider}`)
  const url = new URL(endpoint)
  url.searchParams.set('ak', credential)
  return {
    // pi-ai concatenates `/chat/completions`; the fragment absorbs that suffix,
    // and Fetch omits the fragment while preserving this exact path and query.
    model: { ...model, baseUrl: `${url.href}#` },
    options: {
      ...options,
      apiKey: 'unused',
      headers: {
        ...options?.headers,
        Authorization: null,
        'X-TT-LOGID': randomUUID(),
      },
    } as unknown as T,
    credential,
  }
}

function modelHubApi(endpoint: string): ProviderStreams {
  const delegate = openAICompletionsApi()
  return {
    stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream {
      const request = exactRequest(endpoint, model, options)
      return sanitizedStream(delegate.stream(request.model, context, request.options), request.credential)
    },
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
      const request = exactRequest(endpoint, model, options)
      return sanitizedStream(delegate.streamSimple(request.model, context, request.options), request.credential)
    },
  }
}

function materializeModels(config: ResolvedModelHubConfig): Model<'openai-completions'>[] {
  return config.models.map(model => ({
    id: model.id,
    name: model.name ?? model.id,
    api: 'openai-completions',
    provider: MODELHUB_PROVIDER,
    baseUrl: config.endpoint,
    reasoning: false,
    input: [...model.input],
    cost: NO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
    },
  }))
}

/**
 * Build the pi-ai provider captured by one ModelHub adapter snapshot.
 * @param config - validated ModelHub configuration.
 * @returns provider with an immutable catalog and exact-target stream methods.
 */
export function buildProvider(config: ResolvedModelHubConfig): Provider {
  return createProvider({
    id: MODELHUB_PROVIDER,
    name: MODELHUB_DISPLAY_NAME,
    baseUrl: config.endpoint,
    auth: { apiKey: apiKeyAuth() },
    models: materializeModels(config),
    api: modelHubApi(config.endpoint),
  })
}
