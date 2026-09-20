/** Build and validate the self-contained Host runtime used by the desktop app. */

import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const execFileAsync = promisify(execFile)
const LOCAL_PLUGINS_ENV = 'DSH_DESKTOP_LOCAL_PLUGINS'
const LOCAL_PLUGINS_MANIFEST = 'local-plugins.json'

interface LocalPluginPackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dsh?: {
    readonly bundle?: {
      readonly patch?: unknown
    }
  }
}

/** Validated local bundle package selected for one desktop stage. */
export interface DesktopLocalPlugin {
  readonly sourceDirectory: string
  readonly packageName: string
  readonly version: string
  readonly bundlePatch: string
  readonly archiveName: string
}

/** One local bundle captured in a staged runtime. */
interface StagedLocalPlugin {
  readonly packageName: string
  readonly version: string
  readonly bundlePatch: string
  readonly packageRoot: string
  readonly archive: string
  readonly sha256: string
}

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
  readonly versionDirectory: string
  readonly currentFile: string
  readonly versionName: string
  readonly sourceNodeExecutable: string
  readonly metadata: DesktopStageMetadata
  readonly localPlugins: readonly DesktopLocalPlugin[]
  readonly commands: {
    readonly build: DesktopStageCommand
    readonly packLocalPlugins: readonly DesktopStageCommand[]
    readonly deploy: DesktopStageCommand
    readonly installLocalPlugins: readonly DesktopStageCommand[]
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
  readonly localPlugins?: readonly DesktopLocalPlugin[]
}

const isPackageName = (value: string): boolean =>
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(value)

