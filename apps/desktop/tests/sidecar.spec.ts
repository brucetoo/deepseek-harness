import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SIDECAR_ORIGIN,
  SidecarLifecycleError,
  SidecarShutdownError,
  SidecarStartupError,
  SidecarSupervisor,
  type SidecarDependencies,
  type SidecarSignal,
  type SidecarSpawn,
} from '../src/sidecar.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/sidecar-fixture.mjs', import.meta.url))
const children = new Set<ChildProcessWithoutNullStreams>()

function asynchronouslyErroredChild(
  error: Error,
  onExit: () => void,
): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams
  child.once('exit', onExit)
  queueMicrotask(() => child.emit('error', error))
  return child
}

const trackedSpawn: SidecarSpawn = (executable, args, options) => {
  const child = nodeSpawn(executable, args, options)
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

function exitObservedSpawn(): {
  readonly spawn: SidecarSpawn
  readonly exited: () => boolean
} {
  let exited = false
  return {
    spawn: (executable, args, options) => {
      const child = trackedSpawn(executable, args, options)
      child.once('exit', () => {
        exited = true
      })
      return child
    },
    exited: () => exited,
  }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const child of children) {
    child.kill('SIGKILL')
  }
  await Promise.all([...children].map(child => new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve()
    })
  })))
  children.clear()
})

function supervisor(
  token: string,
  options: {
    readonly startupTimeoutMs?: number
    readonly readinessConfirmationMs?: number
    readonly stderrTailBytes?: number
    readonly spawn?: SidecarSpawn
    readonly platform?: NodeJS.Platform
    readonly closeStdin?: SidecarDependencies['closeStdin']
    readonly signal?: SidecarDependencies['signal']
    readonly reportError?: SidecarDependencies['reportError']
  } = {},
): SidecarSupervisor {
  return new SidecarSupervisor({
    nodeExecutable: process.execPath,
    cliEntry: fixturePath,
    harnessHome: '/tmp/dsh-desktop-home',
    inheritedEnvironment: {
      HOME: '/tmp/dsh-desktop-home',
      NODE_OPTIONS: '--must-not-be-inherited',
      PATH: process.env.PATH,
    },
    startupTimeoutMs: options.startupTimeoutMs ?? 500,
    readinessConfirmationMs: options.readinessConfirmationMs ?? 10,
    stderrTailBytes: options.stderrTailBytes ?? 256,
    shutdownGraceMs: 10,
    terminationGraceMs: 10,
    killGraceMs: 10,
  }, {
    platform: options.platform ?? 'linux',
    spawn: options.spawn ?? trackedSpawn,
    ...(options.closeStdin === undefined ? {} : { closeStdin: options.closeStdin }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.reportError === undefined ? {} : { reportError: options.reportError }),
  }, token)
}

async function startupFailure(pending: Promise<unknown>): Promise<SidecarStartupError> {
  try {
    await pending
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SidecarStartupError)
    return error as SidecarStartupError
  }
  throw new Error('expected sidecar startup to fail')
}

