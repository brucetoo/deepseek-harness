import { describe, expect, it } from 'vitest'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import {
  BrowserNavigationPolicy,
  configureBrowserWorkerWindow,
  encodeBrowserWorkerEvent,
  isBrowserWorkerProcess,
  parseBrowserWorkerCommand,
  resolveBrowserWorkerProfile,
} from '../src/browser-worker.ts'

describe('configureBrowserWorkerWindow', () => {
  it('denies permissions, downloads, popups, webviews, and unapproved origins', () => {
    const webContentsHandlers = new Map<string, (...args: unknown[]) => void>()
    const windowHandlers = new Map<string, () => void>()
    let permissionCheck: (() => boolean) | undefined
    let permissionRequest: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined
    let downloadHandler: ((event: { preventDefault(): void }) => void) | undefined
    let openHandler: (() => { action: string }) | undefined
    const window = {
      isDestroyed: () => false,
      on: (event: string, handler: () => void) => {
        windowHandlers.set(event, handler)
      },
      webContents: {
        getURL: () => 'https://example.com/form',
        isDestroyed: () => false,
        session: {
          setPermissionCheckHandler: (handler: () => boolean) => {
            permissionCheck = handler
          },
          setPermissionRequestHandler: (handler: typeof permissionRequest) => {
            permissionRequest = handler
          },
          on: (event: string, handler: typeof downloadHandler) => {
            if (event === 'will-download') downloadHandler = handler
          },
        },
        setWindowOpenHandler: (handler: () => { action: string }) => {
          openHandler = handler
        },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          webContentsHandlers.set(event, handler)
        },
      },
    } as unknown as ElectronBrowserWindow
    const policy = new BrowserNavigationPolicy()
    policy.prepare('https://example.com/form')
    const blocked: unknown[] = []
    let rendererGone = false
    let closed = false
    configureBrowserWorkerWindow(
      window,
      policy,
      event => blocked.push(event),
      () => { rendererGone = true },
      () => { closed = true },
    )

    expect(permissionCheck?.()).toBe(false)
    let permissionAllowed: boolean | undefined
    permissionRequest?.(undefined, 'camera', (allowed) => { permissionAllowed = allowed })
    expect(permissionAllowed).toBe(false)
    const download = { preventDefault: () => blocked.push('download') }
    downloadHandler?.(download)
    expect(openHandler?.()).toEqual({ action: 'deny' })
    const webview = { preventDefault: () => blocked.push('webview') }
    webContentsHandlers.get('will-attach-webview')?.(webview)
    const allowed = { preventDefault: () => blocked.push('unexpected') }
    webContentsHandlers.get('will-navigate')?.(allowed, 'https://example.com/result')
    const denied = { preventDefault: () => blocked.push('navigation') }
    webContentsHandlers.get('will-redirect')?.(denied, 'https://other.test/private')
    webContentsHandlers.get('render-process-gone')?.()
    windowHandlers.get('closed')?.()

    expect(blocked).toEqual([
      'download',
      'webview',
      'navigation',
      {
        attemptedUrl: 'https://other.test/private',
        currentUrl: 'https://example.com/form',
        pageUsable: true,
      },
    ])
    expect(rendererGone).toBe(true)
    expect(closed).toBe(true)
  })
})

describe('BrowserNavigationPolicy', () => {
  it('admits an explicitly prepared origin and its later same-origin navigation', () => {
    const policy = new BrowserNavigationPolicy()
    policy.prepare('https://example.com/form')

    expect(policy.authorize('https://example.com/form')).toBe(true)
    expect(policy.authorize('https://example.com/result?ok=1')).toBe(true)
  })

  it('blocks an unprepared cross-origin navigation', () => {
    const policy = new BrowserNavigationPolicy()
    policy.prepare('https://example.com/form')
    expect(policy.authorize('https://example.com/form')).toBe(true)

    expect(policy.authorize('https://other.test/result')).toBe(false)
  })

  it('promotes one prepared cross-origin destination and retires the prior origin', () => {
    const policy = new BrowserNavigationPolicy()
    policy.prepare('https://example.com/form')
    expect(policy.authorize('https://example.com/form')).toBe(true)
    policy.prepare('https://other.test/submit')

    expect(policy.authorize('https://other.test/submit')).toBe(true)
    expect(policy.authorize('https://other.test/result')).toBe(true)
    expect(policy.authorize('https://example.com/form')).toBe(false)
  })

  it('revokes an unused permit without forgetting the current origin', () => {
    const policy = new BrowserNavigationPolicy()
    policy.prepare('https://example.com/')
    expect(policy.authorize('https://example.com/')).toBe(true)
    policy.prepare('https://other.test/')
    policy.revoke()

    expect(policy.authorize('https://other.test/')).toBe(false)
    expect(policy.authorize('https://example.com/next')).toBe(true)
  })

  it.each([
    'file:///tmp/private.txt',
    'javascript:alert(1)',
    'https://user@example.com/',
  ])('rejects unsupported or credential-bearing navigation: %s', (url) => {
    const policy = new BrowserNavigationPolicy()

    expect(() => { policy.prepare(url) }).toThrow(/credential-free HTTP or HTTPS/)
    expect(policy.authorize(url)).toBe(false)
  })
})

