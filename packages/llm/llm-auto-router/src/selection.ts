/** Durable logical model-selection projection. */

import type { ModelSelectionIntent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

interface ModelSelectionEvent {
  readonly type: 'model/selection'
  readonly data: ModelSelectionIntent
}

/**
 * Fold the latest accepted logical model selection from session history.
 * @param events - Session events in append order.
 * @param fallback - Intent used when the history has no selection event.
 * @returns a detached latest intent or fallback, or `undefined` when neither exists.
 */
export function foldModelSelectionIntent(
  events: readonly SessionEvent[],
  fallback?: ModelSelectionIntent,
): ModelSelectionIntent | undefined {
  const event = events.findLast(candidate => (candidate as { type: string }).type === 'model/selection')
  const intent = (event as unknown as ModelSelectionEvent | undefined)?.data ?? fallback
  return intent === undefined ? undefined : { ...intent }
}
