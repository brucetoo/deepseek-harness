/** Candidate discovery and per-request automatic physical routing. */

import type { Agent, AutoModelSelection, ModelSelection, ModelSelectionIntent } from '@deepseek-ai/dsh-agent'
import { contentHasImage, type LlmCallConfig, type LlmModelInfo, type LlmResolvedModelInfo, type ModelModality } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, type EpochHeader, type Session } from '@deepseek-ai/dsh-session'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import { RouteKey } from './brand.ts'
import { buildCandidateCatalog } from './catalog.ts'
import type { AutoRouteAttempt } from './attempts.ts'
import { Attempts } from './attempts.ts'
import { AutoModelRouter, AutoRoutingError } from './policy.ts'
import type { AutoRouteDecision, AutoRouterPolicy, CandidateRoute } from './types.ts'

interface LlmDirectory {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

interface RoutingDependencies {
  readonly llm: LlmDirectory
  readonly tokenMeter: Pick<TokenMeter, 'measure'>
}

/** Inputs captured from the prepended `agent/request` listener. */
export interface RouteResolution {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
  readonly intent: ModelSelectionIntent | undefined
  readonly proposal: LlmCallConfig
}

/** Stable failure when no provider directory can be read. */
export class AutoCatalogError extends Error {
  /** Stable machine-routing code. */
  readonly code = 'AUTO_CATALOG_UNAVAILABLE'

  constructor() {
    super('AUTO_CATALOG_UNAVAILABLE: every provider catalog failed')
    this.name = 'AutoCatalogError'
  }
}

function candidate(info: LlmResolvedModelInfo): CandidateRoute {
  return {
    key: RouteKey(`${info.provider}/${info.id}`),
    provider: info.provider,
    model: info.id,
    advertised: true,
    enabled: true,
    pool: 'default',
    preferenceMultiplier: 1,
    concurrencyLimit: Number.MAX_SAFE_INTEGER,
    ...info.inputModalities === undefined ? {} : { inputModalities: info.inputModalities },
    ...info.context === undefined ? {} : { contextWindow: info.context.contextWindow },
    ...info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens },
    ...info.reasoning === undefined ? {} : { reasoningEfforts: info.reasoning.efforts.map(effort => effort.id) },
  }
}

function requiredModalities(session: Session): readonly ModelModality[] {
  const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  return messages.some(message => contentHasImage(message.content)) ? ['text', 'image'] : ['text']
}

function candidateConfig(proposal: LlmCallConfig, route: CandidateRoute): LlmCallConfig {
  const { reasoningEffort: _inheritedEffort, ...controls } = proposal
  return { ...controls, provider: route.provider, model: route.model }
}

/** Owns cached exact-model discovery and request-time route reservations. */
export class Routing {
  #catalog: Promise<readonly CandidateRoute[]> | undefined

  constructor(
    readonly dependencies: RoutingDependencies,
    readonly policy: AutoRouterPolicy,
    readonly router: AutoModelRouter,
    readonly attempts: Attempts,
  ) {}

  /** Invalidate discovery after `llm/adapters-updated`. */
  invalidateCatalog(): void {
    this.#catalog = undefined
  }

