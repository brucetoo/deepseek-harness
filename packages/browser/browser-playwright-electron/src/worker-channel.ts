/** Private control and event protocol for the desktop browser worker. */

import { StringDecoder } from 'node:string_decoder'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { BrowserError } from '@deepseek-ai/dsh-browser'

/** One top-level navigation rejected by the Electron worker. */
export interface BlockedNavigation {
  readonly attemptedUrl: string
  readonly currentUrl: string
  readonly pageUsable: boolean
}

interface NavigationStatus {
  readonly type: 'navigation-status'
  readonly requestId: number
  readonly blocked: BlockedNavigation | null
}

interface PendingInspection {
  readonly resolve: (blocked: BlockedNavigation | undefined) => void
  readonly reject: (error: unknown) => void
  readonly timer: NodeJS.Timeout
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
}

const EVENT_PREFIX = 'dsh-browser-worker:event '
const WORKER_READY_LINE = 'dsh-browser-worker: ready'
const CDP_LINE = /^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)$/

const protocolError = (cause: unknown): Error =>
  cause instanceof Error
    ? cause
    : new BrowserError('browser worker failed with a non-Error reason', 'BROWSER_WORKER_PROTOCOL', { cause })

/**
 * Await both the worker marker and random loopback CDP endpoint.
 * @param process - Spawned Electron worker.
 * @param timeoutMs - Launch deadline.
 * @param maxBytes - Combined readiness output bound.
 * @param signal - Optional launch cancellation.
 * @returns The loopback CDP endpoint.
 */
export const waitForWorkerReadiness = (
  process: SubprocessHandle,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> => new Promise((resolve, reject) => {
  const stdout = process.stdout
  const stderr = process.stderr
  if (stdout === undefined || stderr === undefined) {
    reject(new BrowserError('browser worker requires piped stdout and stderr', 'BROWSER_LAUNCH_FAILED'))
    return
  }
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stdoutPending = ''
  let stderrPending = ''
  let retainedBytes = 0
  let workerReady = false
  let endpoint: string | undefined
  let settled = false

  const finish = (error?: unknown): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    stdout.off('data', onStdout)
    stderr.off('data', onStderr)
    if (error === undefined) resolve(endpoint as string)
    else reject(protocolError(error))
  }
  const inspect = (stream: 'stdout' | 'stderr', line: string): void => {
    if (stream === 'stdout' && line === WORKER_READY_LINE) workerReady = true
    if (stream === 'stderr') endpoint = CDP_LINE.exec(line)?.[1] ?? endpoint
    if (workerReady && endpoint !== undefined) finish()
  }
  const consume = (
    stream: 'stdout' | 'stderr',
    pending: string,
    chunk: Buffer | string,
    decoder: StringDecoder,
  ): string => {
    retainedBytes += Buffer.byteLength(chunk)
    if (retainedBytes > maxBytes) {
      finish(new BrowserError('browser worker readiness exceeded its output bound', 'BROWSER_LAUNCH_FAILED'))
      return ''
    }
    let value = pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk))
    for (let newline = value.indexOf('\n'); newline !== -1; newline = value.indexOf('\n')) {
      const line = value.slice(0, newline).replace(/\r$/u, '')
      value = value.slice(newline + 1)
      inspect(stream, line)
      if (settled) break
    }
    return value
  }
  const onStdout = (chunk: Buffer | string): void => {
    stdoutPending = consume('stdout', stdoutPending, chunk, stdoutDecoder)
  }
  const onStderr = (chunk: Buffer | string): void => {
    stderrPending = consume('stderr', stderrPending, chunk, stderrDecoder)
  }
  const onAbort = (): void => {
    finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  const timer = setTimeout(() => {
    finish(new BrowserError('browser worker did not become ready before the launch deadline', 'BROWSER_LAUNCH_TIMEOUT'))
  }, timeoutMs)
  stdout.on('data', onStdout)
  stderr.on('data', onStderr)
  signal?.addEventListener('abort', onAbort, { once: true })
  void process.done.then(
    (outcome) => {
      finish(new BrowserError(
        `browser worker exited before readiness (${outcome.exitCode ?? outcome.signal ?? 'unknown'})`,
        'BROWSER_LAUNCH_FAILED',
      ))
    },
    (cause: unknown) => {
      finish(new BrowserError('browser worker failed before readiness', 'BROWSER_LAUNCH_FAILED', { cause }))
    },
  )
})

/**
 * Parse one prefixed worker event.
 * @param line - Complete UTF-8 stdout line.
 * @returns A validated navigation status, or undefined for unrelated output.
 */