describe('desktop sidecar startup', () => {
  it('uses the staged runtime command, fixed Web arguments, and a scrubbed environment', async () => {
    const spawn = vi.fn<SidecarSpawn>(trackedSpawn)
    const sidecar = supervisor('fragmented', { spawn })

    await expect(sidecar.start()).resolves.toEqual({ origin: SIDECAR_ORIGIN })

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      fixturePath,
      'web',
      '--port',
      '37615',
      '--no-open',
      '--bearer-token-env',
      'DSH_DESKTOP_TOKEN',
    ], {
      env: {
        DSH_DESKTOP_TOKEN: 'fragmented',
        DSH_HOME: '/tmp/dsh-desktop-home',
        HOME: '/tmp/dsh-desktop-home',
        PATH: process.env.PATH,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  })

  it('assembles fragmented stdout and ignores unrelated complete lines', async () => {
    const sidecar = supervisor('fragmented')

    await expect(sidecar.start()).resolves.toEqual({
      origin: 'http://127.0.0.1:37615',
    })
  })

  it('rejects a duplicate canonical readiness line', async () => {
    const observation = exitObservedSpawn()
    const error = await startupFailure(supervisor('duplicate', {
      spawn: observation.spawn,
    }).start())

    expect(error).toMatchObject({
      code: 'SIDECAR_DUPLICATE_READINESS',
      diagnostics: { stderrTail: '' },
    })
    expect(observation.exited()).toBe(true)
  })

  it.each(['malformed-origin', 'malformed-readiness'])(
    'rejects %s output',
    async (token) => {
      const observation = exitObservedSpawn()
      const error = await startupFailure(supervisor(token, {
        spawn: observation.spawn,
      }).start())

      expect(error).toMatchObject({
        code: 'SIDECAR_MALFORMED_READINESS',
      })
      expect(observation.exited()).toBe(true)
    },
  )

  it('rejects startup when the readiness bound expires', async () => {
    const observation = exitObservedSpawn()
    const error = await startupFailure(supervisor('timeout', {
      spawn: observation.spawn,
      startupTimeoutMs: 20,
    }).start())

    expect(error).toMatchObject({
      code: 'SIDECAR_TIMEOUT',
    })
    expect(observation.exited()).toBe(true)
  })

  it('rejects startup when the child exits before readiness', async () => {
    const error = await startupFailure(supervisor('early-exit').start())

    expect(error).toMatchObject({
      code: 'SIDECAR_EARLY_EXIT',
      diagnostics: {
        exitCode: 23,
        signal: null,
      },
    })
  })

  it('classifies EADDRINUSE stderr followed by early exit as a port conflict', async () => {
    const token = 'port-conflict'
    const error = await startupFailure(supervisor(token).start())

    expect(error).toMatchObject({
      code: 'SIDECAR_PORT_CONFLICT',
      diagnostics: {
        exitCode: 1,
        signal: null,
      },
    })
    expect(error.diagnostics.stderrTail).toContain('EADDRINUSE')
    expect(JSON.stringify(error.diagnostics)).not.toContain(token)
  })

  it('retains a bounded stderr tail and redacts the launch token', async () => {
    const token = 'stderr-tail:desktop-secret-token'
    const error = await startupFailure(supervisor(token, {
      stderrTailBytes: 80,
    }).start())

    expect(error.code).toBe('SIDECAR_EARLY_EXIT')
    expect(error.diagnostics.stderrTail).toContain('[redacted]')
    expect(error.diagnostics.stderrTail).toContain('tail-marker')
    expect(error.diagnostics.stderrTail).not.toContain(token)
    expect(Buffer.byteLength(error.diagnostics.stderrTail)).toBeLessThanOrEqual(80)
    expect(error.message).not.toContain(token)
  })

  it('classifies a synchronous spawn failure without exposing its message', async () => {
    const token = 'spawn-secret-token'
    const spawn: SidecarSpawn = () => {
      throw new Error(`cannot spawn with ${token}`)
    }
    const error = await startupFailure(supervisor(token, { spawn }).start())

    expect(error).toMatchObject({
      code: 'SIDECAR_SPAWN_FAILURE',
      diagnostics: { stderrTail: '' },
    })
    expect(error.message).not.toContain(token)
    expect(JSON.stringify(error.diagnostics)).not.toContain(token)
  })

  it('classifies an asynchronously emitted spawn failure without exposing its message', async () => {
    const token = 'async-spawn-secret-token'
    let child: ChildProcessWithoutNullStreams | undefined
    let exited = false
    const spawn: SidecarSpawn = () =>
      child = asynchronouslyErroredChild(new Error(`cannot spawn with ${token}`), () => {
        exited = true
      })
    const signal: SidecarDependencies['signal'] = (spawned) => {
      Object.assign(spawned, { exitCode: 1 })
      spawned.emit('exit', 1, null)
    }
    const error = await startupFailure(supervisor(token, { signal, spawn }).start())

    expect(error).toMatchObject({
      code: 'SIDECAR_SPAWN_FAILURE',
      diagnostics: { stderrTail: '' },
    })
    expect(child).toBeDefined()
    expect(exited).toBe(true)
    expect(error.message).not.toContain(token)
    expect(error.stack).not.toContain(token)
    expect(JSON.stringify(error.diagnostics)).not.toContain(token)
  })

  it('contains and reports a child error emitted after readiness without exposing the token', async () => {
    const token = 'late-error-secret-token'
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams
    const spawn: SidecarSpawn = () => {
      setImmediate(() => {
        stdout.write('dsh web: http://127.0.0.1:37615\n')
      })
      return child
    }
    const reported: Error[] = []
    const sidecar = supervisor(token, {
      reportError: error => reported.push(error),
      spawn,
    })
    await sidecar.start()

    await new Promise<void>(resolve => setImmediate(resolve))
    expect(() => {
      child.emit('error', new Error(`late failure for ${token}`))
    }).not.toThrow()

    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      name: 'Error',
      message: 'late failure for [redacted]',
    })
    expect(reported[0]?.stack).not.toContain(token)
  })
})

