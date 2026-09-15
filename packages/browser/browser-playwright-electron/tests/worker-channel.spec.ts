import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  BrowserWorkerChannel,
  parseBrowserWorkerEvent,
  waitForWorkerReadiness,
} from '../src/worker-channel.ts'

interface ProcessHarness {
  readonly process: SubprocessHandle
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly writes: string[]
  readonly exit: (exitCode?: number | null, signal?: NodeJS.Signals | null) => void
  readonly fail: (cause: unknown) => void
}

const createProcess = (): ProcessHarness => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const writes: string[] = []
  stdin.on('data', (chunk: Buffer | string) => {
    writes.push(chunk.toString())
  })
  const done = Promise.withResolvers<{
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
  }>()
  return {
    process: {
      pid: 123,
      stdin,
      stdout,
      stderr,
      collected: {},
      done: done.promise,
      terminate: () => {},
      waitForExit: async () => false,
    },
    stdin,
    stdout,
    stderr,
    writes,
    exit: (exitCode = 0, signal = null) => {
      done.resolve({ exitCode, signal })
    },
    fail: (cause) => {
      done.reject(cause)
    },
  }
}

const eventLine = (
  requestId: number,
  blocked: {
    readonly attemptedUrl: string
    readonly currentUrl: string
    readonly pageUsable: boolean
  } | null = null,
): string => `dsh-browser-worker:event ${JSON.stringify({
  type: 'navigation-status',
  requestId,
  blocked,
})}\n`

