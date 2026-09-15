import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDesktopBuildConfiguration,
  resolveDesktopPackageStage,
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

    expect(resolveDesktopPackageStage(root)).toEqual({
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

    expect(() => resolveDesktopPackageStage(root)).toThrow(
      'desktop package requires a darwin-arm64 stage',
    )
  })

  it('creates an unsigned app and ZIP configuration with one sidecar version', () => {
    const root = '/checkout'
    const stage = {
      versionName: 'release-1',
      sourceDirectory: '/checkout/apps/desktop/.stage/versions/release-1',
    }

    expect(createDesktopBuildConfiguration(root, stage)).toEqual({
      appId: 'ai.deepseek.harness',
      productName: 'DeepSeek Harness',
      asar: true,
      npmRebuild: false,
      electronDist: '/checkout/apps/desktop/node_modules/electron/dist',
      directories: {
        output: '/checkout/apps/desktop/dist',
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
        icon: '/checkout/apps/desktop/build/icon.png',
        target: [
          { target: 'dir', arch: ['arm64'] },
          { target: 'zip', arch: ['arm64'] },
        ],
      },
      artifactName: 'DeepSeek-Harness-${version}-${arch}.${ext}',
    })
  })
})
