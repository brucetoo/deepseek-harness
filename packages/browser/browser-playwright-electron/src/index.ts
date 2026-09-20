/**
 * Playwright-over-CDP Service Provider for the desktop Electron browser.
 * @module @deepseek-ai/dsh-browser-playwright-electron
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserRuntime, {
  BrowserError,
  BrowserPreparedActionId,
  parsePublicBrowserUrl,
  type BrowserElementAction,
  type BrowserObservation,
  type BrowserOpenRequest,
  type BrowserPreparedAction,
  type BrowserPreparedActionId as BrowserPreparedActionIdType,
  type BrowserWaitRequest,
} from '@deepseek-ai/dsh-browser'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { connectPlaywrightBrowserDriver } from './playwright-driver.ts'
import type {
  BrowserDriver,
  BrowserDriverPreparedAction,
  BrowserProviderDependencies,
} from './types.ts'
import {
  BrowserWorkerChannel,
  waitForWorkerReadiness,
} from './worker-channel.ts'

export type {
  BrowserDriver,
  BrowserDriverPreparedAction,
  BrowserProviderDependencies,
} from './types.ts'

/** Provider configuration resolved by the desktop Host composition. */
export interface Config {
  /** Electron executable used for the dedicated worker. */
  readonly electronExecutable: string
  /** Desktop application entry loaded by Electron. */
  readonly applicationEntry: string
  /** Parent directory for ephemeral Chromium profiles. */
  readonly tempRoot: string
  /** Milliseconds allowed for worker and CDP readiness. */
  readonly launchTimeoutMs: number
  /** Milliseconds allowed for Playwright and worker-protocol operations. */
  readonly operationTimeoutMs: number
  /** Milliseconds allowed for navigation policy events to settle after an operation. */
  readonly navigationSettleMs: number
  /** Milliseconds allowed for driver cleanup and process-tree quiescence. */
  readonly cleanupTimeoutMs: number
  /** Milliseconds between graceful and forced worker termination. */
  readonly processGraceMs: number
  /** Maximum bytes accepted from one worker protocol phase. */
  readonly readinessMaxBytes: number
  /** Maximum depth of returned ARIA snapshots. */
  readonly snapshotDepth: number
}

export const Config: z<Config> = z.object({
  electronExecutable: z.string(),
  applicationEntry: z.string(),
  tempRoot: z.string(),
  launchTimeoutMs: z.number().default(10_000),
  operationTimeoutMs: z.number().default(10_000),
  navigationSettleMs: z.number().default(50),
  cleanupTimeoutMs: z.number().default(5_000),
  processGraceMs: z.number().default(2_000),
  readinessMaxBytes: z.number().default(16_384),
  snapshotDepth: z.number().default(8),
})

interface PreparedRecord {
  readonly action: BrowserElementAction
  readonly driverAction: BrowserDriverPreparedAction
}

interface BrowserInstance {
  readonly owner: Agent
  readonly prepared: Map<BrowserPreparedActionIdType, PreparedRecord>
  phase: 'starting' | 'active' | 'closing'
  profile?: string
  process?: SubprocessHandle
  driver?: BrowserDriver
  channel?: BrowserWorkerChannel
}

const positiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`browser-playwright-electron: ${name} must be a positive integer`)
  }
}

const validateConfig = (config: Config): void => {
  for (const [name, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.length === 0) {
      throw new Error(`browser-playwright-electron: ${name} must be non-empty`)
    }
    if (typeof value === 'number') positiveInteger(name, value)
  }
}

/**
 * Electron browser implementation with exact-Agent ownership and awaited
 * process/profile cleanup.
 */
export class PlaywrightElectronBrowserRuntime extends BrowserRuntime {
  static inject = ['subprocess']
  static Config = Config

  private readonly dependencies: BrowserProviderDependencies
  private instance: BrowserInstance | undefined
  private queue: Promise<void> = Promise.resolve()
  private nextPreparedAction = 0

