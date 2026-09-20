/** Dedicated Electron mode for one ephemeral public browser window. */

import { createInterface } from 'node:readline'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'

/** Command-line marker that selects the browser worker instead of the desktop shell. */
const BROWSER_WORKER_FLAG = '--dsh-browser-worker'
const BROWSER_PROFILE_PREFIX = '--dsh-browser-profile='

/**
 * Test whether one Electron argv selects the isolated browser worker.
 * @param argv - Process argument vector.
 * @returns True only when the exact worker marker is present.
 */
export const isBrowserWorkerProcess = (argv: readonly string[]): boolean =>
  argv.includes(BROWSER_WORKER_FLAG)

/**
 * Resolve the private profile path supplied by the owning Host.
 * @param argv - Process argument vector.
 * @returns The sole non-empty browser profile path.
 */
export const resolveBrowserWorkerProfile = (argv: readonly string[]): string => {
  const values = argv
    .filter(argument => argument.startsWith(BROWSER_PROFILE_PREFIX))
    .map(argument => argument.slice(BROWSER_PROFILE_PREFIX.length))
  if (values.length !== 1 || values[0] === '') {
    throw new Error('browser worker requires exactly one non-empty browser profile')
  }
  return values[0] as string
}

/** Exact stdin command accepted by the browser worker. */
interface BrowserWorkerPermitNavigation {
  readonly type: 'permit-navigation'
  readonly url: string | null
  readonly requestId: number
}

/** Request the navigation decision accumulated since the prior inspection. */
interface BrowserWorkerInspectNavigation {
  readonly type: 'inspect-navigation'
  readonly requestId: number
}

/** Browser worker control command. */
export type BrowserWorkerCommand =
  | BrowserWorkerPermitNavigation
  | BrowserWorkerInspectNavigation

/** Report emitted when the worker rejects one top-level navigation. */
export interface BrowserWorkerBlockedNavigation {
  readonly attemptedUrl: string
  readonly currentUrl: string
  readonly pageUsable: boolean
}

/** Correlated response for one navigation inspection. */
export interface BrowserWorkerNavigationStatus {
  readonly type: 'navigation-status'
  readonly requestId: number
  readonly blocked: BrowserWorkerBlockedNavigation | null
}

/**
 * Encode one browser-worker event for the Provider's private stdout protocol.
 * @param event - Navigation rejection observed by Electron.
 * @returns One newline-terminated protocol record.
 */
export const encodeBrowserWorkerEvent = (
  event: BrowserWorkerNavigationStatus,
): string => `dsh-browser-worker:event ${JSON.stringify(event)}\n`

const credentialFreeWebOrigin = (input: string): string => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('browser navigation must use a credential-free HTTP or HTTPS URL')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new Error('browser navigation must use a credential-free HTTP or HTTPS URL')
  }
  return url.origin
}

/**
 * Parse one line from the private worker control stream.
 * @param line - UTF-8 JSON line from stdin.
 * @returns Validated worker command.
 */
export const parseBrowserWorkerCommand = (line: string): BrowserWorkerCommand => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('invalid browser worker command')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid browser worker command')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length === 2
    && record['type'] === 'inspect-navigation'
    && typeof record['requestId'] === 'number'
    && Number.isSafeInteger(record['requestId'])
    && record['requestId'] > 0
  ) {
    return {
      type: 'inspect-navigation',
      requestId: record['requestId'],
    }
  }
  if (
    Object.keys(record).length !== 3
    || record['type'] !== 'permit-navigation'
    || (record['url'] !== null && typeof record['url'] !== 'string')
    || typeof record['requestId'] !== 'number'
    || !Number.isSafeInteger(record['requestId'])
    || record['requestId'] <= 0
  ) {
    throw new Error('invalid browser worker command')
  }
  return {
    type: 'permit-navigation',
    url: record['url'],
    requestId: record['requestId'],
  }
}

/**
 * Stateful top-level origin policy. A permit admits the next new origin; once
 * navigation starts, only that origin remains active until another permit.
 */
export class BrowserNavigationPolicy {
  #currentOrigin: string | undefined
  #preparedOrigin: string | undefined

  /**
   * Permit one origin for the next top-level navigation.
   * @param url - Inspected destination URL.
   */
  prepare(url: string): void {
    this.#preparedOrigin = credentialFreeWebOrigin(url)
  }

