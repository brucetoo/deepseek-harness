/**
 * Automatic model-route policy plugin.
 * @module @deepseek-ai/dsh-llm-auto-router
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  assembledModelSelectionIntent,
  type Agent,
  type AutoModelSelection,
  type ModelSelection,
  type RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { isAgentLoopRequest, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { Attempts } from './attempts.ts'
import { resolveConfig } from './config.ts'
import { AutoModelRouter } from './policy.ts'
import { Routing } from './routing.ts'
import { observeAttemptStream, recoverAttempt } from './stream.ts'
import type { ScoringWeights } from './types.ts'

/** Optional automatic-routing operations consumed by Host APIs. */
export interface LlmAutoRouterService {
  /** Reject an unknown named pool without consulting provider state. */
  validatePool(pool?: string): void
  /** Test current route eligibility without reservation or health mutation. */
  routable(input: {
    agent: Agent
    selection: AutoModelSelection
    requiredModalities: readonly ModelModality[]
  }): Promise<boolean>
  /** Resolve a concrete admission route without reservation, pins, or health mutation. */
  preflight(input: {
    agent: Agent
    selection: AutoModelSelection
    requiredModalities: readonly ModelModality[]
    signal: AbortSignal
  }): Promise<ModelSelection>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional automatic-routing operations consumed by Host APIs. */
    llmAutoRouter?: LlmAutoRouterService
  }
}

/** Raw named pool configuration accepted from composition. */
export interface PoolConfig {
  /** Included provider/model patterns. */
  readonly include?: string[]
  /** Excluded provider/model patterns. */
  readonly exclude?: string[]
}

/** Loader configuration for one explicit provider/model route. */
export interface RouteConfig {
  /** Named pool that owns this route. */
  readonly pool: string
  /** Whether selection may use this route. */
  readonly enabled?: boolean
  /** Non-negative score multiplier; lower values are preferred. */
  readonly preferenceMultiplier?: number
  /** Maximum concurrent attempts on this route. */
  readonly concurrencyLimit: number
}

/** Raw automatic-router plugin configuration. */
export interface Config {
  /** Virtual provider that invokes automatic routing. */
  readonly virtualProvider?: string
  /** Virtual model that invokes automatic routing. */
  readonly virtualModel?: string
  /** Named route-pattern pools. */
  readonly pools?: Record<string, PoolConfig>
  /** Explicit route policy keyed by canonical `provider/model` identity. */
  readonly models?: Record<string, RouteConfig>
  /** Maximum physical failovers within one logical step. */
  readonly maxFailoversPerStep?: number
  /** Tokens reserved beyond measured input and requested output. */
  readonly tokenSafetyReserve?: number
  /** Weight of each new timing sample in the latency EWMA. */
  readonly ewmaAlpha?: number
  /** Consecutive failures that open a route circuit. */
  readonly failureThreshold?: number
  /** Initial circuit-open cooldown. */
  readonly baseCooldownMs?: number
  /** Maximum circuit-open cooldown. */
  readonly maxCooldownMs?: number
  /** Concurrent probes allowed for a half-open route. */
  readonly halfOpenConcurrency?: number
  /** Score reduction applied to unsampled routes. */
  readonly explorationWeight?: number
  /** Relative latency, load, and failure score weights. */
  readonly scoring?: ScoringWeights
}

const poolSchema: z<PoolConfig> = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
})

const routeSchema: z<RouteConfig> = z.object({
  pool: z.string().required(),
  enabled: z.boolean(),
  preferenceMultiplier: z.number().min(0),
  concurrencyLimit: z.number().step(1).min(1).required(),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  virtualProvider: z.string().default('auto'),
  virtualModel: z.string().default('auto'),
  pools: z.dict(poolSchema).default({ default: { include: ['*/*'], exclude: [] } }),
  models: z.dict(routeSchema).default({}),
  maxFailoversPerStep: z.number().step(1).min(0).default(2),
  tokenSafetyReserve: z.number().step(1).min(0).default(1_024),
  ewmaAlpha: z.number().min(Number.MIN_VALUE).max(1).default(0.2),
  failureThreshold: z.number().step(1).min(1).default(3),
  baseCooldownMs: z.number().step(1).min(1).default(5_000),
  maxCooldownMs: z.number().step(1).min(1).default(120_000),
  halfOpenConcurrency: z.number().step(1).min(1).default(1),
  explorationWeight: z.number().min(0).default(0.05),
  scoring: z.object({
    latency: z.number().min(0).default(0.35),
    load: z.number().min(0).default(0.35),
    failure: z.number().min(0).default(0.3),
  }),
})

export { resolveConfig }
export { RouteKey } from './brand.ts'
export { AutoModelRouter, AutoRoutingError } from './policy.ts'
export { buildCandidateCatalog } from './catalog.ts'
export { foldModelSelectionIntent } from './selection.ts'
export type * from './types.ts'

/** Cordis function-plugin name. */
export const name = 'llm-auto-router'
/** Services required by request-time routing tasks. */
export const inject = ['agents', 'llm', 'sessions', 'tokenMeter']

interface RouterRuntime {
  policy: ReturnType<typeof resolveConfig>
  router: AutoModelRouter
  attempts: Attempts
  routing: Routing
  dependencies: {
    context: Context
    agents: Context['agents']
    llm: Context['llm']
    sessions: Context['sessions']
    tokenMeter: Context['tokenMeter']
  }
  owners: number
}

