/** Pure candidate filtering, scoring, circuit, and reservation state. */

import type {
  AttemptReservation,
  AutoRouteDecision,
  AutoRouteRequest,
  AutoRouterPolicy,
  AutoRouteStatus,
  CandidateRoute,
  RouteFailure,
  RouteKey,
  SuccessSample,
} from './types.ts'

interface RouteHealth {
  inFlight: number
  ewmaTtftMs?: number
  successes: number
  failures: number
  consecutiveFailures: number
  openCount: number
  cooldownUntil: number
  halfOpenInFlight: number
  circuit: 'closed' | 'open' | 'half-open'
  lastFailureCode?: string
}

interface RouterInternals {
  readonly now?: () => number
  readonly rotationSeed?: number
}

type Rejection =
  | 'attempted'
  | 'context-capacity'
  | 'disabled'
  | 'modality'
  | 'output-capacity'
  | 'reasoning'
  | 'saturated'

const REJECTION_ORDER: readonly Rejection[] = [
  'disabled',
  'attempted',
  'modality',
  'reasoning',
  'context-capacity',
  'output-capacity',
  'saturated',
]

/** Stable no-candidate failure without prompt content or provider errors. */
export class AutoRoutingError extends Error {
  /** Stable machine-routing code. */
  readonly code = 'AUTO_NO_CANDIDATE'

  /**
   * @param rejectedCapabilities - stable capability categories that excluded candidates.
   */
  constructor(readonly rejectedCapabilities: readonly Rejection[]) {
    super(`AUTO_NO_CANDIDATE: rejected ${rejectedCapabilities.join(', ') || 'pool'}`)
    this.name = 'AutoRoutingError'
  }
}

function freshHealth(): RouteHealth {
  return {
    inFlight: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    openCount: 0,
    cooldownUntil: 0,
    halfOpenInFlight: 0,
    circuit: 'closed',
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 1
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 1
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? upper) + upper) / 2 : upper
}

/** Owns route health and provides deterministic pure routing decisions. */
export class AutoModelRouter {
  readonly #health = new Map<RouteKey, RouteHealth>()
  readonly #now: () => number
  readonly #rotationSeed: number
  readonly #probeAuthorizations = new Map<RouteKey, number>()
  readonly #reservations = new WeakMap<AttemptReservation, () => RouteHealth>()
  #catalog: readonly CandidateRoute[] = []
  #rotation = 0

  /**
   * @param policy - immutable validated selection policy.
   * @param internals - deterministic clock and tie rotation for tests.
   */
  constructor(
    readonly policy: AutoRouterPolicy,
    internals: RouterInternals = {},
  ) {
    this.#now = internals.now ?? Date.now
    this.#rotationSeed = internals.rotationSeed ?? 0
  }

