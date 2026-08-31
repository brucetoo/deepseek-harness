/** Feishu notifications for DSH user questions through the local `feishu-cli`. */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from 'zod'
import type { Recipient, RecipientTestResult } from './types.ts'

export type * from './types.ts'

export const name = 'feishu-hitl-notifier'
export const inject = ['userQuestions', 'sessionTitle', 'subprocess']

/** Settings namespace owned by the Feishu HITL notifier. */
export const FEISHU_HITL_SETTINGS_NAMESPACE = settingsNamespace('feishu-hitl-notifier')

/** Deployment-owned `feishu-cli` process settings. */
export interface CliConfig {
  /** Executable name or path resolved through the subprocess provider. */
  executable?: string
  /** Credential configuration path passed to `feishu-cli`. */
  configPath?: string
  /** Maximum duration of one delivery attempt in milliseconds. */
  timeoutMs?: number
}

/** Loader configuration for Feishu user-question notifications. */
export interface Config {
  /** Whether automatic question notifications are sent. */
  enabled?: boolean
  /** Absolute DSH Web URL used for session return links. */
  webBaseUrl: string
  /** Feishu destinations that receive each notification. */
  recipients: Recipient[]
  /** Maximum Unicode code points retained from the first question. */
  summaryMaxChars?: number
  /** Whether an available session title is included in the card. */
  includeSessionTitle?: boolean
  /** Deployment-owned executable, credential path, and timeout. */
  cli?: CliConfig
}

/** Complete notifier settings persisted and replaced atomically. */
export interface NotifierConfiguration {
  enabled: boolean
  webBaseUrl: string
  recipients: Recipient[]
  summaryMaxChars: number
  includeSessionTitle: boolean
}

/** Settings document owned by the notifier namespace. */
export interface NotifierSettings {
  configuration: NotifierConfiguration
}

const recipientSchema = z.object({
  type: z.union(['open_id', 'user_id', 'chat_id', 'email']).required(),
  id: z.string().required(),
})

const configurationSchema: z<NotifierConfiguration> = z.object({
  enabled: z.boolean().default(true),
  webBaseUrl: z.string().required(),
  recipients: z.array(recipientSchema).required(),
  summaryMaxChars: z.number().default(240),
  includeSessionTitle: z.boolean().default(true),
})

const settingsSchema: z<NotifierSettings> = z.object({ configuration: configurationSchema.required() })

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  webBaseUrl: z.string().required(),
  recipients: z.array(recipientSchema).required(),
  summaryMaxChars: z.number().default(240),
  includeSessionTitle: z.boolean().default(true),
  cli: z.object({
    executable: z.string().default('feishu-cli'),
    configPath: z.string().default('~/.feishu-cli/config.yaml'),
    timeoutMs: z.number().default(10_000),
  }),
})

interface EffectiveConfiguration extends Omit<NotifierConfiguration, 'webBaseUrl'> {
  webBaseUrl: URL
}

interface DeploymentConfiguration {
  executable: string
  configPath: string
  timeoutMs: number
}

const codePoints = (value: string): number => Array.from(value).length

const normalizeRecipient = (recipient: Recipient): Recipient => {
  const id = recipient.id.trim()
  const length = codePoints(id)
  if (length < 1 || length > 512) {
    throw new TypeError('feishu-hitl-notifier: recipient id must contain between 1 and 512 Unicode codepoints')
  }
  return { type: recipient.type, id }
}

const recipientKey = (recipient: Recipient): string => `${recipient.type}:${recipient.id}`

/**
 * Validate a complete notifier configuration without applying it.
 *
 * @param value - configuration to validate.
 */
export const validateNotifierConfiguration = (value: NotifierConfiguration): void => {
  validateConfiguration(value)
}

