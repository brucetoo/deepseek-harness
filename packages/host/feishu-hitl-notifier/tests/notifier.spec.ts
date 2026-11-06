import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import FeishuHitlNotifier, { validateNotifierConfiguration } from '@deepseek-ai/dsh-feishu-hitl-notifier'

class StubSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly resolutions: string[] = []
  outcome: SubprocessOutcome = { exitCode: 0, signal: null }
  stdout: SubprocessOutputRead = { text: '{"message_id":"om_1"}', nextOffset: 21, lossy: false }
  pending = false
  readonly terminations: Array<ReturnType<typeof vi.fn>> = []

  resolveExecutable(command: string): Promise<string> {
    this.resolutions.push(command)
    return Promise.resolve(`/usr/local/bin/${command}`)
  }

  terminalEnvironment(): Promise<{ platform: 'posix' }> {
    return Promise.resolve({ platform: 'posix' })
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(structuredClone(spec))
    const terminate = vi.fn(() => undefined)
    this.terminations.push(terminate)
    const done = this.pending
      ? new Promise<SubprocessOutcome>(resolve => spec.signal?.addEventListener('abort', () => {
        terminate()
        resolve({ exitCode: null, signal: 'SIGTERM' })
      }, { once: true }))
      : Promise.resolve(this.outcome)
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => this.stdout },
        stderr: { readFrom: () => ({ text: 'private stderr', nextOffset: 14, lossy: false }) },
      },
      done, terminate, waitForExit: () => Promise.resolve(true),
    }
  }

  spawnTerminal(): never { throw new Error('unused') }
}

const makeAgent = (value = 'session-1'): Agent => {
  const id = SessionId(value)
  return {
    id,
    session: Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      isSeeded: false,
      delegationDepth: 0,
    }),
  } as Agent
}

const baseConfiguration = {
  enabled: true,
  webBaseUrl: 'https://dsh.example.test/app',
  recipients: [
    { type: 'email' as const, id: 'operator@example.com' },
    { type: 'chat_id' as const, id: 'oc_oncall' },
  ],
  summaryMaxChars: 80,
  includeSessionTitle: true,
}

const cli = {
  cli: { executable: 'feishu-cli', configPath: '~/.feishu-cli/config.yaml', timeoutMs: 10_000 },
}

async function mounted(options: { config?: typeof baseConfiguration } = {}) {
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(StubSubprocess)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 80, maxTitleBytes: 120 })
  ctx.on('user-questions/request', request => Promise.resolve({
    answers: [{ id: request.questions[0]?.id ?? 'missing', selected: ['done'] }],
  }))
  const notifierFiber = ctx.plugin(FeishuHitlNotifier, {
    configuration: options.config ?? baseConfiguration,
    ...cli,
  })
  await notifierFiber.await()
  return { ctx, notifier: ctx.feishuHitlNotifier, subprocess: ctx.subprocess as StubSubprocess, notifierFiber }
}

const contentOf = (spec: SubprocessSpawnSpec): string => spec.argv[spec.argv.indexOf('--content') + 1] ?? ''

async function request(ctx: Context, id: string, question = 'Choose rollout'): Promise<void> {
  const caller = makeAgent(id)
  await ctx.parallel('user-question/requested', { agent: caller, questions: [{ id: 'q', question }] })
}

