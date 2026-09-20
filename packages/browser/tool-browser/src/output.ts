/** Bounded model-facing projection of browser observations. */

import type { BrowserObservation } from '@deepseek-ai/dsh-browser'

/** Canonical bounded value returned by every observing browser tool. */
export interface BrowserToolObservation {
  readonly url: string
  readonly title: string
  readonly snapshot: string
  readonly truncated: boolean
}

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const encoded = Buffer.from(value)
  if (encoded.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true })
        .decode(encoded.subarray(0, end))
    } catch {
      end -= 1
    }
  }
  return ''
}

/**
 * Render one canonical browser observation for the model.
 * @param value - Bounded structured observation.
 * @returns Stable text with URL, title, truncation, and ARIA state.
 */
export const formatBrowserObservation = (
  value: BrowserToolObservation,
): string =>
  `URL: ${value.url}\nTitle: ${value.title}\nTruncated: ${value.truncated ? 'yes' : 'no'}\n\nARIA snapshot:\n${value.snapshot}`

/**
 * Bound a complete rendered observation by UTF-8 bytes while retaining every
 * required header.
 * @param observation - Provider observation.
 * @param maxBytes - Complete rendered-result byte cap.
 * @returns Bounded canonical observation.
 */
export const projectBrowserObservation = (
  observation: BrowserObservation,
  maxBytes: number,
): BrowserToolObservation => {
  const unchanged: BrowserToolObservation = {
    ...observation,
    truncated: false,
  }
  if (Buffer.byteLength(formatBrowserObservation(unchanged)) <= maxBytes) {
    return unchanged
  }

  const fieldBudget = Math.max(1, Math.floor((maxBytes - 64) / 4))
  const url = truncateUtf8(observation.url, fieldBudget)
  const title = truncateUtf8(observation.title, fieldBudget)
  const empty: BrowserToolObservation = {
    url,
    title,
    snapshot: '',
    truncated: true,
  }
  const remaining = Math.max(
    0,
    maxBytes - Buffer.byteLength(formatBrowserObservation(empty)),
  )
  return {
    ...empty,
    snapshot: truncateUtf8(observation.snapshot, remaining),
  }
}
