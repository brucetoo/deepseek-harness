import { PassThrough } from 'node:stream'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  BrowserElementAction,
  BrowserElementFingerprint,
  BrowserObservation,
} from '@deepseek-ai/dsh-browser'
import { BrowserError } from '@deepseek-ai/dsh-browser'
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { BrowserNavigationPolicy } from '../../../../apps/desktop/src/browser-worker.ts'
import {
  makeBrowserTempDirectory,
  PlaywrightElectronBrowserRuntime,
  removeBrowserTempDirectory,
  type BrowserDriver,
  type BrowserDriverPreparedAction,
  type BrowserProviderDependencies,
  type Config,
} from '../src/index.ts'

const observation = (url = 'https://example.com/'): BrowserObservation => ({
  url,
  title: 'Example',
  snapshot: '- heading "Example"',
})

const fingerprint: BrowserElementFingerprint = {
  tagName: 'button',
  role: 'button',
  accessibleName: 'Submit',
  formAction: 'https://example.com/submit',
}

const fakeAgent = (id: string): Agent => ({ id } as unknown as Agent)

const runtimeConfig = (
  electronExecutable = '/Applications/Electron',
  launchTimeoutMs = 1_000,
  snapshotDepth = 8,
  tempRoot = '/tmp/dsh-browser',
): Config => ({
  electronExecutable,
  applicationEntry: '/Applications/App/app.asar',
  tempRoot,
  launchTimeoutMs,
  operationTimeoutMs: 1_000,
  navigationSettleMs: 1,
  cleanupTimeoutMs: 1_000,
  processGraceMs: 100,
  readinessMaxBytes: 4_096,
  snapshotDepth,
})

class StubSubprocessRuntime extends SubprocessRuntime {
  constructor(
    ctx: Context,
    private readonly spawnImplementation: (
      spec: SubprocessSpawnSpec,
    ) => SubprocessHandle,
  ) {
    super(ctx)
  }

  override resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.spawnImplementation(spec)
  }

  override spawnTerminal(
    _spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('terminal spawning is not used'))
  }
}

interface Harness {
  readonly ctx: Context
  readonly runtime: PlaywrightElectronBrowserRuntime
  readonly dependencies: BrowserProviderDependencies
  readonly driver: BrowserDriver
  readonly prepared: BrowserDriverPreparedAction
  readonly spawnSpecs: SubprocessSpawnSpec[]
  readonly stdinWrites: string[]
  readonly order: string[]
  readonly policy: BrowserNavigationPolicy
  readonly pausePermits: () => void
  readonly resumePermits: () => void
  readonly closeControlStream: () => void
  readonly exitWorker: () => void
  readonly failWorker: (cause: unknown) => void
  readonly blockNextNavigation: (attemptedUrl: string, pageUsable?: boolean) => void
}

