/** Hardened Electron main-process entrypoint and testable lifecycle coordinator. */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import {
  SidecarShutdownError,
  SidecarStartupError,
  SidecarSupervisor,
  type SidecarDependencies,
  type SidecarShutdownResult,
  type SidecarStartResult,
  type SidecarSupervisorOptions,
} from './sidecar.ts'
import {
  APP_ORIGIN,
  APP_WEBSOCKET_ORIGIN,
  authorizeRequestHeaders,
  classifyNavigation,
  type RequestHeaders,
} from './security.ts'

/** Minimal cancellable event required by navigation and quit policy. */
export interface NavigationEvent {
  preventDefault(): void
}

/** Request fields consumed by the authorization interceptor. */
export interface BeforeSendHeadersDetails {
  readonly url: string
  readonly requestHeaders: RequestHeaders
}

/**
 * Electron-compatible request interceptor.
 * @param details - Current request URL and headers.
 * @param callback - Completion callback with the final headers.
 */
export type BeforeSendHeadersListener = (
  details: BeforeSendHeadersDetails,
  callback: (response: { readonly requestHeaders: RequestHeaders }) => void,
) => void

/** URL filter used for the application session interceptor. */
export interface RequestFilter {
  readonly urls: readonly string[]
}

/** Security-relevant BrowserWindow construction fields. */
export interface BrowserWindowOptions {
  readonly width: number
  readonly height: number
  readonly minWidth: number
  readonly minHeight: number
  readonly show: boolean
  readonly webPreferences: {
    readonly nodeIntegration: false
    readonly contextIsolation: true
    readonly sandbox: true
  }
}

/** BrowserWindow methods used by desktop lifecycle orchestration. */
export interface DesktopWindow {
  readonly webContents: {
    installBeforeSendHeaders(
      filter: RequestFilter,
      listener: BeforeSendHeadersListener,
    ): void
    onWillNavigate(listener: (event: NavigationEvent, url: string) => void): void
    onWillRedirect(listener: (event: NavigationEvent, url: string) => void): void
    setWindowOpenHandler(
      handler: (details: { readonly url: string }) => { readonly action: 'deny' },
    ): void
  }
  isMinimized(): boolean
  restore(): void
  focus(): void
  onceReadyToShow(listener: () => void): void
  show(): void
  loadURL(url: string): Promise<void>
}

/** Sidecar lifecycle used by the Electron coordinator. */
export interface SidecarProcess {
  start(): Promise<SidecarStartResult>
  shutdown(): Promise<SidecarShutdownResult>
}

/** Token-free startup diagnostic accepted by dialog and logging adapters. */
export interface DesktopStartupReport {
  readonly code:
    | SidecarStartupError['code']
    | 'DESKTOP_ELECTRON_FAILURE'
    | 'DESKTOP_SIDECAR_FAILURE'
    | 'DESKTOP_WINDOW_FAILURE'
    | 'DESKTOP_NAVIGATION_FAILURE'
  readonly message: string
  readonly diagnostics?: SidecarStartupError['diagnostics']
}

/** Token-free shutdown diagnostic accepted by dialog and logging adapters. */
export interface DesktopShutdownReport {
  readonly code: SidecarShutdownError['code'] | 'DESKTOP_SHUTDOWN_FAILURE'
  readonly message: string
}

/** Replaceable Electron and sidecar operations used by the coordinator. */
export interface DesktopRuntime {
  readonly app: {
    requestSingleInstanceLock(): boolean
    whenReady(): Promise<void>
    quit(): void
    onBeforeQuit(listener: (event: NavigationEvent) => void): void
    onSecondInstance(listener: () => void): void
    onWindowAllClosed(listener: () => void): void
  }
  readonly createWindow: (options: BrowserWindowOptions) => DesktopWindow
  readonly createSidecar: (token: string) => SidecarProcess
  readonly createToken: () => string
  readonly openExternal: (url: string) => Promise<void>
  readonly reportStartupFailure: (report: DesktopStartupReport) => void
  readonly reportForcedTermination: () => void
  readonly reportShutdownFailure: (report: DesktopShutdownReport) => void
}

/** Byte generator accepted by the launch-token factory. */
export type RandomBytes = (size: number) => Buffer

