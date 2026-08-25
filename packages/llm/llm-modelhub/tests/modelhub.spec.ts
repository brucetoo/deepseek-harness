import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as ModelHub from '../src/index.ts'
import { buildProvider } from '../src/provider.ts'
import { startModelHubServer } from './support.ts'
import type { ModelHubServer } from './support.ts'

const servers: ModelHubServer[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllEnvs()
})

function config(endpoint: string): ModelHub.ModelHubConfig {
  return {
    endpoint,
    apiKeyEnv: 'MODELHUB_TEST_AK',
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', input: ['text'] },
      { id: 'fallback-name' },
    ],
  }
}

async function harness(endpoint: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ModelHub, config(endpoint))
  return ctx
}

describe('ModelHub adapter', () => {
  it('sends query authentication to the exact endpoint with a fresh request id', async () => {
    vi.stubEnv('MODELHUB_TEST_AK', 'query-secret')
    const server = await startModelHubServer()
    servers.push(server)
    const ctx = await harness(`${server.origin}/api/modelhub/online/v2/crawl?region=boe`)
    const assembler = new BlockAssembler()

    for await (const chunk of ctx.llm.stream({
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'gpt-5.6-sol',
      maxTokens: 500,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'What is the result of 1+1?' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) assembler.push(chunk)

    expect(assembler.message({
      kind: 'model',
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'gpt-5.6-sol',
    }).content).toEqual([{ type: 'text', text: 'hello' }])
    const request = server.requests[0]
    if (request === undefined) throw new Error('ModelHub test server received no request')
    const requestUrl = new URL(request.url, server.origin)
    expect(requestUrl.pathname).toBe('/api/modelhub/online/v2/crawl')
    expect(requestUrl.searchParams.get('region')).toBe('boe')
    expect(requestUrl.searchParams.get('ak')).toBe('query-secret')
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers['x-tt-logid']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(request.body).toMatchObject({ model: 'gpt-5.6-sol', max_tokens: 500 })
    await expect(ctx.llm.listModels(ModelHub.MODELHUB_PROVIDER)).resolves.toEqual([
      {
        provider: ModelHub.MODELHUB_PROVIDER,
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        inputModalities: ['text'],
      },
      {
        provider: ModelHub.MODELHUB_PROVIDER,
        id: 'fallback-name',
        name: 'fallback-name',
        inputModalities: ['text'],
      },
    ])
  })

  it('redacts the raw and encoded query credential from provider failures', async () => {
    const credential = 'query-secret~/%+'
    const uriEncoded = encodeURIComponent(credential)
    const formEncoded = new URLSearchParams({ credential }).toString().slice('credential='.length)
    vi.stubEnv('MODELHUB_TEST_AK', credential)
    const server = await startModelHubServer({
      status: 401,
      body: JSON.stringify({
        error: {
          message: `denied raw=${credential} uri=${uriEncoded} form=${formEncoded}`,
        },
      }),
    })
    servers.push(server)
    const ctx = await harness(`${server.origin}/crawl`)
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'gpt-5.6-sol',
      messages: [],
    })) assembler.push(chunk)

    expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    if (assembler.finish.kind !== 'error') throw new Error('expected the provider failure')
    expect(assembler.finish.failure.message).not.toContain(credential)
    expect(assembler.finish.failure.message).not.toContain(uriEncoded)
    expect(assembler.finish.failure.message).not.toContain(formEncoded)
    expect(assembler.finish.failure.message).toContain('[redacted]')
  })

  it('fails before transport when its credential reference resolves empty', async () => {
    vi.stubEnv('MODELHUB_TEST_AK', '')
    const ctx = await harness('https://modelhub.test/crawl')
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'gpt-5.6-sol',
      messages: [],
    })) assembler.push(chunk)
    expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('supports pi-ai full-stream callers and refuses a missing provider key', async () => {
    const server = await startModelHubServer()
    servers.push(server)
    const resolved = ModelHub.resolveConfig(config(`${server.origin}/full-stream`))
    const provider = buildProvider(resolved)
    const [model] = provider.getModels()
    if (model === undefined) throw new Error('resolved provider has no model')
    const events = provider.stream(model, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { apiKey: 'full-stream-key' })
    for await (const _event of events) { /* drain */ }
    expect(new URL(server.requests[0]!.url, server.origin).pathname).toBe('/full-stream')
    expect(() => provider.streamSimple(model, { messages: [] })).toThrow(/No API key/)

    const auth = provider.auth.apiKey
    if (auth === undefined) throw new Error('ModelHub provider has no API-key auth resolver')
    const authContext = {
      env: (_name: string) => Promise.resolve(undefined),
      fileExists: (_path: string) => Promise.resolve(false),
    }
    await expect(auth.resolve({ ctx: authContext })).resolves.toEqual({
      auth: {},
      source: ModelHub.MODELHUB_DISPLAY_NAME,
    })
    await expect(auth.resolve({
      ctx: authContext,
      credential: { type: 'api_key', key: 'stored-key' },
    })).resolves.toEqual({
      auth: { apiKey: 'stored-key' },
      source: ModelHub.MODELHUB_DISPLAY_NAME,
    })
  })

  it('resolves a late attachment service for configured image input', async () => {
    vi.stubEnv('MODELHUB_TEST_AK', 'query-secret')
    const server = await startModelHubServer()
    servers.push(server)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const pluginConfig = config(`${server.origin}/images`)
    pluginConfig.models = [{ id: 'gpt-5.6-sol', input: ['text', 'image'] }]
    await ctx.plugin(ModelHub, pluginConfig)
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImage = vi.fn((_ref: ImageAttachmentRef): Promise<StoredImageAttachment> => Promise.resolve({
      ref,
      data: Uint8Array.of(1),
    }))
    class TestAttachmentStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1,
        maxImagePixels: 1,
        maxImageDimension: 1,
        mediaTypes: ['image/png'],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.resolve()
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return Promise.resolve(ref)
      }

      readImage(value: ImageAttachmentRef): Promise<StoredImageAttachment> {
        return readImage(value)
      }
    }
    await ctx.plugin(TestAttachmentStore)

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'gpt-5.6-sol',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) assembler.push(chunk)
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(readImage).toHaveBeenCalledWith(ref)
  })

  it('warns when legacy replay state must degrade to provider-neutral content', async () => {
    vi.stubEnv('MODELHUB_TEST_AK', 'query-secret')
    const server = await startModelHubServer()
    servers.push(server)
    const ctx = await harness(`${server.origin}/replay`)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const poisoned = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      source: {
        kind: 'model',
        ...{
          provider: ModelHub.MODELHUB_PROVIDER,
          model: 'gpt-5.6-sol',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: ModelHub.MODELHUB_PROVIDER,
            model: 'gpt-5.6-sol',
            stopReason: 'length',
            blocks: [{ type: 'text' }, { type: 'tool-call' }],
          },
        },
      },
    })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'gpt-5.6-sol',
      messages: [poisoned],
    })) assembler.push(chunk)
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unusable replay state'))
  })

  it('removes its route and configurable-provider entry when unloaded', async () => {
    vi.stubEnv('MODELHUB_TEST_AK', 'query-secret')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(ModelHub, config('https://modelhub.test/crawl'))
    expect(ctx.llm.listProviders()).toEqual([{
      id: ModelHub.MODELHUB_PROVIDER,
      name: ModelHub.MODELHUB_DISPLAY_NAME,
    }])
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: ModelHub.MODELHUB_PROVIDER,
      displayName: ModelHub.MODELHUB_DISPLAY_NAME,
      settingsNs: 'llm-modelhub',
      settingsPath: [],
    })
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })
})
