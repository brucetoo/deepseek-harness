import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Attempts } from '../src/attempts.ts'
import { RouteKey } from '../src/brand.ts'
import { AutoModelRouter } from '../src/policy.ts'
import { observeAttemptStream } from '../src/stream.ts'
import type { AutoRouterPolicy, CandidateRoute } from '../src/types.ts'

const policy: AutoRouterPolicy = {
  virtualProvider: 'auto', virtualModel: 'auto', pools: { default: { include: ['*/*'], exclude: [] } }, models: [],
  maxFailoversPerStep: 2, tokenSafetyReserve: 0, ewmaAlpha: 0.5, failureThreshold: 1,
  baseCooldownMs: 10, maxCooldownMs: 100, halfOpenConcurrency: 1, explorationWeight: 0,
  scoring: { latency: 1, load: 0, failure: 0 },
}
const route: CandidateRoute = {
  key: RouteKey('p/m'), provider: 'p', model: 'm', advertised: true, enabled: true, pool: 'default',
  preferenceMultiplier: 1, concurrencyLimit: 1, inputModalities: ['text'], contextWindow: 1000, defaultMaxTokens: 100,
}
function fixture() {
  let now = 10
  const router = new AutoModelRouter(policy, { now: () => now })
  router.replaceCatalog([route])
  const attempt = new Attempts().begin({} as Agent, 1, 1, 'default',
    { route, reason: 'normal', candidateCount: 1 }, router.begin(route.key))
  return { router, attempt, now: () => now, advance: (delta: number) => { now += delta } }
}
async function* chunks(values: readonly StreamChunk[], advance: () => void) {
  for (const value of values) { advance(); yield value }
}
async function drain(stream: AsyncIterable<StreamChunk>) { for await (const _chunk of stream) { /* drain */ } }

describe('observeAttemptStream', () => {
  it('uses the first nonempty content delta for TTFT and successful terminal finish for health', async () => {
    const { router, attempt, now, advance } = fixture()
    const values: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '' },
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    await drain(observeAttemptStream(attempt, router, chunks(values, () => { advance(5) }), now))
    expect(attempt).toMatchObject({ committed: true, settled: true, startedAt: 10, ttftAt: 25 })
    expect(router.snapshot()[0]).toMatchObject({ inFlight: 0, sampleCount: 1, ewmaTtftMs: 15 })
  })

  it.each([
    [{ type: 'reasoning-delta', index: 0, text: 'r' }],
    [{ type: 'tool-call-delta', index: 0, id: CallId('c'), argumentsDelta: '' }],
    [{ type: 'block-end', index: 0, block: { type: 'text', text: '' } }],
  ] satisfies readonly [StreamChunk][])('marks commitment for %o', async (committing) => {
    const { router, attempt, now } = fixture()
    await drain(observeAttemptStream(attempt, router, chunks([
      committing, { type: 'finish', reason: { kind: 'error', failure: { code: 'ERR', message: 'bad' } } },
    ], () => {}), now))
    expect(attempt.committed).toBe(true)
  })

  it('penalizes only terminal provider errors', async () => {
    const { router, attempt, now } = fixture()
    await drain(observeAttemptStream(attempt, router, chunks([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'ERR', message: 'bad' } } },
    ], () => {}), now))
    expect(router.snapshot()[0]).toMatchObject({ inFlight: 0, sampleCount: 1, lastFailureCode: 'ERR' })
  })

  it('releases aborted and thrown streams without a health penalty', async () => {
    const aborted = fixture()
    await drain(observeAttemptStream(aborted.attempt, aborted.router, chunks([
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stop' } } },
    ], () => {}), aborted.now))
    expect(aborted.router.snapshot()[0]).toMatchObject({ inFlight: 0, sampleCount: 0 })

    const thrown = fixture()
    const source = (async function* (): AsyncIterable<StreamChunk> { throw new Error('wrapper') })()
    await expect(drain(observeAttemptStream(thrown.attempt, thrown.router, source, thrown.now))).rejects.toThrow('wrapper')
    expect(thrown.router.snapshot()[0]).toMatchObject({ inFlight: 0, sampleCount: 0 })
  })
})
