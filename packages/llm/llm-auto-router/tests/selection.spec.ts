import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelectionIntent } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { foldModelSelectionIntent } from '../src/selection.ts'

describe('foldModelSelectionIntent()', () => {
  it('returns the latest detached logical selection intent', () => {
    expectTypeOf<SessionEventMap['model/selection']>().toEqualTypeOf<ModelSelectionIntent>()
    const session = Session.create(SessionId('selection-fold'))
    session.append('model/selection', { kind: 'auto', pool: 'fast' })
    session.append('model/selection', { kind: 'model', provider: 'fixed', model: 'm1' })

    const selected = foldModelSelectionIntent(session.events)
    expect(selected).toEqual({ kind: 'model', provider: 'fixed', model: 'm1' })
    expect(selected).not.toBe(session.events.at(-1)?.data)
  })

  it('does not let a later physical request header override Auto intent', () => {
    const session = Session.create(SessionId('selection-physical-header'))
    session.append('model/selection', { kind: 'auto', pool: 'fast' })
    session.append('request/header', {
      header: { config: { provider: 'physical', model: 'served-model' } },
      reason: 'initial',
    })
    expect(foldModelSelectionIntent(session.events)).toEqual({ kind: 'auto', pool: 'fast' })
  })

  it('retains concrete reasoning effort', () => {
    const session = Session.create(SessionId('selection-effort'))
    session.append('model/selection', {
      kind: 'model', provider: 'fixed', model: 'reasoner', reasoningEffort: ReasoningEffortId('high'),
    })
    expect(foldModelSelectionIntent(session.events)).toEqual({
      kind: 'model', provider: 'fixed', model: 'reasoner', reasoningEffort: 'high',
    })
  })

  it('retains selection in a balanced fork seed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const parent = ctx.sessions.create(SessionId('selection-parent'))
    parent.append('model/selection', { kind: 'auto', pool: 'fast' })
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const child = ctx.sessions.fork(parent, undefined, SessionId('selection-child'))
    expect(foldModelSelectionIntent(child.events)).toEqual({ kind: 'auto', pool: 'fast' })
    await ctx.fiber.dispose()
  })

  it('returns a detached fallback when no logical selection was recorded', () => {
    const session = Session.create(SessionId('selection-empty'))
    const fallback: ModelSelectionIntent = { kind: 'auto', pool: 'default' }
    const selected = foldModelSelectionIntent(session.events, fallback)
    expect(selected).toEqual(fallback)
    expect(selected).not.toBe(fallback)
  })

  it('returns undefined without an event or fallback', () => {
    const session = Session.create(SessionId('selection-undefined'))
    expect(foldModelSelectionIntent(session.events)).toBeUndefined()
  })
})
