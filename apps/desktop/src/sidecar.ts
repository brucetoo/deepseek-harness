/**
 * Lifecycle supervision for the independently staged desktop Host process.
 * Electron integration supplies paths and owns the returned supervisor.
 */

import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** Fixed loopback origin exposed by the desktop Host. */
export const SIDECAR_ORIGIN = 'http://127.0.0.1:37615'

const READINESS_LINE = `dsh web: ${SIDECAR_ORIGIN}`
const TOKEN_ENVIRONMENT_NAME = 'DSH_DESKTOP_TOKEN'
const POSIX_ENVIRONMENT_KEYS = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR'] as const
const WINDOWS_ENVIRONMENT_KEYS = [
  'APPDATA',
  'ComSpec',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
] as const

/** Stable startup failure categories consumed by the desktop main process. */
export type SidecarStartupErrorCode =
  | 'SIDECAR_TIMEOUT'
  | 'SIDECAR_EARLY_EXIT'
  | 'SIDECAR_PORT_CONFLICT'
  | 'SIDECAR_MALFORMED_READINESS'
  | 'SIDECAR_DUPLICATE_READINESS'
  | 'SIDECAR_SPAWN_FAILURE'

/** Token-free evidence retained for a sidecar startup failure. */
export interface SidecarStartupDiagnostics {
  /** Bounded stderr suffix with the launch token replaced. */
  readonly stderrTail: string
  /** Exit status when the process exited before readiness. */
  readonly exitCode?: number | null
  /** Exit signal when the process exited before readiness. */
  readonly signal?: NodeJS.Signals | null
}

/** Typed startup failure with a stable machine-readable category. */
export class SidecarStartupError extends Error {
  /** Stable startup failure category. */
  readonly code: SidecarStartupErrorCode
  /** Token-free diagnostic fields suitable for logs and dialogs. */
  readonly diagnostics: SidecarStartupDiagnostics

