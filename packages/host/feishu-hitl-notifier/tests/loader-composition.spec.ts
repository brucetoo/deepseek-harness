/** REAL Loader composition for the deployment-owned notifier profile row. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as FeishuHitlNotifier from '@deepseek-ai/dsh-feishu-hitl-notifier'

class LoaderSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  async resolveExecutable(command: string): Promise<string> {
    return `/loader-bin/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    return {
      pid: 1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: '{"message_id":"om_loader"}', nextOffset: 26, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => undefined,
      waitForExit: () => Promise.resolve(true),
    }
  }

  spawnTerminal(): never {
    throw new Error('composition does not allocate a terminal')
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-feishu-notifier-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 8',
    '    fallbackMaxBytes: 80',
    '    maxTitleBytes: 120',
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-subprocess'",
    "- name: '@deepseek-ai/dsh-feishu-hitl-notifier'",
    '  config:',
    '    enabled: true',
    "    webBaseUrl: 'https://dsh.example.test/'",
    '    recipients:',
    "      - type: 'chat_id'",
    "        id: 'oc_oncall'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-subprocess', LoaderSubprocess],
    ['@deepseek-ai/dsh-feishu-hitl-notifier', FeishuHitlNotifier],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('Feishu notifier Loader composition', () => {
  it('loads an opt-in deployment row through the real Loader', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(FeishuHitlNotifier.default).toBe(FeishuHitlNotifier.FeishuHitlNotifier)
    expect(ctx.feishuHitlNotifier).toBeInstanceOf(FeishuHitlNotifier.FeishuHitlNotifier)

    ctx.userQuestions.registerProvider({ ask: async () => ({ answers: [] }) })
    const agent = {
      id: 'loader-session',
      session: { id: 'loader-session', events: [] } as unknown as Session,
    } as unknown as Agent
    ctx.agents.enter(agent, undefined)
    await ctx.userQuestions.ask({
      agent,
      questions: [{ id: 'confirm', question: 'Continue through Loader?' }],
    })
    const subprocess = ctx.subprocess as LoaderSubprocess
    await expect.poll(() => subprocess.specs.length).toBe(1)
    expect(subprocess.specs[0]?.argv).toContain('oc_oncall')
    expect(subprocess.specs[0]?.argv.join(' ')).toContain('Continue through Loader?')
  })
})
