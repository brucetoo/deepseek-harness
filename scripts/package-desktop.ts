/** Package the validated desktop stage as an unsigned macOS arm64 application. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Configuration } from 'electron-builder'

/** One immutable runtime selected by the stage's atomic current pointer. */
export interface DesktopPackageStage {
  readonly versionName: string
  readonly sourceDirectory: string
}

interface DesktopStageTargetMetadata {
  readonly platform?: unknown
  readonly arch?: unknown
}

const parseStageVersion = (content: string): string => {
  const versionName = content.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(versionName)) {
    throw new Error('desktop stage pointer is invalid')
  }
  return versionName
}

/**
 * Resolve and target-check the immutable stage selected for packaging.
 * @param root - Repository root containing `apps/desktop/.stage`.
 * @returns Selected version name and absolute payload directory.
 */
export const resolveDesktopPackageStage = (
  root: string,
): DesktopPackageStage => {
  const stageDirectory = resolve(root, 'apps/desktop/.stage')
  const versionName = parseStageVersion(
    readFileSync(resolve(stageDirectory, 'current'), 'utf8'),
  )
  const sourceDirectory = resolve(stageDirectory, 'versions', versionName)
  const metadata = JSON.parse(
    readFileSync(resolve(sourceDirectory, 'metadata.json'), 'utf8'),
  ) as DesktopStageTargetMetadata
  if (metadata.platform !== 'darwin' || metadata.arch !== 'arm64') {
    throw new Error('desktop package requires a darwin-arm64 stage')
  }
  return { versionName, sourceDirectory }
}

/**
 * Create the electron-builder configuration for one selected stage.
 * @param root - Repository root.
 * @param stage - Validated immutable sidecar stage.
 * @returns Complete unsigned macOS application configuration.
 */
export const createDesktopBuildConfiguration = (
  root: string,
  stage: DesktopPackageStage,
): Configuration => ({
  appId: 'ai.deepseek.harness',
  productName: 'DeepSeek Harness',
  asar: true,
  npmRebuild: false,
  electronDist: resolve(root, 'apps/desktop/node_modules/electron/dist'),
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
  mac: {
    category: 'public.app-category.developer-tools',
    identity: null,
    icon: resolve(root, 'apps/desktop/build/icon.png'),
    target: [
      { target: 'dir', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
  },
  artifactName: 'DeepSeek-Harness-${version}-${arch}.${ext}',
})

const main = async (): Promise<void> => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('desktop package command currently supports macOS arm64 only')
  }
  const root = resolve(import.meta.dirname, '..')
  const stage = resolveDesktopPackageStage(root)
  const configuration = createDesktopBuildConfiguration(root, stage)
  const { build } = await import('electron-builder')
  await build({
    projectDir: resolve(root, 'apps/desktop'),
    config: configuration,
  })
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