  /**
   * Create a token-free startup failure.
   * @param code - Stable startup failure category.
   * @param diagnostics - Sanitized bounded diagnostics.
   */
  constructor(code: SidecarStartupErrorCode, diagnostics: SidecarStartupDiagnostics) {
    super(startupFailureMessage(code))
    this.name = 'SidecarStartupError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

/** Stable shutdown failure categories consumed by the desktop main process. */
export type SidecarShutdownErrorCode = 'SIDECAR_NO_QUIESCENCE'

/** Typed shutdown failure indicating that the child may still be running. */
export class SidecarShutdownError extends Error {
  /** Stable shutdown failure category. */
  readonly code: SidecarShutdownErrorCode

  /** Create a no-quiescence shutdown failure. */
  constructor() {
    super('Desktop Host remained alive after the final termination deadline.')
    this.name = 'SidecarShutdownError'
    this.code = 'SIDECAR_NO_QUIESCENCE'
  }
}

/** Stable lifecycle misuse categories consumed by the desktop main process. */
export type SidecarLifecycleErrorCode = 'SIDECAR_ALREADY_SHUT_DOWN'

/** Typed lifecycle failure for an attempted launch after shutdown. */
export class SidecarLifecycleError extends Error {
  /** Stable lifecycle failure category. */
  readonly code: SidecarLifecycleErrorCode

  /** Create a launch-after-shutdown failure. */
  constructor() {
    super('Desktop Host cannot start after its supervisor has shut down.')
    this.name = 'SidecarLifecycleError'
    this.code = 'SIDECAR_ALREADY_SHUT_DOWN'
  }
}

/** Successful sidecar startup result. */
export interface SidecarStartResult {
  /** Exact authenticated origin owned by the desktop application. */
  readonly origin: typeof SIDECAR_ORIGIN
}

/** Child-process options pinned by the desktop launch contract. */
export interface SidecarSpawnOptions extends Omit<SpawnOptionsWithoutStdio, 'stdio'> {
  /** Scrubbed inherited environment plus the per-launch bearer token. */
  readonly env: NodeJS.ProcessEnv
  /** All three standard streams remain available to the supervisor. */
  readonly stdio: ['pipe', 'pipe', 'pipe']
  /** Prevent a console window when the desktop application runs on Windows. */
  readonly windowsHide: true
}

/**
 * Spawn adapter used to substitute a deterministic process in tests.
 * @param executable - Staged Node executable.
 * @param args - Staged CLI entry and fixed Web arguments.
 * @param options - Piped, hidden, scrubbed process options.
 * @returns The running sidecar process.
 */
export type SidecarSpawn = (
  executable: string,
  args: readonly string[],
  options: SidecarSpawnOptions,
) => ChildProcessWithoutNullStreams

/** Signals used by the bounded sidecar shutdown sequence. */
export type SidecarSignal = 'SIGTERM' | 'SIGKILL'

/** Construction options for one desktop sidecar lifecycle. */
export interface SidecarSupervisorOptions {
  /** Absolute path to the staged Node executable. */
  readonly nodeExecutable: string
  /** Absolute path to the staged dsh CLI entry. */
  readonly cliEntry: string
  /** Desktop-owned Harness home, isolated from the user's CLI installation. */
  readonly harnessHome: string
  /** Read-only application skills shipped inside the staged runtime. */
  readonly bundledSkillDirectory: string
  /** Optional working directory for the staged process. */
  readonly cwd?: string
  /** Environment source filtered through the platform allowlist. */
  readonly inheritedEnvironment?: NodeJS.ProcessEnv
  /** Maximum wait for canonical readiness. */
  readonly startupTimeoutMs: number
  /** Quiet interval after the canonical line in which a duplicate is rejected. */
  readonly readinessConfirmationMs: number
  /** Maximum retained stderr suffix in UTF-8 bytes after redaction. */
  readonly stderrTailBytes: number
  /** Grace after stdin closes before termination escalation. */
  readonly shutdownGraceMs: number
  /** Grace after the platform termination request before `SIGKILL`. */
  readonly terminationGraceMs: number
  /** Final bounded wait after `SIGKILL`. */
  readonly killGraceMs: number
}

/** Replaceable process dependencies for deterministic lifecycle tests. */
export interface SidecarDependencies {
  /** Host platform used to select inherited environment keys and signaling. */
  readonly platform: NodeJS.Platform
  /** Child-process launcher. */
  readonly spawn: SidecarSpawn
  /**
   * Graceful request that closes the Host's stdin.
   * @param child - Running sidecar process.
   */
  readonly closeStdin: (child: ChildProcessWithoutNullStreams) => void
  /**
   * Platform-owned termination request; desktop tests replace this adapter.
   * @param child - Running sidecar process.
   * @param signal - Current escalation tier.
   * @param platform - Selected host platform.
   */
  readonly signal: (
    child: ChildProcessWithoutNullStreams,
    signal: SidecarSignal,
    platform: NodeJS.Platform,
  ) => void
  /**
   * Report a contained process error after startup completes.
   * @param error - Token-free child-process error.
   */
  readonly reportError: (error: Error) => void
}

const defaultSpawn: SidecarSpawn = (executable, args, options) =>
  nodeSpawn(executable, args, options)
const defaultCloseStdin: SidecarDependencies['closeStdin'] = child => child.stdin.end()
const defaultSignal: SidecarDependencies['signal'] = (child, signal, _platform) => {
  child.kill(signal)
}
const defaultReportError: SidecarDependencies['reportError'] = (error) => {
  process.stderr.write(`${error.stack ?? `${error.name}: ${error.message}`}\n`)
}

/** Result of a completed bounded sidecar shutdown. */
export interface SidecarShutdownResult {
  /** Whether shutdown advanced beyond the stdin grace to process signaling. */
  readonly forcedTermination: boolean
}

type SidecarLifecycleState = 'idle' | 'active' | 'shut-down'

/**
 * Own one staged Host child from spawn through bounded shutdown.
 * The instance is single-use: one `start()` call owns one process.
 */
export class SidecarSupervisor {
  readonly #options: SidecarSupervisorOptions
  readonly #dependencies: SidecarDependencies
  readonly #token: string
  #child: ChildProcessWithoutNullStreams | undefined
  #startPromise: Promise<SidecarStartResult> | undefined
  #shutdownPromise: Promise<SidecarShutdownResult> | undefined
  #exitPromise: Promise<void> | undefined
  #exited = false
  #stderr = ''
  #sawPortConflict = false
  #state: SidecarLifecycleState = 'idle'

  /**
   * Create a supervisor for one caller-supplied launch token.
   * @param options - Staged paths and lifecycle bounds.
   * @param dependencies - Replaceable process adapters.
   * @param token - Per-launch bearer token placed only in the child environment.
   */
  constructor(
    options: SidecarSupervisorOptions,
    dependencies: Partial<SidecarDependencies>,
    token: string,
  ) {
    this.#options = options
    this.#dependencies = {
      platform: dependencies.platform ?? process.platform,
      spawn: dependencies.spawn ?? defaultSpawn,
      closeStdin: dependencies.closeStdin ?? defaultCloseStdin,
      signal: dependencies.signal ?? defaultSignal,
      reportError: dependencies.reportError ?? defaultReportError,
    }
    this.#token = token
  }

  /**
   * Spawn the staged Host and wait for one canonical readiness line.
   * @returns The fixed sidecar origin after the duplicate-detection interval.
   * @throws {SidecarStartupError} With a stable code and token-free diagnostics.
   * @throws {SidecarLifecycleError} When shutdown began before the first launch.
   * @throws {SidecarShutdownError} When failed-start cleanup cannot stop the child.
   */
  start(): Promise<SidecarStartResult> {
    if (this.#startPromise !== undefined) return this.#startPromise
    if (this.#state === 'shut-down') {
      this.#startPromise = Promise.reject(new SidecarLifecycleError())
      return this.#startPromise
    }
    this.#state = 'active'
    this.#startPromise = this.#start()
    return this.#startPromise
  }

  /**
   * Close stdin, then escalate through platform TERM and KILL requests on bounded waits.
   * Concurrent and later calls join the first shutdown.
   * @returns Whether process signaling was required.
   * @throws {SidecarShutdownError} When the child remains alive after final escalation.
   */
  shutdown(): Promise<SidecarShutdownResult> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise
    this.#state = 'shut-down'
    this.#shutdownPromise = this.#shutdown()
    return this.#shutdownPromise
  }

  async #start(): Promise<SidecarStartResult> {
    if (this.#token.length === 0) {
      throw this.#failure('SIDECAR_SPAWN_FAILURE')
    }

    const spawnOptions: SidecarSpawnOptions = {
      ...this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd },
      env: launchEnvironment(
        this.#dependencies.platform,
        this.#options.inheritedEnvironment ?? process.env,
        this.#options.harnessHome,
        this.#options.nodeExecutable,
        this.#options.bundledSkillDirectory,
        this.#token,
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }

    try {
      this.#child = this.#dependencies.spawn(
        this.#options.nodeExecutable,
        [
          this.#options.cliEntry,
          'web',
          '--port',
          '37615',
          '--no-open',
          '--bearer-token-env',
          TOKEN_ENVIRONMENT_NAME,
        ],
        spawnOptions,
      )
    } catch {
      throw this.#failure('SIDECAR_SPAWN_FAILURE')
    }