/**
 * Create an unpredictable 256-bit token for one Host launch.
 * @param randomBytes - Cryptographic byte generator.
 * @returns A URL-safe token without padding.
 */
export const createLaunchToken = (
  randomBytes: RandomBytes = nodeRandomBytes,
): string => randomBytes(32).toString('base64url')

const WINDOW_OPTIONS: BrowserWindowOptions = {
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
}

const startupReport = (
  error: unknown,
  fallbackCode:
    | 'DESKTOP_ELECTRON_FAILURE'
    | 'DESKTOP_SIDECAR_FAILURE'
    | 'DESKTOP_WINDOW_FAILURE'
    | 'DESKTOP_NAVIGATION_FAILURE',
): DesktopStartupReport => {
  if (error instanceof SidecarStartupError) {
    return {
      code: error.code,
      message: error.message,
      diagnostics: error.diagnostics,
    }
  }
  const fallbackMessages = {
    DESKTOP_ELECTRON_FAILURE: 'The Electron main process could not become ready.',
    DESKTOP_SIDECAR_FAILURE: 'The desktop Host could not be prepared.',
    DESKTOP_WINDOW_FAILURE: 'The desktop application could not create its window.',
    DESKTOP_NAVIGATION_FAILURE: 'The desktop application could not load its local interface.',
  } as const
  return {
    code: fallbackCode,
    message: fallbackMessages[fallbackCode],
  }
}

const shutdownReport = (error: unknown): DesktopShutdownReport => {
  if (error instanceof SidecarShutdownError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'DESKTOP_SHUTDOWN_FAILURE',
    message: 'The desktop Host could not be shut down cleanly.',
  }
}