  /**
   * Replace exact candidates while preserving health for identities still present.
   * @param routes - detached exact candidate metadata.
   */
  replaceCatalog(routes: readonly CandidateRoute[]): void {
    this.#catalog = routes.map(route => Object.freeze({ ...route })).toSorted((left, right) => left.key.localeCompare(right.key))
    const retained = new Set(this.#catalog.map(route => route.key))
    for (const key of this.#health.keys()) {
      if (!retained.has(key)) {
        this.#health.delete(key)
        this.#probeAuthorizations.delete(key)
      }
    }
    for (const key of retained) if (!this.#health.has(key)) this.#health.set(key, freshHealth())
  }

  #reject(route: CandidateRoute, request: AutoRouteRequest): Rejection | undefined {
    const health = this.#health.get(route.key) ?? freshHealth()
    if (!route.enabled) return 'disabled'
    if (request.attemptedRoutes.has(route.key)) return 'attempted'
    const inputModalities = route.inputModalities
    if (inputModalities === undefined
      || request.requiredModalities.some(modality => !inputModalities.includes(modality))) return 'modality'
    if (request.reasoningEffort !== undefined
      && (route.reasoningEfforts === undefined || !route.reasoningEfforts.includes(request.reasoningEffort))) return 'reasoning'
    if (route.contextWindow === undefined) return 'context-capacity'
    const outputAllowance = request.requestedMaxTokens ?? route.defaultMaxTokens
    if (outputAllowance === undefined) return 'output-capacity'
    const estimatedInputTokens = request.estimatedInputTokensByRoute?.get(route.key) ?? request.estimatedInputTokens
    if (estimatedInputTokens + outputAllowance + this.policy.tokenSafetyReserve > route.contextWindow) {
      return 'context-capacity'
    }
    if (health.inFlight >= route.concurrencyLimit) return 'saturated'
    return undefined
  }

  #effectiveTtft(route: CandidateRoute, catalog: readonly CandidateRoute[] = this.#catalog): number {
    const health = this.#health.get(route.key)
    if (health?.ewmaTtftMs !== undefined) return health.ewmaTtftMs
    return median(catalog
      .filter(candidate => candidate.pool === route.pool)
      .flatMap(candidate => this.#health.get(candidate.key)?.ewmaTtftMs ?? []))
  }

  #score(route: CandidateRoute, poolMaxTtft: number, catalog: readonly CandidateRoute[] = this.#catalog): number {
    const health = this.#health.get(route.key) ?? freshHealth()
    const latency = this.#effectiveTtft(route, catalog) / Math.max(poolMaxTtft, 1)
    const load = health.inFlight / route.concurrencyLimit
    const samples = health.successes + health.failures
    const failure = samples === 0 ? 0 : health.failures / samples
    const exploration = samples === 0 ? -this.policy.explorationWeight : 0
    return route.preferenceMultiplier * (
      this.policy.scoring.latency * latency
      + this.policy.scoring.load * load
      + this.policy.scoring.failure * failure
    ) + exploration
  }

  /**
   * Test whether one compatible route is currently available without changing selection or health state.
   * @param request - capability, pressure, and attempted-route inputs.
   * @param routes - candidate directory to inspect; defaults to the current catalog.
   * @returns whether a closed/half-open route or an eligible cooled probe exists.
   */
  canSelect(request: AutoRouteRequest, routes: readonly CandidateRoute[] = this.#catalog): boolean {
    const compatible = routes.filter(route => route.pool === request.pool && this.#reject(route, request) === undefined)
    if (compatible.some((route) => {
      const health = this.#health.get(route.key) ?? freshHealth()
      return health.circuit === 'closed'
        || (health.circuit === 'half-open'
          && health.halfOpenInFlight + (this.#probeAuthorizations.get(route.key) ?? 0)
            < this.policy.halfOpenConcurrency)
    })) return true
    return compatible.some((route) => {
      const health = this.#health.get(route.key) ?? freshHealth()
      return health.circuit === 'open'
        && request.now >= health.cooldownUntil
        && (this.#probeAuthorizations.get(route.key) ?? 0) + health.halfOpenInFlight < this.policy.halfOpenConcurrency
    })
  }

  /**
   * Select one compatible route without reserving it.
   * @param request - capability, pressure, and attempt inputs.
   * @returns selected route and stable decision metadata.
   */
  select(request: AutoRouteRequest): AutoRouteDecision {
    return this.#select(request, true)
  }

  /**
   * Resolve one route without changing tie rotation or probe authorization.
   * @param request - capability, pressure, and attempted-route inputs.
   * @param routes - candidate directory to inspect; defaults to the current catalog.
   * @returns the selected route and detached decision metadata.
   */
  preview(request: AutoRouteRequest, routes: readonly CandidateRoute[] = this.#catalog): AutoRouteDecision {
    return this.#select(request, false, routes)
  }

  #select(
    request: AutoRouteRequest,
    mutate: boolean,
    catalog: readonly CandidateRoute[] = this.#catalog,
  ): AutoRouteDecision {
    const poolRoutes = catalog.filter(route => route.pool === request.pool)
    const rejections = new Set<Rejection>()
    const compatible = poolRoutes.filter((route) => {
      const rejection = this.#reject(route, request)
      if (rejection !== undefined) rejections.add(rejection)
      return rejection === undefined
    })
    const available = compatible.filter((route) => {
      const health = this.#health.get(route.key) ?? freshHealth()
      return health.circuit === 'closed' || (health.circuit === 'half-open'
        && health.halfOpenInFlight + (this.#probeAuthorizations.get(route.key) ?? 0)
          < this.policy.halfOpenConcurrency)
    })
    let choices = available
    let reason: AutoRouteDecision['reason'] = request.attemptedRoutes.size > 0 ? 'failover' : 'normal'
    if (choices.length === 0 && compatible.length > 0) {
      const cooling = compatible.filter((route) => {
        const health = this.#health.get(route.key) ?? freshHealth()
        return health.circuit === 'open'
          && request.now >= health.cooldownUntil
          && (this.#probeAuthorizations.get(route.key) ?? 0) + health.halfOpenInFlight < this.policy.halfOpenConcurrency
      })
      if (cooling.length > 0) {
        const earliest = cooling.reduce((selected, route) => {
          const selectedUntil = this.#health.get(selected.key)?.cooldownUntil ?? 0
          const routeUntil = this.#health.get(route.key)?.cooldownUntil ?? 0
          return routeUntil < selectedUntil ? route : selected
        })
        choices = [earliest]
        reason = 'probe'
      }
    }
    if (choices.length === 0) {
      const ordered = REJECTION_ORDER.filter(category => rejections.has(category))
      throw new AutoRoutingError(ordered)
    }
    const poolMaxTtft = Math.max(...choices.map(route => this.#effectiveTtft(route, catalog)), 1)
    const scored = choices.map(route => ({ route, score: this.#score(route, poolMaxTtft, catalog) }))
      .toSorted((left, right) => left.score - right.score || left.route.key.localeCompare(right.route.key))
    const best = scored[0]?.score ?? 0
    const tied = scored.filter(entry => Math.abs(entry.score - best) < 1e-12)
    const index = (this.#rotationSeed + this.#rotation) % tied.length
    if (mutate) this.#rotation += 1
    const selected = tied[index]?.route
    if (selected === undefined) throw new AutoRoutingError([])
    if (this.#health.get(selected.key)?.circuit === 'half-open') reason = 'probe'
    if (mutate && reason === 'probe') {
      this.#probeAuthorizations.set(selected.key, (this.#probeAuthorizations.get(selected.key) ?? 0) + 1)
    }
    return { route: selected, reason, candidateCount: compatible.length }
  }

  /**
   * Reserve one route's capacity until exactly one settlement method runs.
   * @param route - route identity selected by this router.
   * @returns single-owner settlement token.
   */
  begin(route: RouteKey): AttemptReservation {
    const health = this.#health.get(route)
    if (health === undefined) throw new Error(`llm-auto-router: unknown route ${route}`)
    const candidate = this.#catalog.find(entry => entry.key === route)
    if (candidate === undefined || health.inFlight >= candidate.concurrencyLimit) {
      throw new Error(`llm-auto-router: route ${route} has no concurrency capacity`)
    }
    if (health.circuit === 'open' || health.circuit === 'half-open') {
      const authorized = this.#probeAuthorizations.get(route) ?? 0
      if (authorized < 1 || health.halfOpenInFlight >= this.policy.halfOpenConcurrency) {
        throw new Error(`llm-auto-router: half-open probe for ${route} was not authorized by select`)
      }
      if (authorized === 1) this.#probeAuthorizations.delete(route)
      else this.#probeAuthorizations.set(route, authorized - 1)
      health.circuit = 'half-open'
    }
    const halfOpen = health.circuit === 'half-open'
    health.inFlight += 1
    if (halfOpen) health.halfOpenInFlight += 1
    const reservation: AttemptReservation = {
      route,
      cancel: () => { this.#settle(reservation) },
    }
    let settled = false
    this.#reservations.set(reservation, () => {
      if (settled) throw new Error(`llm-auto-router: reservation for ${route} already settled`)
      settled = true
      health.inFlight -= 1
      if (halfOpen) health.halfOpenInFlight -= 1
      return health
    })
    return reservation
  }

  #settle(reservation: AttemptReservation): RouteHealth {
    const settle = this.#reservations.get(reservation)
    if (settle === undefined) throw new Error('llm-auto-router: foreign attempt reservation')
    return settle()
  }

  /**
   * Settle a successful attempt and update timing health.
   * @param reservation - outstanding single-owner route reservation.
   * @param sample - non-negative first-token and total latency.
   */
  recordSuccess(reservation: AttemptReservation, sample: SuccessSample): void {
    if (!Number.isFinite(sample.ttftMs) || sample.ttftMs < 0
      || !Number.isFinite(sample.totalLatencyMs) || sample.totalLatencyMs < sample.ttftMs) {
      throw new Error('llm-auto-router: success latency sample is invalid')
    }
    const health = this.#settle(reservation)
    health.ewmaTtftMs = health.ewmaTtftMs === undefined
      ? sample.ttftMs
      : this.policy.ewmaAlpha * sample.ttftMs + (1 - this.policy.ewmaAlpha) * health.ewmaTtftMs
    health.successes += 1
    health.consecutiveFailures = 0
    health.openCount = 0
    health.cooldownUntil = 0
    health.circuit = 'closed'
    this.#probeAuthorizations.delete(reservation.route)
    delete health.lastFailureCode
  }

  /**
   * Settle a provider failure and update circuit health.
   * @param reservation - outstanding single-owner route reservation.
   * @param failure - provider-neutral failure facts.
   */
  recordFailure(reservation: AttemptReservation, failure: RouteFailure): void {
    const health = this.#settle(reservation)
    health.failures += 1
    health.consecutiveFailures += 1
    health.lastFailureCode = failure.code
    if (health.consecutiveFailures < this.policy.failureThreshold) return
    health.openCount += 1
    const exponential = Math.min(
      this.policy.baseCooldownMs * 2 ** Math.min(health.openCount - 1, 30),
      this.policy.maxCooldownMs,
    )
    const requested = failure.providerRetryAfterMs
    const cooldown = requested !== undefined && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, this.policy.maxCooldownMs)
      : exponential
    health.cooldownUntil = this.#now() + cooldown
    health.circuit = 'open'
    this.#probeAuthorizations.delete(reservation.route)
  }

  /**
   * Read detached health and load state without exposing mutable accounting.
   * @returns route status ordered by route identity.
   */
  snapshot(): readonly AutoRouteStatus[] {
    return this.#catalog.map((route) => {
      const health = this.#health.get(route.key) ?? freshHealth()
      const samples = health.successes + health.failures
      return Object.freeze({
        key: route.key,
        inFlight: health.inFlight,
        ...health.ewmaTtftMs === undefined ? {} : { ewmaTtftMs: health.ewmaTtftMs },
        effectiveTtftMs: this.#effectiveTtft(route),
        recentFailureRate: samples === 0 ? 0 : health.failures / samples,
        consecutiveFailures: health.consecutiveFailures,
        sampleCount: samples,
        circuit: health.circuit,
        cooldownUntil: health.cooldownUntil,
        ...health.lastFailureCode === undefined ? {} : { lastFailureCode: health.lastFailureCode },
      })
    })
  }
}
