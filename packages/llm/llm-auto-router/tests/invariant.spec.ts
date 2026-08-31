import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { AutoRouteAttemptId } from '../src/brand.ts'
import * as AutoRouterInvariant from '../src/invariant.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AutoRouterInvariant)
  const session = ctx.sessions.create(SessionId('auto-router-invariant'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'a', model: 'm' } }, reason: 'initial',
  })
  return { ctx, session }
}

const route = {
  attemptId: AutoRouteAttemptId('attempt-1'), turn: 1, step: 1, attempt: 1,
  pool: 'default', provider: 'a', model: 'm', candidateCount: 2, reason: 'normal' as const,
}

describe('llm-auto-router invariant companion', () => {
  it('accepts a matching route and uncommitted failover', async () => {
    const { session } = await setup()
    expect(() => {
      session.append('llm/auto-route', route)
      session.append('llm/auto-failover', {
        attemptId: route.attemptId, turn: 1, step: 1, attempt: 1,
        fromProvider: 'a', fromModel: 'm', failureCode: 'SERVER',
      })
    }).not.toThrow()
  })

  it('rejects route identity that does not match the physical header', async () => {
    const { session } = await setup()
    expect(() => session.append('llm/auto-route', { ...route, provider: 'b' }))
      .toThrow(/physical identity/)
  })

  it('rejects duplicate failover for one attempt', async () => {
    const { session } = await setup()
    session.append('llm/auto-route', route)
    const failover = {
      attemptId: route.attemptId, turn: 1, step: 1, attempt: 1,
      fromProvider: 'a', fromModel: 'm', failureCode: 'SERVER',
    }
    session.append('llm/auto-failover', failover)
    expect(() => session.append('llm/auto-failover', failover)).toThrow(/duplicate failover/)
  })

  it('rejects failover after committed output', async () => {
    const { session } = await setup()
    session.append('llm/auto-route', route)
    session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'committed' },
    })
    expect(() => session.append('llm/auto-failover', {
      attemptId: route.attemptId, turn: 1, step: 1, attempt: 1,
      fromProvider: 'a', fromModel: 'm', failureCode: 'SERVER',
    })).toThrow(/committed output/)
  })

  it('rejects an orphan failover and validates loaded history', async () => {
    const { session } = await setup()
    expect(() => session.append('llm/auto-failover', {
      attemptId: AutoRouteAttemptId('missing'), turn: 1, step: 1, attempt: 1,
      fromProvider: 'a', fromModel: 'm', failureCode: 'SERVER',
    })).toThrow(/no prior route/)

    const late = new Context()
    await late.plugin(SessionStore)
    const invalid = late.sessions.create(SessionId('late-invalid'))
    invalid.append('turn/start', { turn: 1 })
    invalid.append('step/start', { turn: 1, step: 1 })
    invalid.append('request/header', {
      header: { config: { provider: 'b', model: 'm' } }, reason: 'initial',
    })
    invalid.append('llm/auto-route', route)
    await late.plugin(InvariantRegistry)
    await expect(late.plugin(AutoRouterInvariant)).rejects.toThrow(/physical identity/)
  })
})
