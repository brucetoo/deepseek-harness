/**
 * Agent-scoped model selection shared by runtime entry points.
 * @module @deepseek-ai/dsh-agent/model-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

import type { Agent } from './runtime-types.ts'

/** Complete concrete provider, model, and optional reasoning effort selected for one live Agent. */
export interface ModelSelection {
  /** Concrete-selection discriminant. */
  kind: 'model'
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Logical automatic model selection resolved by a request-routing plugin. */
export interface AutoModelSelection {
  /** Automatic-selection discriminant. */
  kind: 'auto'
  /** Optional router-owned candidate pool. */
  pool?: string
}

/** Logical model choice retained independently from physical request routing. */
export type ModelSelectionIntent = ModelSelection | AutoModelSelection

/** Mutable model-selection intent plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Intent selected for the next step that enters prompt assembly. */
  current: ModelSelectionIntent | undefined
  /** Intent captured when the current step entered prompt assembly. */
  assembled: ModelSelectionIntent | undefined
}

interface AssembledIntentEntry {
  owner: object
  intent: ModelSelectionIntent
}

const assembledIntents = new WeakMap<Agent, AssembledIntentEntry>()

/**
 * Read the model-selection intent captured by the latest prompt assembly.
 * @param agent - Agent whose process-local assembled intent is requested.
 * @returns a detached intent snapshot, or `undefined` when none is installed and assembled.
 */
export function assembledModelSelectionIntent(agent: Agent): ModelSelectionIntent | undefined {
  const entry = assembledIntents.get(agent)
  return entry === undefined ? undefined : { ...entry.intent }
}

/**
 * Couple one mutable selection to Agent-scoped prompt assembly and request routing.
 * Prompt assembly snapshots the selected model before delegating, then applies
 * its provider/model pair and effort to request config so a
 * concurrent switch takes effect on a later step instead of splitting the two
 * surfaces. An absent selected effort clears any inherited effort, restoring
 * the selected model's provider/default behavior.
 *
 * @param agentCtx - The selected Agent's scoped context.
 * @param selection - Mutable selection owned by the calling entry point.
 * @returns Disposer for both scoped waterfall listeners.
 */
export function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const agent = agentCtx.agent
  let active = true
  let lifecycleGeneration = 0
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assemblyGeneration = lifecycleGeneration
    const assembled = await next()
    if (!active || assemblyGeneration !== lifecycleGeneration) return assembled
    selection.assembled = selected === undefined ? undefined : { ...selected }
    if (agent !== undefined) {
      if (selection.assembled === undefined) {
        if (assembledIntents.get(agent)?.owner === selection) assembledIntents.delete(agent)
      } else {
        assembledIntents.set(agent, { owner: selection, intent: selection.assembled })
      }
    }
    if (selected === undefined) return assembled
    const logical = selected.kind === 'auto'
      ? { provider: 'auto', model: 'auto' }
      : { provider: selected.provider, model: selected.model }
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        ...logical,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined || selected.kind === 'auto') return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
      }
    },
  )
  return () => {
    if (!active) return
    active = false
    lifecycleGeneration += 1
    disposeAssembly()
    disposeRequest()
    selection.assembled = undefined
    if (agent !== undefined && assembledIntents.get(agent)?.owner === selection) assembledIntents.delete(agent)
  }
}