describe('FeishuHitlNotifier service', () => {
  it('rejects a duplicate Host service instance', async () => {
    const { ctx } = await mounted()
    await expect(ctx.plugin(FeishuHitlNotifier, {
      configuration: baseConfiguration,
      ...cli,
    })).rejects.toThrow(/service "feishuHitlNotifier" has been registered/)
  })

  it('resolves the deployment CLI while notifications are disabled', async () => {
    const config = { ...baseConfiguration, enabled: false, recipients: [] }
    const { ctx, subprocess } = await mounted({ config })
    expect(subprocess.resolutions).toEqual(['feishu-cli'])
    await request(ctx, 'disabled')
    expect(subprocess.specs).toHaveLength(0)
  })

  it.each([
    [{ ...baseConfiguration, enabled: true, recipients: [] }, 'at least one recipient'],
    [{ ...baseConfiguration, recipients: Array.from({ length: 101 }, (_, i) => ({ type: 'user_id' as const, id: `u${i}` })) }, 'at most 100'],
    [{ ...baseConfiguration, recipients: [{ type: 'user_id' as const, id: ' same ' }, { type: 'user_id' as const, id: 'same' }] }, 'unique'],
    [{ ...baseConfiguration, recipients: [{ type: 'user_id' as const, id: '😀'.repeat(513) }] }, '512'],
    [{ ...baseConfiguration, webBaseUrl: '/relative' }, 'absolute'],
    [{ ...baseConfiguration, webBaseUrl: 'https://user@example.test/path' }, 'userinfo'],
    [{ ...baseConfiguration, webBaseUrl: 'https://example.test/path?secret=1' }, 'query'],
    [{ ...baseConfiguration, webBaseUrl: 'https://example.test/path?' }, 'query'],
    [{ ...baseConfiguration, webBaseUrl: 'https://example.test/path#secret' }, 'hash'],
    [{ ...baseConfiguration, webBaseUrl: 'https://example.test/path#' }, 'hash'],
    [{ ...baseConfiguration, summaryMaxChars: 0 }, 'between 1 and 1000'],
    [{ ...baseConfiguration, summaryMaxChars: 1.5 }, 'integer'],
  ])('rejects invalid configuration %#', (config, message) => {
    expect(() => {
      validateNotifierConfiguration({
        enabled: config.enabled,
        webBaseUrl: config.webBaseUrl,
        recipients: config.recipients,
        summaryMaxChars: config.summaryMaxChars,
        includeSessionTitle: config.includeSessionTitle,
      })
    }).toThrow(message)
  })

  it('sends privacy-minimized cards with argv-only transport', async () => {
    const { ctx, subprocess } = await mounted()
    await request(ctx, 'privacy', 'Review private rollout')
    await vi.waitFor(() => { expect(subprocess.specs).toHaveLength(2) })
    const spec = subprocess.specs[0]!
    expect(spec.argv.slice(0, 8)).toEqual([
      '/usr/local/bin/feishu-cli', '--config', join(homedir(), '.feishu-cli/config.yaml'),
      'msg', 'send', '--receive-id-type', 'email', '--receive-id',
    ])
    expect(contentOf(spec)).toContain('Review private rollout')
    expect(contentOf(spec)).toContain('https://dsh.example.test/app?session=privacy')
    expect(spec.stdio).toEqual({ stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } })
  })

  it('tests exactly one normalized active recipient with a fixed safe card while disabled', async () => {
    const config = { ...baseConfiguration, enabled: false, recipients: [{ type: 'email' as const, id: ' operator@example.com ' }] }
    const { notifier, subprocess } = await mounted({ config })
    await expect(notifier.testRecipient({ type: 'email', id: 'operator@example.com' })).resolves.toEqual({ status: 'sent' })
    expect(subprocess.specs).toHaveLength(1)
    expect(subprocess.specs[0]?.argv).toContain('operator@example.com')
    const wire = JSON.stringify(subprocess.specs[0]?.argv)
    expect(wire).not.toContain('session')
    expect(wire).not.toContain('question')
    expect(wire).not.toContain('title')
    expect(wire).not.toContain('https://')
  })

  it('normalizes test requests and rejects non-members without delivery', async () => {
    const { notifier, subprocess } = await mounted()
    await expect(notifier.testRecipient({ type: 'email', id: ' operator@example.com ' })).resolves.toEqual({ status: 'sent' })
    await expect(notifier.testRecipient({ type: 'email', id: 'missing@example.com' })).resolves.toEqual({ status: 'not-configured' })
    expect(subprocess.specs).toHaveLength(1)
  })

  it('returns busy for a Host-wide concurrent test of the same normalized key', async () => {
    const { notifier, subprocess, notifierFiber } = await mounted()
    subprocess.pending = true
    const first = notifier.testRecipient({ type: 'email', id: 'operator@example.com' })
    await vi.waitFor(() => { expect(subprocess.specs).toHaveLength(1) })
    await expect(notifier.testRecipient({ type: 'email', id: ' operator@example.com ' })).resolves.toEqual({ status: 'busy' })
    await notifierFiber.dispose()
    await expect(first).resolves.toEqual({ status: 'delivery-failed' })
  })

  it('does not expose errors, stdio, paths, recipients, or cards in remote results and logs', async () => {
    const { ctx, notifier, subprocess } = await mounted()
    subprocess.outcome = { exitCode: 7, signal: null }
    subprocess.stdout = { text: 'private stdout /secret/path operator@example.com', nextOffset: 48, lossy: false }
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const result = await notifier.testRecipient({ type: 'email', id: 'operator@example.com' })
    expect(result).toEqual({ status: 'delivery-failed' })
    const exposed = JSON.stringify([result, warn.mock.calls])
    expect(exposed).not.toContain('private stdout')
    expect(exposed).not.toContain('/secret/path')
    expect(exposed).not.toContain('operator@example.com')
    expect(exposed).not.toContain('DSH')
  })

  it('aborts and joins real and test deliveries during unload', async () => {
    const { ctx, notifier, subprocess, notifierFiber } = await mounted()
    subprocess.pending = true
    await request(ctx, 'unload')
    const test = notifier.testRecipient({ type: 'email', id: 'operator@example.com' })
    await vi.waitFor(() => { expect(subprocess.specs).toHaveLength(3) })
    await notifierFiber.dispose()
    await test
    expect(subprocess.terminations).toHaveLength(3)
    expect(subprocess.terminations.every(fn => fn.mock.calls.length === 1)).toBe(true)
  })
})