export const parseBrowserWorkerEvent = (
  line: string,
): NavigationStatus | undefined => {
  if (!line.startsWith(EVENT_PREFIX)) return undefined
  let value: unknown
  try {
    value = JSON.parse(line.slice(EVENT_PREFIX.length))
  } catch (cause: unknown) {
    throw new BrowserError('browser worker emitted malformed event JSON', 'BROWSER_WORKER_PROTOCOL', { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserError('browser worker emitted an invalid event', 'BROWSER_WORKER_PROTOCOL')
  }
  const record = value as Record<string, unknown>
  const blocked = record['blocked']
  const validBlocked = blocked === null || (
    typeof blocked === 'object'
    && !Array.isArray(blocked)
    && Object.keys(blocked).length === 3
    && typeof (blocked as Record<string, unknown>)['attemptedUrl'] === 'string'
    && typeof (blocked as Record<string, unknown>)['currentUrl'] === 'string'
    && typeof (blocked as Record<string, unknown>)['pageUsable'] === 'boolean'
  )
  if (
    Object.keys(record).length !== 3
    || record['type'] !== 'navigation-status'
    || typeof record['requestId'] !== 'number'
    || !Number.isSafeInteger(record['requestId'])
    || record['requestId'] <= 0
    || !validBlocked
  ) {
    throw new BrowserError('browser worker emitted an invalid event', 'BROWSER_WORKER_PROTOCOL')
  }
  return record as unknown as NavigationStatus
}

/**
 * Correlated navigation-policy channel over one worker's piped stdio.
 * Inspections are barriers: the response is emitted after all earlier worker
 * commands and navigation callbacks have run.
 */
export class BrowserWorkerChannel {
  private readonly pending = new Map<number, PendingInspection>()
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private nextRequestId = 0
  private closed = false

  constructor(
    private readonly process: SubprocessHandle,
    private readonly timeoutMs: number,
    private readonly maxBytes: number,
  ) {
    if (process.stdin === undefined || process.stdout === undefined) {
      throw new BrowserError('browser worker requires piped control streams', 'BROWSER_WORKER_PROTOCOL')
    }
    process.stdout.on('data', this.onData)
    void process.done.then(
      () => {
        this.fail(new BrowserError('browser worker closed its event stream', 'BROWSER_WORKER_CLOSED'))
      },
      (cause: unknown) => {
        this.fail(new BrowserError('browser worker event stream failed', 'BROWSER_WORKER_CLOSED', { cause }))
      },
    )
  }

  /**
   * Inspect policy decisions made since the prior correlated response.
   * @param signal - Cancellation of the inspection wait.
   * @returns The latest rejected navigation, when one occurred.
   */
  inspectNavigation(signal?: AbortSignal): Promise<BlockedNavigation | undefined> {
    return this.request({ type: 'inspect-navigation' }, signal)
  }

  /**
   * Install or revoke a permit and wait for the worker's acknowledgement.
   * @param url - Inspected destination, or null to revoke any unused permit.
   * @param signal - Cancellation of the acknowledgement wait.
   */
  async setNavigationPermit(url: string | null, signal?: AbortSignal): Promise<void> {
    await this.request({ type: 'permit-navigation', url }, signal)
  }

  private request(
    command: { readonly type: 'inspect-navigation' } | {
      readonly type: 'permit-navigation'
      readonly url: string | null
    },
    signal?: AbortSignal,
  ): Promise<BlockedNavigation | undefined> {
    signal?.throwIfAborted()
    const stdin = this.process.stdin
    if (this.closed || stdin === undefined || stdin.destroyed) {
      return Promise.reject(new BrowserError('browser worker control stream is unavailable', 'BROWSER_WORKER_CLOSED'))
    }
    const requestId = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.settle(requestId, signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        this.settle(
          requestId,
          new BrowserError('browser worker did not answer navigation inspection', 'BROWSER_WORKER_TIMEOUT'),
        )
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      stdin.write(`${JSON.stringify({ ...command, requestId })}\n`)
    })
  }

  /** Stop reading worker events and reject outstanding inspections. */
  dispose(): void {
    this.fail(new BrowserError('browser worker event channel was disposed', 'BROWSER_WORKER_CLOSED'))
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (Buffer.byteLength(this.buffer) > this.maxBytes) {
      this.fail(new BrowserError('browser worker event exceeded its output bound', 'BROWSER_WORKER_PROTOCOL'))
      return
    }
    for (let newline = this.buffer.indexOf('\n'); newline !== -1; newline = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      let event: NavigationStatus | undefined
      try {
        event = parseBrowserWorkerEvent(line)
      } catch (error: unknown) {
        this.fail(error)
        return
      }
      if (event !== undefined) this.settle(event.requestId, undefined, event.blocked ?? undefined)
    }
  }

  private settle(
    requestId: number,
    error?: unknown,
    blocked?: BlockedNavigation,
  ): void {
    const inspection = this.pending.get(requestId)
    if (inspection === undefined) return
    this.pending.delete(requestId)
    clearTimeout(inspection.timer)
    inspection.signal?.removeEventListener('abort', inspection.onAbort)
    if (error === undefined) inspection.resolve(blocked)
    else inspection.reject(protocolError(error))
  }

  private fail(error: unknown): void {
    if (this.closed) return
    this.closed = true
    this.process.stdout?.off('data', this.onData)
    for (const requestId of this.pending.keys()) this.settle(requestId, error)
  }
}
