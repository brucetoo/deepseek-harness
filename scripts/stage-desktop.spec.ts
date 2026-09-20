import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopStagePlan,
  createDesktopStageMetadata,
  executeDesktopStage,
  publishDesktopStage,
  removeDesktopStagePath,
  resolveDesktopLocalPlugins,
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
  'app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'app/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/preset.yml',
  'app/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml',
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
  'app/skills/office-docx/SKILL.md',
  'app/skills/office-docx/scripts/create-document.mjs',
  'app/skills/office-xlsx/SKILL.md',
  'app/skills/office-xlsx/scripts/create-workbook.mjs',
  'app/skills/browser-research/SKILL.md',
  'app/skills/browser-task/SKILL.md',
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
    name: '@deepseek-ai/dsh-desktop-runtime',
    type: 'module',
  }))
  createPackage(stage, 'node-pty')
  createPackage(stage, 'koffi')
  createPackage(stage, 'docx')
  createPackage(stage, 'exceljs')
  write(join(stage, 'local-plugins.json'), '[]\n')
  const node = join(stage, 'node/bin', process.platform === 'win32' ? 'node.exe' : 'node')
  write(node)
  if (process.platform !== 'win32') chmodSync(node, 0o755)
  write(join(stage, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
}

const validate = (stage: string, expected = metadata): Promise<void> =>
  validateDesktopStage(stage, expected, {
    readNodeVersion: vi.fn(async () => metadata.nodeVersion),
    loadNativeDependencies: vi.fn(async () => {}),
    runCliSmoke: vi.fn(async () => {}),
  })

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop stage planning', () => {
  it('plans shell-free build and filtered production deploy commands', () => {
    const root = resolve('/checkout')
    const plan = createDesktopStagePlan({
      root,
      sourceNodeExecutable: '/runtime/bin/node',
      metadata,
      temporaryId: 'fixture',
      pnpm: { command: '/runtime/bin/node', args: ['/pnpm.cjs'] },
    })

    expect(plan).toMatchObject({
      root,
      stageDirectory: resolve(root, 'apps/desktop/.stage'),
      temporaryDirectory: resolve(root, 'apps/desktop/.stage.tmp-fixture'),
      versionDirectory: resolve(root, 'apps/desktop/.stage/versions/fixture'),
      currentFile: resolve(root, 'apps/desktop/.stage/current'),
      versionName: 'fixture',
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
            '@deepseek-ai/dsh-desktop-runtime',
            'deploy',
            '--prod',
            '--ignore-scripts',
            '--config.node-linker=hoisted',
            '--config.inject-workspace-packages=true',
            resolve(root, 'apps/desktop/.stage.tmp-fixture/app'),
          ],
          cwd: root,
        },
      },
    })
  })

  it('plans local bundle packing and staged installation without changing the deploy root', () => {
    const root = resolve('/checkout')
    const plugin = {
      sourceDirectory: resolve('/plugins/example'),
      packageName: '@example/desktop-plugin',
      version: '1.2.3',
      bundlePatch: 'cordis.patch.yml',
      archiveName: 'example-desktop-plugin-1.2.3.tgz',
    }
    const plan = createDesktopStagePlan({
      root,
      sourceNodeExecutable: '/runtime/bin/node',
      metadata,
      temporaryId: 'fixture',
      pnpm: { command: '/runtime/bin/node', args: ['/pnpm.cjs'] },
      localPlugins: [plugin],
    })

    expect(plan.commands.packLocalPlugins).toEqual([{
      command: '/runtime/bin/node',
      args: [
        '/pnpm.cjs',
        'pack',
        '--pack-destination',
        resolve(root, 'apps/desktop/.stage.tmp-fixture/local-plugin-archives'),
      ],
      cwd: plugin.sourceDirectory,
    }])
    expect(plan.commands.installLocalPlugins).toEqual([{
      command: '/runtime/bin/node',
      args: [
        '/pnpm.cjs',
        'install',
        '--prod',
        '--ignore-scripts',
        '--config.node-linker=hoisted',
        '--config.auto-install-peers=false',
      ],
      cwd: resolve(
        root,
        'apps/desktop/.stage.tmp-fixture/app/local-plugins/%40example%2Fdesktop-plugin',
      ),
    }])
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

describe('desktop local plugin input', () => {
  const localPlugin = (
    root: string,
    name = '@example/desktop-plugin',
    version = '1.2.3',
    patch = 'cordis.patch.yml',
  ): string => {
    const directory = join(root, name.replaceAll('/', '-'))
    write(join(directory, 'package.json'), JSON.stringify({
      name,
      version,
      dsh: { bundle: { patch } },
    }))
    write(join(directory, patch), '[]\n')
    return directory
  }

  it('resolves relative package directories and bundle declarations', async () => {
    const root = fixtureRoot()
    const directory = localPlugin(root)

    await expect(resolveDesktopLocalPlugins(
      JSON.stringify([relative(root, directory)]),
      root,
    )).resolves.toEqual([{
      sourceDirectory: directory,
      packageName: '@example/desktop-plugin',
      version: '1.2.3',
      bundlePatch: 'cordis.patch.yml',
      archiveName: 'example-desktop-plugin-1.2.3.tgz',
    }])
  })

  it.each([
    ['not JSON', 'not-json'],
    ['not an array', JSON.stringify({ plugin: '/tmp/example' })],
    ['an empty entry', JSON.stringify([''])],
  ])('rejects %s', async (_label, value) => {
    await expect(resolveDesktopLocalPlugins(value, fixtureRoot()))
      .rejects.toThrow('DSH_DESKTOP_LOCAL_PLUGINS must be a JSON array')
  })

  it('rejects a package without a bundle declaration', async () => {
    const root = fixtureRoot()
    const directory = join(root, 'plain')
    write(join(directory, 'package.json'), JSON.stringify({
      name: 'plain-plugin',
      version: '1.0.0',
    }))

    await expect(resolveDesktopLocalPlugins(JSON.stringify([directory]), root))
      .rejects.toThrow('plain-plugin declares no relative dsh.bundle.patch')
  })

  it('rejects a package version that could escape the archive directory', async () => {
    const root = fixtureRoot()
    const directory = localPlugin(root, 'unsafe-version', '../../outside')

    await expect(resolveDesktopLocalPlugins(JSON.stringify([directory]), root))
      .rejects.toThrow('unsafe-version has an invalid package version')
  })

  it('rejects duplicate package names', async () => {
    const root = fixtureRoot()
    const first = localPlugin(join(root, 'first'), 'duplicate-plugin')
    const second = localPlugin(join(root, 'second'), 'duplicate-plugin')

    await expect(resolveDesktopLocalPlugins(JSON.stringify([first, second]), root))
      .rejects.toThrow('desktop local plugin package name is duplicated: duplicate-plugin')
  })

  it('rejects distinct package names that produce the same archive name', async () => {
    const root = fixtureRoot()
    const first = localPlugin(join(root, 'first'), '@example/plugin')
    const second = localPlugin(join(root, 'second'), 'example-plugin')

    await expect(resolveDesktopLocalPlugins(JSON.stringify([first, second]), root))
      .rejects.toThrow('desktop local plugin archive name is duplicated: example-plugin-1.2.3.tgz')
  })
})

describe('desktop stage validation', () => {
  it('accepts a complete self-contained stage', async () => {
    await expect(validate(createValidStage())).resolves.toBeUndefined()
  })

  it.each([
    ['Node executable', `node/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`],
    ['CLI entry', 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'],
    ['standard preset', 'app/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/preset.yml'],
    ['standard agent composition', 'app/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml'],
    ['base composition', 'app/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'],
    ['Web composition', 'app/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'],
    ['Web dist index', 'app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'],
    ['generated Remote entrypoint', 'app/node_modules/@deepseek-ai/dsh-goal/lib/typert.remote-client.js'],
    ['DOCX skill', 'app/skills/office-docx/SKILL.md'],
    ['XLSX generator', 'app/skills/office-xlsx/scripts/create-workbook.mjs'],
    ['browser research skill', 'app/skills/browser-research/SKILL.md'],
    ['browser task skill', 'app/skills/browser-task/SKILL.md'],
  ])('rejects a missing %s', async (label, relativePath) => {
    const stage = createValidStage()
    rmSync(join(stage, relativePath), { force: true })

    await expect(validate(stage)).rejects.toThrow(`${label} is missing`)
  })

  it.each(['node-pty', 'koffi', 'docx', 'exceljs'])('rejects an unresolved %s runtime dependency', async (dependency) => {
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
      loadNativeDependencies: async () => {},
      runCliSmoke: async () => {},
    })).rejects.toThrow('Node version mismatch')
  })

  it('rejects a native dependency that cannot load in the staged Node runtime', async () => {
    const stage = createValidStage()

    await expect(validateDesktopStage(stage, metadata, {
      readNodeVersion: async () => metadata.nodeVersion,
      loadNativeDependencies: async () => {
        throw new Error('dlopen failed')
      },
      runCliSmoke: async () => {},
    })).rejects.toThrow('staged native dependencies failed to load: dlopen failed')
  })

  it('rejects a staged CLI that cannot start without the checkout', async () => {
    const stage = createValidStage()

    await expect(validateDesktopStage(stage, metadata, {
      readNodeVersion: async () => metadata.nodeVersion,
      loadNativeDependencies: async () => {},
      runCliSmoke: async () => {
        throw new Error('missing peer')
      },
    })).rejects.toThrow('staged CLI smoke failed: missing peer')
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
    symlinkSync('node_modules/@deepseek-ai/dsh/lib/bin.js', join(stage, 'app/cli-link'))

    await expect(validate(stage)).resolves.toBeUndefined()
  })

  it('rejects a local plugin archive whose recorded digest does not match', async () => {
    const stage = createValidStage()
    const packageRoot = join(stage, 'app/local-plugins/example-plugin/node_modules/example-plugin')
    write(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'example-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    write(join(packageRoot, 'cordis.patch.yml'), '[]\n')
    write(join(stage, 'local-plugin-archives/example-plugin-1.0.0.tgz'), 'archive')
    write(join(stage, 'local-plugins.json'), JSON.stringify([{
      packageName: 'example-plugin',
      version: '1.0.0',
      bundlePatch: 'cordis.patch.yml',
      packageRoot: 'app/local-plugins/example-plugin/node_modules/example-plugin',
      archive: 'local-plugin-archives/example-plugin-1.0.0.tgz',
      sha256: '0'.repeat(64),
    }]))

    await expect(validate(stage)).rejects.toThrow(
      'desktop local plugin example-plugin archive digest mismatch',
    )
  })
})

describe('desktop stage publication', () => {
  it('retries a transient Windows stage rename without weakening atomic publication', async () => {
    const parent = fixtureRoot()
    const stage = join(parent, '.stage')
    const temporary = join(parent, '.stage.tmp')
    const version = join(stage, 'versions/new')
    const current = join(stage, 'current')
    const delays: number[] = []
    let renameAttempts = 0
    write(current, 'old\n')
    write(join(temporary, 'marker'), 'new')

    await publishDesktopStage(
      {
        stageDirectory: stage,
        temporaryDirectory: temporary,
        versionDirectory: version,
        currentFile: current,
        versionName: 'new',
      },
      {
        platform: 'win32',
        renameVersion: async (source, destination) => {
          renameAttempts += 1
          if (renameAttempts === 1) {
            throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' })
          }
          renameSync(source, destination)
        },
        wait: async (delayMs) => {
          delays.push(delayMs)
        },
      },
    )

    expect(renameAttempts).toBe(2)
    expect(delays).toEqual([200])
    expect(readFileSync(join(version, 'marker'), 'utf8')).toBe('new')
    expect(readFileSync(current, 'utf8')).toBe('new\n')
  })

  it('stops retrying a locked Windows stage after the bounded budget', async () => {
    const parent = fixtureRoot()
    const stage = join(parent, '.stage')
    const temporary = join(parent, '.stage.tmp')
    const version = join(stage, 'versions/new')
    const current = join(stage, 'current')
    let renameAttempts = 0
    write(current, 'old\n')
    write(join(temporary, 'marker'), 'new')

    await expect(publishDesktopStage(
      {
        stageDirectory: stage,
        temporaryDirectory: temporary,
        versionDirectory: version,
        currentFile: current,
        versionName: 'new',
      },
      {
        platform: 'win32',
        renameVersion: async () => {
          renameAttempts += 1
          throw Object.assign(new Error('still locked'), { code: 'EPERM' })
        },
        wait: async () => {},
      },
    )).rejects.toThrow('still locked')

    expect(renameAttempts).toBe(51)
    expect(readFileSync(current, 'utf8')).toBe('old\n')
    expect(existsSync(temporary)).toBe(true)
  })

  it('publishes a version before atomically replacing the current pointer', async () => {
    const parent = fixtureRoot()
    const stage = join(parent, '.stage')
    const temporary = join(parent, '.stage.tmp')
    const version = join(stage, 'versions/new')
    const current = join(stage, 'current')
    write(current, 'old\n')
    write(join(temporary, 'marker'), 'new')

    await publishDesktopStage({
      stageDirectory: stage,
      temporaryDirectory: temporary,
      versionDirectory: version,
      currentFile: current,
      versionName: 'new',
    })

    expect(readFileSync(join(version, 'marker'), 'utf8')).toBe('new')
    expect(readFileSync(current, 'utf8')).toBe('new\n')
    expect(existsSync(temporary)).toBe(false)
  })

  it('keeps the previous pointer when atomic pointer publication fails', async () => {
    const parent = fixtureRoot()
    const stage = join(parent, '.stage')
    const temporary = join(parent, '.stage.tmp')
    const version = join(stage, 'versions/new')
    const current = join(stage, 'current')
    write(current, 'old\n')
    write(join(temporary, 'marker'), 'new')

    await expect(publishDesktopStage(
      {
        stageDirectory: stage,
        temporaryDirectory: temporary,
        versionDirectory: version,
        currentFile: current,
        versionName: 'new',
      },
      {
        writeCurrent: async () => {
          throw new Error('injected publication failure')
        },
      },
    )).rejects.toThrow('injected publication failure')

    expect(readFileSync(current, 'utf8')).toBe('old\n')
    expect(existsSync(version)).toBe(false)
    expect(existsSync(temporary)).toBe(false)
  })
})

describe('desktop stage cleanup', () => {
  it('unlinks a directory symlink without traversing its target', async () => {
    const parent = fixtureRoot()
    const outside = join(parent, 'outside')
    const link = join(parent, 'candidate')
    write(join(outside, 'keep'), 'outside')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

    await removeDesktopStagePath(link)

    expect(existsSync(link)).toBe(false)
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside')
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
      loadNativeDependencies: async () => {},
      runCliSmoke: async () => {},
    })

    expect(commands).toEqual([plan.commands.build, plan.commands.deploy])
    const stagedNode = join(plan.versionDirectory, 'node/bin', process.platform === 'win32' ? 'node.exe' : 'node')
    expect(readFileSync(stagedNode, 'utf8')).toBe('exact-node-runtime')
    if (process.platform !== 'win32') {
      expect(statSync(stagedNode).mode & 0o777).toBe(statSync(sourceNode).mode & 0o777)
    }
    expect(JSON.parse(readFileSync(join(plan.versionDirectory, 'metadata.json'), 'utf8'))).toEqual(metadata)
    expect(existsSync(plan.temporaryDirectory)).toBe(false)
    expect(readFileSync(plan.currentFile, 'utf8')).toBe(`${plan.versionName}\n`)
  })

  it('packs, installs, records, and validates local bundle packages', async () => {
    const root = fixtureRoot()
    const sourceNode = join(root, 'runtime/node')
    const sourcePlugin = join(root, 'plugins/example')
    write(sourceNode, 'exact-node-runtime')
    write(join(sourcePlugin, 'package.json'), JSON.stringify({
      name: 'example-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    write(join(sourcePlugin, 'cordis.patch.yml'), '[]\n')
    if (process.platform !== 'win32') chmodSync(sourceNode, 0o751)
    const [plugin] = await resolveDesktopLocalPlugins(JSON.stringify([sourcePlugin]), root)
    if (plugin === undefined) throw new Error('local plugin fixture was not resolved')
    const plan = createDesktopStagePlan({
      root,
      sourceNodeExecutable: sourceNode,
      metadata,
      temporaryId: 'local-plugin',
      pnpm: { command: sourceNode, args: ['/pnpm.cjs'] },
      localPlugins: [plugin],
    })
    const commands: unknown[] = []

    await executeDesktopStage(plan, {
      run: async (command) => {
        commands.push(command)
        if (command === plan.commands.packLocalPlugins[0]) {
          write(join(plan.temporaryDirectory, 'local-plugin-archives', plugin.archiveName), 'packed-plugin')
        }
        if (command === plan.commands.deploy) {
          populateValidStage(plan.temporaryDirectory)
          write(join(plan.temporaryDirectory, 'app/package.json'), JSON.stringify({
            name: '@deepseek-ai/dsh-desktop-runtime',
            dependencies: { 'shared-runtime': '1.0.0' },
          }))
          createPackage(plan.temporaryDirectory, 'shared-runtime')
        }
        if (command === plan.commands.installLocalPlugins[0]) {
          const installManifest = JSON.parse(
            readFileSync(join(command.cwd, 'package.json'), 'utf8'),
          ) as {
            dependencies: Record<string, string>
          }
          expect(installManifest.dependencies['example-plugin']).toBe(
            'file:../../../local-plugin-archives/example-plugin-1.0.0.tgz',
          )
          expect(installManifest.dependencies['shared-runtime']).toBe(
            'link:../../node_modules/shared-runtime',
          )
          expect(readFileSync(join(command.cwd, 'pnpm-workspace.yaml'), 'utf8'))
            .toContain('"shared-runtime":"link:../../node_modules/shared-runtime"')
          const installed = join(command.cwd, 'node_modules/example-plugin')
          write(join(installed, 'package.json'), JSON.stringify({
            name: 'example-plugin',
            version: '1.0.0',
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
          }))
          write(join(installed, 'cordis.patch.yml'), '[]\n')
        }
      },
      readNodeVersion: async () => metadata.nodeVersion,
      loadNativeDependencies: async () => {},
      runCliSmoke: async () => {},
    })

    expect(commands).toEqual([
      plan.commands.build,
      plan.commands.packLocalPlugins[0],
      plan.commands.deploy,
      plan.commands.installLocalPlugins[0],
    ])
    const recorded = JSON.parse(
      readFileSync(join(plan.versionDirectory, 'local-plugins.json'), 'utf8'),
    ) as unknown[]
    expect(recorded).toEqual([expect.objectContaining({
      packageName: 'example-plugin',
      version: '1.0.0',
      bundlePatch: 'cordis.patch.yml',
      packageRoot: 'app/local-plugins/example-plugin/node_modules/example-plugin',
      archive: 'local-plugin-archives/example-plugin-1.0.0.tgz',
      sha256: createHash('sha256').update('packed-plugin').digest('hex'),
    })])
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
      loadNativeDependencies: async () => {},
      runCliSmoke: async () => {},
    })).rejects.toThrow('CLI entry is missing')

    expect(readFileSync(join(plan.stageDirectory, 'marker'), 'utf8')).toBe('old')
    expect(existsSync(plan.temporaryDirectory)).toBe(false)
  })

})
