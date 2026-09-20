/** Validate desktop distributables and write their integrity manifest. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { DesktopPackageTarget } from './package-desktop.ts'

const checksumFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('desktop artifact stream emitted text')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/**
 * Write SHA-256 checksums for the complete distributable set of one target.
 * @param outputDirectory - Electron Builder output directory.
 * @param target - Native package target.
 * @param artifacts - Artifact paths returned by Electron Builder.
 * @returns Absolute checksum manifest path.
 */
export const writeDesktopArtifactChecksums = async (
  outputDirectory: string,
  target: DesktopPackageTarget,
  artifacts: readonly string[],
): Promise<string> => {
  const distributables = artifacts
    .filter(path => extname(path) === '.exe' || extname(path) === '.zip')
    .sort((left, right) => basename(left).localeCompare(basename(right)))
  const extensions = distributables.map(path => extname(path))
  const expected = target === 'darwin-arm64' ? ['.zip'] : ['.exe', '.zip']
  if (
    extensions.length !== expected.length
    || extensions.some((extension, index) => extension !== expected[index])
  ) {
    const requirement = target === 'darwin-arm64'
      ? 'exactly one .zip artifact'
      : 'exactly one .exe and one .zip artifact'
    throw new Error(`desktop package ${target} must produce ${requirement}`)
  }
  const lines = await Promise.all(
    distributables.map(async path =>
      `${await checksumFile(path)}  ${basename(path)}`),
  )
  const manifest = resolve(outputDirectory, 'SHA256SUMS')
  await writeFile(manifest, `${lines.join('\n')}\n`)
  return manifest
}
