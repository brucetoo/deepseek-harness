/** Pure automatic-routing policy types. */

import type { LlmFailure, ModelModality, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RouteKey } from './brand.ts'

export type { AutoRouteAttemptId, RouteKey } from './brand.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Physical provider/model selected for one automatic request attempt. */
    'llm/auto-route': {
      attemptId: import('./brand.ts').AutoRouteAttemptId
      turn: number
      step: number
      attempt: number
      pool: string
      provider: string
      model: string
      candidateCount: number
      reason: 'normal' | 'probe' | 'failover'
    }
    /** Failed uncommitted physical attempt that authorized routing to another model. */
    'llm/auto-failover': {
      attemptId: import('./brand.ts').AutoRouteAttemptId
      turn: number
      step: number
      attempt: number
      fromProvider: string
      fromModel: string
      failureCode: string
    }
  }
}

/** A concrete provider/model destination. */
export interface PhysicalRoute {
  readonly key: RouteKey
  readonly provider: string
  readonly model: string
}

/** One named candidate pool's route-pattern configuration. */
export interface RoutePool {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/** Relative contributions to a route's selection score. */
export interface ScoringWeights {
  /** Relative first-token latency contribution. */
  readonly latency: number
  /** Relative in-flight load contribution. */
  readonly load: number
  /** Relative recent-failure contribution. */
  readonly failure: number
}

/** Explicit ownership and tuning for one route. */
export interface RouteOverride {
  readonly route: RouteKey
  readonly pool: string
  readonly enabled?: boolean
  readonly preferenceMultiplier?: number
  readonly concurrencyLimit: number
}

/** Immutable automatic-routing policy. */
export interface AutoRouterPolicy {
  readonly virtualProvider: string
  readonly virtualModel: string
  readonly pools: Readonly<Record<string, RoutePool>>
  readonly models: readonly RouteOverride[]
  readonly maxFailoversPerStep: number
  readonly tokenSafetyReserve: number
  readonly ewmaAlpha: number
  readonly failureThreshold: number
  readonly baseCooldownMs: number
  readonly maxCooldownMs: number
  readonly halfOpenConcurrency: number
  readonly explorationWeight: number
  readonly scoring: ScoringWeights
}

/** Exact metadata and operator policy for one candidate route. */
export interface CandidateRoute extends PhysicalRoute {
  readonly advertised: boolean
  readonly enabled: boolean
  readonly pool: string
  readonly preferenceMultiplier: number
  readonly concurrencyLimit: number
  readonly inputModalities?: readonly ModelModality[]
  readonly contextWindow?: number
  readonly defaultMaxTokens?: number
  readonly reasoningEfforts?: readonly ReasoningEffortId[]
}

/** Inputs required for one pure route decision. */
export interface AutoRouteRequest {
  readonly pool: string
  readonly requiredModalities: readonly ModelModality[]
  readonly reasoningEffort?: ReasoningEffortId
  readonly estimatedInputTokens: number
  readonly estimatedInputTokensByRoute?: ReadonlyMap<RouteKey, number>
  readonly requestedMaxTokens?: number
  readonly attemptedRoutes: ReadonlySet<RouteKey>
  readonly now: number
}

/** Result of one route decision. */
export interface AutoRouteDecision {
  readonly route: CandidateRoute
  readonly reason: 'normal' | 'probe' | 'failover'
  readonly candidateCount: number
}

/** Successful timing sample for one settled attempt. */
export interface SuccessSample {
  readonly ttftMs: number
  readonly totalLatencyMs: number
}

/** Detached health and load status for one route. */
export interface AutoRouteStatus {
  readonly key: RouteKey
  readonly inFlight: number
  readonly ewmaTtftMs?: number
  readonly effectiveTtftMs: number
  readonly recentFailureRate: number
  readonly consecutiveFailures: number
  readonly sampleCount: number
  readonly circuit: 'closed' | 'open' | 'half-open'
  readonly cooldownUntil: number
  readonly lastFailureCode?: string
}

/** One in-flight increment that must settle exactly once. */
export interface AttemptReservation {
  readonly route: RouteKey
  /** Release the attempt without changing route health. */
  cancel(): void
}

/** Provider-neutral failure accepted by health accounting. */
export type RouteFailure = LlmFailure
