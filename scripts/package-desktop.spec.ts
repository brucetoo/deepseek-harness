import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopBuildConfiguration,
  resolveDesktopPackageStage,
  resolveDesktopPackageTarget,
} from './package-desktop.ts'

const roots: string[] = []

const fixtureRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-package-'))
  roots.push(root)
  return root
}

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop package stage', () => {
  it('selects the atomically published macOS arm64 stage', () => {
    const root = fixtureRoot()
    write(join(root, 'apps/desktop/.stage/current'), 'release-1\n')
    write(join(root, 'apps/desktop/.stage/versions/release-1/metadata.json'), JSON.stringify({
      platform: 'darwin',
      arch: 'arm64',
    }))

    expect(resolveDesktopPackageStage(root, 'darwin-arm64')).toEqual({
      versionName: 'release-1',
      sourceDirectory: join(root, 'apps/desktop/.stage/versions/release-1'),
    })
  })

  it('selects the atomically published Windows x64 stage', () => {
    const root = fixtureRoot()
    write(join(root, 'apps/desktop/.stage/current'), 'release-1\n')
    write(join(root, 'apps/desktop/.stage/versions/release-1/metadata.json'), JSON.stringify({
      platform: 'win32',
      arch: 'x64',
    }))

    expect(resolveDesktopPackageStage(root, 'win32-x64')).toEqual({
      versionName: 'release-1',
      sourceDirectory: join(root, 'apps/desktop/.stage/versions/release-1'),
    })
  })

  it('rejects a stage built for another target', () => {
    const root = fixtureRoot()
    write(join(root, 'apps/desktop/.stage/current'), 'release-1\n')
    write(join(root, 'apps/desktop/.stage/versions/release-1/metadata.json'), JSON.stringify({
      platform: 'linux',
      arch: 'x64',
    }))

    expect(() => resolveDesktopPackageStage(root, 'darwin-arm64')).toThrow(
      'desktop package requires a darwin-arm64 stage',
    )
  })

  it('requires a supported target running on its native host', () => {
    expect(resolveDesktopPackageTarget('darwin-arm64', 'darwin', 'arm64')).toBe(
      'darwin-arm64',
    )
    expect(resolveDesktopPackageTarget('win32-x64', 'win32', 'x64')).toBe(
      'win32-x64',
    )
    expect(() => resolveDesktopPackageTarget(undefined, 'darwin', 'arm64'))
      .toThrow('desktop package target must be darwin-arm64 or win32-x64')
    expect(() => resolveDesktopPackageTarget('win32-x64', 'darwin', 'arm64'))
      .toThrow('desktop package target win32-x64 requires a win32-x64 host')
  })

  it('creates an unsigned macOS app and ZIP configuration with one sidecar version', () => {
    const root = resolve('/checkout')
    const stage = {
      versionName: 'release-1',
      sourceDirectory: resolve(root, 'apps/desktop/.stage/versions/release-1'),
    }

    expect(createDesktopBuildConfiguration(root, stage, 'darwin-arm64')).toEqual({
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
  })

  it('creates an unsigned assisted Windows installer and ZIP configuration', () => {
    const root = 'C:\\checkout'
    const stage = {
      versionName: 'release-1',
      sourceDirectory: 'C:\\checkout\\apps\\desktop\\.stage\\versions\\release-1',
    }

    expect(createDesktopBuildConfiguration(root, stage, 'win32-x64')).toEqual({
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
      win: {
        icon: resolve(root, 'apps/desktop/build/icon.png'),
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
      artifactName: 'DeepSeek-Harness-${version}-${arch}.${ext}',
    })
  })
})