  constructor(
    ctx: Context,
    readonly config: Config,
    dependencies?: BrowserProviderDependencies,
  ) {
    super(ctx)
    validateConfig(config)
    this.dependencies = dependencies ?? {
      spawn: spec => ctx.subprocess.spawn(spec),
      connect: connectPlaywrightBrowserDriver,
      makeTempDirectory: makeBrowserTempDirectory,
      removeTempDirectory: removeBrowserTempDirectory,
    }
    ctx.effect(() => () => this.serialize(async () => {
      if (this.instance !== undefined) await this.teardown(this.instance)
    }), 'browser-playwright-electron teardown')
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.instance?.owner !== agent) return
      void this.serialize(async () => {
        if (this.instance?.owner === agent) await this.teardown(this.instance)
      }).catch((error: unknown) => {
        ctx.logger.warn(`browser owner cleanup failed: ${String(error)}`)
      })
    })
  }

  /** @inheritdoc */
  open(
    owner: Agent,
    request: BrowserOpenRequest,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    return this.serialize(async () => {
      signal?.throwIfAborted()
      if (this.instance !== undefined) {
        throw new BrowserError(
          this.instance.owner === owner ? 'this Session already owns a browser' : 'another Session owns the browser',
          this.instance.owner === owner ? 'BROWSER_ALREADY_OPEN' : 'BROWSER_BUSY',
        )
      }
      const instance: BrowserInstance = {
        owner,
        prepared: new Map(),
        phase: 'starting',
      }
      this.instance = instance
      try {
        const url = parsePublicBrowserUrl(request.url)
        instance.profile = await this.dependencies.makeTempDirectory(this.config.tempRoot)
        signal?.throwIfAborted()
        instance.process = this.dependencies.spawn({
          argv: [
            this.config.electronExecutable,
            this.config.applicationEntry,
            '--dsh-browser-worker',
            `--dsh-browser-profile=${instance.profile}`,
          ],
          cwd: dirname(this.config.applicationEntry),
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          graceMs: this.config.processGraceMs,
          ...signal === undefined ? {} : { signal },
        })
        this.observeWorkerExit(instance as BrowserInstance & { readonly process: SubprocessHandle })
        const endpoint = await waitForWorkerReadiness(
          instance.process,
          this.config.launchTimeoutMs,
          this.config.readinessMaxBytes,
          signal,
        )
        instance.driver = await this.dependencies.connect(
          endpoint,
          this.config.operationTimeoutMs,
          this.config.snapshotDepth,
        )
        instance.channel = new BrowserWorkerChannel(
          instance.process,
          this.config.operationTimeoutMs,
          this.config.readinessMaxBytes,
        )
        const active = instance as BrowserInstance & {
          readonly channel: BrowserWorkerChannel
          readonly driver: BrowserDriver
          readonly process: SubprocessHandle
        }
        const result = await this.runObserved(
          active,
          signal,
          () => this.withNavigationPermit(active, url, signal, () => active.driver.goto(url, signal)),
          false,
        )
        instance.phase = 'active'
        return result
      } catch (cause: unknown) {
        let cleanupError: unknown
        try {
          await this.teardown(instance)
        } catch (error: unknown) {
          cleanupError = error
        }
        throw new BrowserError(
          'browser worker could not be opened',
          'BROWSER_LAUNCH_FAILED',
          { cause: cleanupError === undefined ? cause : new AggregateError([cause, cleanupError]) },
        )
      }
    })
  }

  /** @inheritdoc */
  snapshot(owner: Agent, signal?: AbortSignal): Promise<BrowserObservation> {
    return this.serialize(() => this.runActive(
      owner,
      signal,
      instance => instance.driver.snapshot(signal),
    ))
  }

  /** @inheritdoc */
  prepare(
    owner: Agent,
    action: BrowserElementAction,
    signal?: AbortSignal,
  ): Promise<BrowserPreparedAction> {
    return this.serialize(() => this.runActive(owner, signal, async (instance) => {
      const driverAction = await instance.driver.prepare(action, signal)
      let current: BrowserObservation
      try {
        current = await instance.driver.snapshot(signal)
      } catch (error: unknown) {
        await driverAction.dispose()
        throw error
      }
      const id = BrowserPreparedActionId(`browser-action-${++this.nextPreparedAction}`)
      instance.prepared.set(id, { action, driverAction })
      return {
        id,
        owner,
        pageUrl: current.url,
        action,
        fingerprint: driverAction.fingerprint,
      }
    }))
  }

  /** @inheritdoc */
  commit(
    owner: Agent,
    id: BrowserPreparedActionIdType,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    return this.serialize(() => this.runActive(owner, signal, async (instance) => {
      const prepared = instance.prepared.get(id)
      if (prepared === undefined) {
        throw new BrowserError('prepared browser action is missing or already settled', 'BROWSER_PREPARED_ACTION_MISSING')
      }
      instance.prepared.delete(id)
      const destination = prepared.driverAction.fingerprint.href
        ?? prepared.driverAction.fingerprint.formAction
      try {
        if (destination !== undefined) {
          await this.withNavigationPermit(
            instance,
            parsePublicBrowserUrl(destination),
            signal,
            () => prepared.driverAction.commit(signal),
          )
        } else await prepared.driverAction.commit(signal)
      } finally {
        await prepared.driverAction.dispose()
      }
      return instance.driver.snapshot(signal)
    }))
  }

  /** @inheritdoc */
  release(owner: Agent, id: BrowserPreparedActionIdType): Promise<void> {
    return this.serialize(async () => {
      const instance = this.active(owner)
      const prepared = instance.prepared.get(id)
      if (prepared === undefined) return
      instance.prepared.delete(id)
      await prepared.driverAction.dispose()
    })
  }

  /** @inheritdoc */
  wait(
    owner: Agent,
    request: BrowserWaitRequest,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    return this.serialize(() => this.runActive(owner, signal, (instance) => {
      positiveInteger('durationMs', request.durationMs)
      return instance.driver.wait(request.durationMs, signal)
    }))
  }

  /** @inheritdoc */
  close(owner: Agent): Promise<void> {
    return this.serialize(async () => {
      if (this.instance === undefined) return
      if (this.instance.owner !== owner) {
        throw new BrowserError('browser belongs to another Session', 'BROWSER_FOREIGN_OWNER')
      }
      await this.teardown(this.instance)
    })
  }

  private active(owner: Agent): BrowserInstance & {
    readonly channel: BrowserWorkerChannel
    readonly driver: BrowserDriver
    readonly process: SubprocessHandle
  } {
    const instance = this.instance
    if (
      instance === undefined
      || instance.phase !== 'active'
      || instance.channel === undefined
      || instance.driver === undefined
      || instance.process === undefined
    ) {
      throw new BrowserError('no active browser exists', 'BROWSER_NOT_OPEN')
    }
    if (instance.owner !== owner) {
      throw new BrowserError('browser belongs to another Session', 'BROWSER_FOREIGN_OWNER')
    }
    return instance as BrowserInstance & {
      readonly channel: BrowserWorkerChannel
      readonly driver: BrowserDriver
      readonly process: SubprocessHandle
    }
  }

  private observeWorkerExit(
    instance: BrowserInstance & { readonly process: SubprocessHandle },
  ): void {
    const cleanup = async (): Promise<void> => {
      instance.process.terminate()
      await instance.process.waitForExit()
      await this.cleanupExitedWorker(instance)
    }
    void instance.process.done.then(cleanup, cleanup)
  }

  private async runActive<T>(
    owner: Agent,
    signal: AbortSignal | undefined,
    operation: (
      instance: BrowserInstance & {
        readonly channel: BrowserWorkerChannel
        readonly driver: BrowserDriver
        readonly process: SubprocessHandle
      },
    ) => Promise<T>,
  ): Promise<T> {
    const instance = this.active(owner)
    try {
      return await this.runObserved(instance, signal, () => operation(instance))
    } catch (error: unknown) {
      if (signal?.aborted !== true) throw error
      try {
        await this.teardown(instance)
      } catch (cleanupError: unknown) {
        throw new BrowserError(
          'browser cancellation cleanup failed',
          'BROWSER_CLEANUP_FAILED',
          { cause: new AggregateError([error, cleanupError]) },
        )
      }
      throw error
    }
  }

  private async runObserved<T>(
    instance: BrowserInstance & {
      readonly channel: BrowserWorkerChannel
      readonly driver: BrowserDriver
      readonly process: SubprocessHandle
    },
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    inspectBefore = true,
  ): Promise<T> {
    if (inspectBefore) await this.assertNoBlockedNavigation(instance, signal)
    try {
      const result = await operation()
      await delay(this.config.navigationSettleMs, undefined, {
        ...signal === undefined ? {} : { signal },
      })
      await this.assertNoBlockedNavigation(instance, signal)
      return result
    } catch (error: unknown) {
      if (instance.phase === 'closing') throw error
      try {
        await this.assertNoBlockedNavigation(instance, signal)
      } catch (navigationError: unknown) {
        throw navigationError
      }
      throw error
    }
  }

  private async withNavigationPermit<T>(
    instance: BrowserInstance & { readonly channel: BrowserWorkerChannel },
    url: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      await instance.channel.setNavigationPermit(url, signal)
      return await operation()
    } finally {
      try {
        await instance.channel.setNavigationPermit(null)
      } catch (error: unknown) {
        try {
          await this.teardown(instance)
        } catch (cleanupError: unknown) {
          throw new BrowserError(
            'browser permit revocation and cleanup failed',
            'BROWSER_CLEANUP_FAILED',
            { cause: new AggregateError([error, cleanupError]) },
          )
        }
        throw error
      }
    }
  }

  private async assertNoBlockedNavigation(
    instance: BrowserInstance & { readonly channel: BrowserWorkerChannel },
    signal?: AbortSignal,
  ): Promise<void> {
    const blocked = await instance.channel.inspectNavigation(signal)
    if (blocked === undefined) return
    const usability = blocked.pageUsable
      ? `the current page remains usable at ${blocked.currentUrl}`
      : 'the current page is no longer usable'
    throw new BrowserError(
      `browser blocked top-level navigation to ${blocked.attemptedUrl}; ${usability}`,
      'BROWSER_NAVIGATION_BLOCKED',
    )
  }

  private cleanupExitedWorker(instance: BrowserInstance): Promise<void> {
    return this.serialize(async () => {
      if (this.instance !== instance) return
      try {
        await this.teardown(instance)
      } catch (error: unknown) {
        this.ctx.logger.warn(`browser worker exit cleanup failed: ${String(error)}`)
      }
    })
  }

  private async teardown(instance: BrowserInstance): Promise<void> {
    instance.phase = 'closing'
    const deadline = AbortSignal.timeout(this.config.cleanupTimeoutMs)
    let cleanupTimer: NodeJS.Timeout
    const driverCleanup = Promise.race([
      this.cleanupDriver(instance),
      new Promise<unknown[]>((resolve) => {
        cleanupTimer = setTimeout(() => {
          resolve([new BrowserError('browser driver cleanup timed out', 'BROWSER_CLEANUP_TIMEOUT')])
        }, this.config.cleanupTimeoutMs)
      }),
    ]).finally(() => { clearTimeout(cleanupTimer) })
    let exited = true
    if (instance.process !== undefined) {
      instance.channel?.dispose()
      instance.process.stdin?.end()
      instance.process.terminate()
      exited = await instance.process.waitForExit(deadline)
    }
    const failures = await driverCleanup
    if (!exited) {
      throw new BrowserError('browser worker process tree did not reach quiescence', 'BROWSER_CLEANUP_TIMEOUT', {
        cause: new AggregateError(failures),
      })
    }
    let profileRemoved = true
    if (instance.profile !== undefined) {
      try {
        await this.dependencies.removeTempDirectory(instance.profile)
      } catch (error: unknown) {
        profileRemoved = false
        failures.push(error)
      }
    }
    if (profileRemoved) this.instance = undefined
    if (failures.length > 0) {
      throw new BrowserError(
        'browser cleanup failed',
        'BROWSER_CLEANUP_FAILED',
        { cause: new AggregateError(failures) },
      )
    }
  }

  private async cleanupDriver(instance: BrowserInstance): Promise<unknown[]> {
    const operations = [...instance.prepared.values()].map(async prepared => prepared.driverAction.dispose())
    instance.prepared.clear()
    const driver = instance.driver
    delete instance.driver
    if (driver !== undefined) operations.push((async () => driver.close())())
    const outcomes = await Promise.allSettled(operations)
    return outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Plugin class loaded by Cordis. */
export default PlaywrightElectronBrowserRuntime

/**
 * Create one ephemeral browser-profile directory.
 * @param root - Parent directory for browser profiles.
 * @returns The new profile directory path.
 */
export const makeBrowserTempDirectory = async (root: string): Promise<string> => {
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, 'session-'))
}

/**
 * Remove one ephemeral browser profile recursively.
 * @param path - Profile directory to remove.
 */
export const removeBrowserTempDirectory = (path: string): Promise<void> =>
  rm(path, { force: true, recursive: true })