describe('waitForWorkerReadiness', () => {
  it('requires both piped output streams', async () => {
    const harness = createProcess()
    const withoutStdout = { ...harness.process, stdout: undefined }

    await expect(waitForWorkerReadiness(withoutStdout, 100, 1_024)).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
    })
  })

  it('accepts split CRLF markers in either arrival order', async () => {
    const first = createProcess()
    const firstReady = waitForWorkerReadiness(first.process, 100, 1_024)
    first.stdout.write(Buffer.from('dsh-browser-worker: rea'))
    first.stdout.write(Buffer.from('dy\r\n'))
    first.stderr.write('ignored diagnostic\n')
    first.stderr.write('DevTools listening on ws://127.0.0.1:49152/devtools/browser/test\n')
    await expect(firstReady).resolves.toBe(
      'ws://127.0.0.1:49152/devtools/browser/test',
    )
    first.exit()
    await Promise.resolve()

    const second = createProcess()
    const secondReady = waitForWorkerReadiness(second.process, 100, 1_024)
    second.stderr.write('DevTools listening on ws://127.0.0.1:49153/devtools/browser/other\n')
    second.stderr.write('unrelated stderr after endpoint\n')
    second.stdout.write('dsh-browser-worker: ready\n')
    await expect(secondReady).resolves.toBe(
      'ws://127.0.0.1:49153/devtools/browser/other',
    )
  })

  it('rejects excessive readiness output', async () => {
    const harness = createProcess()
    const ready = waitForWorkerReadiness(harness.process, 100, 4)
    harness.stdout.write('noise\n')

    await expect(ready).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
    })
  })

  it('bounds startup output even when the worker never writes a newline', async () => {
    const harness = createProcess()
    const ready = waitForWorkerReadiness(harness.process, 100, 8)
    harness.stderr.write('1234')
    harness.stderr.write('56789')

    await expect(ready).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
    })
  })

  it('rejects launch timeout, cancellation, and early process completion', async () => {
    vi.useFakeTimers()
    try {
      const timedOut = createProcess()
      const timeout = waitForWorkerReadiness(timedOut.process, 10, 1_024)
      const timeoutExpectation = expect(timeout).rejects.toMatchObject({
        code: 'BROWSER_LAUNCH_TIMEOUT',
      })
      await vi.advanceTimersByTimeAsync(10)
      await timeoutExpectation

      const cancelled = createProcess()
      const controller = new AbortController()
      const reason = new Error('cancel launch')
      const abort = waitForWorkerReadiness(cancelled.process, 100, 1_024, controller.signal)
      controller.abort(reason)
      await expect(abort).rejects.toBe(reason)

      const exited = createProcess()
      const exit = waitForWorkerReadiness(exited.process, 100, 1_024)
      exited.exit(null, 'SIGTERM')
      await expect(exit).rejects.toThrow(/SIGTERM/)

      const unknownExit = createProcess()
      const unknown = waitForWorkerReadiness(unknownExit.process, 100, 1_024)
      unknownExit.exit(null, null)
      await expect(unknown).rejects.toThrow(/unknown/)

      const failed = createProcess()
      const cause = new Error('spawn monitor failed')
      const failure = waitForWorkerReadiness(failed.process, 100, 1_024)
      failed.fail(cause)
      await expect(failure).rejects.toMatchObject({
        code: 'BROWSER_LAUNCH_FAILED',
        cause,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses standard abort errors when a signal provides no reason', async () => {
    const harness = createProcess()
    const signal = new EventTarget() as EventTarget & AbortSignal
    Object.assign(signal, {
      aborted: false,
      reason: undefined,
      throwIfAborted: () => {},
      onabort: null,
    })
    const ready = waitForWorkerReadiness(harness.process, 100, 1_024, signal)

    signal.dispatchEvent(new Event('abort'))

    await expect(ready).rejects.toMatchObject({
      name: 'AbortError',
    })

    const nonErrorHarness = createProcess()
    const nonErrorSignal = new EventTarget() as EventTarget & AbortSignal
    Object.assign(nonErrorSignal, {
      aborted: false,
      reason: 'cancelled',
      throwIfAborted: () => {},
      onabort: null,
    })
    const normalized = waitForWorkerReadiness(
      nonErrorHarness.process,
      100,
      1_024,
      nonErrorSignal,
    )
    nonErrorSignal.dispatchEvent(new Event('abort'))
    await expect(normalized).rejects.toMatchObject({
      code: 'BROWSER_WORKER_PROTOCOL',
      cause: 'cancelled',
    })
  })

  it('accepts string chunks from decoded process streams', async () => {
    const harness = createProcess()
    const ready = waitForWorkerReadiness(harness.process, 100, 1_024)

    harness.stdout.emit('data', 'dsh-browser-worker: ready\n')
    harness.stderr.emit(
      'data',
      'DevTools listening on ws://127.0.0.1:49154/devtools/browser/string\n',
    )

    await expect(ready).resolves.toBe(
      'ws://127.0.0.1:49154/devtools/browser/string',
    )
  })
})

describe('browser worker command and event protocol', () => {
  it('acknowledges permits and revocation and rejects a closed control stream', async () => {
    const harness = createProcess()
    const channel = new BrowserWorkerChannel(harness.process, 100, 1_024)

    const permit = channel.setNavigationPermit('https://example.com/')
    expect(harness.writes).toEqual([
      '{"type":"permit-navigation","url":"https://example.com/","requestId":1}\n',
    ])
    harness.stdout.write(eventLine(1))
    await permit

    const revoke = channel.setNavigationPermit(null)
    expect(harness.writes.at(-1)).toBe(
      '{"type":"permit-navigation","url":null,"requestId":2}\n',
    )
    harness.stdout.write(eventLine(2))
    await revoke

    harness.stdin.destroy()
    await expect(channel.setNavigationPermit(null)).rejects.toMatchObject({
      code: 'BROWSER_WORKER_CLOSED',
    })
    channel.dispose()
  })

  it('ignores ordinary output and parses null or blocked navigation statuses', () => {
    expect(parseBrowserWorkerEvent('ordinary output')).toBeUndefined()
    expect(parseBrowserWorkerEvent(eventLine(1).trimEnd())).toEqual({
      type: 'navigation-status',
      requestId: 1,
      blocked: null,
    })
    expect(parseBrowserWorkerEvent(eventLine(2, {
      attemptedUrl: 'https://other.test/',
      currentUrl: 'https://example.com/',
      pageUsable: true,
    }).trimEnd())).toEqual({
      type: 'navigation-status',
      requestId: 2,
      blocked: {
        attemptedUrl: 'https://other.test/',
        currentUrl: 'https://example.com/',
        pageUsable: true,
      },
    })
  })

  it.each([
    'dsh-browser-worker:event {',
    'dsh-browser-worker:event null',
    'dsh-browser-worker:event []',
    'dsh-browser-worker:event {"type":"other","requestId":1,"blocked":null}',
    'dsh-browser-worker:event {"type":"navigation-status","requestId":0,"blocked":null}',
    'dsh-browser-worker:event {"type":"navigation-status","requestId":1.5,"blocked":null}',
    'dsh-browser-worker:event {"type":"navigation-status","requestId":1,"blocked":[]}',
    'dsh-browser-worker:event {"type":"navigation-status","requestId":1,"blocked":{"attemptedUrl":"https://other.test/","currentUrl":"https://example.com/","pageUsable":true,"extra":true}}',
  ])('rejects malformed or non-canonical event %s', (line) => {
    expect(() => parseBrowserWorkerEvent(line)).toThrow(
      expect.objectContaining({ code: 'BROWSER_WORKER_PROTOCOL' }),
    )
  })
})

describe('BrowserWorkerChannel', () => {
  it('requires piped control streams', () => {
    const harness = createProcess()

    expect(() => new BrowserWorkerChannel(
      { ...harness.process, stdin: undefined },
      100,
      1_024,
    )).toThrow(expect.objectContaining({ code: 'BROWSER_WORKER_PROTOCOL' }))
  })

  it('correlates split responses and returns the blocked destination', async () => {
    const harness = createProcess()
    const channel = new BrowserWorkerChannel(harness.process, 100, 1_024)
    const clean = channel.inspectNavigation()
    expect(harness.writes).toEqual([
      '{"type":"inspect-navigation","requestId":1}\n',
    ])
    harness.stdout.write('ordinary output\n')
    harness.stdout.write(eventLine(999))
    const cleanLine = eventLine(1)
    harness.stdout.write(Buffer.from(cleanLine.slice(0, 14)))
    harness.stdout.write(Buffer.from(cleanLine.slice(14)))
    await expect(clean).resolves.toBeUndefined()

    const blocked = channel.inspectNavigation()
    harness.stdout.write(eventLine(2, {
      attemptedUrl: 'https://other.test/',
      currentUrl: 'https://example.com/',
      pageUsable: false,
    }))
    await expect(blocked).resolves.toEqual({
      attemptedUrl: 'https://other.test/',
      currentUrl: 'https://example.com/',
      pageUsable: false,
    })
    channel.dispose()
  })

  it('rejects a pre-aborted or subsequently cancelled inspection', async () => {
    const harness = createProcess()
    const channel = new BrowserWorkerChannel(harness.process, 100, 1_024)
    const preAborted = AbortSignal.abort(new Error('already cancelled'))

    expect(() => channel.inspectNavigation(preAborted)).toThrow('already cancelled')

    const controller = new AbortController()
    const reason = new Error('cancel inspection')
    const pending = channel.inspectNavigation(controller.signal)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    channel.dispose()
  })

  it('uses a standard abort error when inspection cancellation has no reason', async () => {
    const harness = createProcess()
    const channel = new BrowserWorkerChannel(harness.process, 100, 1_024)
    const signal = new EventTarget() as EventTarget & AbortSignal
    Object.assign(signal, {
      aborted: false,
      reason: undefined,
      throwIfAborted: () => {},
      onabort: null,
    })
    const pending = channel.inspectNavigation(signal)

    signal.dispatchEvent(new Event('abort'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    channel.dispose()
  })

  it('rejects an inspection timeout and unavailable control stream', async () => {
    vi.useFakeTimers()
    try {
      const harness = createProcess()
      const channel = new BrowserWorkerChannel(harness.process, 10, 1_024)
      const pending = channel.inspectNavigation()
      const timeoutExpectation = expect(pending).rejects.toMatchObject({
        code: 'BROWSER_WORKER_TIMEOUT',
      })
      await vi.advanceTimersByTimeAsync(10)
      await timeoutExpectation

      harness.stdin.destroy()
      await expect(channel.inspectNavigation()).rejects.toMatchObject({
        code: 'BROWSER_WORKER_CLOSED',
      })
      channel.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails pending inspections on malformed or excessive event output', async () => {
    const malformedHarness = createProcess()
    const malformedChannel = new BrowserWorkerChannel(
      malformedHarness.process,
      100,
      1_024,
    )
    const malformed = malformedChannel.inspectNavigation()
    malformedHarness.stdout.write('dsh-browser-worker:event {\n')
    await expect(malformed).rejects.toMatchObject({
      code: 'BROWSER_WORKER_PROTOCOL',
    })
    await expect(malformedChannel.inspectNavigation()).rejects.toMatchObject({
      code: 'BROWSER_WORKER_CLOSED',
    })

    const excessiveHarness = createProcess()
    const excessiveChannel = new BrowserWorkerChannel(
      excessiveHarness.process,
      100,
      4,
    )
    const excessive = excessiveChannel.inspectNavigation()
    excessiveHarness.stdout.write('12345')
    await expect(excessive).rejects.toMatchObject({
      code: 'BROWSER_WORKER_PROTOCOL',
    })
  })

  it('accepts string event chunks', async () => {
    const harness = createProcess()
    const channel = new BrowserWorkerChannel(harness.process, 100, 1_024)
    const pending = channel.inspectNavigation()

    harness.stdout.emit('data', eventLine(1))

    await expect(pending).resolves.toBeUndefined()
    channel.dispose()
  })

  it('fails pending inspections when the worker exits or its monitor rejects', async () => {
    const exitedHarness = createProcess()
    const exitedChannel = new BrowserWorkerChannel(exitedHarness.process, 100, 1_024)
    const exited = exitedChannel.inspectNavigation()
    exitedHarness.exit()
    await expect(exited).rejects.toMatchObject({
      code: 'BROWSER_WORKER_CLOSED',
    })

    const failedHarness = createProcess()
    const failedChannel = new BrowserWorkerChannel(failedHarness.process, 100, 1_024)
    const failed = failedChannel.inspectNavigation()
    const cause = new Error('monitor failed')
    failedHarness.fail(cause)
    await expect(failed).rejects.toMatchObject({
      code: 'BROWSER_WORKER_CLOSED',
      cause,
    })
  })

  it('disposes idempotently and rejects all pending inspections', async () => {
    const harness = createProcess()
    const channel = new BrowserWorkerChannel(harness.process, 100, 1_024)
    const first = channel.inspectNavigation()
    const second = channel.inspectNavigation()

    channel.dispose()
    channel.dispose()

    await expect(first).rejects.toMatchObject({ code: 'BROWSER_WORKER_CLOSED' })
    await expect(second).rejects.toMatchObject({ code: 'BROWSER_WORKER_CLOSED' })
    await expect(channel.inspectNavigation()).rejects.toMatchObject({
      code: 'BROWSER_WORKER_CLOSED',
    })
  })
})