const assertContainedPath = (root: string, target: string, label: string): void => {
  const path = relative(root, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} escapes its allowed directory`)
  }
}

const localPluginArchiveName = (packageName: string, version: string): string =>
  `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`

const localPluginInstallName = (packageName: string): string =>
  encodeURIComponent(packageName)

const localPluginRootPackageName = (packageName: string): string =>
  `dsh-desktop-local-${packageName.replace(/^@/, '').replace('/', '-')}`

const pnpmPath = (from: string, to: string): string =>
  relative(from, to).split(sep).join('/')

const installedPackageNames = async (nodeModules: string): Promise<string[]> => {
  const names: string[] = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
    if (!entry.name.startsWith('@')) {
      names.push(entry.name)
      continue
    }
    for (const scoped of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
      if (scoped.isDirectory() || scoped.isSymbolicLink()) {
        names.push(`${entry.name}/${scoped.name}`)
      }
    }
  }
  return names.sort()
}

/**
 * Parse and validate local desktop bundle directories.
 * @param raw - JSON array from `DSH_DESKTOP_LOCAL_PLUGINS`.
 * @param cwd - Base directory for relative entries.
 * @returns Local packages with validated bundle declarations.
 */
export const resolveDesktopLocalPlugins = async (
  raw: string | undefined,
  cwd: string,
): Promise<DesktopLocalPlugin[]> => {
  if (raw === undefined || raw.trim() === '') return []
  let entries: unknown
  try {
    entries = JSON.parse(raw)
  } catch {
    throw new Error(`${LOCAL_PLUGINS_ENV} must be a JSON array of package directories`)
  }
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${LOCAL_PLUGINS_ENV} must be a JSON array of non-empty package directories`)
  }
  const plugins: DesktopLocalPlugin[] = []
  const packageNames = new Set<string>()
  const archiveNames = new Set<string>()
  for (const entry of entries) {
    const sourceDirectory = resolve(cwd, entry as string)
    let manifest: LocalPluginPackageManifest
    try {
      manifest = JSON.parse(await readFile(join(sourceDirectory, 'package.json'), 'utf8')) as LocalPluginPackageManifest
    } catch (error) {
      throw new Error(`desktop local plugin ${sourceDirectory} has no valid package.json`, { cause: error })
    }
    if (typeof manifest.name !== 'string' || !isPackageName(manifest.name)) {
      throw new Error(`desktop local plugin ${sourceDirectory} has an invalid package name`)
    }
    if (typeof manifest.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(manifest.version)) {
      throw new Error(`desktop local plugin ${manifest.name} has an invalid package version`)
    }
    const bundlePatch = manifest.dsh?.bundle?.patch
    if (typeof bundlePatch !== 'string' || bundlePatch.trim() === '' || isAbsolute(bundlePatch)) {
      throw new Error(`desktop local plugin ${manifest.name} declares no relative dsh.bundle.patch`)
    }
    const patchPath = resolve(sourceDirectory, bundlePatch)
    assertContainedPath(sourceDirectory, patchPath, `desktop local plugin ${manifest.name} patch`)
    try {
      if (!(await stat(patchPath)).isFile()) throw new Error('not a file')
    } catch (error) {
      throw new Error(`desktop local plugin ${manifest.name} patch is missing: ${bundlePatch}`, { cause: error })
    }
    if (packageNames.has(manifest.name)) {
      throw new Error(`desktop local plugin package name is duplicated: ${manifest.name}`)
    }
    const archiveName = localPluginArchiveName(manifest.name, manifest.version)
    if (archiveNames.has(archiveName)) {
      throw new Error(`desktop local plugin archive name is duplicated: ${archiveName}`)
    }
    packageNames.add(manifest.name)
    archiveNames.add(archiveName)
    plugins.push({
      sourceDirectory,
      packageName: manifest.name,
      version: manifest.version,
      bundlePatch,
      archiveName,
    })
  }
  return plugins
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
  const localPlugins = options.localPlugins ?? []
  const localPluginArchiveDirectory = join(temporaryDirectory, 'local-plugin-archives')
  return {
    root,
    stageDirectory,
    temporaryDirectory,
    versionDirectory: join(stageDirectory, 'versions', options.temporaryId),
    currentFile: join(stageDirectory, 'current'),
    versionName: options.temporaryId,
    sourceNodeExecutable: options.sourceNodeExecutable,
    metadata: options.metadata,
    localPlugins,
    commands: {
      build: {
        command: options.pnpm.command,
        args: [...options.pnpm.args, 'run', 'build'],
        cwd: root,
      },
      packLocalPlugins: localPlugins.map(plugin => ({
        command: options.pnpm.command,
        args: [
          ...options.pnpm.args,
          'pack',
          '--pack-destination',
          localPluginArchiveDirectory,
        ],
        cwd: plugin.sourceDirectory,
      })),
      deploy: {
        command: options.pnpm.command,
        args: [
          ...options.pnpm.args,
          '--filter',
          '@deepseek-ai/dsh-desktop-runtime',
          'deploy',
          '--prod',
          '--ignore-scripts',
          '--config.node-linker=hoisted',
          '--config.inject-workspace-packages=true',
          join(temporaryDirectory, 'app'),
        ],
        cwd: root,
      },
      installLocalPlugins: localPlugins.map(plugin => ({
        command: options.pnpm.command,
        args: [
          ...options.pnpm.args,
          'install',
          '--prod',
          '--ignore-scripts',
          '--config.node-linker=hoisted',
          '--config.auto-install-peers=false',
        ],
        cwd: join(
          temporaryDirectory,
          'app/local-plugins',
          localPluginInstallName(plugin.packageName),
        ),
      })),
    },
  }
}

