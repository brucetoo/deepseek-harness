import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { AutoRouteAttemptId } from '../src/brand.ts'
import type {} from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function backend(kind: 'jsonl' | 'sqlite'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (kind === 'jsonl') {
    const root = await mkdtemp(join(tmpdir(), 'dsh-llm-auto-router-jsonl-'))
    dirs.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
  } else {
    await ctx.plugin(SqliteSessionPersistence, { path: ':memory:' })
  }
  return ctx
}

describe.each(['jsonl', 'sqlite'] as const)('%s auto-router persistence', (kind) => {
  it('round-trips logical selections and physical routing facts without deriving routing messages', async () => {
    const ctx = await backend(kind)
    try {
      const session = ctx.sessions.create(SessionId(`auto-router-${kind}`))
      const autoSelection = session.append('model/selection', { kind: 'auto', pool: 'fast' })
      const concreteSelection = session.append('model/selection', {
        kind: 'model', provider: 'fixed', model: 'fixed-model', reasoningEffort: ReasoningEffortId('high'),
      })
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('request/header', {
        header: { config: { provider: 'route-a', model: 'model-a' } },
        reason: 'initial',
      })
      const attemptId = AutoRouteAttemptId(`${kind}:1:1:1`)
      const route = session.append('llm/auto-route', {
        attemptId,
        turn: 1,
        step: 1,
        attempt: 1,
        pool: 'fast',
        provider: 'route-a',
        model: 'model-a',
        candidateCount: 2,
        reason: 'normal',
      })
      const failover = session.append('llm/auto-failover', {
        attemptId,
        turn: 1,
        step: 1,
        attempt: 1,
        fromProvider: 'route-a',
        fromModel: 'model-a',
        failureCode: 'SERVER',
      })
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'hello back' }],
          source: { provider: 'route-b', model: 'model-b' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      expect(session.deriveMessages()).toMatchObject([
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello back' }],
          source: { provider: 'route-b', model: 'model-b' },
        },
      ])
      await ctx.sessions.flush(session)
      const loaded = await ctx.sessionPersistence.load(session.id)

      expect(loaded.events.filter(event => event.type === 'model/selection')).toEqual([
        autoSelection,
        concreteSelection,
      ])
      expect(loaded.events.find(event => event.type === 'llm/auto-route')).toEqual(route)
      expect(loaded.events.find(event => event.type === 'llm/auto-failover')).toEqual(failover)
      const restored = Session.fromRestore(session.id, loaded.events, loaded.meta)
      expect(restored.deriveMessages()).toEqual(session.deriveMessages())
      expect(JSON.stringify(restored.deriveMessages())).not.toContain('llm/auto')
      expect(JSON.stringify(restored.deriveMessages())).not.toContain('SERVER')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
