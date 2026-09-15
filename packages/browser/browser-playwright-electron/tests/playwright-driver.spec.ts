import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserContext,
  BrowserType,
  ElementHandle,
  Locator,
  Page,
  Browser,
} from 'playwright-core'
import { chromium } from 'playwright-core'
import {
  connectPlaywrightBrowserDriver,
  PlaywrightBrowserDriver,
} from '../src/playwright-driver.ts'

interface DriverHarness {
  readonly driver: PlaywrightBrowserDriver
  readonly browser: Browser
  readonly page: Page
  readonly locator: Locator
  readonly element: ElementHandle
  readonly ariaSnapshot: ReturnType<typeof vi.fn>
  readonly elementEvaluate: ReturnType<typeof vi.fn>
  readonly elementHandle: ReturnType<typeof vi.fn>
  readonly locatorNth: ReturnType<typeof vi.fn>
  readonly pageGoto: ReturnType<typeof vi.fn>
  readonly pageGetByRole: ReturnType<typeof vi.fn>
  readonly pageLocator: ReturnType<typeof vi.fn>
  readonly pageTitle: ReturnType<typeof vi.fn>
  readonly calls: string[]
  accessibleElements: {
    element: ElementHandle
    role: string
    name: string
  }[]
  fingerprint: {
    tagName: string
    inputType?: string
    href?: string
    formAction?: string
  }
  connected: boolean
  count: number
}

const createHarness = (
  target = { role: 'button', name: 'Submit' },
): DriverHarness => {
  const calls: string[] = []
  const harness = {
    fingerprint: {
      tagName: 'button',
      formAction: 'https://example.com/submit',
    },
    connected: true,
    count: 1,
  } as DriverHarness
  const elementEvaluate = vi.fn(async (callback: (node: unknown) => unknown) => {
    if (String(callback).includes('isConnected')) return harness.connected
    return harness.fingerprint
  })
  const element = {
    evaluate: elementEvaluate,
    click: vi.fn(async () => {
      calls.push('click')
    }),
    fill: vi.fn(async (value: string) => {
      calls.push(`fill:${value}`)
    }),
    selectOption: vi.fn(async (option: unknown) => {
      calls.push(`select:${JSON.stringify(option)}`)
      return ['selected']
    }),
    dispose: vi.fn(async () => {
      calls.push('dispose')
    }),
  } as unknown as ElementHandle
  const locatorNth = vi.fn(() => locator)
  const elementHandle = vi.fn(async () => element)
  const locator = {
    count: vi.fn(async () => harness.count),
    nth: locatorNth,
    elementHandle,
  } as unknown as Locator
  const ariaSnapshot = vi.fn(async () => '- button "Submit"')
  const pageTitle = vi.fn(async () => 'Public form')
  const pageLocator = vi.fn(() => ({ ariaSnapshot }))
  const pageGoto = vi.fn(async (url: string) => {
    calls.push(`goto:${url}`)
  })
  const pageGetByRole = vi.fn((role: string, options: { name: string; exact: boolean }) => ({
    ...locator,
    evaluateAll: async (
      callback: (nodes: ElementHandle[], retained: ElementHandle) => unknown,
      retained: ElementHandle,
    ) => callback(
      harness.accessibleElements
        .filter(candidate => candidate.role === role && (
          options.exact ? candidate.name === options.name : candidate.name.includes(options.name)
        ))
        .map(candidate => candidate.element),
      retained,
    ),
  }))
  const page = {
    url: vi.fn(() => 'https://example.com/form'),
    title: pageTitle,
    locator: pageLocator,
    getByRole: pageGetByRole,
    goto: pageGoto,
    waitForTimeout: vi.fn(async (durationMs: number) => {
      calls.push(`wait:${durationMs}`)
    }),
  } as unknown as Page
  const browser = {
    close: vi.fn(async () => {
      calls.push('browser:close')
    }),
  } as unknown as Browser
  Object.assign(harness, {
    driver: new PlaywrightBrowserDriver(browser, page, 2_000, 7),
    browser,
    page,
    locator,
    element,
    ariaSnapshot,
    elementEvaluate,
    elementHandle,
    locatorNth,
    pageGoto,
    pageGetByRole,
    pageLocator,
    pageTitle,
    calls,
    accessibleElements: [{ element, ...target }],
  })
  return harness
}