const requiredFiles = new Map<string, string>([
  ['node/bin/node', 'Node executable'],
  ['app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'CLI entry'],
  ['app/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/preset.yml', 'standard preset'],
  ['app/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml', 'standard agent composition'],
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
  ['app/skills/office-docx/SKILL.md', 'DOCX skill'],
  ['app/skills/office-docx/scripts/create-document.mjs', 'DOCX generator'],
  ['app/skills/office-xlsx/SKILL.md', 'XLSX skill'],
  ['app/skills/office-xlsx/scripts/create-workbook.mjs', 'XLSX generator'],
  ['app/skills/browser-research/SKILL.md', 'browser research skill'],
  ['app/skills/browser-task/SKILL.md', 'browser task skill'],
  [LOCAL_PLUGINS_MANIFEST, 'local plugin manifest'],
])

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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

const sha256File = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex')

const readStagedLocalPlugins = async (stage: string): Promise<unknown[]> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(stage, LOCAL_PLUGINS_MANIFEST), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${LOCAL_PLUGINS_MANIFEST} is not valid JSON`)
    throw error
  }
  if (!Array.isArray(parsed)) throw new Error(`${LOCAL_PLUGINS_MANIFEST} must contain an array`)
  return parsed as unknown[]
}

const validateStagedLocalPlugins = async (stage: string): Promise<void> => {
  const plugins = await readStagedLocalPlugins(stage)
  const packageNames = new Set<string>()
  for (const value of plugins) {
    if (
      typeof value !== 'object'
      || value === null
    ) {
      throw new Error(`${LOCAL_PLUGINS_MANIFEST} contains an invalid entry`)
    }
    const plugin = value as Partial<StagedLocalPlugin>
    if (
      typeof plugin.packageName !== 'string'
      || !isPackageName(plugin.packageName)
      || typeof plugin.version !== 'string'
      || plugin.version === ''
      || typeof plugin.bundlePatch !== 'string'
      || plugin.bundlePatch === ''
      || typeof plugin.packageRoot !== 'string'
      || plugin.packageRoot === ''
      || typeof plugin.archive !== 'string'
      || plugin.archive === ''
      || typeof plugin.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(plugin.sha256)
    ) {
      throw new Error(`${LOCAL_PLUGINS_MANIFEST} contains an invalid entry`)
    }
    if (packageNames.has(plugin.packageName)) {
      throw new Error(`${LOCAL_PLUGINS_MANIFEST} contains duplicate package ${plugin.packageName}`)
    }
    packageNames.add(plugin.packageName)
    const archivePath = resolve(stage, plugin.archive)
    const packageDirectory = resolve(stage, plugin.packageRoot)
    const patchPath = resolve(packageDirectory, plugin.bundlePatch)
    assertContainedPath(stage, archivePath, `desktop local plugin ${plugin.packageName} archive`)
    assertContainedPath(stage, packageDirectory, `desktop local plugin ${plugin.packageName} package`)
    assertContainedPath(packageDirectory, patchPath, `desktop local plugin ${plugin.packageName} patch`)
    await assertFile(archivePath, `desktop local plugin ${plugin.packageName} archive`)
    await assertFile(patchPath, `desktop local plugin ${plugin.packageName} patch`)
    if (await sha256File(archivePath) !== plugin.sha256) {
      throw new Error(`desktop local plugin ${plugin.packageName} archive digest mismatch`)
    }
    const installed = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as LocalPluginPackageManifest
    if (installed.name !== plugin.packageName || installed.version !== plugin.version
      || installed.dsh?.bundle?.patch !== plugin.bundlePatch) {
      throw new Error(`desktop local plugin ${plugin.packageName} installed manifest mismatch`)
    }
  }
}

/** Replaceable process probe used by stage validation. */
export interface DesktopStageValidationDependencies {
  readonly readNodeVersion?: (nodeExecutable: string) => Promise<string>
  readonly loadNativeDependencies?: (nodeExecutable: string, appDirectory: string) => Promise<void>
  readonly runCliSmoke?: (nodeExecutable: string, cliEntry: string, appDirectory: string) => Promise<void>
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
  for (const dependency of ['node-pty', 'koffi', 'docx', 'exceljs']) {
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
  await validateStagedLocalPlugins(stage)
  await assertContainedSymlinks(stage)

  const readNodeVersion = dependencies.readNodeVersion
  if (readNodeVersion !== undefined) {
    const actualVersion = await readNodeVersion(join(stage, nodeRelative))
    if (actualVersion !== expectedMetadata.nodeVersion) {
      throw new Error(`Node version mismatch: expected ${expectedMetadata.nodeVersion}, received ${actualVersion}`)
    }
  }
  const nodeExecutable = join(stage, nodeRelative)
  const appDirectory = join(stage, 'app')
  try {
    await (dependencies.loadNativeDependencies ?? loadNativeDependencies)(
      nodeExecutable,
      appDirectory,
    )
  } catch (error) {
    throw new Error(
      `staged native dependencies failed to load: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  try {
    await (dependencies.runCliSmoke ?? runCliSmoke)(
      nodeExecutable,
      join(appDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      appDirectory,
    )
  } catch (error) {
    throw new Error(`staged CLI smoke failed: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

/** Paths participating in atomic stage publication. */
export interface DesktopStagePublication {
  readonly stageDirectory: string
  readonly temporaryDirectory: string
  readonly versionDirectory: string
  readonly currentFile: string
  readonly versionName: string
}

/** Replaceable filesystem operation used to test publication rollback. */
export interface DesktopStagePublicationDependencies {
  /** Host platform used to select the Windows rename retry policy. */
  readonly platform?: NodeJS.Platform
  /** Atomic directory rename operation. */
  readonly renameVersion?: (source: string, destination: string) => Promise<void>
  /** Delay operation between transient Windows rename attempts. */
  readonly wait?: (delayMs: number) => Promise<void>
  readonly writeCurrent?: (path: string, content: string) => Promise<void>
}

const WINDOWS_RENAME_RETRIES = 50
const WINDOWS_RENAME_RETRY_DELAY_MS = 200

const renameStageVersion = async (
  source: string,
  destination: string,
  dependencies: DesktopStagePublicationDependencies,
): Promise<void> => {
  const renameVersion = dependencies.renameVersion ?? rename
  const wait = dependencies.wait
    ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)))
  for (let retries = 0; ; retries += 1) {
    try {
      await renameVersion(source, destination)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (
        (dependencies.platform ?? process.platform) !== 'win32'
        || (code !== 'EPERM' && code !== 'EBUSY')
        || retries >= WINDOWS_RENAME_RETRIES
      ) {
        throw error
      }
      await wait(WINDOWS_RENAME_RETRY_DELAY_MS)
    }
  }
}

/**
 * Publish an immutable stage version, then atomically select it for new launches.
 * @param paths - Container, candidate, version, and current-pointer paths.
 * @param dependencies - Optional filesystem and timing adapters.
 */
export const publishDesktopStage = async (
  paths: DesktopStagePublication,
  dependencies: DesktopStagePublicationDependencies = {},
): Promise<void> => {
  await mkdir(resolve(paths.versionDirectory, '..'), { recursive: true })
  await removeDesktopStagePath(paths.versionDirectory)
  await renameStageVersion(
    paths.temporaryDirectory,
    paths.versionDirectory,
    dependencies,
  )
  const writeCurrent = dependencies.writeCurrent
    ?? ((path: string, content: string) =>
      writeFileAtomic(path, content, { mode: 0o600 }))
  try {
    await writeCurrent(paths.currentFile, `${paths.versionName}\n`)
  } catch (error) {
    await removeDesktopStagePath(paths.versionDirectory)
    throw error
  }
}

/** Replaceable effects used by the staging executor. */
export interface DesktopStageExecutionDependencies {
  readonly run: (command: DesktopStageCommand) => Promise<void>
  readonly readNodeVersion: (nodeExecutable: string) => Promise<string>
  readonly loadNativeDependencies: (nodeExecutable: string, appDirectory: string) => Promise<void>
  readonly runCliSmoke: (nodeExecutable: string, cliEntry: string, appDirectory: string) => Promise<void>
}

/**
 * Remove one owned stage path without traversing a directory link.
 * @param path - Candidate path owned by the staging workflow.
 */
export const removeDesktopStagePath = async (path: string): Promise<void> => {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  if (metadata.isSymbolicLink()) {
    await unlink(path)
    return
  }
  await rm(path, { recursive: true, force: true })
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
  await removeDesktopStagePath(plan.temporaryDirectory)
  await removeDesktopStagePath(plan.versionDirectory)
  try {
    await dependencies.run(plan.commands.build)
    await mkdir(join(plan.temporaryDirectory, 'local-plugin-archives'), { recursive: true })
    for (const command of plan.commands.packLocalPlugins) await dependencies.run(command)
    await dependencies.run(plan.commands.deploy)
    const deployedDependencies = plan.localPlugins.length === 0
      ? []
      : await installedPackageNames(join(plan.temporaryDirectory, 'app/node_modules'))
    for (const [index, command] of plan.commands.installLocalPlugins.entries()) {
      const plugin = plan.localPlugins[index]
      if (plugin === undefined) throw new Error('desktop local plugin install plan is inconsistent')
      const archive = join(plan.temporaryDirectory, 'local-plugin-archives', plugin.archiveName)
      await assertFile(archive, `desktop local plugin ${plugin.packageName} archive`)
      await mkdir(command.cwd, { recursive: true })
      // Root links satisfy peers; overrides keep ordinary transitive references
      // on the staged singleton instead of fetching another Harness copy.
      const deployedLinks: [string, string][] = deployedDependencies
        .filter(packageName => packageName !== plugin.packageName)
        .map((packageName): [string, string] => [
          packageName,
          `link:${pnpmPath(command.cwd, join(plan.temporaryDirectory, 'app/node_modules', packageName))}`,
        ])
      const runtimeDependencies: Record<string, string> = Object.fromEntries([
        [plugin.packageName, `file:${pnpmPath(command.cwd, archive)}`],
        ...deployedLinks,
      ])
      const runtimeOverrides: Record<string, string> = Object.fromEntries(deployedLinks)
      await writeFile(join(command.cwd, 'package.json'), `${JSON.stringify({
        name: localPluginRootPackageName(plugin.packageName),
        private: true,
        dependencies: runtimeDependencies,
      }, null, 2)}\n`)
      await writeFile(join(command.cwd, 'pnpm-workspace.yaml'), [
        'packages:',
        '  - .',
        '',
        'nodeLinker: hoisted',
        'autoInstallPeers: false',
        `overrides: ${JSON.stringify(runtimeOverrides)}`,
        '',
      ].join('\n'))
      await dependencies.run(command)
    }

    const stagedLocalPlugins: StagedLocalPlugin[] = []
    for (const plugin of plan.localPlugins) {
      const installName = localPluginInstallName(plugin.packageName)
      const archive = join(plan.temporaryDirectory, 'local-plugin-archives', plugin.archiveName)
      await assertFile(archive, `desktop local plugin ${plugin.packageName} archive`)
      stagedLocalPlugins.push({
        packageName: plugin.packageName,
        version: plugin.version,
        bundlePatch: plugin.bundlePatch,
        packageRoot: `app/local-plugins/${installName}/node_modules/${plugin.packageName}`,
        archive: `local-plugin-archives/${plugin.archiveName}`,
        sha256: await sha256File(archive),
      })
    }
    await writeFile(
      join(plan.temporaryDirectory, LOCAL_PLUGINS_MANIFEST),
      `${JSON.stringify(stagedLocalPlugins, null, 2)}\n`,
    )

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
      loadNativeDependencies: dependencies.loadNativeDependencies,
      runCliSmoke: dependencies.runCliSmoke,
    })
  } catch (error) {
    await removeDesktopStagePath(plan.temporaryDirectory)
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

const scrubbedProbeEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.platform === 'win32' && process.env.SystemRoot !== undefined
    ? { SystemRoot: process.env.SystemRoot }
    : {},
  ...process.env.HOME !== undefined ? { HOME: process.env.HOME } : {},
  ...process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {},
  ...process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {},
  ...process.env.TEMP !== undefined ? { TEMP: process.env.TEMP } : {},
  ...process.env.TMP !== undefined ? { TMP: process.env.TMP } : {},
})

const loadNativeDependencies = async (
  nodeExecutable: string,
  appDirectory: string,
): Promise<void> => {
  const requireFrom = JSON.stringify(join(appDirectory, 'package.json'))
  const script = [
    "import { createRequire } from 'node:module'",
    `const require = createRequire(${requireFrom})`,
    "require('node-pty')",
    "require('koffi')",
  ].join(';')
  await execFileAsync(nodeExecutable, ['--input-type=module', '--eval', script], {
    cwd: appDirectory,
    env: scrubbedProbeEnvironment(),
  })
}

const runCliSmoke = async (
  nodeExecutable: string,
  cliEntry: string,
  appDirectory: string,
): Promise<void> => {
  await execFileAsync(nodeExecutable, [cliEntry, 'web', '--help'], {
    cwd: appDirectory,
    env: scrubbedProbeEnvironment(),
  })
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
  const localPlugins = await resolveDesktopLocalPlugins(
    process.env[LOCAL_PLUGINS_ENV],
    process.cwd(),
  )
  const plan = createDesktopStagePlan({
    root,
    sourceNodeExecutable: process.execPath,
    metadata,
    temporaryId: `${process.pid}`,
    pnpm: {
      command: process.execPath,
      args: [pnpmEntry],
    },
    localPlugins,
  })
  await executeDesktopStage(plan, {
    run: runCommand,
    readNodeVersion,
    loadNativeDependencies,
    runCliSmoke,
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
