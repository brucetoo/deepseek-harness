/**
 * Provider-neutral vocabulary for one owner-scoped public browser.
 * @module @deepseek-ai/dsh-browser/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Internal basis for one provider-issued prepared action identity. */
export type BrowserPreparedActionIdValue = Branded<'BrowserPreparedActionId'>

/** The current rendered page state returned after every successful operation. */
export interface BrowserObservation {
  /** Final top-level HTTP(S) URL. */
  readonly url: string
  /** Current document title. */
  readonly title: string
  /** Bounded-depth Playwright ARIA snapshot. */
  readonly snapshot: string
}

/** Accessible identity supplied by a model-facing Consumer. */
export interface BrowserElementTarget {
  /** ARIA role accepted by Playwright's role locator. */
  readonly role: string
  /** Exact accessible name. */
  readonly name: string
  /** Zero-based match within the exact role/name result set. */
  readonly index?: number
}

/** Click one accessible element. */
export interface BrowserClickRequest {
  readonly kind: 'click'
  readonly target: BrowserElementTarget
}

/** Replace one ordinary editable control's complete value. */
export interface BrowserFillRequest {
  readonly kind: 'fill'
  readonly target: BrowserElementTarget
  readonly value: string
}

/** Select one option by its visible label or value. */
export interface BrowserSelectRequest {
  readonly kind: 'select'
  readonly target: BrowserElementTarget
  readonly option: string
}

/** One element action that requires prepare, approval, then commit. */
export type BrowserElementAction =
  | BrowserClickRequest
  | BrowserFillRequest
  | BrowserSelectRequest

/** Observable element fields rechecked immediately before commit. */
export interface BrowserElementFingerprint {
  readonly tagName: string
  readonly role: string
  readonly accessibleName: string
  readonly inputType?: string
  readonly href?: string
  readonly formAction?: string
}

/**
 * Provider-issued description of one exact element retained for approval.
 * The provider owns the live element handle associated with {@link id}.
 */
export interface BrowserPreparedAction {
  readonly id: BrowserPreparedActionIdValue
  readonly owner: Agent
  readonly pageUrl: string
  readonly action: BrowserElementAction
  readonly fingerprint: BrowserElementFingerprint
}

/** Request to open a fresh ephemeral public browser. */
export interface BrowserOpenRequest {
  readonly url: string
}

/** Request to wait before observing the current page again. */
export interface BrowserWaitRequest {
  readonly durationMs: number
}

/**
 * Browser failure with a stable open-string code. Consumers must tolerate
 * provider-specific codes in addition to shared `BROWSER_*` failures.
 */
export class BrowserError extends HarnessError {}
