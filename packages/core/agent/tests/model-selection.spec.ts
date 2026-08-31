import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  assembledModelSelectionIntent,
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
} from '../src/index.ts'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

describe('installModelSelection()', () => {
  it('snapshots logical Auto without applying it to physical request config', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = { ctx } as Agent
    Object.defineProperty(ctx, 'agent', { value: agent })
    const selection: ModelSelectionRef = { current: { kind: 'auto', pool: 'fast' }, assembled: undefined }
    const dispose = installModelSelection(ctx, selection)
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'auto', model: 'auto' })
    expect(assembledModelSelectionIntent(agent)).toEqual({ kind: 'auto', pool: 'fast' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    dispose()
    expect(assembledModelSelectionIntent(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('does not publish a pending assembly after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = { ctx } as Agent
    Object.defineProperty(ctx, 'agent', { value: agent })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const didEnter = new Promise<void>((resolve) => { entered = resolve })
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      entered()
      await blocked
      return next()
    })
    const selection: ModelSelectionRef = { current: { kind: 'auto' }, assembled: undefined }
    const dispose = installModelSelection(ctx, selection)

    const pending = ctx.systemPrompt.assemble()
    await didEnter
    dispose()
    release()
    await expect(pending).resolves.toMatchObject({ variables: {} })
    expect(selection.assembled).toBeUndefined()
    expect(assembledModelSelectionIntent(agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx, selection)
    const agent = {} as Agent
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    selection.current = {
      kind: 'model',
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'a1' })
    selection.current = { kind: 'model', provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
    })

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'beta', model: 'b1' })
    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })

    dispose()
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })
})
