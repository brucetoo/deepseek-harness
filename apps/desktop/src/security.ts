/** Framework-independent request and navigation policy for the desktop shell. */

/** Exact loopback origin served by the desktop Host. */
export const APP_ORIGIN = 'http://127.0.0.1:37615'

/** Exact loopback WebSocket origin served by the desktop Host. */
export const APP_WEBSOCKET_ORIGIN = 'ws://127.0.0.1:37615'

/** Header values accepted by Electron's request interception API. */
export type RequestHeaders = Record<string, string | string[]>

/** Navigation outcomes enforced by the Electron main process. */
export type NavigationPolicy = 'allow-in-app' | 'open-external' | 'deny'

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

const isCredentialFree = (url: URL): boolean =>
  url.username.length === 0 && url.password.length === 0

const isApplicationRequest = (url: URL): boolean =>
  isCredentialFree(url)
  && url.hostname === '127.0.0.1'
  && url.port === '37615'
  && (url.protocol === 'http:' || url.protocol === 'ws:')

/**
 * Add the desktop bearer token to HTTP and WebSocket requests for the exact application endpoint.
 * @param url - Current request URL, including any redirect destination.
 * @param headers - Existing request headers.
 * @param token - Per-launch bearer token.
 * @returns A copied header map for the request.
 */
export const authorizeRequestHeaders = (
  url: string,
  headers: Readonly<RequestHeaders>,
  token: string,
): RequestHeaders => {
  const parsed = parseUrl(url)
  if (parsed === undefined || !isApplicationRequest(parsed)) {
    return { ...headers }
  }

  const authorized = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  )
  authorized.Authorization = `Bearer ${token}`
  return authorized
}

/**
 * Classify a requested top-level navigation.
 * @param url - Requested navigation URL.
 * @returns Whether Electron keeps, externally opens, or denies the URL.
 */
export const classifyNavigation = (url: string): NavigationPolicy => {
  const parsed = parseUrl(url)
  if (parsed === undefined || !isCredentialFree(parsed)) return 'deny'
  if (parsed.origin === APP_ORIGIN) return 'allow-in-app'
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return 'open-external'
  }
  return 'deny'
}
