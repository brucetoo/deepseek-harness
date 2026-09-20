/**
 * Service Definition for the owner-scoped public browser capability.
 * @module @deepseek-ai/dsh-browser
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  BrowserElementAction,
  BrowserObservation,
  BrowserOpenRequest,
  BrowserPreparedAction,
  BrowserPreparedActionIdValue,
  BrowserWaitRequest,
} from './types.ts'
import { BrowserError } from './types.ts'

export { BrowserError } from './types.ts'
export type {
  BrowserClickRequest,
  BrowserElementAction,
  BrowserElementFingerprint,
  BrowserElementTarget,
  BrowserFillRequest,
  BrowserObservation,
  BrowserOpenRequest,
  BrowserPreparedAction,
  BrowserSelectRequest,
  BrowserWaitRequest,
} from './types.ts'

/** Opaque identity for a retained element action awaiting commit or release. */
export type BrowserPreparedActionId = BrowserPreparedActionIdValue

/**
 * Brand one provider-issued string as a prepared browser action id.
 * @param value - Raw provider-issued identity.
 * @returns The same string with the prepared-action brand.
 */
export function BrowserPreparedActionId(value: string): BrowserPreparedActionId {
  return value as BrowserPreparedActionId
}

/**
 * Parse one credential-free public-browser URL.
 * @param input - Absolute URL supplied by a caller.
 * @returns Canonical HTTP(S) URL.
 * @throws {@link BrowserError} with `BROWSER_INVALID_URL` for malformed,
 * unsupported, or credential-bearing URLs.
 */
export function parsePublicBrowserUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch (cause: unknown) {
    throw new BrowserError('browser URL must be an absolute HTTP or HTTPS URL', 'BROWSER_INVALID_URL', { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError('browser URL must use HTTP or HTTPS', 'BROWSER_INVALID_URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new BrowserError('browser URL must not contain credentials', 'BROWSER_INVALID_URL')
  }
  return url.href
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/**
 * One visible ephemeral browser owned by an exact live Agent and therefore by
 * its Session. Implementations serialize calls and release ownership only
 * after complete worker and profile cleanup.
 */
export abstract class BrowserRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'browser')
  }

  /**
   * Open a new ephemeral browser after the Consumer obtains approval.
   * @param owner - Exact Agent whose Session owns the browser.
   * @param request - Canonical credential-free HTTP(S) target.
   * @param signal - Cancellation of launch and navigation.
   * @returns Current rendered page observation.
   */
  abstract open(
    owner: Agent,
    request: BrowserOpenRequest,
    signal?: AbortSignal,
  ): Promise<BrowserObservation>

  /**
   * Observe the current page without changing it.
   * @param owner - Exact owning Agent.
   * @param signal - Cancellation of snapshot collection.
   * @returns Current rendered page observation.
   */
  abstract snapshot(owner: Agent, signal?: AbortSignal): Promise<BrowserObservation>

  /**
   * Resolve and retain one exact element without acting on it.
   * @param owner - Exact owning Agent.
   * @param action - Accessible target and requested mutation.
   * @param signal - Cancellation of element resolution.
   * @returns Prepared identity and approval-visible fingerprint.
   */
  abstract prepare(
    owner: Agent,
    action: BrowserElementAction,
    signal?: AbortSignal,
  ): Promise<BrowserPreparedAction>

  /**
   * Recheck and commit a previously prepared element action exactly once.
   * @param owner - Exact owning Agent.
   * @param id - Provider-issued prepared action identity.
   * @param signal - Cancellation of action and resulting observation.
   * @returns Current rendered page observation.
   */
  abstract commit(
    owner: Agent,
    id: BrowserPreparedActionId,
    signal?: AbortSignal,
  ): Promise<BrowserObservation>

  /**
   * Release one prepared action without executing it. Implementations make
   * repeated release harmless so every fail-closed path can converge here.
   * @param owner - Exact owning Agent.
   * @param id - Provider-issued prepared action identity.
   */
  abstract release(owner: Agent, id: BrowserPreparedActionId): Promise<void>

  /**
   * Wait for a bounded interval, then observe the current page.
   * @param owner - Exact owning Agent.
   * @param request - Duration selected by the Consumer within its configured cap.
   * @param signal - Cancellation of the wait.
   * @returns Current rendered page observation.
   */
  abstract wait(
    owner: Agent,
    request: BrowserWaitRequest,
    signal?: AbortSignal,
  ): Promise<BrowserObservation>

  /**
   * Close the owner's browser and await worker and profile quiescence.
   * @param owner - Exact owning Agent.
   */
  abstract close(owner: Agent): Promise<void>
}

export default BrowserRuntime
