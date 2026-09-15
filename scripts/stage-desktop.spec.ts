import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopStagePlan,
  createDesktopStageMetadata,
  executeDesktopStage,
  publishDesktopStage,
  validateDesktopStage,
  type DesktopStageMetadata,
} from './stage-desktop.ts'

const roots: string[] = []
const metadata: DesktopStageMetadata = {
  commit: '0123456789abcdef',
  lockfileSha256: 'a'.repeat(64),
  nodeVersion: 'v24.8.0',
  platform: 'darwin',
  arch: 'arm64',
}

const requiredFiles = [
  'app/lib/bin.js',
  'app/config/agent-presets/standard/preset.yml',
  'app/config/agent-presets/standard/agent.cordis.yml',
  'app/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
  'app/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
  'app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'app/node_modules/@deepseek-ai/dsh-commands/lib/typert.remote-client.js',
  'app/node_modules/@deepseek-ai/dsh-goal/lib/typert.remote-client.js',
  'app/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/typert.remote-client.js',
  'app/node_modules/@deepseek-ai/dsh-file-reference/lib/typert.remote-client.js',
  'app/node_modules/@deepseek-ai/dsh-host-plugin-inventory/lib/typert.remote-client.js',
  'app/node_modules/@deepseek-ai/dsh-message-feedback/lib/typert.remote-client.js',
  'app/node_modules/@deepseek-ai/dsh-session-reference/lib/typert.remote-client.js',
] as const

const fixtureRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-stage-'))
  roots.push(root)
  return root
}

const write = (path: string, content = 'fixture\n'): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const createPackage = (stage: string, name: string): void => {
  const packageRoot = join(stage, 'app/node_modules', name)
  write(join(packageRoot, 'index.js'), 'export {}\n')
  write(join(packageRoot, 'package.json'), JSON.stringify({
    name,
    type: 'module',
    main: 'index.js',
  }))
}

const createValidStage = (parent = fixtureRoot()): string => {
  const stage = join(parent, 'stage')
  populateValidStage(stage)
  return stage
}

const populateValidStage = (stage: string): void => {
  for (const path of requiredFiles) write(join(stage, path))
  write(join(stage, 'app/package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    type: 'module',
  }))
  createPackage(stage, 'node-pty')
  createPackage(stage, 'koffi')
  const node = join(stage, 'node/bin', process.platform === 'win32' ? 'node.exe' : 'node')
  write(node)
  if (process.platform !== 'win32') chmodSync(node, 0o755)
  write(join(stage, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
}

const validate = (stage: string, expected = metadata): Promise<void> =>
  validateDesktopStage(stage, expected, {
    readNodeVersion: vi.fn(async () => metadata.nodeVersion),
  })

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop stage planning', () => {
  it('plans shell-free build and filtered production deploy commands', () => {
    const root = '/checkout'
    const plan = createDesktopStagePlan({
      root,
      sourceNodeExecutable: '/runtime/bin/node',
      metadata,
      temporaryId: 'fixture',
      pnpm: { command: '/runtime/bin/node', args: ['/pnpm.cjs'] },
    })

    expect(plan).toMatchObject({
      root,
      stageDirectory: '/checkout/apps/desktop/.stage',
      temporaryDirectory: '/checkout/apps/desktop/.stage.tmp-fixture',
      backupDirectory: '/checkout/apps/desktop/.stage.backup-fixture',
      sourceNodeExecutable: '/runtime/bin/node',
      metadata,
      commands: {
        build: {
          command: '/runtime/bin/node',
          args: ['/pnpm.cjs', 'run', 'build'],
          cwd: root,
        },
        deploy: {
          command: '/runtime/bin/node',
          args: [
            '/pnpm.cjs',
            '--filter',
            '@deepseek-ai/dsh',
            'deploy',
            '--legacy',
            '--prod',
            '--config.node-linker=hoisted',
            '--config.auto-install-peers=false',
            '--config.link-workspace-packages=true',
            '/checkout/apps/desktop/.stage.tmp-fixture/app',
          ],
          cwd: root,
        },
      },
    })
  })

  it('records the commit, lockfile digest, and target runtime identity', async () => {
    const root = fixtureRoot()
    write(join(root, 'pnpm-lock.yaml'), 'lockfile fixture\n')

    await expect(createDesktopStageMetadata(root, {
      readCommit: async () => 'fedcba9876543210\n',
      nodeVersion: 'v26.0.0',
      platform: 'linux',
      arch: 'x64',
    })).resolves.toEqual({
      commit: 'fedcba9876543210',
      lockfileSha256: createHash('sha256').update('lockfile fixture\n').digest('hex'),
      nodeVersion: 'v26.0.0',
      platform: 'linux',
      arch: 'x64',
    })
  })
})