describe('PlaywrightBrowserDriver observation', () => {
  it('returns URL, title, and a bounded-depth AI ARIA snapshot', async () => {
    const harness = createHarness()

    await expect(harness.driver.snapshot()).resolves.toEqual({
      url: 'https://example.com/form',
      title: 'Public form',
      snapshot: '- button "Submit"',
    })

    expect(harness.pageLocator).toHaveBeenCalledWith('body')
    expect(harness.ariaSnapshot).toHaveBeenCalledWith({
      boxes: false,
      depth: 7,
      mode: 'ai',
      timeout: 2_000,
    })
  })

  it('navigates and waits before returning a fresh observation', async () => {
    const harness = createHarness()

    await harness.driver.goto('https://example.com/form')
    await harness.driver.wait(250)

    expect(harness.calls).toEqual([
      'goto:https://example.com/form',
      'wait:250',
    ])
    expect(harness.pageGoto).toHaveBeenCalledWith('https://example.com/form', {
      timeout: 2_000,
      waitUntil: 'domcontentloaded',
    })
  })

  it('propagates operation completion, rejection, and cancellation with a signal', async () => {
    const completed = createHarness()
    await expect(completed.driver.goto(
      'https://example.com/next',
      new AbortController().signal,
    )).resolves.toMatchObject({ url: 'https://example.com/form' })

    const rejected = createHarness()
    const failure = new Error('title failed')
    rejected.pageTitle.mockRejectedValueOnce(failure)
    await expect(rejected.driver.snapshot(
      new AbortController().signal,
    )).rejects.toBe(failure)

    const cancelled = createHarness()
    const pending = Promise.withResolvers<unknown>()
    cancelled.pageGoto.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const reason = new Error('cancel page operation')
    const navigation = cancelled.driver.goto('https://example.com/slow', controller.signal)
    controller.abort(reason)
    await expect(navigation).rejects.toBe(reason)

    const preAborted = AbortSignal.abort(new Error('already cancelled'))
    await expect(cancelled.driver.snapshot(preAborted)).rejects.toThrow('already cancelled')

    const nonError = createHarness()
    nonError.pageTitle.mockRejectedValueOnce('non-error failure')
    const normalized = await nonError.driver.snapshot(
      new AbortController().signal,
    ).catch((error: unknown) => error)
    expect(normalized).toBeInstanceOf(Error)
    expect((normalized as Error).cause).toBe('non-error failure')
  })
})