const createHarness = (): Harness => {
  const ctx = new Context()
  const order: string[] = []
  const spawnSpecs: SubprocessSpawnSpec[] = []
  const stdinWrites: string[] = []
  const policy = new BrowserNavigationPolicy()
  let permitsPaused = false
  const pendingPermits: (() => void)[] = []
  const stdin = new PassThrough()
  let blockedNavigation:
    | {
      readonly attemptedUrl: string
      readonly currentUrl: string
      readonly pageUsable: boolean
    }
    | undefined
  let spawnCount = 0
  let exitFirstWorker: (() => void) | undefined
  let failFirstWorker: ((cause: unknown) => void) | undefined
  const prepared: BrowserDriverPreparedAction = {
    fingerprint,
    commit: async () => {
      order.push('action:commit')
    },
    dispose: async () => {
      order.push('action:dispose')
    },
  }
  const driver: BrowserDriver = {
    goto: async (url) => {
      if (!policy.authorize(url)) throw new Error('navigation preceded its permit')
      return observation(url)
    },
    snapshot: async () => observation(),
    prepare: async (_action: BrowserElementAction) => prepared,
    wait: async () => observation(),
    close: async () => {
      order.push('driver:close')
    },
  }
  const dependencies: BrowserProviderDependencies = {
    spawn: (spec) => {
      spawnSpecs.push(spec)
      const processStdin = spawnCount++ === 0 ? stdin : new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let input = ''
      processStdin.on('data', (chunk: Buffer | string) => {
        input += chunk.toString()
        for (let newline = input.indexOf('\n'); newline !== -1; newline = input.indexOf('\n')) {
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          stdinWrites.push(`${line}\n`)
          const command = JSON.parse(line) as {
            readonly type: string
            readonly requestId?: number
            readonly url?: string | null
          }
          if (command.type === 'permit-navigation') {
            const permit = (): void => {
              if (command.url === null) policy.revoke()
              else policy.prepare(command.url as string)
              if (command.requestId !== undefined) {
                stdout.write(`dsh-browser-worker:event ${JSON.stringify({
                  type: 'navigation-status',
                  requestId: command.requestId,
                  blocked: blockedNavigation ?? null,
                })}\n`)
                blockedNavigation = undefined
              }
            }
            if (permitsPaused) pendingPermits.push(permit)
            else permit()
            continue
          }
          if (command.type !== 'inspect-navigation') continue
          stdout.write(`dsh-browser-worker:event ${JSON.stringify({
            type: 'navigation-status',
            requestId: command.requestId,
            blocked: blockedNavigation ?? null,
          })}\n`)
          blockedNavigation = undefined
        }
      })
      let processExited = false
      const exit = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
      if (spawnCount === 1) {
        exitFirstWorker = () => {
          processExited = true
          exit.resolve({ exitCode: 1, signal: null })
        }
        failFirstWorker = (cause) => {
          processExited = true
          exit.reject(cause)
        }
      }
      queueMicrotask(() => {
        stderr.write('DevTools listening on ws://127.0.0.1:49152/devtools/browser/test\n')
        stdout.write('dsh-browser-worker: ready\n')
      })
      return {
        pid: 123 + spawnCount,
        stdin: processStdin,
        stdout,
        stderr,
        collected: {},
        done: exit.promise,
        terminate: () => {
          order.push('process:terminate')
          processExited = true
        },
        waitForExit: async () => {
          order.push('process:wait')
          return processExited
        },
      }
    },
    connect: async (endpoint) => {
      expect(endpoint).toBe('ws://127.0.0.1:49152/devtools/browser/test')
      return driver
    },
    makeTempDirectory: async (root) => {
      expect(root).toBe('/tmp/dsh-browser')
      return '/tmp/dsh-browser/session-a'
    },
    removeTempDirectory: async (path) => {
      order.push(`profile:remove:${path}`)
    },
  }
  const runtime = new PlaywrightElectronBrowserRuntime(
    ctx,
    runtimeConfig(),
    dependencies,
  )
  return {
    ctx,
    runtime,
    dependencies,
    driver,
    prepared,
    spawnSpecs,
    stdinWrites,
    order,
    policy,
    pausePermits: () => { permitsPaused = true },
    resumePermits: () => {
      permitsPaused = false
      for (const permit of pendingPermits.splice(0)) permit()
    },
    closeControlStream: () => { stdin.destroy() },
    exitWorker: () => {
      if (exitFirstWorker === undefined) throw new Error('worker was not spawned')
      exitFirstWorker()
    },
    failWorker: (cause) => {
      if (failFirstWorker === undefined) throw new Error('worker was not spawned')
      failFirstWorker(cause)
    },
    blockNextNavigation: (attemptedUrl, pageUsable = true) => {
      blockedNavigation = {
        attemptedUrl,
        currentUrl: 'https://example.com/form',
        pageUsable,
      }
    },
  }
}