  async #discover(signal: AbortSignal): Promise<readonly CandidateRoute[]> {
    const providers = this.dependencies.llm.listProviders()
      .filter(provider => provider.id !== this.policy.virtualProvider)
    const listed = await Promise.allSettled(providers.map(async provider => ({
      provider: provider.id,
      models: await this.dependencies.llm.listModels(provider.id),
    })))
    const successful = listed.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (providers.length > 0 && successful.length === 0 && this.policy.models.length === 0) {
      throw new AutoCatalogError()
    }
    const advertisedResults = await Promise.allSettled(successful.flatMap(({ provider, models }) =>
      models.map(async model => candidate(await this.dependencies.llm.resolveModelInfo(provider, model.id, signal)))))
    if (signal.aborted) signal.throwIfAborted()
    const advertised = advertisedResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (advertisedResults.length > 0 && advertised.length === 0 && this.policy.models.length === 0) {
      throw new AutoCatalogError()
    }
    const explicitKeys = new Set(advertised.map(route => route.key))
    const explicit = await Promise.all(this.policy.models
      .filter(model => !explicitKeys.has(model.route))
      .map(async (model) => {
        const separator = model.route.indexOf('/')
        const provider = model.route.slice(0, separator)
        const routeModel = model.route.slice(separator + 1)
        return candidate(await this.dependencies.llm.resolveModelInfo(provider, routeModel, signal))
      }))
    return buildCandidateCatalog([...advertised, ...explicit], this.policy.pools, this.policy.models)
  }

  async #candidates(signal: AbortSignal): Promise<readonly CandidateRoute[]> {
    this.#catalog ??= this.#discover(signal).catch((error: unknown) => {
      this.#catalog = undefined
      throw error
    })
    return this.#catalog
  }

  /**
   * Resolve a logical Auto proposal to one reserved physical route.
   * @param input - current Agent request and assembled logical intent.
   * @returns the unchanged concrete proposal or selected physical config.
   */
  async resolve(input: RouteResolution): Promise<LlmCallConfig> {
    if (input.intent?.kind !== 'auto') return input.proposal
    const routes = await this.#candidates(input.signal)
    const pool = input.intent.pool ?? 'default'
    const pin = this.attempts.peekPin(input.agent, input.turn, input.step)
    let decision
    if (pin === undefined) {
      const attemptedRoutes = this.attempts.attemptedRoutes(input.agent, input.turn, input.step)
      const estimatedInputTokensByRoute = new Map(routes.map((route) => {
        const header = this.#header(input.agent.session, candidateConfig(input.proposal, route))
        return [route.key, this.dependencies.tokenMeter.measure(input.agent.session, header).totalTokens] as const
      }))
      this.router.replaceCatalog(routes)
      decision = this.router.select({
        pool,
        requiredModalities: requiredModalities(input.agent.session),
        estimatedInputTokens: 0,
        estimatedInputTokensByRoute,
        ...input.proposal.maxTokens === undefined ? {} : { requestedMaxTokens: input.proposal.maxTokens },
        attemptedRoutes,
        now: Date.now(),
      })
    } else {
      this.router.replaceCatalog(routes)
      const route = routes.find(candidateRoute => candidateRoute.key === pin)
      if (route === undefined) throw new Error(`llm-auto-router: pinned route ${pin} left the catalog`)
      decision = { route, reason: 'failover' as const, candidateCount: 1 }
    }
    const reservation = this.router.begin(decision.route.key)
    try {
      this.attempts.begin(input.agent, input.turn, input.step, pool, decision, reservation)
      if (pin !== undefined) this.attempts.commitPin(input.agent, input.turn, input.step, pin)
    } catch (error: unknown) {
      reservation.cancel()
      throw error
    }
    return candidateConfig(input.proposal, decision.route)
  }

  #header(session: Session, config: LlmCallConfig): EpochHeader {
    const current = session.requestHeader()
    return canonicalHeader({
      config,
      ...current?.system === undefined ? {} : { system: current.system },
      ...current?.tools === undefined ? {} : { tools: current.tools },
    })
  }

  /** Reject an unknown configured pool without consulting provider state. */
  validatePool(pool = 'default'): void {
    if (this.policy.pools[pool] === undefined) throw new Error(`llm-auto-router: unknown pool ${pool}`)
  }

  async #decision(input: {
    agent: Agent
    selection: AutoModelSelection
    requiredModalities: readonly ModelModality[]
    signal: AbortSignal
  }): Promise<AutoRouteDecision> {
    const routes = await this.#candidates(input.signal)
    const pool = input.selection.pool ?? 'default'
    this.validatePool(pool)
    const estimatedInputTokensByRoute = new Map(routes.map((route) => {
      const config = { provider: route.provider, model: route.model }
      return [route.key, this.dependencies.tokenMeter.measure(
        input.agent.session,
        this.#header(input.agent.session, config),
      ).totalTokens] as const
    }))
    return this.router.preview({
      pool,
      requiredModalities: input.requiredModalities,
      estimatedInputTokens: 0,
      estimatedInputTokensByRoute,
      attemptedRoutes: new Set(),
      now: Date.now(),
    }, routes)
  }

  /** Test current admission eligibility without reserving or mutating health. */
  async routable(input: {
    agent: Agent
    selection: AutoModelSelection
    requiredModalities: readonly ModelModality[]
  }): Promise<boolean> {
    this.validatePool(input.selection.pool)
    const signal = new AbortController().signal
    try {
      const routes = await this.#candidates(signal)
      const pool = input.selection.pool ?? 'default'
      const estimatedInputTokensByRoute = new Map(routes.map((route) => {
        const config = { provider: route.provider, model: route.model }
        return [route.key, this.dependencies.tokenMeter.measure(
          input.agent.session,
          this.#header(input.agent.session, config),
        ).totalTokens] as const
      }))
      return this.router.canSelect({
        pool,
        requiredModalities: input.requiredModalities,
        estimatedInputTokens: 0,
        estimatedInputTokensByRoute,
        attemptedRoutes: new Set(),
        now: Date.now(),
      }, routes)
    } catch (error: unknown) {
      if (error instanceof AutoRoutingError) return false
      throw error
    }
  }

  /** Resolve one concrete admission candidate without reservation, pins, or health updates. */
  async preflight(input: {
    agent: Agent
    selection: AutoModelSelection
    requiredModalities: readonly ModelModality[]
    signal: AbortSignal
  }): Promise<ModelSelection> {
    const decision = await this.#decision(input)
    return { kind: 'model', provider: decision.route.provider, model: decision.route.model }
  }

  /** Release outstanding state for one disposed Agent. */
  release(agent: Agent): void {
    this.attempts.disposeAgent(agent)
  }

  /** Read the newest unsettled attempt matching a loop-built physical request. */
  matchPhysical(agent: Agent, provider: string, model: string): AutoRouteAttempt | undefined {
    return this.attempts.matchPhysical(agent, provider, model)
  }

  /** Read the latest matching attempt for stream and recovery listeners. */
  match(agent: Agent, turn: number, step: number, provider: string, model: string): AutoRouteAttempt | undefined {
    return this.attempts.match(agent, turn, step, provider, model)
  }

  /** Test whether another compatible, unattempted route exists without reserving or changing policy state. */
  async canFailover(input: RouteResolution): Promise<boolean> {
    const routes = await this.#candidates(input.signal)
    const attempted = this.attempts.attemptedRoutes(input.agent, input.turn, input.step)
    const pool = input.intent?.kind === 'auto' ? input.intent.pool ?? 'default' : 'default'
    const estimatedInputTokensByRoute = new Map(routes.map((route) => {
      const header = this.#header(input.agent.session, candidateConfig(input.proposal, route))
      return [route.key, this.dependencies.tokenMeter.measure(input.agent.session, header).totalTokens] as const
    }))
    return this.router.canSelect({
      pool,
      requiredModalities: requiredModalities(input.agent.session),
      estimatedInputTokens: 0,
      estimatedInputTokensByRoute,
      ...input.proposal.maxTokens === undefined ? {} : { requestedMaxTokens: input.proposal.maxTokens },
      attemptedRoutes: attempted,
      now: Date.now(),
    }, routes)
  }
}
