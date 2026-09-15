/** Playwright page adapter for accessible public-browser operations. */

import type {
  Browser,
  ElementHandle,
  Locator,
  Page,
} from 'playwright-core'
import { chromium } from 'playwright-core'
import {
  BrowserError,
  type BrowserElementAction,
  type BrowserElementFingerprint,
  type BrowserElementTarget,
  type BrowserObservation,
} from '@deepseek-ai/dsh-browser'
import type {
  BrowserDriver,
  BrowserDriverPreparedAction,
} from './types.ts'

type HtmlElementHandle = ElementHandle<HTMLElement | SVGElement>
type ConnectOverCdp = (
  endpoint: string,
  options: { readonly timeout: number },
) => Promise<Browser>

interface DomFingerprint {
  readonly tagName: string
  readonly inputType?: string
  readonly href?: string
  readonly formAction?: string
}

const operationError = (cause: unknown): Error =>
  cause instanceof Error
    ? cause
    : new Error('browser operation failed', { cause })

const abortable = async <T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  signal?.throwIfAborted()
  if (signal === undefined) return operation
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(operationError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(operationError(error))
      },
    )
  })
}

const inspectElement = (element: HtmlElementHandle): Promise<DomFingerprint> =>
  element.evaluate((node) => {
    const absolute = (value: string | null): string | undefined => {
      if (value === null || value === '') return undefined
      return new URL(value, node.ownerDocument.baseURI).href
    }
    const tagName = node.tagName.toLowerCase()
    const inputType = node instanceof HTMLInputElement
      ? node.type.toLowerCase()
      : undefined
    const href = node instanceof HTMLAnchorElement
      ? absolute(node.getAttribute('href'))
      : undefined
    const form = node instanceof HTMLButtonElement || node instanceof HTMLInputElement
      ? node.form
      : undefined
    const ownFormAction = node instanceof HTMLButtonElement || node instanceof HTMLInputElement
      ? node.getAttribute('formaction')
      : null
    const formAction = absolute(ownFormAction ?? form?.getAttribute('action') ?? null)
    return {
      tagName,
      ...inputType === undefined ? {} : { inputType },
      ...href === undefined ? {} : { href },
      ...formAction === undefined ? {} : { formAction },
    }
  })

const completeFingerprint = (
  target: BrowserElementTarget,
  dom: DomFingerprint,
): BrowserElementFingerprint => ({
  tagName: dom.tagName,
  role: target.role,
  accessibleName: target.name,
  ...dom.inputType === undefined ? {} : { inputType: dom.inputType },
  ...dom.href === undefined ? {} : { href: dom.href },
  ...dom.formAction === undefined ? {} : { formAction: dom.formAction },
})

const fingerprintsEqual = (
  left: BrowserElementFingerprint,
  right: BrowserElementFingerprint,
): boolean =>
  left.tagName === right.tagName
  && left.role === right.role
  && left.accessibleName === right.accessibleName
  && left.inputType === right.inputType
  && left.href === right.href
  && left.formAction === right.formAction

const validateTarget = (target: BrowserElementTarget): void => {
  if (target.role.length === 0 || target.name.length === 0) {
    throw new BrowserError('browser target role and name must be non-empty', 'BROWSER_INVALID_TARGET')
  }
  if (
    target.index !== undefined
    && (!Number.isInteger(target.index) || target.index < 0)
  ) {
    throw new BrowserError('browser target index must be a non-negative integer', 'BROWSER_INVALID_TARGET')
  }
}

/** Playwright implementation over exactly one connected Electron page. */
export class PlaywrightBrowserDriver implements BrowserDriver {
  private closed = false

  constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly operationTimeoutMs: number,
    private readonly snapshotDepth: number,
  ) {}

  /** @inheritdoc */
  async goto(url: string, signal?: AbortSignal): Promise<BrowserObservation> {
    await abortable(this.page.goto(url, {
      timeout: this.operationTimeoutMs,
      waitUntil: 'domcontentloaded',
    }), signal)
    return this.snapshot(signal)
  }

  /** @inheritdoc */
  async snapshot(signal?: AbortSignal): Promise<BrowserObservation> {
    const [title, snapshot] = await abortable(Promise.all([
      this.page.title(),
      this.page.locator('body').ariaSnapshot({
        boxes: false,
        depth: this.snapshotDepth,
        mode: 'ai',
        timeout: this.operationTimeoutMs,
      }),
    ]), signal)
    return {
      url: this.page.url(),
      title,
      snapshot,
    }
  }

  /** @inheritdoc */
  async prepare(
    action: BrowserElementAction,
    signal?: AbortSignal,
  ): Promise<BrowserDriverPreparedAction> {
    validateTarget(action.target)
    const role = action.target.role as Parameters<Page['getByRole']>[0]
    const matches = this.page.getByRole(role, {
      name: action.target.name,
      exact: true,
    })
    const count = await abortable(matches.count(), signal)
    const index = action.target.index ?? 0
    if (count === 0 || index >= count) {
      throw new BrowserError('browser target was not found', 'BROWSER_TARGET_MISSING')
    }
    if (action.target.index === undefined && count !== 1) {
      throw new BrowserError(
        'browser target matches more than one element; supply an index',
        'BROWSER_TARGET_AMBIGUOUS',
      )
    }
    const element = await abortable(
      matches.nth(index).elementHandle({ timeout: this.operationTimeoutMs }),
      signal,
    )
    if (element === null) {
      throw new BrowserError('browser target detached before preparation', 'BROWSER_TARGET_CHANGED')
    }
    const handle = element
    const fingerprint = completeFingerprint(
      action.target,
      await abortable(inspectElement(handle), signal),
    )
    if (fingerprint.inputType === 'password') {
      await handle.dispose()
      throw new BrowserError('password controls are not supported', 'BROWSER_PASSWORD_CONTROL')
    }
    if (fingerprint.inputType === 'file') {
      await handle.dispose()
      throw new BrowserError('file chooser controls are not supported', 'BROWSER_FILE_CONTROL')
    }
    return this.preparedAction(handle, action, fingerprint, matches)
  }

  /** @inheritdoc */
  async wait(durationMs: number, signal?: AbortSignal): Promise<BrowserObservation> {
    await abortable(this.page.waitForTimeout(durationMs), signal)
    return this.snapshot(signal)
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.browser.close()
  }

  private preparedAction(
    element: HtmlElementHandle,
    action: BrowserElementAction,
    fingerprint: BrowserElementFingerprint,
    matches: Locator,
  ): BrowserDriverPreparedAction {
    return {
      fingerprint,
      commit: async (signal?: AbortSignal) => {
        const connected = await abortable(
          element.evaluate(node => node.isConnected),
          signal,
        )
        if (!connected) {
          throw new BrowserError('prepared browser target detached', 'BROWSER_TARGET_CHANGED')
        }
        const current = completeFingerprint(
          action.target,
          await abortable(inspectElement(element), signal),
        )
        const matchesIdentity = await abortable(
          matches.evaluateAll((nodes, retained) => nodes.includes(retained), element),
          signal,
        )
        if (!matchesIdentity || !fingerprintsEqual(fingerprint, current)) {
          throw new BrowserError('prepared browser target changed', 'BROWSER_TARGET_CHANGED')
        }
        switch (action.kind) {
          case 'click':
            await abortable(element.click({ timeout: this.operationTimeoutMs }), signal)
            break
          case 'fill':
            await abortable(element.fill(action.value, { timeout: this.operationTimeoutMs }), signal)
            break
          case 'select':
            await abortable(element.selectOption(
              { label: action.option },
              { timeout: this.operationTimeoutMs },
            ), signal)
            break
        }
      },
      dispose: () => element.dispose(),
    }
  }
}

/**
 * Connect to the one context/page created by the Electron browser worker.
 * @param endpoint - Random loopback CDP WebSocket endpoint.
 * @param operationTimeoutMs - Connection and later page-operation timeout.
 * @param snapshotDepth - Maximum ARIA snapshot depth.
 * @param connect - Playwright CDP connector.
 * @returns Driver bound to the worker's sole page.
 */
export const connectPlaywrightBrowserDriver = async (
  endpoint: string,
  operationTimeoutMs: number,
  snapshotDepth: number,
  connect: ConnectOverCdp = (url, options) =>
    chromium.connectOverCDP(url, options),
): Promise<PlaywrightBrowserDriver> => {
  const browser = await connect(endpoint, { timeout: operationTimeoutMs })
  const contexts = browser.contexts()
  const pages = contexts[0]?.pages() ?? []
  if (contexts.length !== 1 || pages.length !== 1) {
    await browser.close()
    throw new BrowserError(
      'browser worker did not expose exactly one context and page',
      'BROWSER_LAUNCH_FAILED',
    )
  }
  return new PlaywrightBrowserDriver(
    browser,
    pages[0] as Page,
    operationTimeoutMs,
    snapshotDepth,
  )
}
