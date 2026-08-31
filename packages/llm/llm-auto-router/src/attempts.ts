/** Process-local ownership for automatic route attempts. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { AutoRouteAttemptId } from './brand.ts'
import type { AutoRouteAttemptId as AutoRouteAttemptIdentity } from './brand.ts'
import type { AttemptReservation, AutoRouteDecision, PhysicalRoute, RouteKey } from './types.ts'

/** One physical request attempt reserved for an automatic selection. */
export interface AutoRouteAttempt {
  readonly id: AutoRouteAttemptIdentity
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly pool: string
  readonly route: PhysicalRoute
  readonly reason: AutoRouteDecision['reason']
  readonly candidateCount: number
  readonly reservation: AttemptReservation
  committed: boolean
  dispatched: boolean
  startedAt?: number
  ttftAt?: number
  settled: boolean
}

interface StepAttempts {
  readonly attempts: AutoRouteAttempt[]
  pin?: RouteKey
}

const stepKey = (turn: number, step: number): string => `${turn}:${step}`

/** Owns per-Agent attempt ledgers and releases every outstanding reservation. */
export class Attempts {
  readonly #agents = new WeakMap<Agent, Map<string, StepAttempts>>()
  readonly #owners = new WeakMap<AutoRouteAttempt, StepAttempts>()
  readonly #liveAgents = new Set<Agent>()

  #steps(agent: Agent): Map<string, StepAttempts> {
    let steps = this.#agents.get(agent)
    if (steps === undefined) {
      steps = new Map()
      this.#agents.set(agent, steps)
      this.#liveAgents.add(agent)
    }
    return steps
  }

  #step(agent: Agent, turn: number, step: number): StepAttempts {
    const steps = this.#steps(agent)
    const key = stepKey(turn, step)
    let state = steps.get(key)
    if (state === undefined) {
      state = { attempts: [] }
      steps.set(key, state)
    }
    return state
  }

  /**
   * Record one reserved physical attempt.
   * @param agent - Agent that owns the open step.
   * @param turn - open turn number.
   * @param step - open step number.
   * @param pool - logical automatic pool.
   * @param decision - selected physical route and decision metadata.
   * @param reservation - unsettled route-capacity reservation.
   * @returns the new attempt record.
   */
  begin(
    agent: Agent,
    turn: number,
    step: number,
    pool: string,
    decision: AutoRouteDecision,
    reservation: AttemptReservation,
  ): AutoRouteAttempt {
    const state = this.#step(agent, turn, step)
    const attemptNumber = state.attempts.length + 1
    const attempt: AutoRouteAttempt = {
      id: AutoRouteAttemptId(`${String(agent.id)}:${turn}:${step}:${attemptNumber}`),
      turn,
      step,
      attempt: attemptNumber,
      pool,
      route: decision.route,
      reason: decision.reason,
      candidateCount: decision.candidateCount,
      reservation,
      committed: false,
      dispatched: false,
      settled: false,
    }
    state.attempts.push(attempt)
    this.#owners.set(attempt, state)
    return attempt
  }

  /** Return the latest attempt when its physical request identity matches. */
  match(
    agent: Agent,
    turn: number,
    step: number,
    provider: string,
    model: string,
  ): AutoRouteAttempt | undefined {
    const attempts = this.#agents.get(agent)?.get(stepKey(turn, step))?.attempts
    const attempt = attempts?.at(-1)
    return attempt?.route.provider === provider && attempt.route.model === model ? attempt : undefined
  }

  /** Return the latest attempt in one Agent step. */
  latest(agent: Agent, turn: number, step: number): AutoRouteAttempt | undefined {
    return this.#agents.get(agent)?.get(stepKey(turn, step))?.attempts.at(-1)
  }

  /** Return the latest attempt whose physical stream observation started. */
  latestDispatched(agent: Agent, turn: number, step: number): AutoRouteAttempt | undefined {
    return this.#agents.get(agent)?.get(stepKey(turn, step))?.attempts.findLast(attempt => attempt.dispatched)
  }

  /** Return the newest unsettled attempt matching one Agent and physical route. */
  matchPhysical(agent: Agent, provider: string, model: string): AutoRouteAttempt | undefined {
    const steps = this.#agents.get(agent)
    if (steps === undefined) return undefined
    const attempts = [...steps.values()].flatMap(state => state.attempts)
    return attempts.findLast(attempt => !attempt.settled
      && attempt.route.provider === provider
      && attempt.route.model === model)
  }

  /** Return every physical route already attempted in one step. */
  attemptedRoutes(agent: Agent, turn: number, step: number): ReadonlySet<RouteKey> {
    return new Set(this.#agents.get(agent)?.get(stepKey(turn, step))?.attempts.map(attempt => attempt.route.key) ?? [])
  }

  /** Pin the next delegated retry to the failed attempt's physical route. */
  pinRetry(attempt: AutoRouteAttempt): void {
    this.#stepFor(attempt).pin = attempt.route.key
  }

  #stepFor(attempt: AutoRouteAttempt): StepAttempts {
    const state = this.#owners.get(attempt)
    if (state === undefined) throw new Error('llm-auto-router: foreign route attempt')
    return state
  }

  /** Read a delegated retry pin without consuming it. */
  peekPin(agent: Agent, turn: number, step: number): RouteKey | undefined {
    return this.#agents.get(agent)?.get(stepKey(turn, step))?.pin
  }

  /** Consume a delegated retry pin after its replacement reservation succeeds. */
  commitPin(agent: Agent, turn: number, step: number, expected: RouteKey): void {
    const state = this.#agents.get(agent)?.get(stepKey(turn, step))
    if (state?.pin !== expected) throw new Error('llm-auto-router: retry pin changed before reservation commit')
    delete state.pin
  }

  /** Mark the point where stream observation assumes settlement ownership. */
  dispatch(attempt: AutoRouteAttempt): void {
    if (attempt.settled || attempt.dispatched) throw new Error('llm-auto-router: route attempt cannot dispatch twice')
    this.#stepFor(attempt)
    attempt.dispatched = true
  }

  /** Release and remove the newest reservation when no stream observation started. */
  releaseUndispatched(agent: Agent, turn: number, step: number): boolean {
    const state = this.#agents.get(agent)?.get(stepKey(turn, step))
    const attempt = state?.attempts.at(-1)
    if (state === undefined || attempt === undefined || attempt.dispatched || attempt.settled) return false
    attempt.reservation.cancel()
    attempt.settled = true
    state.attempts.pop()
    this.#owners.delete(attempt)
    return true
  }

  /** Release all outstanding attempts and forget one Agent ledger. */
  disposeAgent(agent: Agent): void {
    const steps = this.#agents.get(agent)
    if (steps === undefined) return
    for (const state of steps.values()) {
      for (const attempt of state.attempts) {
        if (attempt.settled) continue
        attempt.reservation.cancel()
        attempt.settled = true
      }
    }
    this.#agents.delete(agent)
    this.#liveAgents.delete(agent)
  }

  /** Release every live Agent ledger during plugin disposal. */
  dispose(): void {
    for (const agent of [...this.#liveAgents]) this.disposeAgent(agent)
  }
}