describe('parseBrowserWorkerCommand', () => {
  it('accepts one exact navigation permit command', () => {
    expect(parseBrowserWorkerCommand(
      '{"type":"permit-navigation","url":"https://example.com/form","requestId":1}',
    )).toEqual({
      type: 'permit-navigation',
      url: 'https://example.com/form',
      requestId: 1,
    })
  })

  it('accepts an explicit correlated permit revocation', () => {
    expect(parseBrowserWorkerCommand(
      '{"type":"permit-navigation","url":null,"requestId":2}',
    )).toEqual({ type: 'permit-navigation', url: null, requestId: 2 })
  })

  it('accepts one exact navigation inspection command', () => {
    expect(parseBrowserWorkerCommand(
      '{"type":"inspect-navigation","requestId":7}',
    )).toEqual({
      type: 'inspect-navigation',
      requestId: 7,
    })
  })

  it.each([
    '',
    'not json',
    '{}',
    '{"type":"permit-navigation"}',
    '{"type":"close","url":"https://example.com"}',
    '{"type":"permit-navigation","url":1}',
    '{"type":"permit-navigation","url":"https://example.com","extra":true}',
    '{"type":"permit-navigation","url":"https://example.com","requestId":0}',
    '{"type":"permit-navigation","url":42,"requestId":1}',
    '{"type":"inspect-navigation","requestId":0}',
    '{"type":"inspect-navigation","requestId":1.5}',
  ])('rejects malformed worker input: %s', (line) => {
    expect(() => parseBrowserWorkerCommand(line)).toThrow(
      /invalid browser worker command/,
    )
  })
})

describe('encodeBrowserWorkerEvent', () => {
  it('writes one correlated blocked-navigation status record', () => {
    expect(encodeBrowserWorkerEvent({
      type: 'navigation-status',
      requestId: 3,
      blocked: {
        attemptedUrl: 'https://other.test/',
        currentUrl: 'https://example.com/form',
        pageUsable: true,
      },
    })).toBe(
      'dsh-browser-worker:event {"type":"navigation-status","requestId":3,"blocked":{"attemptedUrl":"https://other.test/","currentUrl":"https://example.com/form","pageUsable":true}}\n',
    )
  })
})

describe('isBrowserWorkerProcess', () => {
  it('selects worker mode only when the exact marker is present', () => {
    expect(isBrowserWorkerProcess(['/Applications/App', '--dsh-browser-worker'])).toBe(true)
    expect(isBrowserWorkerProcess(['/Applications/App', '--dsh-browser-worker=true'])).toBe(false)
    expect(isBrowserWorkerProcess(['/Applications/App'])).toBe(false)
  })
})

describe('resolveBrowserWorkerProfile', () => {
  it('returns the one non-empty dedicated profile path', () => {
    expect(resolveBrowserWorkerProfile([
      '/Applications/App',
      '--dsh-browser-worker',
      '--dsh-browser-profile=/tmp/browser/session-a',
    ])).toBe('/tmp/browser/session-a')
  })

  it.each([
    ['/Applications/App', '--dsh-browser-worker'],
    ['/Applications/App', '--dsh-browser-profile='],
    ['/Applications/App', '--dsh-browser-profile=/tmp/a', '--dsh-browser-profile=/tmp/b'],
  ])('rejects missing, empty, or repeated profile arguments', (...argv) => {
    expect(() => resolveBrowserWorkerProfile(argv)).toThrow(
      /exactly one non-empty browser profile/,
    )
  })
})
