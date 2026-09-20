/** Shared validation, approval, and schema support for browser tools. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserError,
  type BrowserElementAction,
  type BrowserObservation,
  type BrowserPreparedAction,
} from '@deepseek-ai/dsh-browser'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import {
  projectBrowserObservation,
  type BrowserToolObservation,
} from './output.ts'

/** Fully defaulted browser tool configuration. */
export interface ResolvedConfig {
  readonly maxOutputBytes: number
  readonly timeoutMs: number
  readonly maxWaitMs: number
}

interface ApprovalIdentity {
  readonly agent: Agent
  readonly callId: CallId
  readonly signal: AbortSignal
}

/** Accessible target fields accepted by element tools. */
export interface TargetArgs {
  readonly role: string
  readonly name: string
  readonly index?: number
}

/** Shared structured output schema for browser observations. */
export const observationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    snapshot: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
  },
} as const

/** Shared accessible target parameter definitions. */
export const targetParameters = {
  role: {
    type: 'string',
    required: true,
    description: 'Exact accessible role, such as button, link, textbox, or combobox.',
  },
  name: {
    type: 'string',
    required: true,
    description: 'Exact accessible name from the latest browser snapshot.',
  },
  index: {
    type: 'integer',
    description: 'Zero-based match index; omit when role and name identify exactly one element.',
  },
} as const

/**
 * Require the Agent identity attached to a tool execution.
 * @param agent - Optional execution Agent.
 * @returns The owning Agent.
 */
export const assertOwner = (agent: Agent | undefined): Agent => {
  if (agent === undefined) {
    throw new BrowserError('browser tools require an owning agent Session', 'BROWSER_OWNER_REQUIRED')
  }
  return agent
}

/**
 * Validate one positive bounded integer.
 * @param name - Configuration or argument name.
 * @param value - Candidate value.
 * @param minimum - Inclusive lower bound.
 */
export const assertPositiveInteger = (
  name: string,
  value: number,
  minimum = 1,
): void => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-browser: ${name} must be an integer of at least ${minimum}`)
  }
}

/**
 * Validate an accessible target supplied across the model boundary.
 * @param target - Role, name, and optional index.
 */
export const validateTarget = (target: TargetArgs): void => {
  if (target.role.trim().length === 0 || target.name.trim().length === 0) {
    throw new BrowserError('browser target role and name must be non-empty', 'BROWSER_INVALID_TARGET')
  }
  if (
    target.index !== undefined
    && (!Number.isInteger(target.index) || target.index < 0)
  ) {
    throw new BrowserError('browser target index must be a non-negative integer', 'BROWSER_INVALID_TARGET')
  }
}

const actionReason = (prepared: BrowserPreparedAction): string => {
  const { action, fingerprint } = prepared
  const index = action.target.index === undefined ? '' : ` at index ${action.target.index}`
  const target = `${action.target.role} ${JSON.stringify(action.target.name)}${index}`
  const fields = [
    `Operate ${target} on ${prepared.pageUrl}.`,
    `Resolved element: <${fingerprint.tagName}>`,
  ]
  if (fingerprint.inputType !== undefined) fields.push(`type=${JSON.stringify(fingerprint.inputType)}`)
  if (fingerprint.href !== undefined) fields.push(`link destination=${fingerprint.href}`)
  if (fingerprint.formAction !== undefined) fields.push(`form destination=${fingerprint.formAction}`)
  if (action.kind === 'fill') fields.push(`complete fill value=${JSON.stringify(action.value)}`)
  if (action.kind === 'select') fields.push(`selected option=${JSON.stringify(action.option)}`)
  fields.push('Supplied values and subsequent page observations will be stored in Session history.')
  return fields.join(' ')
}

/**
 * Require the exact one-shot approval result.
 * @param ctx - Context carrying the approval service.
 * @param identity - Agent, call, and cancellation identity.
 * @param toolName - Tool requesting approval.
 * @param reason - Complete user-visible operation description.
 */
export const requireApproval = async (
  ctx: Context,
  identity: ApprovalIdentity,
  toolName: string,
  reason: string,
): Promise<void> => {
  const outcome = await ctx.approval.request({
    agent: identity.agent,
    callId: identity.callId,
    reason,
    signal: identity.signal,
    toolName,
  })
  if (outcome !== 'allowed-once') {
    throw new BrowserError(
      `browser action was not approved (${outcome})`,
      'BROWSER_APPROVAL_DENIED',
    )
  }
}

/**
 * Prepare one exact element, obtain approval, and commit only that handle.
 * @param ctx - Context carrying browser and approval services.
 * @param identity - Agent, call, and cancellation identity.
 * @param toolName - Model-facing tool name.
 * @param action - Requested element action.
 * @returns Observation after the committed action.
 */
export const runPreparedAction = async (
  ctx: Context,
  identity: ApprovalIdentity,
  toolName: string,
  action: BrowserElementAction,
): Promise<BrowserObservation> => {
  const prepared = await ctx.browser.prepare(
    identity.agent,
    action,
    identity.signal,
  )
  try {
    await requireApproval(ctx, identity, toolName, actionReason(prepared))
  } catch (error: unknown) {
    await ctx.browser.release(identity.agent, prepared.id)
    throw error
  }
  return ctx.browser.commit(identity.agent, prepared.id, identity.signal)
}

/**
 * Bound and project one Provider observation into tool output.
 * @param observation - Provider result.
 * @param config - Fully resolved output settings.
 * @returns Model-facing observation.
 */
export const project = (
  observation: BrowserObservation,
  config: ResolvedConfig,
): BrowserToolObservation =>
  projectBrowserObservation(observation, config.maxOutputBytes)
