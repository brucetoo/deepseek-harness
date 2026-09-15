/** Build and validate the self-contained Host runtime used by the desktop app. */

import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Provenance recorded beside one desktop Host runtime. */
export interface DesktopStageMetadata {
  readonly commit: string
  readonly lockfileSha256: string
  readonly nodeVersion: string
  readonly platform: NodeJS.Platform
  readonly arch: string
}

/** Resolved repository and runtime facts used to create stage provenance. */
export interface DesktopStageMetadataDependencies {
  readonly readCommit: () => Promise<string>
  readonly nodeVersion: string
  readonly platform: NodeJS.Platform
  readonly arch: string
}

/**
 * Record the exact source revision, dependency lock, and runtime identity.
 * @param root - Repository root containing `pnpm-lock.yaml`.
 * @param dependencies - Commit reader and target runtime identity.
 * @returns Provenance persisted with the staged runtime.
 */
export const createDesktopStageMetadata = async (
  root: string,
  dependencies: DesktopStageMetadataDependencies,
): Promise<DesktopStageMetadata> => ({
  commit: (await dependencies.readCommit()).trim(),
  lockfileSha256: createHash('sha256')
    .update(await readFile(join(root, 'pnpm-lock.yaml')))
    .digest('hex'),
  nodeVersion: dependencies.nodeVersion,
  platform: dependencies.platform,
  arch: dependencies.arch,
})

/** One direct process invocation in the desktop staging workflow. */
export interface DesktopStageCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

/** Deterministic paths and commands for one desktop staging attempt. */
export interface DesktopStagePlan {
  readonly root: string
  readonly stageDirectory: string
  readonly temporaryDirectory: string
  readonly backupDirectory: string
  readonly sourceNodeExecutable: string
  readonly metadata: DesktopStageMetadata
  readonly commands: {
    readonly build: DesktopStageCommand
    readonly deploy: DesktopStageCommand
  }
}

/** Inputs whose environment-dependent values are resolved before planning. */
export interface DesktopStagePlanOptions {
  readonly root: string
  readonly sourceNodeExecutable: string
  readonly metadata: DesktopStageMetadata
  readonly temporaryId: string
  readonly pnpm: {
    readonly command: string
    readonly args: readonly string[]
  }
}

/**
 * Produce the shell-free process plan for one staging attempt.
 * @param options - Resolved repository, runtime, metadata, and pnpm inputs.
 * @returns Immutable staging paths and process invocations.
 */
export const createDesktopStagePlan = (
  options: DesktopStagePlanOptions,
): DesktopStagePlan => {
  const root = resolve(options.root)
  const stageDirectory = join(root, 'apps/desktop/.stage')
  const temporaryDirectory = join(root, `apps/desktop/.stage.tmp-${options.temporaryId}`)
  return {
    root,
    stageDirectory,
    temporaryDirectory,
    backupDirectory: join(root, `apps/desktop/.stage.backup-${options.temporaryId}`),
    sourceNodeExecutable: options.sourceNodeExecutable,
    metadata: options.metadata,
    commands: {
      build: {
        command: options.pnpm.command,
        args: [...options.pnpm.args, 'run', 'build'],
        cwd: root,
      },
      deploy: {
        command: options.pnpm.command,
        args: [
          ...options.pnpm.args,
          '--filter',
          '@deepseek-ai/dsh',
          'deploy',
          '--legacy',
          '--prod',
          '--config.node-linker=hoisted',
          '--config.auto-install-peers=false',
          '--config.link-workspace-packages=true',
          join(temporaryDirectory, 'app'),
        ],
        cwd: root,
      },
    },
  }
}

const requiredFiles = new Map<string, string>([
  ['node/bin/node', 'Node executable'],
  ['app/lib/bin.js', 'CLI entry'],
  ['app/config/agent-presets/standard/preset.yml', 'standard preset'],
  ['app/config/agent-presets/standard/agent.cordis.yml', 'standard agent composition'],
  ['app/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml', 'base composition'],
  ['app/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml', 'Web composition'],
  ['app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', 'Web dist index'],
  ['app/node_modules/@deepseek-ai/dsh-commands/lib/typert.remote-client.js', 'generated Remote entrypoint'],
  ['app/node_modules/@deepseek-ai/dsh-goal/lib/typert.remote-client.js', 'generated Remote entrypoint'],
  ['app/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/typert.remote-client.js', 'generated Remote entrypoint'],
  ['app/node_modules/@deepseek-ai/dsh-file-reference/lib/typert.remote-client.js', 'generated Remote entrypoint'],
  ['app/node_modules/@deepseek-ai/dsh-host-plugin-inventory/lib/typert.remote-client.js', 'generated Remote entrypoint'],
  ['app/node_modules/@deepseek-ai/dsh-message-feedback/lib/typert.remote-client.js', 'generated Remote entrypoint'],
  ['app/node_modules/@deepseek-ai/dsh-session-reference/lib/typert.remote-client.js', 'generated Remote entrypoint'],
])

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const assertFile = async (path: string, label: string): Promise<void> => {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`${label} is missing`)
  } catch (error) {
    if (isMissing(error)) throw new Error(`${label} is missing`)
    throw error
  }
}

