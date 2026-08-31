import { describe, expect, it, vi } from 'vitest'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { Attempts, type AutoRouteAttempt } from '../src/attempts.ts'
import { AutoRouteAttemptId, RouteKey } from '../src/brand.ts'
import { AutoRoutingError } from '../src/policy.ts'
import { recoverAttempt } from '../src/stream.ts'

function attempt(patch: Partial<AutoRouteAttempt> = {}): AutoRouteAttempt {
  return {
    id: AutoRouteAttemptId('attempt-1'), turn: 1, step: 1, attempt: 1, pool: 'default',
    route: { key: RouteKey('a/m'), provider: 'a', model: 'm' },
    reason: 'normal', candidateCount: 2,
    reservation: { route: RouteKey('a/m'), cancel() {} },
    committed: false, dispatched: true, settled: true,
    ...patch,
  }
}

describe('recoverAttempt', () => {
  it('owns an uncommitted cross-route retry within budget', async () => {
    const appendFailover = vi.fn()
    const next = vi.fn<() => Promise<RequestErrorAction>>()
    await expect(recoverAttempt({
      agent: {} as Agent, attempt: attempt(), failureCode: 'RATE_LIMIT', maxFailovers: 2,
      hasAlternative: () => Promise.resolve(true), appendFailover, attempts: new Attempts(), next,
    })).resolves.toEqual({ kind: 'retry' })
    expect(appendFailover).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    ['context overflow', attempt(), 'CONTEXT_WINDOW_EXCEEDED', 2, true],
    ['committed output', attempt({ committed: true }), 'RATE_LIMIT', 2, true],
    ['exhausted budget', attempt({ attempt: 3 }), 'RATE_LIMIT', 2, true],
    ['no alternative', attempt(), 'RATE_LIMIT', 2, false],
  ])('delegates %s and pins a downstream retry', async (_case, failed, failureCode, maxFailovers, alternative) => {
    const pin = vi.fn()
    const attempts = { pinRetry: pin } as unknown as Attempts
    const appendFailover = vi.fn()
    const next = vi.fn(async () => ({ kind: 'retry' as const }))
    await expect(recoverAttempt({
      agent: {} as Agent, attempt: failed, failureCode, maxFailovers,
      hasAlternative: () => Promise.resolve(alternative), appendFailover, attempts, next,
    })).resolves.toEqual({ kind: 'retry' })
    expect(appendFailover).not.toHaveBeenCalled()
    expect(pin).toHaveBeenCalledWith(failed)
  })

  it('treats only no-candidate routing errors as no alternative', async () => {
    const next = vi.fn(async () => undefined)
    await expect(recoverAttempt({
      agent: {} as Agent, attempt: attempt(), failureCode: 'ERR', maxFailovers: 2,
      hasAlternative: () => Promise.reject(new AutoRoutingError(['attempted'])),
      appendFailover() {}, attempts: new Attempts(), next,
    })).resolves.toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it('propagates infrastructure failures while checking alternatives', async () => {
    await expect(recoverAttempt({
      agent: {} as Agent, attempt: attempt(), failureCode: 'ERR', maxFailovers: 2,
      hasAlternative: () => Promise.reject(new Error('catalog infrastructure failed')),
      appendFailover() {}, attempts: new Attempts(), next: () => Promise.resolve(undefined),
    })).rejects.toThrow('catalog infrastructure failed')
  })

  it('does not pin when downstream declines recovery', async () => {
    const pin = vi.fn()
    const attempts = { pinRetry: pin } as unknown as Attempts
    await expect(recoverAttempt({
      agent: {} as Agent, attempt: attempt({ committed: true }), failureCode: 'ERR', maxFailovers: 2,
      hasAlternative: () => Promise.resolve(true), appendFailover() {}, attempts,
      next: () => Promise.resolve(undefined),
    })).resolves.toBeUndefined()
    expect(pin).not.toHaveBeenCalled()
  })
})