describe('desktop sidecar shutdown', () => {
  it('prevents start after shutdown without spawning a child', async () => {
    const spawn = vi.fn<SidecarSpawn>(() => {
      throw new Error('spawn must not run')
    })
    const sidecar = supervisor('already-shut-down', { spawn })

    await expect(sidecar.shutdown()).resolves.toEqual({ forcedTermination: false })
    const start = sidecar.start()
    await expect(start).rejects.toBeInstanceOf(SidecarLifecycleError)
    await expect(start).rejects.toMatchObject({
      name: 'SidecarLifecycleError',
      code: 'SIDECAR_ALREADY_SHUT_DOWN',
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects when the child remains alive after the final SIGKILL wait', async () => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams
    const spawn: SidecarSpawn = () => {
      queueMicrotask(() => {
        stdout.write('dsh web: http://127.0.0.1:37615\n')
      })
      return child
    }
    const signal = vi.fn<SidecarDependencies['signal']>()
    const sidecar = supervisor('no-quiescence', {
      closeStdin: vi.fn(),
      signal,
      spawn,
    })
    await sidecar.start()

    const shutdown = sidecar.shutdown()
    await expect(shutdown).rejects.toBeInstanceOf(SidecarShutdownError)
    await expect(shutdown).rejects.toMatchObject({
      name: 'SidecarShutdownError',
      code: 'SIDECAR_NO_QUIESCENCE',
    })
    expect(signal.mock.calls.map(([, requested]) => requested)).toEqual([
      'SIGTERM',
      'SIGKILL',
    ])
  })

  it('lets the Host exit within the stdin grace without sending a signal', async () => {
    const closeStdin = vi.fn<SidecarDependencies['closeStdin']>(child => child.stdin.end())
    const signal = vi.fn<SidecarDependencies['signal']>()
    const sidecar = supervisor('graceful', { closeStdin, signal })
    await sidecar.start()

    await expect(sidecar.shutdown()).resolves.toEqual({ forcedTermination: false })

    expect(closeStdin).toHaveBeenCalledOnce()
    expect(signal).not.toHaveBeenCalled()
  })

  it('requests SIGTERM after the stdin grace and stops when the process exits', async () => {
    const signals: SidecarSignal[] = []
    const signal: SidecarDependencies['signal'] = (child, requested) => {
      signals.push(requested)
      child.kill('SIGKILL')
    }
    const sidecar = supervisor('term', { signal })
    await sidecar.start()

    await expect(sidecar.shutdown()).resolves.toEqual({ forcedTermination: true })

    expect(signals).toEqual(['SIGTERM'])
  })

  it('escalates from SIGTERM to SIGKILL after both earlier bounds expire', async () => {
    const requests: Array<{ signal: SidecarSignal; platform: NodeJS.Platform }> = []
    const signal: SidecarDependencies['signal'] = (child, requested, platform) => {
      requests.push({ signal: requested, platform })
      if (requested === 'SIGKILL') child.kill('SIGKILL')
    }
    const sidecar = supervisor('kill', {
      platform: 'win32',
      signal,
    })
    await sidecar.start()

    await expect(sidecar.shutdown()).resolves.toEqual({ forcedTermination: true })

    expect(requests).toEqual([
      { signal: 'SIGTERM', platform: 'win32' },
      { signal: 'SIGKILL', platform: 'win32' },
    ])
  })

  it('coalesces concurrent shutdown calls and remains idempotent', async () => {
    const closeStdin = vi.fn<SidecarDependencies['closeStdin']>(child => child.stdin.end())
    const signal = vi.fn<SidecarDependencies['signal']>()
    const sidecar = supervisor('graceful', { closeStdin, signal })
    await sidecar.start()

    const first = sidecar.shutdown()
    const second = sidecar.shutdown()

    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ forcedTermination: false })
    await expect(sidecar.shutdown()).resolves.toEqual({ forcedTermination: false })
    expect(closeStdin).toHaveBeenCalledOnce()
    expect(signal).not.toHaveBeenCalled()
  })

  it('does not close stdin or signal after observing process exit', async () => {
    const closeStdin = vi.fn<SidecarDependencies['closeStdin']>()
    const signal = vi.fn<SidecarDependencies['signal']>()
    const sidecar = supervisor('natural-exit', {
      closeStdin,
      readinessConfirmationMs: 5,
      signal,
    })
    await sidecar.start()
    await new Promise(resolve => setTimeout(resolve, 35))

    await expect(sidecar.shutdown()).resolves.toEqual({ forcedTermination: false })

    expect(closeStdin).not.toHaveBeenCalled()
    expect(signal).not.toHaveBeenCalled()
  })
})