const validateConfiguration = (value: NotifierConfiguration): EffectiveConfiguration => {
  if (!Number.isInteger(value.summaryMaxChars)) {
    throw new TypeError('feishu-hitl-notifier: summaryMaxChars must be an integer')
  }
  if (value.summaryMaxChars < 1 || value.summaryMaxChars > 1000) {
    throw new TypeError('feishu-hitl-notifier: summaryMaxChars must be between 1 and 1000')
  }
  if (codePoints(value.webBaseUrl) > 2048) {
    throw new TypeError('feishu-hitl-notifier: webBaseUrl must contain at most 2048 Unicode codepoints')
  }
  let webBaseUrl: URL
  try {
    webBaseUrl = new URL(value.webBaseUrl)
  } catch {
    throw new TypeError('feishu-hitl-notifier: webBaseUrl must be an absolute HTTP(S) URL')
  }
  if (webBaseUrl.protocol !== 'http:' && webBaseUrl.protocol !== 'https:') {
    throw new TypeError('feishu-hitl-notifier: webBaseUrl must be an absolute HTTP(S) URL')
  }
  if (webBaseUrl.username !== '' || webBaseUrl.password !== '') {
    throw new TypeError('feishu-hitl-notifier: webBaseUrl must not contain userinfo')
  }
  const authorityAndPath = value.webBaseUrl.slice(value.webBaseUrl.indexOf('://') + 3)
  if (authorityAndPath.includes('?')) throw new TypeError('feishu-hitl-notifier: webBaseUrl must not contain a query')
  if (authorityAndPath.includes('#')) throw new TypeError('feishu-hitl-notifier: webBaseUrl must not contain a hash')
  if (value.recipients.length > 100) {
    throw new TypeError('feishu-hitl-notifier: recipients must contain at most 100 entries')
  }
  const recipients = value.recipients.map(normalizeRecipient)
  if (value.enabled && recipients.length === 0) {
    throw new TypeError('feishu-hitl-notifier: enabled configuration requires at least one recipient')
  }
  const keys = recipients.map(recipientKey)
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('feishu-hitl-notifier: recipients must be unique by type and trimmed id')
  }
  return Object.freeze({
    enabled: value.enabled,
    webBaseUrl,
    recipients: Object.freeze(recipients.map(recipient => Object.freeze(recipient))) as Recipient[],
    summaryMaxChars: value.summaryMaxChars,
    includeSessionTitle: value.includeSessionTitle,
  })
}

const positiveInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`feishu-hitl-notifier: ${name} must be a positive safe integer`)
  }
  return value
}

const resolveHomePath = (path: string): string => {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

const normalizeSummary = (text: string, maxChars: number): string => {
  const normalized = text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return normalized
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

const isPlanReview = (questions: readonly AskUserQuestionItem[]): boolean =>
  questions.some(question => question.intent?.kind === 'plan-review')

const sessionUrl = (base: URL, sessionId: string): string => {
  const url = new URL(base.href)
  url.searchParams.set('session', sessionId)
  return url.href
}

const eventCard = (request: AskUserQuestionRequest, title: string | undefined, url: string, max: number): string => {
  const planReview = isPlanReview(request.questions)
  const fields = [{ is_short: true, text: { tag: 'plain_text', content: `类型\n${planReview ? '计划审核' : '问题确认'}` } }]
  if (title !== undefined) fields.push({ is_short: true, text: { tag: 'plain_text', content: `会话\n${normalizeSummary(title, 80)}` } })
  return JSON.stringify({
    header: { template: planReview ? 'orange' : 'blue', title: { tag: 'plain_text', content: 'DSH 等待人工处理' } },
    elements: [
      { tag: 'div', fields },
      { tag: 'div', text: { tag: 'plain_text', content: `问题摘要\n${normalizeSummary(request.questions[0]?.question ?? 'DSH is waiting for input', max)}` } },
      ...(request.questions.length <= 1 ? [] : [{ tag: 'note', elements: [{ tag: 'plain_text', content: `共 ${String(request.questions.length)} 个问题等待处理` }] }]),
      { tag: 'hr' },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', url, text: { tag: 'plain_text', content: '前往 DSH 处理' } }] },
    ],
  })
}

const SAFE_TEST_CARD = JSON.stringify({
  elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'DSH 通知通道工作正常。' } }],
})

/** Observes admitted user questions and sends bounded Feishu notification cards. */
export class FeishuHitlNotifier extends TypertRemoteService {
  static Config = Config
  static inject = inject