const RUNTIME_KEY = Symbol.for('@deepseek-ai/dsh-llm-auto-router/runtime')
const processState = globalThis as typeof globalThis & { [RUNTIME_KEY]?: RouterRuntime }

function routeEvent(attempt: ReturnType<Routing['matchPhysical']>) {
  if (attempt === undefined) throw new Error('llm-auto-router: missing physical attempt')
  return {
    attemptId: attempt.id,
    turn: attempt.turn,
    step: attempt.step,
    attempt: attempt.attempt,
    pool: attempt.pool,
    provider: attempt.route.provider,
    model: attempt.route.model,
    candidateCount: attempt.candidateCount,
    reason: attempt.reason,
  }
}

/**
 * Install process-global automatic routing state and lifecycle listeners.
 * @param ctx - context carrying Agent, LLM, session, and token-meter services.
 * @param config - raw Loader configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const policy = resolveConfig(config)
  const dependencies = {
    context: ctx,
    agents: ctx.agents,
    llm: ctx.llm,
    sessions: ctx.sessions,
    tokenMeter: ctx.tokenMeter,
  }
  let runtime = processState[RUNTIME_KEY]
  if (runtime === undefined) {
    const router = new AutoModelRouter(policy)
    const attempts = new Attempts()
    runtime = {
      policy,
      router,
      attempts,
      routing: new Routing(ctx, policy, router, attempts),
      dependencies,
      owners: 0,
    }
    processState[RUNTIME_KEY] = runtime
  } else if (JSON.stringify(runtime.policy) !== JSON.stringify(policy)
    || runtime.dependencies.context !== dependencies.context
    || runtime.dependencies.agents !== dependencies.agents
    || runtime.dependencies.llm !== dependencies.llm
    || runtime.dependencies.sessions !== dependencies.sessions
    || runtime.dependencies.tokenMeter !== dependencies.tokenMeter) {
    throw new Error('llm-auto-router: process-global runtime is incompatible with this context or policy')
  }
  runtime.owners += 1
  const active = runtime
  ctx.provide('llmAutoRouter', {
    validatePool: (pool) => {
      active.routing.validatePool(pool)
    },
    routable: input => active.routing.routable(input),
    preflight: input => active.routing.preflight(input),
  })

  const disposeRequest = ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const proposal = await next()
    return active.routing.resolve({
      agent, turn, step, signal,
      intent: assembledModelSelectionIntent(agent),
      proposal,
    })
  }, { prepend: true })
  const disposeStream = ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next()
    const agent = ctx.agents.get(options.sessionId)
    if (agent === undefined) return next()
    const attempt = active.routing.matchPhysical(agent, options.provider, options.model)
    if (attempt === undefined) return next()
    let source: AsyncIterable<StreamChunk>
    try {
      source = next()
    } catch (error: unknown) {
      active.attempts.releaseUndispatched(agent, attempt.turn, attempt.step)
      throw error
    }
    return observeAttemptStream(
      attempt,
      active.router,
      source,
      Date.now,
      () => {
        active.attempts.dispatch(attempt)
        agent.session.append('llm/auto-route', routeEvent(attempt))
      },
      () => { active.attempts.releaseUndispatched(agent, attempt.turn, attempt.step) },
    )
  })
  const disposeError = ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure, signal },
    next: () => Promise<RequestErrorAction>,
  ) => {
    const matching = active.attempts.latestDispatched(agent, turn, step)
    const header = agent.session.requestHeader()
    if (matching === undefined
      || matching.route.provider !== provider
      || header?.config.provider !== matching.route.provider
      || header.config.model !== matching.route.model) return next()
    const proposal: LlmCallConfig = { provider: matching.route.provider, model: matching.route.model }
    return recoverAttempt({
      agent,
      attempt: matching,
      failureCode: failure.code,
      maxFailovers: active.policy.maxFailoversPerStep,
      attempts: active.attempts,
      hasAlternative: () => active.routing.canFailover({
        agent, turn, step, signal,
        intent: assembledModelSelectionIntent(agent),
        proposal,
      }),
      appendFailover: () => agent.session.append('llm/auto-failover', {
        attemptId: matching.id,
        turn,
        step,
        attempt: matching.attempt,
        fromProvider: matching.route.provider,
        fromModel: matching.route.model,
        failureCode: failure.code,
      }),
      next,
    })
  }, { prepend: true })
  const disposeUpdated = ctx.on('llm/adapters-updated', () => {
    active.routing.invalidateCatalog()
  })
  const disposeErrorBoundary = ctx.on('agent/error', ({ agent, turn, step }) => {
    active.attempts.releaseUndispatched(agent, turn, step)
  })
  const disposeAgent = ctx.on('agent/disposed', ({ agent }) => {
    active.routing.release(agent)
  })

  ctx.effect(() => () => {
    disposeRequest()
    disposeStream()
    disposeError()
    disposeUpdated()
    disposeErrorBoundary()
    disposeAgent()
    active.owners -= 1
    if (active.owners === 0) {
      active.attempts.dispose()
      if (processState[RUNTIME_KEY] === active) Reflect.deleteProperty(processState, RUNTIME_KEY)
    }
  }, 'llm-auto-router: remove listeners and release attempts')
}
