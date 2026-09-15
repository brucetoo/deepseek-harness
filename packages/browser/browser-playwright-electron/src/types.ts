/** Internal interfaces for the Electron browser Provider. */

import type {
  BrowserElementAction,
  BrowserElementFingerprint,
  BrowserObservation,
} from '@deepseek-ai/dsh-browser'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Prepared element retained inside a concrete browser driver. */
export interface BrowserDriverPreparedAction {
  readonly fingerprint: BrowserElementFingerprint
  commit(signal?: AbortSignal): Promise<void>
  dispose(): Promise<void>
}

/** Playwright-facing operations consumed by the owner/lifecycle runtime. */
export interface BrowserDriver {
  goto(url: string, signal?: AbortSignal): Promise<BrowserObservation>
  snapshot(signal?: AbortSignal): Promise<BrowserObservation>
  prepare(
    action: BrowserElementAction,
    signal?: AbortSignal,
  ): Promise<BrowserDriverPreparedAction>
  wait(durationMs: number, signal?: AbortSignal): Promise<BrowserObservation>
  close(): Promise<void>
}

/** Replaceable process, CDP, and temporary-directory operations. */
export interface BrowserProviderDependencies {
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly connect: (
    endpoint: string,
    operationTimeoutMs: number,
    snapshotDepth: number,
  ) => Promise<BrowserDriver>
  readonly makeTempDirectory: (root: string) => Promise<string>
  readonly removeTempDirectory: (path: string) => Promise<void>
}
