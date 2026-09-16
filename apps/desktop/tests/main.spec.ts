import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopSidecarOptions,
  createLaunchToken,
  resolveDesktopSidecarPaths,
  startDesktop,
  type BeforeSendHeadersListener,
  type BrowserWindowOptions,
  type DesktopRuntime,
  type DesktopWindow,
  type NavigationEvent,
  type SidecarProcess,
} from '../src/main.ts'
import { APP_ORIGIN, APP_WEBSOCKET_ORIGIN } from '../src/security.ts'
import { SidecarShutdownError, SidecarStartupError } from '../src/sidecar.ts'

interface TestHarness {
  readonly runtime: DesktopRuntime
  readonly order: string[]
  readonly windowOptions: BrowserWindowOptions[]
  readonly openedExternalUrls: string[]
  readonly startupReports: unknown[]
  readonly shutdownReports: unknown[]
  readonly window: DesktopWindow
  readonly sidecar: SidecarProcess
  readonly emitBeforeQuit: () => boolean
  readonly emitSecondInstance: () => void
  readonly emitWindowAllClosed: () => void
  readonly emitReadyToShow: () => void
  readonly requestListener: () => BeforeSendHeadersListener
  readonly navigationListener: () => (event: NavigationEvent, url: string) => void
  readonly redirectListener: () => (event: NavigationEvent, url: string) => void
  readonly windowOpenHandler: () => (details: { readonly url: string }) => { readonly action: 'deny' }
  readonly setMinimized: (value: boolean) => void
  readonly quitCalls: () => number
}

const createHarness = (options: {
  readonly hasLock?: boolean
  readonly start?: () => Promise<{ readonly origin: typeof APP_ORIGIN }>
  readonly shutdown?: () => Promise<{ readonly forcedTermination: boolean }>
  readonly loadURL?: (url: string) => Promise<void>
  readonly createToken?: () => string
  readonly whenReady?: () => Promise<void>
  readonly openExternal?: (url: string) => Promise<void>
} = {}): TestHarness => {
  const order: string[] = []
  const windowOptions: BrowserWindowOptions[] = []
  const openedExternalUrls: string[] = []
  const startupReports: unknown[] = []
  const shutdownReports: unknown[] = []
  let quitCalls = 0
  let minimized = false
  let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined
  let secondInstance: (() => void) | undefined
  let windowAllClosed: (() => void) | undefined
  let readyToShow: (() => void) | undefined
  let beforeSendHeaders: BeforeSendHeadersListener | undefined
  let willNavigate: ((event: NavigationEvent, url: string) => void) | undefined
  let willRedirect: ((event: NavigationEvent, url: string) => void) | undefined
  let openWindow: ((details: { readonly url: string }) => { readonly action: 'deny' }) | undefined

  const sidecar: SidecarProcess = {
    start: options.start ?? (async () => {
      order.push('sidecar:start')
      return { origin: APP_ORIGIN }
    }),
    shutdown: options.shutdown ?? (async () => ({ forcedTermination: false })),
  }
  const window: DesktopWindow = {
    webContents: {
      installBeforeSendHeaders: (filter, listener) => {
        order.push('headers:install')
        expect(filter).toEqual({
          urls: [`${APP_ORIGIN}/*`, `${APP_WEBSOCKET_ORIGIN}/*`],
        })
        beforeSendHeaders = listener
      },
      onWillNavigate: (listener) => {
        willNavigate = listener
      },
      onWillRedirect: (listener) => {
        willRedirect = listener
      },
      setWindowOpenHandler: (handler) => {
        openWindow = handler
      },
    },
    isMinimized: () => minimized,
    restore: () => {
      order.push('window:restore')
    },
    focus: () => {
      order.push('window:focus')
    },
    onceReadyToShow: (listener) => {
      readyToShow = listener
    },
    show: () => {
      order.push('window:show')
    },
    loadURL: options.loadURL ?? (async (url) => {
      order.push(`window:load:${url}`)
    }),
  }
  const runtime: DesktopRuntime = {
    app: {
      requestSingleInstanceLock: () => {
        order.push('app:lock')
        return options.hasLock ?? true
      },
      whenReady: options.whenReady ?? (async () => {
        order.push('app:ready')
      }),
      quit: () => {
        quitCalls += 1
        order.push('app:quit')
        beforeQuit?.({ preventDefault: () => order.push('quit:prevent') })
      },
      onBeforeQuit: (listener) => {
        beforeQuit = listener
      },
      onSecondInstance: (listener) => {
        secondInstance = listener
      },
      onWindowAllClosed: (listener) => {
        windowAllClosed = listener
      },
    },
    createWindow: (createdOptions) => {
      order.push('window:create')
      windowOptions.push(createdOptions)
      return window
    },
    createSidecar: (token) => {
      order.push(`sidecar:create:${token}`)
      return sidecar
    },
    createToken: options.createToken ?? (() => 'test-launch-token'),
    openExternal: options.openExternal ?? (async (url) => {
      openedExternalUrls.push(url)
    }),
    reportStartupFailure: report => startupReports.push(report),
    reportForcedTermination: () => order.push('shutdown:forced'),
    reportShutdownFailure: report => shutdownReports.push(report),
  }

  return {
    runtime,
    order,
    windowOptions,
    openedExternalUrls,
    startupReports,
    shutdownReports,
    window,
    sidecar,
    emitBeforeQuit: () => {
      let prevented = false
      beforeQuit?.({ preventDefault: () => {
        prevented = true
      } })
      return prevented
    },
    emitSecondInstance: () => secondInstance?.(),
    emitWindowAllClosed: () => windowAllClosed?.(),
    emitReadyToShow: () => readyToShow?.(),
    requestListener: () => {
      if (beforeSendHeaders === undefined) throw new Error('request listener not installed')
      return beforeSendHeaders
    },
    navigationListener: () => {
      if (willNavigate === undefined) throw new Error('navigation listener not installed')
      return willNavigate
    },
    redirectListener: () => {
      if (willRedirect === undefined) throw new Error('redirect listener not installed')
      return willRedirect
    },
    windowOpenHandler: () => {
      if (openWindow === undefined) throw new Error('window-open handler not installed')
      return openWindow
    },
    setMinimized: (value) => {
      minimized = value
    },
    quitCalls: () => quitCalls,
  }
}