const assertMetadata = (
  actual: unknown,
  expected: DesktopStageMetadata,
): void => {
  if (typeof actual !== 'object' || actual === null) {
    throw new Error('metadata.json must contain an object')
  }
  const record = actual as Record<string, unknown>
  for (const field of ['commit', 'lockfileSha256', 'nodeVersion', 'platform', 'arch'] as const) {
    if (!(field in record) || record[field] !== expected[field]) {
      throw new Error(`metadata ${field} mismatch`)
    }
  }
}

const assertContainedSymlinks = async (stage: string): Promise<void> => {
  const canonicalStage = await realpath(stage)
  const pending = [stage]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        const stageRelative = relative(canonicalStage, target)
        if (
          stageRelative === '..'
          || stageRelative.startsWith(`..${sep}`)
          || isAbsolute(stageRelative)
        ) {
          throw new Error(`symlink escapes the stage: ${relative(stage, path).split(sep).join('/')}`)
        }
      } else if (entry.isDirectory()) {
        pending.push(path)
      }
    }
  }
}

/** Replaceable process probe used by stage validation. */
export interface DesktopStageValidationDependencies {
  readonly readNodeVersion?: (nodeExecutable: string) => Promise<string>
}

/**
 * Validate a staged runtime without consulting the source checkout.
 * @param stage - Candidate stage root.
 * @param expectedMetadata - Provenance expected by the caller.
 * @param dependencies - Optional Node version probe.
 */
export const validateDesktopStage = async (
  stage: string,
  expectedMetadata: DesktopStageMetadata,
  dependencies: DesktopStageValidationDependencies = {},
): Promise<void> => {
  const nodeRelative = process.platform === 'win32' ? 'node/bin/node.exe' : 'node/bin/node'
  const platformRequiredFiles = new Map(requiredFiles)
  if (process.platform === 'win32') {
    platformRequiredFiles.delete('node/bin/node')
    platformRequiredFiles.set(nodeRelative, 'Node executable')
  }
  for (const [relativePath, label] of platformRequiredFiles) {
    await assertFile(join(stage, relativePath), label)
  }
  if (process.platform !== 'win32') {
    try {
      await access(join(stage, nodeRelative), constants.X_OK)
    } catch {
      throw new Error('Node executable is not executable')
    }
  }
  for (const dependency of ['node-pty', 'koffi']) {
    await assertFile(
      join(stage, 'app/node_modules', dependency, 'package.json'),
      `runtime dependency ${dependency} does not resolve`,
    )
  }

  let parsedMetadata: unknown
  try {
    parsedMetadata = JSON.parse(await readFile(join(stage, 'metadata.json'), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('metadata.json is not valid JSON')
    throw error
  }
  assertMetadata(parsedMetadata, expectedMetadata)
  await assertContainedSymlinks(stage)

  const readNodeVersion = dependencies.readNodeVersion
  if (readNodeVersion !== undefined) {
    const actualVersion = await readNodeVersion(join(stage, nodeRelative))
    if (actualVersion !== expectedMetadata.nodeVersion) {
      throw new Error(`Node version mismatch: expected ${expectedMetadata.nodeVersion}, received ${actualVersion}`)
    }
  }
}

/** Paths participating in atomic stage publication. */
export interface DesktopStagePublication {
  readonly stageDirectory: string
  readonly temporaryDirectory: string
  readonly backupDirectory: string
}

/** Replaceable filesystem operation used to test publication rollback. */
export interface DesktopStagePublicationDependencies {
  readonly rename?: (source: string, destination: string) => Promise<void>
}

/**
 * Publish a validated temporary stage while preserving the previous stage on failure.
 * @param paths - Final, temporary, and backup stage paths.
 * @param dependencies - Optional rename operation.
 */
export const publishDesktopStage = async (
  paths: DesktopStagePublication,
  dependencies: DesktopStagePublicationDependencies = {},
): Promise<void> => {
  const move = dependencies.rename ?? rename
  let backedUp = false
  try {
    await move(paths.stageDirectory, paths.backupDirectory)
    backedUp = true
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  try {
    await move(paths.temporaryDirectory, paths.stageDirectory)
  } catch (error) {
    if (backedUp) await move(paths.backupDirectory, paths.stageDirectory)
    throw error
  }
  if (backedUp) await rm(paths.backupDirectory, { recursive: true, force: true })
}

/** Replaceable effects used by the staging executor. */
export interface DesktopStageExecutionDependencies {
  readonly run: (command: DesktopStageCommand) => Promise<void>
  readonly readNodeVersion: (nodeExecutable: string) => Promise<string>
}

const findSymlink = async (directory: string): Promise<string | undefined> => {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) return path
    if (entry.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

const copyPackageWithoutNestedDependencies = async (
  source: string,
  destination: string,
): Promise<void> => {
  const nestedNodeModules = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
  })
}

const prepareDeployedClosure = async (plan: DesktopStagePlan): Promise<void> => {
  const app = join(plan.temporaryDirectory, 'app')
  const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(app, 'node_modules', dependency)
    try {
      await lstat(destination)
      continue
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const source = join(plan.root, 'apps/cli/node_modules', dependency)
    try {
      await lstat(source)
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(`deployed dependency ${dependency} is missing`)
      }
      throw error
    }
    await mkdir(resolve(destination, '..'), { recursive: true })
    await copyPackageWithoutNestedDependencies(source, destination)
  }

  const nodeModules = join(app, 'node_modules')
  let symlink = await findSymlink(nodeModules)
  while (symlink !== undefined) {
    const segments = relative(nodeModules, symlink).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), {
        recursive: true,
        force: true,
      })
    } else {
      const source = await realpath(symlink)
      await rm(symlink, { recursive: true, force: true })
      await copyPackageWithoutNestedDependencies(source, symlink)
    }
    symlink = await findSymlink(nodeModules)
  }
}

