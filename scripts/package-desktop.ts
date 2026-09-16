/** Package a validated native desktop stage for its supported host target. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Configuration } from 'electron-builder'
import { writeDesktopArtifactChecksums } from './package-desktop-artifacts.ts'

/** One immutable runtime selected by the stage's atomic current pointer. */
export interface DesktopPackageStage {
  readonly versionName: string
  readonly sourceDirectory: string
}

interface DesktopStageTargetMetadata {
  readonly platform?: unknown
  readonly arch?: unknown
}

/** Native platform and architecture pair supported by desktop packaging. */
export type DesktopPackageTarget = 'darwin-arm64' | 'win32-x64'

const packageTargetMetadata = {
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
  },
} as const satisfies Record<
  DesktopPackageTarget,
  {
    readonly platform: NodeJS.Platform
    readonly arch: string
  }
>

const parseStageVersion = (content: string): string => {
  const versionName = content.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(versionName)) {
    throw new Error('desktop stage pointer is invalid')
  }
  return versionName
}

/**
 * Validate one supported package target against the current native host.
 * @param requested - Target name supplied by the package command.
 * @param hostPlatform - Platform of the Node process running Electron Builder.
 * @param hostArch - Architecture of the Node process running Electron Builder.
 * @returns Validated native package target.
 */
export const resolveDesktopPackageTarget = (
  requested: string | undefined,
  hostPlatform: NodeJS.Platform,
  hostArch: string,
): DesktopPackageTarget => {
  if (requested !== 'darwin-arm64' && requested !== 'win32-x64') {
    throw new Error(
      'desktop package target must be darwin-arm64 or win32-x64',
    )
  }
  const expected = packageTargetMetadata[requested]
  if (hostPlatform !== expected.platform || hostArch !== expected.arch) {
    throw new Error(
      `desktop package target ${requested} requires a ${expected.platform}-${expected.arch} host`,
    )
  }
  return requested
}

/**
 * Resolve and target-check the immutable stage selected for packaging.
 * @param root - Repository root containing `apps/desktop/.stage`.
 * @param target - Native package target whose stage metadata must match.
 * @returns Selected version name and absolute payload directory.
 */
export const resolveDesktopPackageStage = (
  root: string,
  target: DesktopPackageTarget,
): DesktopPackageStage => {
  const stageDirectory = resolve(root, 'apps/desktop/.stage')
  const versionName = parseStageVersion(
    readFileSync(resolve(stageDirectory, 'current'), 'utf8'),
  )
  const sourceDirectory = resolve(stageDirectory, 'versions', versionName)
  const metadata = JSON.parse(
    readFileSync(resolve(sourceDirectory, 'metadata.json'), 'utf8'),
  ) as DesktopStageTargetMetadata
  const expected = packageTargetMetadata[target]
  if (
    metadata.platform !== expected.platform
    || metadata.arch !== expected.arch
  ) {
    throw new Error(`desktop package requires a ${target} stage`)
  }
  return { versionName, sourceDirectory }
}

/**
 * Create the electron-builder configuration for one selected stage.
 * @param root - Repository root.
 * @param stage - Validated immutable sidecar stage.
 * @param target - Native package target.
 * @returns Complete unsigned application configuration.
 */
export const createDesktopBuildConfiguration = (
  root: string,
  stage: DesktopPackageStage,
  target: DesktopPackageTarget,
): Configuration => {
  const common: Configuration = {
    appId: 'ai.deepseek.harness',
    productName: 'DeepSeek Harness',
    asar: true,
    npmRebuild: false,
    directories: {
      output: resolve(root, 'apps/desktop/dist'),
    },
    files: [
      'lib/types/src/**/*',
      'package.json',
    ],
    extraResources: [{
      from: stage.sourceDirectory,
      to: 'sidecar',
    }],
    artifactName: 'DeepSeek-Harness-${version}-${arch}.${ext}',
  }
  const icon = resolve(root, 'apps/desktop/build/icon.png')
  if (target === 'darwin-arm64') {
    return {
      ...common,
      mac: {
        category: 'public.app-category.developer-tools',
        identity: null,
        icon,
        target: [
          { target: 'dir', arch: ['arm64'] },
          { target: 'zip', arch: ['arm64'] },
        ],
      },
    }
  }
  return {
    ...common,
    win: {
      icon,
      signExecutable: false,
      target: [
        { target: 'nsis', arch: ['x64'] },
        { target: 'zip', arch: ['x64'] },
      ],
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
    },
  }
}

const main = async (): Promise<void> => {
  if (process.argv.length !== 3) {
    throw new Error(
      'desktop package command requires exactly one target: darwin-arm64 or win32-x64',
    )
  }
  const target = resolveDesktopPackageTarget(
    process.argv[2],
    process.platform,
    process.arch,
  )
  const root = resolve(import.meta.dirname, '..')
  const stage = resolveDesktopPackageStage(root, target)
  const configuration = createDesktopBuildConfiguration(root, stage, target)
  const { build } = await import('electron-builder')
  const artifacts = await build({
    projectDir: resolve(root, 'apps/desktop'),
    config: configuration,
  })
  await writeDesktopArtifactChecksums(
    resolve(root, 'apps/desktop/dist'),
    target,
    artifacts,
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