const flushPromises = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('desktop sidecar paths', () => {
  it('isolates the Host under the Electron user-data directory', () => {
    expect(createDesktopSidecarOptions({
      isPackaged: true,
      resourcesPath: '/Applications/DeepSeek Harness.app/Contents/Resources',
      appPath: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
      platform: 'darwin',
      userDataPath: '/Users/test/Library/Application Support/DeepSeek Harness',
      electronExecutable: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    })).toMatchObject({
      sidecar: {
        harnessHome: resolve('/Users/test/Library/Application Support/DeepSeek Harness/dsh'),
        bundledSkillDirectory: resolve('/Applications/DeepSeek Harness.app/Contents/Resources/sidecar/app/skills'),
        browserElectronExecutable: resolve('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'),
        browserApplicationEntry: resolve('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'),
        browserTempRoot: resolve('/Users/test/Library/Application Support/DeepSeek Harness/browser'),
      },
    })
  })

  it('resolves packaged runtimes only from the Electron resources directory', () => {
    expect(resolveDesktopSidecarPaths({
      isPackaged: true,
      resourcesPath: '/Applications/DeepSeek Harness.app/Contents/Resources',
      appPath: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
      platform: 'darwin',
    })).toEqual({
      nodeExecutable: resolve('/Applications/DeepSeek Harness.app/Contents/Resources/sidecar/node/bin/node'),
      cliEntry: resolve('/Applications/DeepSeek Harness.app/Contents/Resources/sidecar/app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    })
  })

  it('resolves development runtimes from the atomically published stage version', () => {
    expect(resolveDesktopSidecarPaths({
      isPackaged: false,
      resourcesPath: '/electron/resources',
      appPath: '/checkout/apps/desktop',
      platform: process.platform,
      readStageVersion: (path) => {
        expect(path).toBe(resolve('/checkout/apps/desktop/.stage/current'))
        return 'fixture\n'
      },
    })).toEqual({
      nodeExecutable: join(
        '/checkout/apps/desktop/.stage/versions/fixture/node/bin',
        process.platform === 'win32' ? 'node.exe' : 'node',
      ),
      cliEntry: '/checkout/apps/desktop/.stage/versions/fixture/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    })
  })

  it('rejects a development stage pointer that is not one version name', () => {
    expect(() => resolveDesktopSidecarPaths({
      isPackaged: false,
      resourcesPath: '/electron/resources',
      appPath: '/checkout/apps/desktop',
      platform: 'darwin',
      readStageVersion: () => '../outside\n',
    })).toThrow('desktop stage pointer is invalid')
  })

  it('uses one explicit stage-root override for either launch mode', () => {
    expect(resolveDesktopSidecarPaths({
      isPackaged: true,
      resourcesPath: '/ignored/resources',
      appPath: '/ignored/app',
      platform: 'win32',
      stageRootOverride: '/custom/sidecar',
    })).toEqual({
      nodeExecutable: resolve('/custom/sidecar/node/bin/node.exe'),
      cliEntry: resolve('/custom/sidecar/app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    })
  })
})

describe('desktop main process startup', () => {
  it('takes the single-instance lock before creating a sidecar', async () => {
    const harness = createHarness({ hasLock: false })

    await startDesktop(harness.runtime)

    expect(harness.order).toEqual(['app:lock', 'app:quit'])
  })

  it('uses a fresh 256-bit base64url launch token', () => {
    const randomBytes = vi.fn((size: number) => {
      expect(size).toBe(32)
      return Buffer.alloc(size, 0xff)
    })

    expect(createLaunchToken(randomBytes)).toBe('__________________________________________8')
    expect(randomBytes).toHaveBeenCalledOnce()
  })

  it('starts the sidecar before loading a hidden hardened window', async () => {
    const harness = createHarness()

    await startDesktop(harness.runtime)

    expect(harness.windowOptions).toEqual([{
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    }])
    expect(harness.order).toEqual([
      'app:lock',
      'app:ready',
      'sidecar:create:test-launch-token',
      'sidecar:start',
      'window:create',
      'headers:install',
      `window:load:${APP_ORIGIN}`,
    ])
    expect(harness.order).not.toContain('window:show')

    harness.emitReadyToShow()
    expect(harness.order.at(-1)).toBe('window:show')
  })

  it('authorizes exact-origin requests through the installed callback', async () => {
    const harness = createHarness()
    await startDesktop(harness.runtime)
    const callback = vi.fn()

    harness.requestListener()({
      url: `${APP_ORIGIN}/api`,
      requestHeaders: { Accept: 'application/json' },
    }, callback)

    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: 'application/json',
        Authorization: 'Bearer test-launch-token',
      },
    })
  })

  it('authorizes exact-endpoint WebSocket handshakes through the installed callback', async () => {
    const harness = createHarness()
    await startDesktop(harness.runtime)
    const callback = vi.fn()

    harness.requestListener()({
      url: `${APP_WEBSOCKET_ORIGIN}/api/events`,
      requestHeaders: { Upgrade: 'websocket' },
    }, callback)

    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Upgrade: 'websocket',
        Authorization: 'Bearer test-launch-token',
      },
    })
  })

  it('reports a categorized token-free startup failure and quits', async () => {
    const startupError = new SidecarStartupError('SIDECAR_PORT_CONFLICT', {
      stderrTail: 'listen EADDRINUSE',
    })
    const shutdown = vi.fn(async () => ({ forcedTermination: false }))
    const harness = createHarness({
      start: async () => {
        throw startupError
      },
      shutdown,
    })

    await startDesktop(harness.runtime)
    await flushPromises()

    expect(harness.startupReports).toEqual([{
      code: 'SIDECAR_PORT_CONFLICT',
      message: startupError.message,
      diagnostics: { stderrTail: 'listen EADDRINUSE' },
    }])
    expect(JSON.stringify(harness.startupReports)).not.toContain('test-launch-token')
    expect(shutdown).toHaveBeenCalledOnce()
    expect(harness.quitCalls()).toBe(2)
  })

  it('contains failures that occur before sidecar construction', async () => {
    const harness = createHarness({
      createToken: () => {
        throw new Error('token-generator-secret')
      },
    })

    await startDesktop(harness.runtime)
    await flushPromises()

    expect(harness.startupReports).toEqual([{
      code: 'DESKTOP_SIDECAR_FAILURE',
      message: 'The desktop Host could not be prepared.',
    }])
    expect(JSON.stringify(harness.startupReports)).not.toContain('token-generator-secret')
    expect(harness.quitCalls()).toBe(2)
  })

  it('contains Electron readiness failures without creating a sidecar', async () => {
    const harness = createHarness({
      whenReady: async () => {
        throw new Error('electron-readiness-secret')
      },
    })

    await startDesktop(harness.runtime)
    await flushPromises()

    expect(harness.startupReports).toEqual([{
      code: 'DESKTOP_ELECTRON_FAILURE',
      message: 'The Electron main process could not become ready.',
    }])
    expect(harness.order).not.toContain('sidecar:create:test-launch-token')
    expect(JSON.stringify(harness.startupReports)).not.toContain('electron-readiness-secret')
    expect(harness.quitCalls()).toBe(2)
  })
})

describe('desktop window policy', () => {
  it('restores and focuses the existing window on a second launch', async () => {
    const harness = createHarness()
    await startDesktop(harness.runtime)
    harness.emitReadyToShow()
    harness.setMinimized(true)

    harness.emitSecondInstance()

    expect(harness.order.slice(-2)).toEqual(['window:restore', 'window:focus'])
  })

  it('remembers a second launch until the primary window can be shown', async () => {
    let resolveReady: (() => void) | undefined
    const harness = createHarness({
      whenReady: () => new Promise<void>((resolve) => {
        resolveReady = resolve
      }),
    })
    const startup = startDesktop(harness.runtime)

    harness.emitSecondInstance()
    resolveReady?.()
    await startup

    expect(harness.order.filter(entry => entry === 'sidecar:start')).toHaveLength(1)
    expect(harness.order).not.toContain('window:focus')
    harness.setMinimized(true)
    harness.emitReadyToShow()
    expect(harness.order.slice(-3)).toEqual([
      'window:show',
      'window:restore',
      'window:focus',
    ])
  })

  it('denies unsafe navigation and opens only external Web navigation', async () => {
    const harness = createHarness()
    await startDesktop(harness.runtime)
    const navigate = harness.navigationListener()
    const sameOrigin = { preventDefault: vi.fn() }
    const external = { preventDefault: vi.fn() }
    const unsafe = { preventDefault: vi.fn() }

    navigate(sameOrigin, `${APP_ORIGIN}/settings`)
    navigate(external, 'https://example.com/docs')
    navigate(unsafe, 'file:///tmp/secret')
    await flushPromises()

    expect(sameOrigin.preventDefault).not.toHaveBeenCalled()
    expect(external.preventDefault).toHaveBeenCalledOnce()
    expect(unsafe.preventDefault).toHaveBeenCalledOnce()
    expect(harness.openedExternalUrls).toEqual(['https://example.com/docs'])
  })

  it('denies popups while opening safe external Web URLs outside the application', async () => {
    const harness = createHarness()
    await startDesktop(harness.runtime)
    const openWindow = harness.windowOpenHandler()

    for (const url of [
      'http://example.com/reference',
      'https://example.com/citation',
    ]) {
      expect(openWindow({ url })).toEqual({ action: 'deny' })
    }
    await flushPromises()

    expect(harness.openedExternalUrls).toEqual([
      'http://example.com/reference',
      'https://example.com/citation',
    ])
  })

  it.each([
    `${APP_ORIGIN}/settings`,
    'file:///tmp/secret',
    'data:text/html,unsafe',
    'javascript:alert(1)',
    'dsh://settings',
    'http://user:password@example.com/',
    'not a URL',
  ])('denies popup URL %s without opening it externally', async (url) => {
    const harness = createHarness()
    await startDesktop(harness.runtime)

    expect(harness.windowOpenHandler()({ url })).toEqual({ action: 'deny' })
    await flushPromises()

    expect(harness.openedExternalUrls).toEqual([])
  })

  it('contains popup opener failures while keeping the popup denied', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('opener unavailable')
    })
    const harness = createHarness({ openExternal })
    await startDesktop(harness.runtime)

    expect(harness.windowOpenHandler()({
      url: 'https://example.com/citation',
    })).toEqual({ action: 'deny' })
    await flushPromises()

    expect(openExternal).toHaveBeenCalledOnce()
  })

  it('applies navigation policy to redirects', async () => {
    const harness = createHarness()
    await startDesktop(harness.runtime)
    const redirect = harness.redirectListener()
    const sameOrigin = { preventDefault: vi.fn() }
    const external = { preventDefault: vi.fn() }
    const unsafe = { preventDefault: vi.fn() }

    redirect(sameOrigin, `${APP_ORIGIN}/sessions`)
    redirect(external, 'https://example.com/docs')
    redirect(unsafe, 'javascript:alert(1)')
    await flushPromises()

    expect(sameOrigin.preventDefault).not.toHaveBeenCalled()
    expect(external.preventDefault).toHaveBeenCalledOnce()
    expect(unsafe.preventDefault).toHaveBeenCalledOnce()
    expect(harness.openedExternalUrls).toEqual(['https://example.com/docs'])
  })
})

