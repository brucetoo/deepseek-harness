/**
 * Model-facing tools for one approved, ephemeral public browser.
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserError,
  parsePublicBrowserUrl,
  type BrowserElementAction,
} from '@deepseek-ai/dsh-browser'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import {
  formatBrowserObservation,
  type BrowserToolObservation,
} from './output.ts'
import {
  assertOwner,
  assertPositiveInteger,
  observationSchema,
  project,
  requireApproval,
  runPreparedAction,
  targetParameters,
  validateTarget,
  type ResolvedConfig,
} from './tool-support.ts'

export {
  formatBrowserObservation,
  projectBrowserObservation,
} from './output.ts'
export type { BrowserToolObservation } from './output.ts'

/** Cordis plugin name. */
export const name = 'tool-browser'
/** Required services for browser execution, approval, and model context. */
export const inject = ['tools', 'browser', 'approval', 'systemPrompt']

/** Model-facing browser tool configuration. */
export interface Config {
  /** Maximum UTF-8 bytes retained in one complete observation. */
  readonly maxOutputBytes?: number
  /** Cooperative execution budget attached to each tool definition. */
  readonly timeoutMs?: number
  /** Maximum duration accepted by `browser_wait`. */
  readonly maxWaitMs?: number
}

export const Config: z<Config> = z.object({
  maxOutputBytes: z.number().default(64_000),
  timeoutMs: z.number().default(30_000),
  maxWaitMs: z.number().default(10_000),
})

const executePreparedAction = async (
  ctx: Context,
  config: ResolvedConfig,
  exec: ToolRunContext,
  toolName: string,
  action: BrowserElementAction,
): Promise<BrowserToolObservation> => {
  validateTarget(action.target)
  const owner = assertOwner(exec.agent)
  return project(await runPreparedAction(
    ctx,
    { agent: owner, callId: exec.callId, signal: exec.signal },
    toolName,
    action,
  ), config)
}

/**
 * Register the seven browser tools and their public-only operating guidance.
 * @param ctx - Agent context carrying browser, approval, tools, and prompt services.
 * @param config - Output, execution, and wait bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxOutputBytes', resolved.maxOutputBytes, 128)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxWaitMs', resolved.maxWaitMs)

  const owners = new Set<Agent>()
  ctx.effect(() => async () => {
    await Promise.all([...owners].map(owner =>
      ctx.browser.close(owner).catch(() => undefined),
    ))
    owners.clear()
  }, 'tool-browser cleanup')

  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 111,
    text: 'Use browser_* tools only for public pages that need visible interaction. '
      + 'Do not use them for login, credentials, secrets, private pages, uploads, downloads, popups, screenshots, '
      + 'or coordinate-based interaction. Observe, perform one approved action, then observe again. Always call '
      + 'browser_close when the browser task ends.',
  })

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open one visible ephemeral browser at a credential-free HTTP(S) URL after user approval.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute credential-free HTTP(S) URL.' },
    },
    output: {
      schema: observationSchema,
      render: (_args, value) => [{ type: 'text', text: formatBrowserObservation(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const owner = assertOwner(exec.agent)
      const url = parsePublicBrowserUrl(args.url)
      await requireApproval(ctx, { agent: owner, callId: exec.callId, signal: exec.signal }, 'browser_open',
        `Open public browser at ${url}. Page observations will be stored in Session history.`)
      const result = await ctx.browser.open(owner, { url }, exec.signal)
      owners.add(owner)
      return project(result, resolved)
    },
    presentCall: args => ({ card: 'generic', title: args.url, kind: 'search', rawInput: args.url }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Observe the current browser page as a bounded ARIA snapshot.',
    parameters: {},
    output: {
      schema: observationSchema,
      render: (_args, value) => [{ type: 'text', text: formatBrowserObservation(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(_args, exec) {
      const owner = assertOwner(exec.agent)
      return project(await ctx.browser.snapshot(owner, exec.signal), resolved)
    },
    presentCall: () => ({ card: 'generic', title: 'Observe browser', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click one exact accessible element after user approval.',
    parameters: targetParameters,
    output: {
      schema: observationSchema,
      render: (_args, value) => [{ type: 'text', text: formatBrowserObservation(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return executePreparedAction(
        ctx,
        resolved,
        exec,
        'browser_click',
        {
          kind: 'click',
          target: {
            role: args.role,
            name: args.name,
            ...args.index === undefined ? {} : { index: args.index },
          },
        },
      )
    },
    presentCall: args => ({
      card: 'generic',
      title: `Click ${args.name}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_fill',
    description: 'Replace one ordinary accessible form control value after user approval. Password controls are rejected.',
    parameters: {
      ...targetParameters,
      value: { type: 'string', required: true, description: 'Complete non-secret value to enter.' },
    },
    output: {
      schema: observationSchema,
      render: (_args, value) => [{ type: 'text', text: formatBrowserObservation(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return executePreparedAction(
        ctx,
        resolved,
        exec,
        'browser_fill',
        {
          kind: 'fill',
          target: {
            role: args.role,
            name: args.name,
            ...args.index === undefined ? {} : { index: args.index },
          },
          value: args.value,
        },
      )
    },
    presentCall: args => ({
      card: 'generic',
      title: `Fill ${args.name}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select',
    description: 'Select one visible option in an exact accessible control after user approval.',
    parameters: {
      ...targetParameters,
      option: { type: 'string', required: true, description: 'Exact visible option label.' },
    },
    output: {
      schema: observationSchema,
      render: (_args, value) => [{ type: 'text', text: formatBrowserObservation(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      return executePreparedAction(
        ctx,
        resolved,
        exec,
        'browser_select',
        {
          kind: 'select',
          target: {
            role: args.role,
            name: args.name,
            ...args.index === undefined ? {} : { index: args.index },
          },
          option: args.option,
        },
      )
    },
    presentCall: args => ({
      card: 'generic',
      title: `Select ${args.name}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait',
    description: `Wait up to ${resolved.maxWaitMs} milliseconds, then observe the current page.`,
    parameters: {
      duration_ms: { type: 'integer', required: true, description: 'Positive wait duration in milliseconds.' },
    },
    output: {
      schema: observationSchema,
      render: (_args, value) => [{ type: 'text', text: formatBrowserObservation(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      assertPositiveInteger('duration_ms', args.duration_ms)
      if (args.duration_ms > resolved.maxWaitMs) {
        throw new BrowserError(
          `browser wait exceeds the ${resolved.maxWaitMs} ms limit`,
          'BROWSER_WAIT_TOO_LONG',
        )
      }
      const owner = assertOwner(exec.agent)
      return project(await ctx.browser.wait(
        owner,
        { durationMs: args.duration_ms },
        exec.signal,
      ), resolved)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Wait ${args.duration_ms} ms`,
      kind: 'other',
      rawInput: args.duration_ms,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close the current browser and delete its ephemeral profile.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
        },
      },
      render: () => [{ type: 'text', text: 'Browser closed.' }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(_args, exec) {
      const owner = assertOwner(exec.agent)
      await ctx.browser.close(owner)
      owners.delete(owner)
      return { closed: true }
    },
    presentCall: () => ({ card: 'generic', title: 'Close browser', kind: 'other' }),
  }))
}