describe('PlaywrightElectronBrowserRuntime ownership', () => {
  it('launches one private worker, permits the target, and rejects another owner', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    const foreign = fakeAgent('foreign')

    await expect(harness.runtime.open(owner, {
      url: 'https://example.com/form',
    })).resolves.toEqual(observation('https://example.com/form'))

    expect(harness.spawnSpecs).toEqual([expect.objectContaining({
      argv: [
        '/Applications/Electron',
        '/Applications/App/app.asar',
        '--dsh-browser-worker',
        '--dsh-browser-profile=/tmp/dsh-browser/session-a',
      ],
      cwd: '/Applications/App',
      graceMs: 100,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })])
    expect(harness.stdinWrites.map(line => JSON.parse(line) as unknown)).toContainEqual(
      expect.objectContaining({ type: 'permit-navigation', url: 'https://example.com/form' }),
    )
    await expect(harness.runtime.snapshot(foreign)).rejects.toMatchObject({
      code: 'BROWSER_FOREIGN_OWNER',
    })
    await expect(harness.runtime.open(foreign, {
      url: 'https://other.test/',
    })).rejects.toMatchObject({ code: 'BROWSER_BUSY' })
  })

  it('reports a blocked top-level destination and whether the page remains usable', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/form' })
    harness.blockNextNavigation('https://other.test/private')

    await expect(harness.runtime.snapshot(owner)).rejects.toMatchObject({
      code: 'BROWSER_NAVIGATION_BLOCKED',
      message: 'browser blocked top-level navigation to https://other.test/private; the current page remains usable at https://example.com/form',
    })
    await expect(harness.runtime.snapshot(owner)).resolves.toEqual(observation())
  })

  it('awaits driver, process-tree, and profile cleanup before releasing ownership', async () => {
    const harness = createHarness()
    const first = fakeAgent('first')
    const second = fakeAgent('second')
    await harness.runtime.open(first, { url: 'https://example.com/' })

    await harness.runtime.close(first)

    expect(harness.order).toEqual([
      'driver:close',
      'process:terminate',
      'process:wait',
      'profile:remove:/tmp/dsh-browser/session-a',
    ])
    await expect(harness.runtime.open(second, {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('rejects duplicate ownership and permits idempotent or authorized close only', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    const foreign = fakeAgent('foreign')

    await harness.runtime.close(owner)
    await expect(harness.runtime.snapshot(owner)).rejects.toMatchObject({
      code: 'BROWSER_NOT_OPEN',
    })
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    await expect(harness.runtime.open(owner, {
      url: 'https://example.com/',
    })).rejects.toMatchObject({ code: 'BROWSER_ALREADY_OPEN' })
    await expect(harness.runtime.close(foreign)).rejects.toMatchObject({
      code: 'BROWSER_FOREIGN_OWNER',
    })
    await harness.runtime.close(owner)
  })

  it('uses the non-usable blocked-navigation diagnostic', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    harness.blockNextNavigation('https://other.test/', false)

    await expect(harness.runtime.snapshot(owner)).rejects.toMatchObject({
      code: 'BROWSER_NAVIGATION_BLOCKED',
    })
    await expect(harness.runtime.snapshot(owner)).resolves.toEqual(observation())
  })
})

describe('PlaywrightElectronBrowserRuntime prepared actions', () => {
  it('commits a control with no static navigation destination', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    Object.assign(harness.prepared, {
      fingerprint: { tagName: 'button', role: 'button', accessibleName: 'Submit' },
    })
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })

    await expect(harness.runtime.commit(owner, action.id)).resolves.toEqual(observation())
    expect(harness.order).toContain('action:commit')
  })

  it.each([false, true])('closes the browser on failed permit revocation, cleanup failure=%s', async (cleanupFails) => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    vi.spyOn(harness.prepared, 'commit').mockImplementation(async () => {
      harness.closeControlStream()
    })
    if (cleanupFails) {
      vi.spyOn(harness.dependencies, 'removeTempDirectory').mockRejectedValueOnce(new Error('profile unavailable'))
    }
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })

    await expect(harness.runtime.commit(owner, action.id)).rejects.toMatchObject({
      code: cleanupFails ? 'BROWSER_CLEANUP_FAILED' : 'BROWSER_WORKER_CLOSED',
    })
    expect(harness.order).toContain('process:terminate')
    await expect(harness.runtime.snapshot(owner)).rejects.toMatchObject({
      code: 'BROWSER_NOT_OPEN',
    })
    if (cleanupFails) await harness.runtime.close(owner)
    await expect(harness.runtime.open(fakeAgent('next'), {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it.each([false, true])('revokes an unused destination after action failure=%s', async (fails) => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    Object.assign(harness.prepared, {
      fingerprint: { ...fingerprint, href: 'https://other.test/next' },
    })
    if (fails) vi.spyOn(harness.prepared, 'commit').mockRejectedValueOnce(new Error('click failed'))
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'link', name: 'Next' },
    })
    if (fails) await expect(harness.runtime.commit(owner, action.id)).rejects.toThrow('click failed')
    else await harness.runtime.commit(owner, action.id)

    expect(harness.policy.authorize('https://other.test/unrelated')).toBe(false)
  })

  it('waits for the worker to install the permit before executing an action', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    Object.assign(harness.prepared, {
      fingerprint: { ...fingerprint, href: 'https://other.test/next' },
    })
    const commit = vi.spyOn(harness.prepared, 'commit').mockImplementation(async () => {
      expect(harness.policy.authorize('https://other.test/next')).toBe(true)
    })
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'link', name: 'Next' },
    })
    harness.pausePermits()
    const pending = harness.runtime.commit(owner, action.id)
    const outcome = pending.catch((error: unknown) => error)
    await vi.waitFor(() => {
      expect(harness.stdinWrites.some(line => line.includes('https://other.test/next'))).toBe(true)
    })
    const callsBeforeAcknowledgement = commit.mock.calls.length
    harness.resumePermits()
    await outcome

    expect(callsBeforeAcknowledgement).toBe(0)
    await expect(pending).resolves.toEqual(observation())
  })

  it('commits one retained action once and observes the resulting page', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })

    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    expect(action).toMatchObject({
      id: 'browser-action-1',
      owner,
      pageUrl: 'https://example.com/',
      fingerprint,
    })

    await expect(harness.runtime.commit(owner, action.id)).resolves.toEqual(observation())
    expect(harness.order).toContain('action:commit')
    await expect(harness.runtime.commit(owner, action.id)).rejects.toMatchObject({
      code: 'BROWSER_PREPARED_ACTION_MISSING',
    })
  })

  it('releases a rejected action without committing it and tolerates repeated release', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const action = await harness.runtime.prepare(owner, {
      kind: 'fill',
      target: { role: 'textbox', name: 'Query' },
      value: 'public value',
    })

    await harness.runtime.release(owner, action.id)
    await harness.runtime.release(owner, action.id)

    expect(harness.order).toContain('action:dispose')
    expect(harness.order).not.toContain('action:commit')
  })

  it('does not let a foreign owner commit or release a prepared action', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    const foreign = fakeAgent('foreign')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })

    await expect(harness.runtime.commit(foreign, action.id)).rejects.toMatchObject({
      code: 'BROWSER_FOREIGN_OWNER',
    })
    await expect(harness.runtime.release(foreign, action.id)).rejects.toMatchObject({
      code: 'BROWSER_FOREIGN_OWNER',
    })
    expect(harness.order).not.toContain('action:commit')
    expect(harness.order).not.toContain('action:dispose')
  })

  it('disposes the retained handle when the preparation snapshot fails', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const failure = new Error('snapshot failed')
    vi.spyOn(harness.driver, 'snapshot').mockRejectedValueOnce(failure)

    await expect(harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })).rejects.toBe(failure)
    expect(harness.order).toContain('action:dispose')
  })

  it('permits an href destination and always disposes after commit failure', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    Object.assign(harness.prepared, {
      fingerprint: {
        ...fingerprint,
        href: 'https://example.com/next',
        formAction: undefined,
      },
    })
    const failure = new Error('click failed')
    vi.spyOn(harness.prepared, 'commit').mockRejectedValueOnce(failure)
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'link', name: 'Next' },
    })

    await expect(harness.runtime.commit(owner, action.id)).rejects.toBe(failure)
    expect(harness.stdinWrites.map(line => JSON.parse(line) as unknown)).toContainEqual(
      expect.objectContaining({ type: 'permit-navigation', url: 'https://example.com/next' }),
    )
    expect(harness.order).toContain('action:dispose')
  })

  it('rejects an invalid prepared destination and still disposes its handle', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    Object.assign(harness.prepared, {
      fingerprint: {
        ...fingerprint,
        href: 'javascript:alert(1)',
        formAction: undefined,
      },
    })
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'link', name: 'Unsafe' },
    })

    await expect(harness.runtime.commit(owner, action.id)).rejects.toMatchObject({
      code: 'BROWSER_INVALID_URL',
    })
    expect(harness.order).toContain('action:dispose')
  })
})