  /** Revoke an unused permit when its approved action settles. */
  revoke(): void {
    this.#preparedOrigin = undefined
  }

  /**
   * Decide one attempted top-level navigation and advance the active origin.
   * @param url - Attempted navigation URL.
   * @returns Whether the worker may continue the navigation.
   */
  authorize(url: string): boolean {
    let origin: string
    try {
      origin = credentialFreeWebOrigin(url)
    } catch {
      return false
    }
    if (origin === this.#currentOrigin) return true
    if (origin !== this.#preparedOrigin) return false
    this.#currentOrigin = origin
    this.#preparedOrigin = undefined
    return true
  }
}

/** Electron APIs used by the isolated worker entrypoint. */
export interface BrowserWorkerElectron {
  readonly app: {
    readonly commandLine: {
      appendSwitch(name: string, value?: string): void
    }
    setPath(name: 'userData', path: string): void
    whenReady(): Promise<void>
    exit(code?: number): void
    quit(): void
  }
  readonly BrowserWindow: new (options: {
    readonly width: number
    readonly height: number
    readonly show: boolean
    readonly webPreferences: {
      readonly nodeIntegration: false
      readonly contextIsolation: true
      readonly sandbox: true
    }
  }) => ElectronBrowserWindow
}

/**
 * Install the browser worker's fail-closed window policy.
 * @param window - Dedicated browser window.
 * @param policy - Stateful top-level origin policy.
 * @param reportBlocked - Sink for rejected navigation facts.
 * @param onRendererGone - Fatal renderer-exit handler.
 * @param onClosed - Visible-window close handler.
 */
export const configureBrowserWorkerWindow = (
  window: ElectronBrowserWindow,
  policy: BrowserNavigationPolicy,
  reportBlocked: (blocked: BrowserWorkerBlockedNavigation) => void,
  onRendererGone: () => void,
  onClosed: () => void,
): void => {
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.webContents.session.on('will-download', (event) => {
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const blockNavigation = (event: { preventDefault(): void }, url: string): void => {
    event.preventDefault()
    reportBlocked({
      attemptedUrl: url,
      currentUrl: window.webContents.getURL(),
      pageUsable: !window.isDestroyed() && !window.webContents.isDestroyed(),
    })
  }
  window.webContents.on('will-navigate', (event, url) => {
    if (!policy.authorize(url)) blockNavigation(event, url)
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!policy.authorize(url)) blockNavigation(event, url)
  })
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  window.webContents.on('render-process-gone', onRendererGone)
  window.on('closed', onClosed)
}

/**
 * Run the dedicated visible browser process until its window or stdin closes.
 * @param electron - Electron main-process APIs.
 */
export const runBrowserWorker = async (
  electron: BrowserWorkerElectron,
  argv: readonly string[] = process.argv,
): Promise<void> => {
  electron.app.setPath('userData', resolveBrowserWorkerProfile(argv))
  electron.app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  electron.app.commandLine.appendSwitch('remote-debugging-port', '0')
  await electron.app.whenReady()

  const policy = new BrowserNavigationPolicy()
  let blockedNavigation: BrowserWorkerBlockedNavigation | undefined
  const window = new electron.BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  configureBrowserWorkerWindow(
    window,
    policy,
    (blocked) => { blockedNavigation = blocked },
    () => { electron.app.exit(1) },
    () => { electron.app.quit() },
  )

  await window.loadURL('about:blank')

  const reportNavigationStatus = async (requestId: number): Promise<void> => {
    await window.webContents.executeJavaScript('undefined')
    process.stdout.write(encodeBrowserWorkerEvent({
      type: 'navigation-status',
      requestId,
      blocked: blockedNavigation ?? null,
    }))
    blockedNavigation = undefined
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    try {
      const command = parseBrowserWorkerCommand(line)
      if (command.type === 'permit-navigation') {
        if (command.url === null) policy.revoke()
        else policy.prepare(command.url)
        process.stdout.write(encodeBrowserWorkerEvent({
          type: 'navigation-status',
          requestId: command.requestId,
          blocked: null,
        }))
        return
      }
      void reportNavigationStatus(command.requestId).catch(() => {
        electron.app.exit(2)
      })
    } catch {
      electron.app.exit(2)
    }
  })
  lines.on('close', () => {
    window.close()
  })

  process.stdout.write('dsh-browser-worker: ready\n')
}