describe('desktop stage validation', () => {
  it('accepts a complete self-contained stage', async () => {
    await expect(validate(createValidStage())).resolves.toBeUndefined()
  })

  it.each([
    ['Node executable', `node/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`],
    ['CLI entry', 'app/lib/bin.js'],
    ['standard preset', 'app/config/agent-presets/standard/preset.yml'],
    ['standard agent composition', 'app/config/agent-presets/standard/agent.cordis.yml'],
    ['base composition', 'app/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'],
    ['Web composition', 'app/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'],
    ['Web dist index', 'app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'],
    ['generated Remote entrypoint', 'app/node_modules/@deepseek-ai/dsh-goal/lib/typert.remote-client.js'],
  ])('rejects a missing %s', async (label, relativePath) => {
    const stage = createValidStage()
    rmSync(join(stage, relativePath), { force: true })

    await expect(validate(stage)).rejects.toThrow(`${label} is missing`)
  })

  it.each(['node-pty', 'koffi'])('rejects an unresolved %s runtime dependency', async (dependency) => {
    const stage = createValidStage()
    rmSync(join(stage, 'app/node_modules', dependency), { recursive: true, force: true })

    await expect(validate(stage)).rejects.toThrow(`runtime dependency ${dependency} does not resolve`)
  })

  it('rejects a non-executable Node binary on POSIX', async () => {
    if (process.platform === 'win32') return
    const stage = createValidStage()
    chmodSync(join(stage, 'node/bin/node'), 0o644)

    await expect(validate(stage)).rejects.toThrow('Node executable is not executable')
  })

  it('rejects a Node binary reporting a different version', async () => {
    const stage = createValidStage()

    await expect(validateDesktopStage(stage, metadata, {
      readNodeVersion: async () => 'v22.19.0',
    })).rejects.toThrow('Node version mismatch')
  })

  it.each([
    ['commit', 'different'],
    ['lockfileSha256', 'b'.repeat(64)],
    ['nodeVersion', 'v22.19.0'],
    ['platform', 'linux'],
    ['arch', 'x64'],
  ] as const)('rejects mismatched metadata field %s', async (field, value) => {
    const stage = createValidStage()
    write(join(stage, 'metadata.json'), JSON.stringify({ ...metadata, [field]: value }))

    await expect(validate(stage)).rejects.toThrow(`metadata ${field} mismatch`)
  })

  it('rejects malformed metadata without echoing its contents', async () => {
    const stage = createValidStage()
    write(join(stage, 'metadata.json'), '{ "secret": "do-not-report"')

    await expect(validate(stage)).rejects.toThrow('metadata.json is not valid JSON')
    await expect(validate(stage)).rejects.not.toThrow('do-not-report')
  })

  it('rejects a symlink that escapes the stage', async () => {
    const stage = createValidStage()
    const outside = join(dirname(stage), 'outside.txt')
    write(outside)
    symlinkSync(outside, join(stage, 'app/escape'))

    await expect(validate(stage)).rejects.toThrow('symlink escapes the stage: app/escape')
  })

  it('accepts a symlink whose resolved target stays in the stage', async () => {
    const stage = createValidStage()
    symlinkSync('lib/bin.js', join(stage, 'app/cli-link'))

    await expect(validate(stage)).resolves.toBeUndefined()
  })
})

describe('desktop stage publication', () => {
  it('replaces an existing stage and removes its backup', async () => {
    const parent = fixtureRoot()
    const final = join(parent, '.stage')
    const temporary = join(parent, '.stage.tmp')
    const backup = join(parent, '.stage.backup')
    write(join(final, 'marker'), 'old')
    write(join(temporary, 'marker'), 'new')

    await publishDesktopStage({ stageDirectory: final, temporaryDirectory: temporary, backupDirectory: backup })

    expect(readFileSync(join(final, 'marker'), 'utf8')).toBe('new')
    expect(existsSync(temporary)).toBe(false)
    expect(existsSync(backup)).toBe(false)
  })

  it('restores the previous stage when final publication fails', async () => {
    const parent = fixtureRoot()
    const final = join(parent, '.stage')
    const temporary = join(parent, '.stage.tmp')
    const backup = join(parent, '.stage.backup')
    write(join(final, 'marker'), 'old')
    write(join(temporary, 'marker'), 'new')
    let calls = 0

    await expect(publishDesktopStage(
      { stageDirectory: final, temporaryDirectory: temporary, backupDirectory: backup },
      {
        rename: async (source, destination) => {
          calls += 1
          if (calls === 2) throw new Error('injected publication failure')
          const { rename } = await import('node:fs/promises')
          await rename(source, destination)
        },
      },
    )).rejects.toThrow('injected publication failure')

    expect(readFileSync(join(final, 'marker'), 'utf8')).toBe('old')
    expect(readFileSync(join(temporary, 'marker'), 'utf8')).toBe('new')
    expect(existsSync(backup)).toBe(false)
  })
})