describe('PlaywrightElectronBrowserRuntime launch failures', () => {
  it('removes the private profile when connecting fails', async () => {
    const harness = createHarness()
    const failure = new Error('CDP refused')
    const connect = vi.fn<BrowserProviderDependencies['connect']>().mockRejectedValue(failure)
    const runtime = new PlaywrightElectronBrowserRuntime(
      new Context(),
      runtimeConfig(),
      {
        spawn: harness.spawnSpecs.length === -1
          ? (() => { throw new Error('unreachable') })
          : (spec) => {
            harness.spawnSpecs.push(spec)
            queueMicrotask(() => {
              const streams = harness.runtime as unknown
              void streams
            })
            const stdin = new PassThrough()
            const stdout = new PassThrough()
            const stderr = new PassThrough()
            queueMicrotask(() => {
              stderr.write('DevTools listening on ws://127.0.0.1:49152/devtools/browser/test\n')
              stdout.write('dsh-browser-worker: ready\n')
            })
            let exited = false
            return {
              pid: 124,
              stdin,
              stdout,
              stderr,
              collected: {},
              done: new Promise(() => {}),
              terminate: () => {
                exited = true
                harness.order.push('process:terminate')
              },
              waitForExit: async () => exited,
            }
          },
        connect,
        makeTempDirectory: async () => '/tmp/dsh-browser/session-failed',
        removeTempDirectory: async (path) => {
          harness.order.push(`profile:remove:${path}`)
        },
      },
    )

    await expect(runtime.open(fakeAgent('owner'), {
      url: 'https://example.com/',
    })).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' })
    expect(harness.order).toContain('profile:remove:/tmp/dsh-browser/session-failed')
  })

  it('rejects invalid static and per-operation configuration', async () => {
    const harness = createHarness()
    expect(() => new PlaywrightElectronBrowserRuntime(
      new Context(),
      runtimeConfig(''),
      harness.dependencies,
    )).toThrow(/electronExecutable must be non-empty/)
    expect(() => new PlaywrightElectronBrowserRuntime(
      new Context(),
      runtimeConfig('/Applications/Electron', 0),
      harness.dependencies,
    )).toThrow(/launchTimeoutMs must be a positive integer/)
    expect(() => new PlaywrightElectronBrowserRuntime(
      new Context(),
      runtimeConfig('/Applications/Electron', 1_000, 1.5),
      harness.dependencies,
    )).toThrow(/snapshotDepth must be a positive integer/)

    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    await expect(harness.runtime.wait(owner, { durationMs: 0 })).rejects.toThrow(
      /durationMs must be a positive integer/,
    )
  })

  it('cleans partial launch state and aggregates a cleanup failure', async () => {
    const harness = createHarness()
    const launchFailure = new Error('spawn failed')
    const cleanupFailure = new Error('profile removal failed')
    const runtime = new PlaywrightElectronBrowserRuntime(
      new Context(),
      harness.runtime.config,
      {
        ...harness.dependencies,
        spawn: () => {
          throw launchFailure
        },
        removeTempDirectory: async () => {
          throw cleanupFailure
        },
      },
    )

    const error = await runtime.open(fakeAgent('owner'), {
      url: 'https://example.com/',
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BrowserError)
    expect((error as BrowserError).code).toBe('BROWSER_LAUNCH_FAILED')
    expect((error as BrowserError).cause).toBeInstanceOf(AggregateError)
  })

  it('cleans an instance whose profile creation fails', async () => {
    const harness = createHarness()
    const failure = new Error('profile creation failed')
    const runtime = new PlaywrightElectronBrowserRuntime(
      new Context(),
      harness.runtime.config,
      {
        ...harness.dependencies,
        makeTempDirectory: async () => {
          throw failure
        },
      },
    )

    await expect(runtime.open(fakeAgent('owner'), {
      url: 'https://example.com/',
    })).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
      cause: failure,
    })
  })

  it('propagates cancellation after creating the private profile', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const reason = new Error('cancel before spawn')
    const runtime = new PlaywrightElectronBrowserRuntime(
      new Context(),
      harness.runtime.config,
      {
        ...harness.dependencies,
        makeTempDirectory: async () => {
          controller.abort(reason)
          return '/tmp/dsh-browser/cancelled'
        },
      },
    )

    await expect(runtime.open(
      fakeAgent('owner'),
      { url: 'https://example.com/' },
      controller.signal,
    )).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
      cause: reason,
    })
    expect(harness.order).toContain('profile:remove:/tmp/dsh-browser/cancelled')
  })

  it('forwards a live launch signal through spawn and observed delay', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const owner = fakeAgent('owner')

    await expect(harness.runtime.open(
      owner,
      { url: 'https://example.com/' },
      controller.signal,
    )).resolves.toEqual(observation('https://example.com/'))
    expect(harness.spawnSpecs[0]).toMatchObject({
      signal: controller.signal,
    })
    await expect(harness.runtime.snapshot(owner, controller.signal)).resolves.toEqual(
      observation(),
    )
  })
})