  private source: () => NotifierSettings
  private readonly deployment: DeploymentConfiguration
  private readonly executable: Promise<string>
  private readonly controller = new AbortController()
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly testing = new Set<string>()
  private stopped = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'feishuHitlNotifier')
    const entry: NotifierSettings = { configuration: {
      enabled: config.enabled ?? true,
      webBaseUrl: config.webBaseUrl,
      recipients: config.recipients,
      summaryMaxChars: config.summaryMaxChars ?? 240,
      includeSessionTitle: config.includeSessionTitle ?? true,
    } }
    validateConfiguration(entry.configuration)
    this.source = () => entry
    this.deployment = {
      executable: config.cli?.executable ?? 'feishu-cli',
      configPath: resolveHomePath(config.cli?.configPath ?? '~/.feishu-cli/config.yaml'),
      timeoutMs: positiveInteger('cli.timeoutMs', config.cli?.timeoutMs ?? 10_000),
    }
    this.executable = ctx.subprocess.resolveExecutable(this.deployment.executable)
    installSettingsSection(ctx, FEISHU_HITL_SETTINGS_NAMESPACE, settingsSchema, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => {},
      validate: (value) => { validateConfiguration(value.configuration) },
    })
    ctx.on('user-question/requested', (request) => { this.onQuestion(request) })
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    await this.executable
    yield async () => {
      this.stopped = true
      this.controller.abort(new Error('feishu HITL notifier unloaded'))
      await Promise.allSettled([...this.inflight])
    }
  }

  private snapshot(): EffectiveConfiguration {
    return validateConfiguration(structuredClone(this.source().configuration))
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.inflight.add(task)
    void task.then(
      () => this.inflight.delete(task),
      () => this.inflight.delete(task),
    )
    return task
  }

  private onQuestion(request: AskUserQuestionRequest): void {
    if (this.stopped || request.agent === undefined) return
    const snapshot = this.snapshot()
    if (!snapshot.enabled) return
    const title = snapshot.includeSessionTitle ? this.ctx.sessionTitle.get(request.agent.session)?.title : undefined
    const card = eventCard(request, title, sessionUrl(snapshot.webBaseUrl, String(request.agent.id)), snapshot.summaryMaxChars)
    for (const recipient of snapshot.recipients) {
      const task = this.deliver(recipient, card).catch(() => {
        if (!this.controller.signal.aborted) this.ctx.logger.warn('feishu-hitl-notifier: delivery failed')
      })
      void this.track(task)
    }
  }

  private async deliver(recipient: Recipient, content: string): Promise<void> {
    const executable = await this.executable
    const controller = new AbortController()
    const abort = (): void => {
      controller.abort(this.controller.signal.reason)
    }
    if (this.controller.signal.aborted) abort()
    else this.controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      controller.abort(new Error('delivery timed out'))
    }, this.deployment.timeoutMs)
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [executable, '--config', this.deployment.configPath, 'msg', 'send', '--receive-id-type', recipient.type,
          '--receive-id', recipient.id, '--msg-type', 'interactive', '--content', content, '--output', 'json'],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 * 1024 }, stderr: { maxBytes: 32 * 1024 } },
        graceMs: 1_000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      if (controller.signal.aborted) throw controller.signal.reason
      if (outcome.exitCode !== 0) throw new Error('delivery failed')
      const stdout = handle.collected.stdout?.readFrom(0).text.trim()
      if (stdout !== undefined && stdout.length > 0) JSON.parse(stdout)
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener('abort', abort)
    }
  }

  /**
   * Send a fixed privacy-safe card to one currently configured recipient.
   *
   * @param request - identity of a recipient already present in saved settings.
   * @returns a sanitized delivery status without process output or recipient details.
   */
  @Remote('testRecipient')
  async testRecipient(request: Recipient): Promise<RecipientTestResult> {
    let recipient: Recipient
    try {
      recipient = normalizeRecipient(request)
    } catch {
      return { status: 'not-configured' }
    }
    const snapshot = this.snapshot()
    const active = snapshot.recipients.find(candidate => recipientKey(candidate) === recipientKey(recipient))
    if (active === undefined) return { status: 'not-configured' }
    const key = recipientKey(active)
    if (this.testing.has(key)) return { status: 'busy' }
    this.testing.add(key)
    try {
      await this.track(this.deliver(active, SAFE_TEST_CARD))
      return { status: 'sent' }
    } catch {
      if (!this.controller.signal.aborted) this.ctx.logger.warn('feishu-hitl-notifier: test delivery failed')
      return { status: 'delivery-failed' }
    } finally {
      this.testing.delete(key)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishuHitlNotifier: FeishuHitlNotifier
  }
}

export default FeishuHitlNotifier
