/** Non-buffering stream observation and attempt settlement. */

import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { CONTEXT_WINDOW_EXCEEDED_CODE, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Attempts, type AutoRouteAttempt } from './attempts.ts'
import { AutoRoutingError } from './policy.ts'
import type { AutoModelRouter } from './policy.ts'

const isFirstToken = (chunk: StreamChunk): boolean => {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': return chunk.text.length > 0
    case 'tool-call-delta': return chunk.name !== undefined || chunk.argumentsDelta.length > 0
    default: return false
  }
}

const commitsOutput = (chunk: StreamChunk): boolean =>
  chunk.type === 'block-end'
  || chunk.type === 'tool-call-delta'
  || ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)

/**
 * Forward chunks immediately while recording commitment, TTFT, and terminal health.
 * Wrapper throws, incomplete streams, and aborted finishes release capacity without penalty.
 * @param attempt - matching unsettled automatic route attempt.
 * @param router - process-global route health owner.
 * @param source - delegated physical stream.
 * @param now - monotonic-enough millisecond clock.
 * @returns the same chunks in source order without buffering.
 */
/** Inputs for one `agent/request-error` decision. */
export interface AttemptRecovery {
  readonly agent: Agent
  readonly attempt: AutoRouteAttempt
  readonly failureCode: string
  readonly maxFailovers: number
  readonly hasAlternative: () => Promise<boolean>
  readonly appendFailover: () => void
  readonly attempts: Attempts
  readonly next: () => Promise<RequestErrorAction>
}

/**
 * Own only safe uncommitted cross-route failover and pin delegated retries.
 * @param recovery - failed attempt, policy checks, durable append, and downstream waterfall.
 * @returns retry only when this router or a downstream listener owns recovery.
 */
export async function recoverAttempt(recovery: AttemptRecovery): Promise<RequestErrorAction> {
  let hasAlternative = false
  if (recovery.failureCode !== CONTEXT_WINDOW_EXCEEDED_CODE
    && !recovery.attempt.committed
    && recovery.attempt.attempt <= recovery.maxFailovers) {
    try {
      hasAlternative = await recovery.hasAlternative()
    } catch (error: unknown) {
      if (!(error instanceof AutoRoutingError)) throw error
    }
  }
  const canFailover = hasAlternative
  if (canFailover) {
    recovery.appendFailover()
    return { kind: 'retry' }
  }
  const action = await recovery.next()
  if (action?.kind === 'retry') recovery.attempts.pinRetry(recovery.attempt)
  return action
}

export async function* observeAttemptStream(
  attempt: AutoRouteAttempt,
  router: AutoModelRouter,
  source: AsyncIterable<StreamChunk>,
  now: () => number = Date.now,
  enter: () => void = () => {},
  abandon: () => void = () => {
    attempt.reservation.cancel()
    attempt.settled = true
  },
): AsyncIterable<StreamChunk> {
  attempt.startedAt = now()
  let iterator: AsyncIterator<StreamChunk>
  try {
    iterator = source[Symbol.asyncIterator]()
  } catch (error: unknown) {
    abandon()
    throw error
  }
  let current: IteratorResult<StreamChunk>
  try {
    current = await iterator.next()
  } catch (error: unknown) {
    abandon()
    throw error
  }
  enter()
  let terminal = false
  try {
    while (!current.done) {
      const chunk = current.value
      if (attempt.ttftAt === undefined && isFirstToken(chunk)) attempt.ttftAt = now()
      if (commitsOutput(chunk)) attempt.committed = true
      if (chunk.type === 'finish') {
        terminal = true
        if (chunk.reason.kind === 'error') {
          router.recordFailure(attempt.reservation, chunk.reason.failure)
          attempt.settled = true
        } else if (chunk.reason.kind === 'aborted') {
          attempt.reservation.cancel()
          attempt.settled = true
        } else {
          const finishedAt = now()
          const startedAt = attempt.startedAt
          const ttftAt = attempt.ttftAt ?? finishedAt
          router.recordSuccess(attempt.reservation, {
            ttftMs: ttftAt - startedAt,
            totalLatencyMs: finishedAt - startedAt,
          })
          attempt.settled = true
        }
      }
      yield chunk
      current = await iterator.next()
    }
  } finally {
    if (!terminal && !attempt.settled) {
      attempt.reservation.cancel()
      attempt.settled = true
    }
    await iterator.return?.()
  }
}
