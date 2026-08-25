/** Real Loader composition for the installable ModelHub provider plugin. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as ModelHub from '../src/index.ts'
import { startModelHubServer } from './support.ts'
import type { ModelHubServer } from './support.ts'

let root: string | undefined
let context: Context | undefined
let server: ModelHubServer | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.close()
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-modelhub-composition-'))
  server = await startModelHubServer()
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(join(root, '.credentials.yaml'), 'MODELHUB_COMPOSITION_AK: key-from-store\n', { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: llm-modelhub',
    "  name: '@deepseek-ai/dsh-llm-modelhub'",
    '  config:',
    `    endpoint: ${server.origin}/api/modelhub/online/v2/crawl`,
    '    apiKeyEnv: MODELHUB_COMPOSITION_AK',
    '    models:',
    '      - id: loader-model',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-modelhub', ModelHub],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

describe('ModelHub real Loader composition', () => {
  it('loads the route, applies settings live, and resolves the stored credential', async () => {
    const { ctx, settingsPath } = await loadComposition()
    expect(ctx.llm.listProviders()).toEqual([{
      id: ModelHub.MODELHUB_PROVIDER,
      name: ModelHub.MODELHUB_DISPLAY_NAME,
    }])
    await expect(ctx.llm.listModels(ModelHub.MODELHUB_PROVIDER)).resolves.toMatchObject([
      { id: 'loader-model', inputModalities: ['text'] },
    ])

    await writeFile(settingsPath, [
      'llm-modelhub:',
      '  retryPolicy:',
      '    mode: normal',
      '    maxRetries: 2',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.providerRetryPolicy(ModelHub.MODELHUB_PROVIDER)).toMatchObject({
        mode: 'normal',
        maxRetries: 2,
      })
    }, { timeout: 5_000 })

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'loader-model',
      messages: [],
    })) assembler.push(chunk)
    expect(assembler.message({
      kind: 'model',
      provider: ModelHub.MODELHUB_PROVIDER,
      model: 'loader-model',
    }).content).toEqual([{ type: 'text', text: 'hello' }])
    const request = server?.requests[0]
    if (request === undefined) throw new Error('ModelHub test server received no request')
    expect(new URL(request.url, server?.origin).searchParams.get('ak')).toBe('key-from-store')
  })
})