    this.#observeExit(this.#child)
    try {
      return await this.#waitForReadiness(this.#child)
    } catch (error: unknown) {
      if (
        error instanceof SidecarStartupError
        && error.code !== 'SIDECAR_EARLY_EXIT'
      ) {
        await this.shutdown()
      }
      throw error
    }
  }

  async #shutdown(): Promise<SidecarShutdownResult> {
    const child = this.#child
    if (child === undefined || this.#hasExited(child)) {
      return { forcedTermination: false }
    }

    try {
      this.#dependencies.closeStdin(child)
    } catch {
      // A broken stdin cannot prevent bounded signal escalation.
    }
    if (await this.#waitForExit(child, this.#options.shutdownGraceMs)) {
      return { forcedTermination: false }
    }

    if (!this.#hasExited(child)) {
      this.#dependencies.signal(child, 'SIGTERM', this.#dependencies.platform)
    }
    if (await this.#waitForExit(child, this.#options.terminationGraceMs)) {
      return { forcedTermination: true }
    }

    if (!this.#hasExited(child)) {
      this.#dependencies.signal(child, 'SIGKILL', this.#dependencies.platform)
    }
    if (!await this.#waitForExit(child, this.#options.killGraceMs)) {
      throw new SidecarShutdownError()
    }
    return { forcedTermination: true }
  }

  #observeExit(child: ChildProcessWithoutNullStreams): void {
    this.#exitPromise = new Promise((resolve) => {
      child.once('exit', () => {
        this.#exited = true
        resolve()
      })
    })
  }

  #hasExited(child: ChildProcessWithoutNullStreams): boolean {
    return this.#exited || child.exitCode !== null || child.signalCode !== null
  }

  #waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.#hasExited(child)) return Promise.resolve(true)
    const exit = this.#exitPromise
    if (exit === undefined) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        resolve(this.#hasExited(child))
      }, timeoutMs)
      void exit.then(() => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  #waitForReadiness(child: ChildProcessWithoutNullStreams): Promise<SidecarStartResult> {
    return new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8')
      let stdout = ''
      let readinessCount = 0
      let confirmation: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const finish = (error?: SidecarStartupError): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (confirmation !== undefined) clearTimeout(confirmation)
        child.stdout.off('data', onStdout)
        child.stderr.off('data', onStderr)
        child.off('close', onClose)
        if (error === undefined) resolve({ origin: SIDECAR_ORIGIN })
        else reject(error)
      }

      const inspectLine = (line: string): void => {
        const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
        if (normalized === READINESS_LINE) {
          readinessCount += 1
          if (readinessCount > 1) {
            finish(this.#failure('SIDECAR_DUPLICATE_READINESS'))
            return
          }
          confirmation = setTimeout(() => {
            finish()
          }, this.#options.readinessConfirmationMs)
          return
        }
        if (normalized.startsWith('dsh web:')) {
          finish(this.#failure('SIDECAR_MALFORMED_READINESS'))
        }
      }

      const onStdout = (chunk: Buffer | string): void => {
        stdout += typeof chunk === 'string' ? chunk : decoder.write(chunk)
        for (let newline = stdout.indexOf('\n'); newline !== -1; newline = stdout.indexOf('\n')) {
          const line = stdout.slice(0, newline)
          stdout = stdout.slice(newline + 1)
          inspectLine(line)
          if (settled) return
        }
      }

      const onStderr = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const retentionBytes = this.#options.stderrTailBytes + Buffer.byteLength(this.#token)
        this.#stderr = utf8Tail(this.#stderr + text, retentionBytes)
        if (this.#stderr.includes('EADDRINUSE')) this.#sawPortConflict = true
      }

      const onError = (error: Error): void => {
        if (!settled) {
          finish(this.#failure('SIDECAR_SPAWN_FAILURE'))
          return
        }
        try {
          this.#dependencies.reportError(redactError(error, this.#token))
        } catch {
          // Reporter failures cannot escape the child process event dispatcher.
        }
      }

      const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        const code = this.#sawPortConflict ? 'SIDECAR_PORT_CONFLICT' : 'SIDECAR_EARLY_EXIT'
        finish(this.#failure(code, { exitCode, signal }))
      }

      const timeout = setTimeout(() => {
        finish(this.#failure('SIDECAR_TIMEOUT'))
      }, this.#options.startupTimeoutMs)

      child.stdout.on('data', onStdout)
      child.stderr.on('data', onStderr)
      child.on('error', onError)
      child.once('close', onClose)
    })
  }

  #failure(
    code: SidecarStartupErrorCode,
    exit?: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null },
  ): SidecarStartupError {
    const stderrTail = utf8Tail(
      this.#stderr.replaceAll(this.#token, '[redacted]'),
      this.#options.stderrTailBytes,
    )
    return new SidecarStartupError(code, {
      stderrTail,
      ...exit,
    })
  }
}

