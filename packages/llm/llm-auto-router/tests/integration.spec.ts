import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { markAgentLoopRequest, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { apply } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(TokenMeter)
  const session = Session.create(SessionId('auto-integration'))
  const agent = {
    id: session.id,
    session,
    ctx,
  } as Agent
  Object.defineProperty(ctx, 'agent', { value: agent })
  ctx.agents.register(agent)
  const selection: ModelSelectionRef = { current: { kind: 'auto' }, assembled: undefined }
  installModelSelection(ctx, selection)
  await ctx.systemPrompt.assemble()
  ctx.llm.listProviders = () => [{ id: 'physical', name: 'Physical' }]
  ctx.llm.listModels = async provider => [{ provider, id: 'model', name: 'Model', inputModalities: ['text'] }]
  ctx.llm.resolveModelInfo = async (provider, model) => ({
    provider, id: model, name: model, inputModalities: ['text'],
    context: { contextWindow: 10_000 }, defaultMaxTokens: 100,
  })
  ctx.agents.get = id => id === agent.id ? agent : undefined
  apply(ctx, { tokenSafetyReserve: 0 })
  contexts.push(ctx)
  return { ctx, agent }
}

async function request(ctx: Context, agent: Agent, seed: LlmCallConfig) {
  return ctx.waterfall('agent/request', {
    agent, turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve(seed))
}

describe('auto-router integration', () => {
  it('rejects process-global reuse across incompatible contexts', async () => {
    const first = await harness()
    const second = new Context()
    await second.plugin(LlmRuntime)
    await second.plugin(SessionStore)
    await second.plugin(AgentRegistry)
    await second.plugin(SystemPrompt)
    await second.plugin(TokenMeter)

    expect(() =>{  apply(second, { tokenSafetyReserve: 0 }) })
      .toThrow(/process-global runtime is incompatible/)
    expect(first.ctx.get('llmAutoRouter')).toBeDefined()
    await second.fiber.dispose()
  })

  it('routes Auto after downstream listeners in both registration orders', async () => {
    const { ctx, agent } = await harness()
    await expect(request(ctx, agent, { provider: 'seed', model: 'seed', temperature: 0.4 }))
      .resolves.toEqual({ provider: 'physical', model: 'model', temperature: 0.4 })
  })

  it('releases a reservation when downstream request preparation fails', async () => {
    const { ctx, agent } = await harness()
    await request(ctx, agent, { provider: 'seed', model: 'seed' })

    ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('prepare failed') })

    const service = ctx.get('llmAutoRouter')
    expect(service).toBeDefined()
    await expect(service?.routable({ agent, selection: { kind: 'auto' }, requiredModalities: ['text'] }))
      .resolves.toBe(true)
  })

  it('does not append a route or hold capacity when delegated stream construction throws', async () => {
    const { ctx, agent } = await harness()
    const config = await request(ctx, agent, { provider: 'seed', model: 'seed' })
    ctx.on('llm/stream', () => { throw new Error('construct failed') })
    const options = markAgentLoopRequest({ ...config, messages: [], sessionId: agent.id })

    expect(() => ctx.llm.stream(options)).toThrow('construct failed')
    expect(agent.session.events.some(event => event.type === 'llm/auto-route')).toBe(false)
  })

  it('does not append a route and releases capacity when the first next fails', async () => {
    const { ctx, agent } = await harness()
    const config = await request(ctx, agent, { provider: 'seed', model: 'seed' })
    ctx.on('llm/stream', () => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('first next failed')) }
      },
    }))
    const options = markAgentLoopRequest({ ...config, messages: [], sessionId: agent.id })

    await expect((async () => { for await (const _chunk of ctx.llm.stream(options)) { /* drain */ } })())
      .rejects.toThrow('first next failed')
    expect(agent.session.events.some(event => event.type === 'llm/auto-route')).toBe(false)
  })

  it('appends the route after iterator entry and before the first yielded chunk', async () => {
    const { ctx, agent } = await harness()
    const config = await request(ctx, agent, { provider: 'seed', model: 'seed' })
    agent.session.append('request/header', { header: { config }, reason: 'initial' })
    ctx.on('llm/stream', (_options, _next) => (async function* (): AsyncIterable<StreamChunk> {
      expect(agent.session.events.some(event => event.type === 'llm/auto-route')).toBe(false)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const options = markAgentLoopRequest({ ...config, messages: [], sessionId: agent.id })
    for await (const _chunk of ctx.llm.stream(options)) {
      expect(agent.session.events.some(event => event.type === 'llm/auto-route')).toBe(true)
    }
    expect(agent.session.events.find(event => event.type === 'llm/auto-route')).toMatchObject({
      data: { turn: 1, step: 1, attempt: 1, provider: 'physical', model: 'model' },
    })
  })
})