const configureWindow = (
  window: DesktopWindow,
  runtime: DesktopRuntime,
  token: string,
  onReadyToShow: () => void,
): void => {
  window.webContents.installBeforeSendHeaders(
    { urls: [`${APP_ORIGIN}/*`, `${APP_WEBSOCKET_ORIGIN}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: authorizeRequestHeaders(
          details.url,
          details.requestHeaders,
          token,
        ),
      })
    },
  )
  const enforceNavigationPolicy = (event: NavigationEvent, url: string): void => {
    const policy = classifyNavigation(url)
    if (policy === 'allow-in-app') return
    event.preventDefault()
    if (policy !== 'open-external') return
    void runtime.openExternal(url).catch(() => {
      // An opener failure must not fall back to loading the URL in the application.
    })
  }
  window.webContents.onWillNavigate(enforceNavigationPolicy)
  window.webContents.onWillRedirect(enforceNavigationPolicy)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyNavigation(url) === 'open-external') {
      void runtime.openExternal(url).catch(() => {
        // A failed opener must leave the popup denied.
      })
    }
    return { action: 'deny' }
  })
  window.onceReadyToShow(onReadyToShow)
}

/**
 * Start and own one Electron desktop lifecycle.
 * @param runtime - Injected Electron, sidecar, token, and reporting adapters.
 */
export const startDesktop = async (runtime: DesktopRuntime): Promise<void> => {
  if (!runtime.app.requestSingleInstanceLock()) {
    runtime.app.quit()
    return
  }

  let window: DesktopWindow | undefined
  let sidecar: SidecarProcess | undefined
  let shutdown: Promise<void> | undefined
  let finalQuit = false
  const lifecycle = { quitRequested: false }
  let secondInstancePending = false
  let windowReady = false

  const isQuitRequested = (): boolean => lifecycle.quitRequested
  const completeQuit = (): void => {
    finalQuit = true
    runtime.app.quit()
  }
  const focusWindow = (): void => {
    if (isQuitRequested()) return
    if (window === undefined || !windowReady) {
      secondInstancePending = true
      return
    }
    secondInstancePending = false
    if (window.isMinimized()) window.restore()
    window.focus()
  }
  const beginShutdown = (): void => {
    if (shutdown !== undefined) return
    if (sidecar === undefined) {
      completeQuit()
      return
    }
    shutdown = sidecar.shutdown()
      .then((result) => {
        if (result.forcedTermination) runtime.reportForcedTermination()
      })
      .catch((error: unknown) => {
        runtime.reportShutdownFailure(shutdownReport(error))
      })
      .then(completeQuit)
  }
  runtime.app.onBeforeQuit((event) => {
    if (finalQuit) return
    event.preventDefault()
    lifecycle.quitRequested = true
    beginShutdown()
  })
  runtime.app.onSecondInstance(() => {
    focusWindow()
  })
  runtime.app.onWindowAllClosed(() => {
    runtime.app.quit()
  })

  try {
    await runtime.app.whenReady()
  } catch (error: unknown) {
    if (isQuitRequested()) return
    runtime.reportStartupFailure(startupReport(error, 'DESKTOP_ELECTRON_FAILURE'))
    runtime.app.quit()
    return
  }
  if (isQuitRequested()) return
  let token: string
  try {
    token = runtime.createToken()
    sidecar = runtime.createSidecar(token)
    await sidecar.start()
  } catch (error: unknown) {
    if (isQuitRequested()) return
    runtime.reportStartupFailure(startupReport(error, 'DESKTOP_SIDECAR_FAILURE'))
    runtime.app.quit()
    return
  }
  if (isQuitRequested()) return

  try {
    window = runtime.createWindow(WINDOW_OPTIONS)
    configureWindow(window, runtime, token, () => {
      if (isQuitRequested()) return
      windowReady = true
      window?.show()
      if (secondInstancePending) focusWindow()
    })
  } catch (error: unknown) {
    runtime.reportStartupFailure(startupReport(error, 'DESKTOP_WINDOW_FAILURE'))
    runtime.app.quit()
    return
  }

  try {
    await window.loadURL(APP_ORIGIN)
  } catch (error: unknown) {
    if (isQuitRequested()) return
    runtime.reportStartupFailure(startupReport(error, 'DESKTOP_NAVIGATION_FAILURE'))
    runtime.app.quit()
  }
}

type ElectronModule = typeof import('electron')

/** Runtime-factory options for staged Host paths and lifecycle bounds. */
export interface ElectronRuntimeOptions {
  readonly sidecar: SidecarSupervisorOptions
  readonly sidecarDependencies?: Partial<SidecarDependencies>
}

/** Inputs used to locate the staged Host runtime. */
export interface DesktopSidecarPathOptions {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly platform: NodeJS.Platform
  readonly stageRootOverride?: string | undefined
  readonly readStageVersion?: ((path: string) => string) | undefined
}

/** Electron paths required to build the default desktop sidecar configuration. */
export interface DesktopSidecarOptionsInput extends DesktopSidecarPathOptions {
  /** Electron application-data directory reserved for this desktop application. */
  readonly userDataPath: string
}

/**
 * Resolve the bundled or development Host runtime without ambient executables.
 * @param options - Electron installation paths, platform, and optional stage override.
 * @returns Executable and CLI paths within one stage root.
 */
export const resolveDesktopSidecarPaths = (
  options: DesktopSidecarPathOptions,
): Pick<SidecarSupervisorOptions, 'nodeExecutable' | 'cliEntry'> => {
  const stageRoot = options.stageRootOverride === undefined
    ? options.isPackaged
      ? resolve(options.resourcesPath, 'sidecar')
      : resolveDevelopmentStageRoot(options)
    : resolve(options.stageRootOverride)
  return {
    nodeExecutable: resolve(
      stageRoot,
      'node/bin',
      options.platform === 'win32' ? 'node.exe' : 'node',
    ),
    cliEntry: resolve(stageRoot, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  }
}

const resolveDevelopmentStageRoot = (
  options: DesktopSidecarPathOptions,
): string => {
  const stageDirectory = resolve(options.appPath, '.stage')
  const readStageVersion = options.readStageVersion
    ?? ((path: string): string => readFileSync(path, 'utf8'))
  const versionName = readStageVersion(resolve(stageDirectory, 'current')).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(versionName)) {
    throw new Error('desktop stage pointer is invalid')
  }
  return resolve(stageDirectory, 'versions', versionName)
}

/**
 * Build the fixed lifecycle policy and isolated data root for the desktop Host.
 * @param input - Electron runtime, application, and user-data paths.
 * @returns Sidecar options consumed by the Electron runtime.
 */
export const createDesktopSidecarOptions = (
  input: DesktopSidecarOptionsInput,
): ElectronRuntimeOptions => {
  const paths = resolveDesktopSidecarPaths(input)
  return {
    sidecar: {
      ...paths,
      bundledSkillDirectory: resolve(dirname(paths.nodeExecutable), '../../app/skills'),
      harnessHome: resolve(input.userDataPath, 'dsh'),
      startupTimeoutMs: 10_000,
      readinessConfirmationMs: 100,
      stderrTailBytes: 8_192,
      shutdownGraceMs: 2_000,
      terminationGraceMs: 2_000,
      killGraceMs: 1_000,
    },
  }
}

const adaptWindow = (window: ElectronBrowserWindow): DesktopWindow => ({
  webContents: {
    installBeforeSendHeaders: (filter, listener) => {
      window.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: [...filter.urls] },
        (details, callback) => {
          listener({
            url: details.url,
            requestHeaders: details.requestHeaders,
          }, (response) => {
            callback(response)
          })
        },
      )
    },
    onWillNavigate: (listener) => {
      window.webContents.on('will-navigate', (event, url) => {
        listener(event, url)
      })
    },
    onWillRedirect: (listener) => {
      window.webContents.on('will-redirect', (event, url) => {
        listener(event, url)
      })
    },
    setWindowOpenHandler: (handler) => {
      window.webContents.setWindowOpenHandler(details => handler(details))
    },
  },
  isMinimized: () => window.isMinimized(),
  restore: () => {
    window.restore()
  },
  focus: () => {
    window.focus()
  },
  onceReadyToShow: (listener) => {
    window.once('ready-to-show', listener)
  },
  show: () => {
    window.show()
  },
  loadURL: url => window.loadURL(url),
})

/**
 * Bind real Electron APIs and staged sidecar options to the testable runtime.
 * @param electron - Electron main-process module.
 * @param options - Staged Host paths, lifecycle bounds, and optional process adapters.
 * @returns Runtime consumed by `startDesktop`.
 */
export const createElectronRuntime = (
  electron: ElectronModule,
  options: ElectronRuntimeOptions,
): DesktopRuntime => ({
  app: {
    requestSingleInstanceLock: () => electron.app.requestSingleInstanceLock(),
    whenReady: () => electron.app.whenReady(),
    quit: () => {
      electron.app.quit()
    },
    onBeforeQuit: (listener) => {
      electron.app.on('before-quit', (event) => {
        listener(event)
      })
    },
    onSecondInstance: (listener) => {
      electron.app.on('second-instance', listener)
    },
    onWindowAllClosed: (listener) => {
      electron.app.on('window-all-closed', listener)
    },
  },
  createWindow: windowOptions => adaptWindow(
    new electron.BrowserWindow(windowOptions),
  ),
  createSidecar: token => new SidecarSupervisor(
    options.sidecar,
    options.sidecarDependencies ?? {},
    token,
  ),
  createToken: () => createLaunchToken(),
  openExternal: url => electron.shell.openExternal(url),
  reportStartupFailure: (report) => {
    const diagnostic = JSON.stringify(report)
    console.error(`desktop startup failed: ${diagnostic}`)
    electron.dialog.showErrorBox(
      'DeepSeek Harness could not start',
      `${report.code}: ${report.message}`,
    )
  },
  reportForcedTermination: () => {
    console.warn('desktop Host required forced termination during shutdown')
  },
  reportShutdownFailure: (report) => {
    console.error(`desktop shutdown failed: ${JSON.stringify(report)}`)
    electron.dialog.showErrorBox(
      'DeepSeek Harness shutdown failed',
      `${report.code}: ${report.message}`,
    )
  },
})

const defaultSidecarOptions = (
  electron: ElectronModule,
): ElectronRuntimeOptions =>
  createDesktopSidecarOptions({
    isPackaged: electron.app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: electron.app.getAppPath(),
    userDataPath: electron.app.getPath('userData'),
    platform: process.platform,
    stageRootOverride: process.env.DSH_DESKTOP_SIDECAR_ROOT,
  })

if (Object.hasOwn(process.versions, 'electron')) {
  void import('electron').then(electron =>
    startDesktop(createElectronRuntime(electron, defaultSidecarOptions(electron))),
  )
}
