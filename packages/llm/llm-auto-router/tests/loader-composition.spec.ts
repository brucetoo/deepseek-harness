import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as autoRouter from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

class RouteAdapter extends LlmAdapter {
  requests = 0

  constructor(
    private readonly provider: string,
    private readonly model: string,
    private readonly outcome: 'error' | 'committed-error' | 'success',
  ) {
    super()
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider: this.provider,
      id: this.model,
      name: this.model,
      inputModalities: ['text'],
    }])
  }

  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider: this.provider,
      id: this.model,
      name: this.model,
      inputModalities: ['text'],
      context: { contextWindow: 16_000 },
      defaultMaxTokens: 256,
    })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.outcome === 'error' || this.outcome === 'committed-error') {
      if (this.outcome === 'committed-error') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial output' }
      }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'route A unavailable', code: 'SERVER' } },
      }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'served by route B' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'served by route B' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-auto-router-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-llm-auto-router', autoRouter],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('fails over before committed output and records only physical request routes', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-llm-auto-router'",
      '  config:',
      '    tokenSafetyReserve: 0',
      '    maxFailoversPerStep: 1',
      '    models:',
      '      route-a/model-a:',
      '        pool: default',
      '        preferenceMultiplier: 0',
      '        concurrencyLimit: 1',
      '      route-b/model-b:',
      '        pool: default',
      '        preferenceMultiplier: 1',
      '        concurrencyLimit: 1',
      "- name: '@deepseek-ai/dsh-agent-loop'",
      '  config:',
      '    agents: []',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const hostCapability = loaded.get('llmAutoRouter')
    expect(hostCapability).toBeDefined()
    hostCapability?.validatePool('default')

    const routeA = new RouteAdapter('route-a', 'model-a', 'error')
    const routeB = new RouteAdapter('route-b', 'model-b', 'success')
    loaded.llm.registerAdapter(['route-a'], routeA)
    loaded.llm.registerAdapter(['route-b'], routeB)

    const { agent } = await loaded.agents.create({
      sessionId: SessionId('loader-auto-router'),
      agentOptions: { provider: 'auto', model: 'auto' },
      setup(agentCtx) {
        const subject = agentCtx.agent
        if (subject === undefined) throw new Error('test setup has no Agent')
        subject.session.append('model/selection', { kind: 'auto' })
        const selection: ModelSelectionRef = { current: { kind: 'auto' }, assembled: undefined }
        installModelSelection(agentCtx, selection)
      },
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'route this request' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(routeA.requests).toBe(1)
    expect(routeB.requests).toBe(1)
    const routeEvents = agent.session.events.filter(event => event.type === 'llm/auto-route')
    expect(routeEvents.map(event => event.data)).toMatchObject([
      { attempt: 1, provider: 'route-a', model: 'model-a', reason: 'normal' },
      { attempt: 2, provider: 'route-b', model: 'model-b', reason: 'failover' },
    ])
    expect(agent.session.events.filter(event => event.type === 'llm/auto-failover')).toMatchObject([{
      data: { attempt: 1, fromProvider: 'route-a', fromModel: 'model-a', failureCode: 'SERVER' },
    }])
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.map(event => event.data.header.config)).toMatchObject([
      { provider: 'route-a', model: 'model-a' },
      { provider: 'route-b', model: 'model-b' },
    ])
    expect(headers.some(event => event.data.header.config.provider === 'auto'
      || event.data.header.config.model === 'auto')).toBe(false)

    const ordered = agent.session.events.filter(event =>
      event.type === 'model/selection'
      || event.type === 'turn/start'
      || event.type === 'request/header'
      || event.type === 'llm/auto-route'
      || event.type === 'llm/auto-failover'
      || event.type === 'assistant/message')
    expect(ordered.map(event => event.type)).toEqual([
      'model/selection',
      'turn/start',
      'request/header',
      'llm/auto-route',
      'llm/auto-failover',
      'request/header',
      'llm/auto-route',
      'assistant/message',
    ])
    expect(agent.session.deriveMessages()).toMatchObject([
      { role: 'user' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'served by route B' }],
        source: { provider: 'route-b', model: 'model-b' },
      },
    ])
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('route A unavailable')
  })

  it('denies cross-route failover after committed output', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-llm-auto-router'",
      '  config:',
      '    tokenSafetyReserve: 0',
      '    maxFailoversPerStep: 1',
      '    models:',
      '      route-a/model-a:',
      '        pool: default',
      '        preferenceMultiplier: 0',
      '        concurrencyLimit: 1',
      '      route-b/model-b:',
      '        pool: default',
      '        preferenceMultiplier: 1',
      '        concurrencyLimit: 1',
      "- name: '@deepseek-ai/dsh-agent-loop'",
      '  config:',
      '    agents: []',
    ])
    const routeA = new RouteAdapter('route-a', 'model-a', 'committed-error')
    const routeB = new RouteAdapter('route-b', 'model-b', 'success')
    loaded.llm.registerAdapter(['route-a'], routeA)
    loaded.llm.registerAdapter(['route-b'], routeB)
    const { agent } = await loaded.agents.create({
      sessionId: SessionId('loader-auto-router-committed'),
      agentOptions: { provider: 'auto', model: 'auto' },
      setup(agentCtx) {
        const subject = agentCtx.agent
        if (subject === undefined) throw new Error('test setup has no Agent')
        subject.session.append('model/selection', { kind: 'auto' })
        installModelSelection(agentCtx, { current: { kind: 'auto' }, assembled: undefined })
      },
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'do not switch after output' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(routeA.requests).toBe(1)
    expect(routeB.requests).toBe(0)
    expect(agent.session.events.filter(event => event.type === 'llm/auto-failover')).toEqual([])
    expect(agent.session.events.filter(event => event.type === 'llm/auto-route')).toHaveLength(1)
  })
})
