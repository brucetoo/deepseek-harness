/** Package-owned automatic route event relationships. @module @deepseek-ai/dsh-llm-auto-router/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-auto-router'

/** Cordis companion plugin name. */
export const name = 'llm-auto-router-invariant'
/** Services required before package-owned event relationships can be checked. */
export const inject = ['invariants']

function validateEvents(events: readonly SessionEvent[], fail: InvariantFailure): void {
  const routes = new Map<string, SessionEvent<'llm/auto-route'>>()
  const lastAttempt = new Map<string, number>()
  const failovers = new Set<string>()
  for (const event of events) {
    if (event.type === 'llm/auto-route') {
      const data = event.data
      const key = `${data.turn}:${data.step}`
      if (data.turn < 1 || data.step < 1 || data.attempt < 1) fail('llm/auto-route numbers must be positive')
      if (data.attempt !== (lastAttempt.get(key) ?? 0) + 1) fail('llm/auto-route attempts must be contiguous')
      const header = events.slice(0, event.seq).findLast(candidate => candidate.type === 'request/header')
      if (header?.type !== 'request/header'
        || header.data.header.config.provider !== data.provider
        || header.data.header.config.model !== data.model) {
        fail('llm/auto-route physical identity must match the current request/header')
      }
      if (routes.has(data.attemptId)) fail('llm/auto-route repeats attemptId')
      routes.set(data.attemptId, event)
      lastAttempt.set(key, data.attempt)
    } else if (event.type === 'llm/auto-failover') {
      if (failovers.has(event.data.attemptId)) fail('llm/auto-failover is a duplicate failover for one attempt')
      const route = routes.get(event.data.attemptId)
      if (route === undefined) fail('llm/auto-failover has no prior route')
      if (route.data.turn !== event.data.turn
        || route.data.step !== event.data.step
        || route.data.attempt !== event.data.attempt
        || route.data.provider !== event.data.fromProvider
        || route.data.model !== event.data.fromModel) {
        fail('llm/auto-failover must match its prior route')
      }
      if (events.slice(route.seq + 1, event.seq).some(candidate =>
        candidate.type === 'assistant/chunk' && commits(candidate.data.chunk))) {
        fail('llm/auto-failover must precede committed output')
      }
      failovers.add(event.data.attemptId)
    }
  }
}

function commits(chunk: SessionEvent<'assistant/chunk'>['data']['chunk']): boolean {
  return chunk.type === 'block-end'
    || chunk.type === 'tool-call-delta'
    || ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateEvents(session.events, fail)
  ctx.on('session/created', (session) => { validateEvents(session.events, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvents([...session.events, event], fail)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