describe('PlaywrightBrowserDriver target preparation', () => {
  it('rejects empty target fields and invalid indexes', async () => {
    const harness = createHarness()

    await expect(harness.driver.prepare({
      kind: 'click',
      target: { role: '', name: 'Submit' },
    })).rejects.toMatchObject({ code: 'BROWSER_INVALID_TARGET' })
    await expect(harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: '', index: -1 },
    })).rejects.toMatchObject({ code: 'BROWSER_INVALID_TARGET' })
    await expect(harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit', index: 0.5 },
    })).rejects.toMatchObject({ code: 'BROWSER_INVALID_TARGET' })
  })

  it('rejects missing and detached targets', async () => {
    const missing = createHarness()
    missing.count = 0
    await expect(missing.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_MISSING' })

    const outOfRange = createHarness()
    await expect(outOfRange.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit', index: 1 },
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_MISSING' })

    const detached = createHarness()
    detached.elementHandle.mockResolvedValueOnce(null)
    await expect(detached.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_CHANGED' })
  })

  it('requires an unambiguous exact role/name target unless an index is supplied', async () => {
    const harness = createHarness()
    harness.count = 2

    await expect(harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_AMBIGUOUS' })

    await expect(harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit', index: 1 },
    })).resolves.toMatchObject({
      fingerprint: {
        tagName: 'button',
        role: 'button',
        accessibleName: 'Submit',
        formAction: 'https://example.com/submit',
      },
    })
    expect(harness.locatorNth).toHaveBeenCalledWith(1)
  })

  it('rejects a password control before publishing prepared state', async () => {
    const harness = createHarness()
    harness.fingerprint = {
      tagName: 'input',
      inputType: 'password',
      formAction: 'https://example.com/login',
    }

    await expect(harness.driver.prepare({
      kind: 'fill',
      target: { role: 'textbox', name: 'Password' },
      value: 'not-allowed',
    })).rejects.toMatchObject({ code: 'BROWSER_PASSWORD_CONTROL' })
    expect(harness.calls).toEqual(['dispose'])
  })

  it('rejects a file chooser before publishing prepared state', async () => {
    const harness = createHarness()
    harness.fingerprint = {
      tagName: 'input',
      inputType: 'file',
    }

    await expect(harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Choose file' },
    })).rejects.toMatchObject({ code: 'BROWSER_FILE_CONTROL' })
    expect(harness.calls).toEqual(['dispose'])
  })

  it('derives canonical DOM fingerprints inside the page', async () => {
    class FakeInput {
      readonly tagName = 'INPUT'
      readonly type = 'TEXT'
      readonly isConnected = true
      readonly ownerDocument = { baseURI: 'https://example.com/form' }
      readonly form = {
        getAttribute: (name: string) => name === 'action' ? '/submit' : null,
      }
      getAttribute(): string | null {
        return null
      }
    }
    class FakeAnchor {
      readonly tagName = 'A'
      readonly isConnected = true
      readonly ownerDocument = { baseURI: 'https://example.com/form' }
      getAttribute(name: string): string | null {
        return name === 'href' ? '/next' : null
      }
    }
    class FakeButton {
      readonly tagName = 'BUTTON'
      readonly isConnected = true
      readonly ownerDocument = { baseURI: 'https://example.com/form' }
      readonly form = null
      constructor(private readonly action: string | null) {}
      getAttribute(name: string): string | null {
        return name === 'formaction' ? this.action : null
      }
    }
    class FakeGeneric {
      readonly tagName = 'DIV'
      readonly isConnected = true
      readonly ownerDocument = { baseURI: 'https://example.com/form' }
      getAttribute(): string | null {
        return null
      }
    }
    vi.stubGlobal('HTMLInputElement', FakeInput)
    vi.stubGlobal('HTMLAnchorElement', FakeAnchor)
    vi.stubGlobal('HTMLButtonElement', FakeButton)
    try {
      const cases = [
        {
          node: new FakeInput(),
          expected: {
            tagName: 'input',
            inputType: 'text',
            formAction: 'https://example.com/submit',
          },
        },
        {
          node: new FakeAnchor(),
          expected: {
            tagName: 'a',
            href: 'https://example.com/next',
          },
        },
        {
          node: new FakeButton(''),
          expected: { tagName: 'button' },
        },
        {
          node: new FakeGeneric(),
          expected: { tagName: 'div' },
        },
      ] as const
      for (const { node, expected } of cases) {
        const harness = createHarness({ role: 'button', name: 'Target' })
        Object.assign(harness.element, {
          evaluate: (
            callback: ((value: unknown) => unknown) | string,
          ): Promise<unknown> => {
            if (typeof callback === 'string') throw new Error('expected callback')
            return Promise.resolve(callback(node))
          },
        })
        const prepared = await harness.driver.prepare({
          kind: 'click',
          target: { role: 'button', name: 'Target' },
        })
        expect(prepared.fingerprint).toEqual({
          ...expected,
          role: 'button',
          accessibleName: 'Target',
        })
        await prepared.commit()
        await prepared.dispose()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('PlaywrightBrowserDriver prepared action identity', () => {
  it('commits against the retained handle when its observable fingerprint is unchanged', async () => {
    const harness = createHarness({ role: 'textbox', name: 'Query' })
    const action = await harness.driver.prepare({
      kind: 'fill',
      target: { role: 'textbox', name: 'Query' },
      value: 'public value',
    })

    await action.commit()
    await action.dispose()

    expect(harness.calls).toEqual(['fill:public value', 'dispose'])
  })

  it.each([
    { role: 'button', name: 'Submit payment' },
    { role: 'link', name: 'Submit' },
  ])('rejects a retained element changed to $role "$name" without acting', async (identity) => {
    const harness = createHarness()
    const action = await harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    harness.accessibleElements = [{ element: harness.element, ...identity }]

    await expect(action.commit()).rejects.toMatchObject({ code: 'BROWSER_TARGET_CHANGED' })

    expect(harness.calls).toEqual([])
    expect(harness.elementHandle).toHaveBeenCalledOnce()
  })

  it('rejects a changed retained element even when a replacement matches the original target', async () => {
    const harness = createHarness()
    const replacement = createHarness()
    const action = await harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    harness.accessibleElements = [
      { element: harness.element, role: 'button', name: 'Delete' },
      { element: replacement.element, role: 'button', name: 'Submit' },
    ]

    await expect(action.commit()).rejects.toMatchObject({ code: 'BROWSER_TARGET_CHANGED' })

    expect(harness.calls).toEqual([])
    expect(replacement.calls).toEqual([])
    expect(harness.elementHandle).toHaveBeenCalledOnce()
  })

  it('keeps the retained element when another match takes its original index', async () => {
    const harness = createHarness()
    const replacement = createHarness()
    const action = await harness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit', index: 0 },
    })
    harness.accessibleElements.unshift({
      element: replacement.element, role: 'button', name: 'Submit',
    })
    harness.count = 2

    await action.commit()

    expect(harness.calls).toEqual(['click'])
    expect(replacement.calls).toEqual([])
    expect(harness.elementHandle).toHaveBeenCalledOnce()
    expect(harness.locatorNth).toHaveBeenCalledOnce()
    expect(harness.pageGetByRole).toHaveBeenLastCalledWith('button', { name: 'Submit', exact: true })
  })

  it('rejects a detached or observably changed element without acting', async () => {
    const detached = createHarness()
    const detachedAction = await detached.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    detached.connected = false
    await expect(detachedAction.commit()).rejects.toMatchObject({
      code: 'BROWSER_TARGET_CHANGED',
    })
    expect(detached.calls).not.toContain('click')

    const changed = createHarness()
    const changedAction = await changed.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    changed.fingerprint = {
      tagName: 'button',
      formAction: 'https://evil.test/submit',
    }
    await expect(changedAction.commit()).rejects.toMatchObject({
      code: 'BROWSER_TARGET_CHANGED',
    })
    expect(changed.calls).not.toContain('click')
  })

  it('uses exact click and visible-option operations', async () => {
    const clickHarness = createHarness()
    const click = await clickHarness.driver.prepare({
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    await click.commit()
    expect(clickHarness.calls).toContain('click')

    const selectHarness = createHarness({ role: 'combobox', name: 'Region' })
    const select = await selectHarness.driver.prepare({
      kind: 'select',
      target: { role: 'combobox', name: 'Region' },
      option: 'Europe',
    })
    await select.commit()
    expect(selectHarness.calls).toContain('select:{"label":"Europe"}')
  })

  it('closes the CDP browser connection idempotently', async () => {
    const harness = createHarness()

    await harness.driver.close()
    await harness.driver.close()

    expect(harness.calls).toEqual(['browser:close'])
  })
})

describe('connectPlaywrightBrowserDriver', () => {
  it('connects to exactly one Electron context and page', async () => {
    const harness = createHarness()
    const context = {
      pages: () => [harness.page],
    } as unknown as BrowserContext
    const connected = Object.assign(harness.browser, {
      contexts: () => [context],
    })
    const connect = vi.fn(async () => connected) as unknown as BrowserType['connectOverCDP']

    const driver = await connectPlaywrightBrowserDriver(
      'ws://127.0.0.1:49152/devtools/browser/test',
      2_000,
      7,
      connect,
    )

    await expect(driver.snapshot()).resolves.toMatchObject({
      url: 'https://example.com/form',
    })
    expect(connect).toHaveBeenCalledWith(
      'ws://127.0.0.1:49152/devtools/browser/test',
      { timeout: 2_000 },
    )
  })

  it('closes and rejects an unexpected context or page topology', async () => {
    const close = vi.fn(async () => {})
    const connected = {
      contexts: () => [],
      close,
    } as unknown as Browser
    const connect = vi.fn(async () => connected) as unknown as BrowserType['connectOverCDP']

    await expect(connectPlaywrightBrowserDriver(
      'ws://127.0.0.1:49152/devtools/browser/test',
      2_000,
      7,
      connect,
    )).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('uses Playwright Chromium as its default CDP connector', async () => {
    const harness = createHarness()
    const context = {
      pages: () => [harness.page],
    } as unknown as BrowserContext
    const connected = Object.assign(harness.browser, {
      contexts: () => [context],
    })
    const connect = vi.spyOn(chromium, 'connectOverCDP').mockResolvedValueOnce(connected)

    const driver = await connectPlaywrightBrowserDriver(
      'ws://127.0.0.1:49152/devtools/browser/default',
      2_000,
      7,
    )

    await expect(driver.snapshot()).resolves.toMatchObject({
      url: 'https://example.com/form',
    })
    expect(connect).toHaveBeenCalledWith(
      'ws://127.0.0.1:49152/devtools/browser/default',
      { timeout: 2_000 },
    )
  })
})
