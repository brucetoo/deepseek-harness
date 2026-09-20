import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeDesktopArtifactChecksums } from './package-desktop-artifacts.ts'

const roots: string[] = []

const fixtureRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-artifacts-'))
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

describe('desktop package artifacts', () => {
  it('writes a deterministic checksum manifest for Windows distributables', async () => {
    const output = fixtureRoot()
    const installer = join(output, 'DeepSeek-Harness-1.0.0-x64.exe')
    const archive = join(output, 'DeepSeek-Harness-1.0.0-x64.zip')
    const blockmap = `${archive}.blockmap`
    write(installer, 'installer')
    write(archive, 'archive')
    write(blockmap, 'metadata')

    const manifest = await writeDesktopArtifactChecksums(
      output,
      'win32-x64',
      [blockmap, archive, installer],
    )

    expect(manifest).toBe(join(output, 'SHA256SUMS'))
    expect(readFileSync(manifest, 'utf8')).toBe(
      '9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c  DeepSeek-Harness-1.0.0-x64.exe\n'
      + '0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3  DeepSeek-Harness-1.0.0-x64.zip\n',
    )
  })

  it('writes a checksum manifest for a macOS ZIP', async () => {
    const output = fixtureRoot()
    const archive = join(output, 'DeepSeek-Harness-1.0.0-arm64.zip')
    write(archive, 'archive')

    const manifest = await writeDesktopArtifactChecksums(
      output,
      'darwin-arm64',
      [archive],
    )

    expect(readFileSync(manifest, 'utf8')).toBe(
      '0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3  DeepSeek-Harness-1.0.0-arm64.zip\n',
    )
  })

  it('rejects an incomplete distributable set before writing checksums', async () => {
    const output = fixtureRoot()
    const archive = join(output, 'DeepSeek-Harness-1.0.0-x64.zip')
    write(archive, 'archive')

    await expect(writeDesktopArtifactChecksums(
      output,
      'win32-x64',
      [archive],
    )).rejects.toThrow(
      'desktop package win32-x64 must produce exactly one .exe and one .zip artifact',
    )
  })
})
