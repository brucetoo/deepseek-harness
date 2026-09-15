import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  removeDesktopStagePath,
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
      versionDirectory: '/checkout/apps/desktop/.stage/versions/fixture',
      currentFile: '/checkout/apps/desktop/.stage/current',
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
})

describe('desktop stage publication', () => {
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
