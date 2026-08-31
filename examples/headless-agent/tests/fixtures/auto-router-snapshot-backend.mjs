/** Deterministic two-route provider backend for the automatic-routing snapshot. */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

const noProviderRetries = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'auto-router-snapshot-backend.retryPolicy')
const requests = []

class AutoRouteSnapshotAdapter extends LlmAdapter {
  constructor(provider, model, outcome) {
    super()
    this.provider = provider
    this.model = model
    this.outcome = outcome
  }

  providerRetryPolicy() {
    return noProviderRetries
  }

  listModels() {
    return Promise.resolve([{
      provider: this.provider,
      id: this.model,
      name: this.model,
      inputModalities: ['text'],
    }])
  }

  resolveModel() {
    return Promise.resolve({
      provider: this.provider,
      id: this.model,
      name: this.model,
      inputModalities: ['text'],
      context: { contextWindow: 16_000 },
      defaultMaxTokens: 256,
    })
  }

  async * stream(options) {
    requests.push(JSON.stringify(options.messages))
    if (requests.length > 2) throw new Error('auto-router snapshot exceeded two physical calls')
    if (requests.length === 2 && requests[1] !== requests[0]) {
      throw new Error('auto-router snapshot changed the model-visible messages')
    }
    if (this.outcome === 'error') {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'route A unavailable', code: 'SERVER' } },
      }
      return
    }
    const text = 'AUTO_ROUTE_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'auto-router-snapshot-backend'
/** Required LLM registry and Agent lifecycle services. */
export const inject = ['agents', 'llm']

/**
 * Register deterministic routes and select Auto through the Agent lifecycle.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying Agent and LLM services.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['route-a'], new AutoRouteSnapshotAdapter('route-a', 'model-a', 'error'))
  ctx.llm.registerAdapter(['route-b'], new AutoRouteSnapshotAdapter('route-b', 'model-b', 'success'))
  ctx.on('agent/created', ({ agent }) => {
    if (!agent.session.events.some(event => event.type === 'model/selection')) {
      agent.session.append('model/selection', { kind: 'auto' })
    }
    installModelSelection(agent.ctx, { current: { kind: 'auto' }, assembled: undefined })
  })
}