describe('PlaywrightElectronBrowserRuntime cancellation', () => {
  it('tears down the browser before propagating an active-operation cancellation', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    const nextOwner = fakeAgent('next-owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const controller = new AbortController()
    const reason = new Error('tool call cancelled')
    Object.assign(harness.driver, {
      wait: (_durationMs: number, signal?: AbortSignal) => new Promise<BrowserObservation>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(reason)
          return
        }
        signal?.addEventListener('abort', () => {
          reject(reason)
        }, { once: true })
      }),
    })

    const waiting = harness.runtime.wait(owner, { durationMs: 500 }, controller.signal)
    controller.abort(reason)

    await expect(waiting).rejects.toBe(reason)
    expect(harness.order).toEqual([
      'driver:close',
      'process:terminate',
      'process:wait',
      'profile:remove:/tmp/dsh-browser/session-a',
    ])
    await expect(harness.runtime.open(nextOwner, {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('reports cancellation cleanup failures', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const controller = new AbortController()
    const operationFailure = new Error('cancelled operation')
    const cleanupFailure = new Error('driver close failed')
    vi.spyOn(harness.driver, 'wait').mockImplementation(
      (_durationMs, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>{  reject(operationFailure) }, { once: true })
      }),
    )
    vi.spyOn(harness.driver, 'close').mockRejectedValueOnce(cleanupFailure)

    const waiting = harness.runtime.wait(owner, { durationMs: 500 }, controller.signal)
    controller.abort(operationFailure)

    const error = await waiting.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BrowserError)
    expect((error as BrowserError).code).toBe('BROWSER_CLEANUP_FAILED')
    expect((error as BrowserError).cause).toBeInstanceOf(AggregateError)
  })
})