/**
 * Materialize, validate, and publish one desktop Host runtime.
 * @param plan - Fully resolved staging plan.
 * @param dependencies - Direct process runner and Node version probe.
 */
export const executeDesktopStage = async (
  plan: DesktopStagePlan,
  dependencies: DesktopStageExecutionDependencies,
): Promise<void> => {
  await rm(plan.temporaryDirectory, { recursive: true, force: true })
  await rm(plan.backupDirectory, { recursive: true, force: true })
  try {
    await dependencies.run(plan.commands.build)
    await dependencies.run(plan.commands.deploy)
    await prepareDeployedClosure(plan)

    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
    const stagedNode = join(plan.temporaryDirectory, 'node/bin', nodeName)
    await mkdir(join(plan.temporaryDirectory, 'node/bin'), { recursive: true })
    await copyFile(plan.sourceNodeExecutable, stagedNode)
    if (process.platform !== 'win32') {
      await chmod(stagedNode, (await stat(plan.sourceNodeExecutable)).mode)
    }
    await writeFile(
      join(plan.temporaryDirectory, 'metadata.json'),
      `${JSON.stringify(plan.metadata, null, 2)}\n`,
    )
    await validateDesktopStage(plan.temporaryDirectory, plan.metadata, {
      readNodeVersion: dependencies.readNodeVersion,
    })
  } catch (error) {
    await rm(plan.temporaryDirectory, { recursive: true, force: true })
    throw error
  }

  await publishDesktopStage(plan)
}

const runCommand = async (command: DesktopStageCommand): Promise<void> => {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      command.command,
      [...command.args],
      { cwd: command.cwd, shell: false, stdio: 'inherit' },
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(
        `desktop stage command failed (${signal === null ? `exit ${code}` : `signal ${signal}`}): ${command.command} ${command.args.join(' ')}`,
      ))
    })
  })
}

const readNodeVersion = async (nodeExecutable: string): Promise<string> => {
  const { stdout } = await execFileAsync(nodeExecutable, ['--version'])
  return stdout.trim()
}

const main = async (): Promise<void> => {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined) {
    throw new Error('desktop staging must run through pnpm so npm_execpath identifies the pinned package manager')
  }
  const metadata = await createDesktopStageMetadata(root, {
    readCommit: async () => (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  })
  const plan = createDesktopStagePlan({
    root,
    sourceNodeExecutable: process.execPath,
    metadata,
    temporaryId: `${process.pid}`,
    pnpm: {
      command: process.execPath,
      args: [pnpmEntry],
    },
  })
  await executeDesktopStage(plan, {
    run: runCommand,
    readNodeVersion,
  })
  console.log(`desktop stage: ${plan.stageDirectory}`)
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