describe('desktop stage execution', () => {
  it('builds, deploys, copies the exact Node executable, validates, and publishes', async () => {
    const root = fixtureRoot()
    const sourceNode = join(root, 'runtime/node')
    write(sourceNode, 'exact-node-runtime')
    if (process.platform !== 'win32') chmodSync(sourceNode, 0o751)
    const plan = createDesktopStagePlan({
      root,
      sourceNodeExecutable: sourceNode,
      metadata,
      temporaryId: 'execute',
      pnpm: { command: sourceNode, args: ['/pnpm.cjs'] },
    })
    const commands: unknown[] = []

    await executeDesktopStage(plan, {
      run: async (command) => {
        commands.push(command)
        if (command === plan.commands.deploy) populateValidStage(plan.temporaryDirectory)
      },
      readNodeVersion: async (nodeExecutable) => {
        expect(nodeExecutable).toBe(join(plan.temporaryDirectory, 'node/bin', process.platform === 'win32' ? 'node.exe' : 'node'))
        return metadata.nodeVersion
      },
    })

    expect(commands).toEqual([plan.commands.build, plan.commands.deploy])
    const stagedNode = join(plan.stageDirectory, 'node/bin', process.platform === 'win32' ? 'node.exe' : 'node')
    expect(readFileSync(stagedNode, 'utf8')).toBe('exact-node-runtime')
    if (process.platform !== 'win32') {
      expect(statSync(stagedNode).mode & 0o777).toBe(statSync(sourceNode).mode & 0o777)
    }
    expect(JSON.parse(readFileSync(join(plan.stageDirectory, 'metadata.json'), 'utf8'))).toEqual(metadata)
    expect(existsSync(plan.temporaryDirectory)).toBe(false)
    expect(existsSync(plan.backupDirectory)).toBe(false)
  })

  it('keeps the previous stage when candidate validation fails', async () => {
    const root = fixtureRoot()
    const sourceNode = join(root, 'runtime/node')
    write(sourceNode, 'node')
    if (process.platform !== 'win32') chmodSync(sourceNode, 0o755)
    const plan = createDesktopStagePlan({
      root,
      sourceNodeExecutable: sourceNode,
      metadata,
      temporaryId: 'invalid',
      pnpm: { command: sourceNode, args: ['/pnpm.cjs'] },
    })
    write(join(plan.stageDirectory, 'marker'), 'old')

    await expect(executeDesktopStage(plan, {
      run: async (command) => {
        if (command === plan.commands.deploy) {
          write(join(plan.temporaryDirectory, 'app/package.json'), JSON.stringify({
            name: '@deepseek-ai/dsh',
          }))
        }
      },
      readNodeVersion: async () => metadata.nodeVersion,
    })).rejects.toThrow('CLI entry is missing')

    expect(readFileSync(join(plan.stageDirectory, 'marker'), 'utf8')).toBe('old')
    expect(existsSync(plan.temporaryDirectory)).toBe(false)
    expect(existsSync(plan.backupDirectory)).toBe(false)
  })

  it('restores deploy-hoisted dependencies and materializes checkout links', async () => {
    const root = fixtureRoot()
    const sourceNode = join(root, 'runtime/node')
    write(sourceNode, 'node')
    if (process.platform !== 'win32') chmodSync(sourceNode, 0o755)
    const sourceDependency = join(root, 'apps/cli/node_modules/direct-dependency')
    write(join(sourceDependency, 'package.json'), JSON.stringify({ name: 'direct-dependency' }))
    write(join(sourceDependency, 'index.js'), 'export const deployed = true\n')
    const linkedPackage = join(root, 'packages/linked')
    write(join(linkedPackage, 'package.json'), JSON.stringify({ name: 'linked-package' }))
    write(join(linkedPackage, 'index.js'), 'export const linked = true\n')
    const plan = createDesktopStagePlan({
      root,
      sourceNodeExecutable: sourceNode,
      metadata,
      temporaryId: 'materialize',
      pnpm: { command: sourceNode, args: ['/pnpm.cjs'] },
    })

    await executeDesktopStage(plan, {
      run: async (command) => {
        if (command !== plan.commands.deploy) return
        populateValidStage(plan.temporaryDirectory)
        write(join(plan.temporaryDirectory, 'app/package.json'), JSON.stringify({
          name: '@deepseek-ai/dsh',
          dependencies: { 'direct-dependency': '1.0.0' },
        }))
        symlinkSync(linkedPackage, join(plan.temporaryDirectory, 'app/node_modules/linked-package'))
      },
      readNodeVersion: async () => metadata.nodeVersion,
    })

    expect(readFileSync(join(plan.stageDirectory, 'app/node_modules/direct-dependency/index.js'), 'utf8'))
      .toBe('export const deployed = true\n')
    expect(readFileSync(join(plan.stageDirectory, 'app/node_modules/linked-package/index.js'), 'utf8'))
      .toBe('export const linked = true\n')
    expect(() => readlinkSync(join(plan.stageDirectory, 'app/node_modules/linked-package'))).toThrow()
  })
})