describe('PlaywrightElectronBrowserRuntime operation failures', () => {
  it('preserves an ordinary driver failure when navigation remains clean', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const failure = new Error('snapshot failed')
    vi.spyOn(harness.driver, 'snapshot').mockRejectedValueOnce(failure)

    await expect(harness.runtime.snapshot(owner)).rejects.toBe(failure)
  })

  it('prioritizes a navigation rejection discovered after a failed operation', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const failure = new Error('snapshot failed')
    vi.spyOn(harness.driver, 'snapshot').mockImplementationOnce(async () => {
      harness.blockNextNavigation('https://blocked.test/')
      throw failure
    })

    await expect(harness.runtime.snapshot(owner)).rejects.toThrow(
      /https:\/\/blocked\.test\//,
    )
  })
})

describe('PlaywrightElectronBrowserRuntime teardown failures', () => {
  it('releases ownership after process/profile cleanup despite a driver error', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    vi.spyOn(harness.driver, 'close').mockRejectedValue(new Error('CDP disconnected'))

    await expect(harness.runtime.close(owner)).rejects.toMatchObject({
      code: 'BROWSER_CLEANUP_FAILED',
    })
    await expect(harness.runtime.open(fakeAgent('next'), {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('terminates the worker even when retained handle disposal does not settle', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    const disposal = Promise.withResolvers<undefined>()
    vi.spyOn(harness.prepared, 'dispose').mockReturnValue(disposal.promise)
    const closing = harness.runtime.close(owner)
    await new Promise<void>(resolve => setImmediate(resolve))
    const terminatedBeforeDisposal = harness.order.includes('process:terminate')
    disposal.resolve(undefined)
    await closing

    expect(terminatedBeforeDisposal).toBe(true)
  })

  it('retries cleanup after a timed-out worker exits later', async () => {
    const harness = createHarness()
    const spawn = harness.dependencies.spawn
    const wait = vi.fn<SubprocessHandle['waitForExit']>().mockResolvedValueOnce(false).mockResolvedValue(true)
    Object.assign(harness.dependencies, {
      spawn: (spec: SubprocessSpawnSpec) => ({ ...spawn(spec), waitForExit: wait }),
    })
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    await expect(harness.runtime.close(owner)).rejects.toMatchObject({
      code: 'BROWSER_CLEANUP_TIMEOUT',
    })
    harness.exitWorker()
    await vi.waitFor(() => {
      expect(harness.order).toContain('profile:remove:/tmp/dsh-browser/session-a')
    })
    await expect(harness.runtime.open(fakeAgent('next'), {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('retains ownership until descendants exit after the worker has closed', async () => {
    const harness = createHarness()
    const spawn = harness.dependencies.spawn
    const tree = Promise.withResolvers<boolean>()
    let treeExited = false
    Object.assign(harness.dependencies, {
      spawn: (spec: SubprocessSpawnSpec) => ({
        ...spawn(spec),
        waitForExit: async (signal?: AbortSignal) => signal === undefined ? tree.promise : treeExited,
      }),
    })
    const owner = fakeAgent('owner')
    const nextOwner = fakeAgent('next')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    harness.exitWorker()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(harness.order).toContain('process:terminate')
    await expect(harness.runtime.open(nextOwner, {
      url: 'https://example.com/',
    })).rejects.toMatchObject({ code: 'BROWSER_BUSY' })

    treeExited = true
    tree.resolve(true)
    await vi.waitFor(() => {
      expect(harness.order).toContain('profile:remove:/tmp/dsh-browser/session-a')
    })
    await expect(harness.runtime.open(nextOwner, {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('bounds an unresponsive driver while preserving profile cleanup', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    vi.spyOn(harness.driver, 'close').mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const closing = harness.runtime.close(owner)
      const rejected = expect(closing).rejects.toMatchObject({ code: 'BROWSER_CLEANUP_FAILED' })
      await vi.advanceTimersByTimeAsync(1_000)
      await rejected
      expect(harness.order).toContain('profile:remove:/tmp/dsh-browser/session-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('aggregates prepared-action, driver, and profile cleanup failures', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    const action = await harness.runtime.prepare(owner, {
      kind: 'click',
      target: { role: 'button', name: 'Submit' },
    })
    expect(action.id).toBe('browser-action-1')
    vi.spyOn(harness.prepared, 'dispose').mockRejectedValueOnce(new Error('dispose failed'))
    vi.spyOn(harness.driver, 'close').mockRejectedValueOnce(new Error('close failed'))
    Object.assign(harness.dependencies, {
      removeTempDirectory: async () => {
        throw new Error('remove failed')
      },
    })

    const error = await harness.runtime.close(owner).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BrowserError)
    expect((error as BrowserError).code).toBe('BROWSER_CLEANUP_FAILED')
    const cause = (error as BrowserError).cause
    expect(cause).toBeInstanceOf(AggregateError)
    expect((cause as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'dispose failed' }),
      expect.objectContaining({ message: 'close failed' }),
      expect.objectContaining({ message: 'remove failed' }),
    ])
  })

  it('fails close when the worker process tree does not become quiescent', async () => {
    const harness = createHarness()
    const spawn = harness.dependencies.spawn
    Object.assign(harness.dependencies, {
      spawn: (spec: SubprocessSpawnSpec) => ({
        ...spawn(spec),
        waitForExit: async () => false,
      }),
    })
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })

    await expect(harness.runtime.close(owner)).rejects.toMatchObject({
      code: 'BROWSER_CLEANUP_TIMEOUT',
    })
  })
})

describe('PlaywrightElectronBrowserRuntime worker exit', () => {
  it('cleans the profile and releases ownership after an unexpected worker exit', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    const nextOwner = fakeAgent('next-owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })

    harness.exitWorker()
    await vi.waitFor(() => {
      expect(harness.order).toContain('profile:remove:/tmp/dsh-browser/session-a')
    })

    await expect(harness.runtime.open(nextOwner, {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('also cleans ownership when the worker monitor rejects', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    const nextOwner = fakeAgent('next-owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })

    harness.failWorker(new Error('monitor failed'))
    await vi.waitFor(() => {
      expect(harness.order).toContain('profile:remove:/tmp/dsh-browser/session-a')
    })
    await expect(harness.runtime.open(nextOwner, {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('cleans the owned browser when its Agent or Context is disposed', async () => {
    const ownerDisposed = createHarness()
    const owner = fakeAgent('owner')
    await ownerDisposed.runtime.open(owner, { url: 'https://example.com/' })

    ownerDisposed.ctx.emit('agent/disposed', { agent: fakeAgent('foreign') })
    await expect(ownerDisposed.runtime.snapshot(owner)).resolves.toEqual(observation())
    ownerDisposed.ctx.emit('agent/disposed', { agent: owner })
    await vi.waitFor(() => {
      expect(ownerDisposed.order).toContain(
        'profile:remove:/tmp/dsh-browser/session-a',
      )
    })

    const contextDisposed = createHarness()
    await contextDisposed.runtime.open(owner, { url: 'https://example.com/' })
    await contextDisposed.ctx.fiber.dispose()
    expect(contextDisposed.order).toContain(
      'profile:remove:/tmp/dsh-browser/session-a',
    )

    const empty = createHarness()
    await empty.ctx.fiber.dispose()
    expect(empty.order).toEqual([])
  })

  it('logs cleanup failure after the owning Agent is disposed', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    vi.spyOn(harness.driver, 'close').mockRejectedValueOnce(
      new Error('close during owner cleanup failed'),
    )
    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => {})

    harness.ctx.emit('agent/disposed', { agent: owner })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        'browser owner cleanup failed',
      ))
    })
  })

  it('ignores queued owner cleanup after an earlier close wins serialization', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })

    const close = harness.runtime.close(owner)
    harness.ctx.emit('agent/disposed', { agent: owner })
    await close
    await Promise.resolve()

    expect(harness.order.filter(item => item === 'driver:close')).toHaveLength(1)
  })

  it('ignores a late worker completion after explicit close', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    await harness.runtime.close(owner)

    harness.exitWorker()
    await Promise.resolve()

    await expect(harness.runtime.open(fakeAgent('next-owner'), {
      url: 'https://example.com/',
    })).resolves.toEqual(observation())
  })

  it('logs cleanup failure after an unexpected worker exit', async () => {
    const harness = createHarness()
    const owner = fakeAgent('owner')
    await harness.runtime.open(owner, { url: 'https://example.com/' })
    vi.spyOn(harness.driver, 'close').mockRejectedValueOnce(
      new Error('close after worker exit failed'),
    )
    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => {})

    harness.failWorker(new Error('worker monitor failed'))

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        'browser worker exit cleanup failed',
      ))
    })
  })
})

describe('browser profile filesystem dependencies', () => {
  it('creates and recursively removes a private profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-runtime-'))
    try {
      const profile = await makeBrowserTempDirectory(root)
      await expect(access(profile)).resolves.toBeUndefined()
      await removeBrowserTempDirectory(profile)
      await expect(access(profile)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('uses the default subprocess, Playwright, and profile dependencies', async () => {
    const processHarness = createHarness()
    const ctx = new Context()
    void new StubSubprocessRuntime(ctx, processHarness.dependencies.spawn)
    const page = {
      goto: vi.fn(async () => {}),
      title: vi.fn(async () => 'Default page'),
      locator: vi.fn(() => ({
        ariaSnapshot: vi.fn(async () => '- heading "Default page"'),
      })),
      url: vi.fn(() => 'https://example.com/'),
    } as unknown as Page
    const browser = {
      contexts: () => [{
        pages: () => [page],
      } as unknown as BrowserContext],
      close: vi.fn(async () => {}),
    } as unknown as Browser
    vi.spyOn(chromium, 'connectOverCDP').mockResolvedValueOnce(browser)
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-defaults-'))
    try {
      const runtime = new PlaywrightElectronBrowserRuntime(
        ctx,
        runtimeConfig('/Applications/Electron', 1_000, 8, root),
      )
      const owner = fakeAgent('owner')

      await expect(runtime.open(owner, {
        url: 'https://example.com/',
      })).resolves.toEqual({
        url: 'https://example.com/',
        title: 'Default page',
        snapshot: '- heading "Default page"',
      })
      await runtime.close(owner)
      expect(processHarness.spawnSpecs).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { force: true, recursive: true })
    }
  })
})