function launchEnvironment(
  platform: NodeJS.Platform,
  inherited: NodeJS.ProcessEnv,
  harnessHome: string,
  nodeExecutable: string,
  bundledSkillDirectory: string,
  token: string,
): NodeJS.ProcessEnv {
  const keys = platform === 'win32' ? WINDOWS_ENVIRONMENT_KEYS : POSIX_ENVIRONMENT_KEYS
  const environment: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    const value = inherited[key]
    if (value !== undefined) environment[key] = value
  }
  environment.DSH_HOME = harnessHome
  environment.DSH_BUNDLED_SKILL_DIR = bundledSkillDirectory
  environment.DEEPSEEK_HARNESS_DESKTOP_NODE = nodeExecutable
  environment.DEEPSEEK_HARNESS_BUNDLED_SKILL_DIR = bundledSkillDirectory
  environment[TOKEN_ENVIRONMENT_NAME] = token
  return environment
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  return bytes.subarray(bytes.length - maxBytes).toString('utf8').replace(/^\uFFFD+/u, '')
}

function redactError(error: Error, token: string): Error {
  const redacted = new Error(error.message.replaceAll(token, '[redacted]'))
  redacted.name = error.name
  if (error.stack !== undefined) {
    redacted.stack = error.stack.replaceAll(token, '[redacted]')
  }
  return redacted
}

function startupFailureMessage(code: SidecarStartupErrorCode): string {
  switch (code) {
    case 'SIDECAR_TIMEOUT':
      return 'Desktop Host did not report readiness before the startup deadline.'
    case 'SIDECAR_EARLY_EXIT':
      return 'Desktop Host exited before reporting readiness.'
    case 'SIDECAR_PORT_CONFLICT':
      return 'Desktop Host could not bind its fixed loopback port.'
    case 'SIDECAR_MALFORMED_READINESS':
      return 'Desktop Host reported a non-canonical readiness line.'
    case 'SIDECAR_DUPLICATE_READINESS':
      return 'Desktop Host reported readiness more than once.'
    case 'SIDECAR_SPAWN_FAILURE':
      return 'Desktop Host process could not be started.'
  }
}