describe('desktop main process shutdown', () => {
  it('does not continue startup after quit while Electron readiness is pending', async () => {
    let resolveReady: (() => void) | undefined
    const harness = createHarness({
      whenReady: () => new Promise<void>((resolve) => {
        resolveReady = resolve
      }),
    })
    const startup = startDesktop(harness.runtime)

    expect(harness.emitBeforeQuit()).toBe(true)
    resolveReady?.()
    await startup

    expect(harness.order).not.toContain('sidecar:create:test-launch-token')
    expect(harness.order).not.toContain('window:create')
    expect(harness.startupReports).toEqual([])
  })

  it('shuts down a starting sidecar without reporting its expected startup failure', async () => {
    let rejectStart: ((error: Error) => void) | undefined
    const shutdown = vi.fn(async () => ({ forcedTermination: false }))
    const harness = createHarness({
      start: () => new Promise((_, reject) => {
        rejectStart = reject
      }),
      shutdown,
    })
    const startup = startDesktop(harness.runtime)
    await flushPromises()

    expect(harness.emitBeforeQuit()).toBe(true)
    expect(shutdown).toHaveBeenCalledOnce()
    rejectStart?.(new Error('stopped during quit'))
    await startup
    await flushPromises()

    expect(harness.order).not.toContain('window:create')
    expect(harness.startupReports).toEqual([])
  })

  it('ignores a pending navigation rejection caused by quit', async () => {
    let rejectLoad: ((error: Error) => void) | undefined
    const harness = createHarness({
      loadURL: () => new Promise((_, reject) => {
        rejectLoad = reject
      }),
    })
    const startup = startDesktop(harness.runtime)
    await flushPromises()

    expect(harness.emitBeforeQuit()).toBe(true)
    await flushPromises()
    expect(harness.quitCalls()).toBe(1)

    rejectLoad?.(new Error('navigation stopped during quit'))
    await startup

    expect(harness.startupReports).toEqual([])
    expect(harness.quitCalls()).toBe(1)
  })

  it('does not show or focus a window whose pending navigation outlives quit', async () => {
    let resolveLoad: (() => void) | undefined
    const harness = createHarness({
      loadURL: () => new Promise<void>((resolve) => {
        resolveLoad = resolve
      }),
    })
    const startup = startDesktop(harness.runtime)
    await flushPromises()

    harness.emitSecondInstance()
    expect(harness.emitBeforeQuit()).toBe(true)
    harness.emitReadyToShow()
    resolveLoad?.()
    await startup
    await flushPromises()

    expect(harness.order).not.toContain('window:show')
    expect(harness.order).not.toContain('window:focus')
    expect(harness.startupReports).toEqual([])
    expect(harness.quitCalls()).toBe(1)
  })

  it('quits when all windows close on every platform', async () => {
    const harness = createHarness()
    await startDesktop(harness.runtime)

    harness.emitWindowAllClosed()
    await flushPromises()

    expect(harness.quitCalls()).toBe(2)
  })

  it('coalesces quit attempts and reports forced sidecar termination once', async () => {
    let resolveShutdown: ((result: { readonly forcedTermination: boolean }) => void) | undefined
    const shutdown = vi.fn(() => new Promise<{ readonly forcedTermination: boolean }>((resolve) => {
      resolveShutdown = resolve
    }))
    const harness = createHarness({ shutdown })
    await startDesktop(harness.runtime)

    expect(harness.emitBeforeQuit()).toBe(true)
    expect(harness.emitBeforeQuit()).toBe(true)
    expect(shutdown).toHaveBeenCalledOnce()
    resolveShutdown?.({ forcedTermination: true })
    await flushPromises()

    expect(shutdown).toHaveBeenCalledOnce()
    expect(harness.order.filter(entry => entry === 'shutdown:forced')).toHaveLength(1)
    expect(harness.quitCalls()).toBe(1)
  })

  it('reports shutdown failure and still completes the final quit', async () => {
    const shutdownError = new SidecarShutdownError()
    const shutdown = vi.fn(async () => {
      throw shutdownError
    })
    const harness = createHarness({ shutdown })
    await startDesktop(harness.runtime)

    expect(harness.emitBeforeQuit()).toBe(true)
    await flushPromises()

    expect(harness.shutdownReports).toEqual([{
      code: 'SIDECAR_NO_QUIESCENCE',
      message: shutdownError.message,
    }])
    expect(harness.quitCalls()).toBe(1)
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
