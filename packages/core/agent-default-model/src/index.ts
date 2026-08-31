/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelectionIntent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = settingsNamespace('agent-default-model')

/** Stored concrete default model selection. */
export interface ConcreteAgentDefaultModelSettings {
  /** Concrete-selection discriminant. */
  kind: 'model'
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Stored automatic default model selection. */
export interface AutoAgentDefaultModelSettings {
  /** Automatic-selection discriminant. */
  kind: 'auto'
  /** Optional router-owned candidate pool. */
  pool?: string
}

/** Stored and composed default model-selection intent. */
export type AgentDefaultModelSettings = ConcreteAgentDefaultModelSettings | AutoAgentDefaultModelSettings

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.union([
  z.object({ kind: z.const('auto').required(), pool: z.string() }),
  z.object({
    kind: z.const('model').required(),
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  }),
])

/** Composition entry for the default model selection. */
export interface Config {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: AgentDefaultModelSettings): ModelSelectionIntent {
  if (settings.kind === 'auto') return { kind: 'auto', ...settings.pool === undefined ? {} : { pool: settings.pool } }
  return {
    kind: 'model',
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })

  private source: () => AgentDefaultModelSettings
  private readonly entry: ConcreteAgentDefaultModelSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentDefaultModel')
    const entry: ConcreteAgentDefaultModelSettings = { kind: 'model', provider: config.provider, model: config.model }
    this.entry = entry
    this.source = () => entry
    installSettingsSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      // Every consumer reads through currentSelection(), so no registration-level fact
      // needs rebuilding when the settings document changes.
      onChange: () => {},
    })
  }

  /**
   * Read the current default model selection.
   * @returns a detached logical model-selection intent.
   */
  currentSelection(): ModelSelectionIntent {
    return selection(this.source())
  }

  /**
   * Read the deployment's concrete Agent creation fallback.
   * @returns a detached concrete composition selection.
   */
  compositionSelection(): ModelSelectionIntent & { kind: 'model' } {
    return selection(this.entry) as ModelSelectionIntent & { kind: 'model' }
  }

  /**
   * Save the complete default model selection. A deployment without a settings
   * provider keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelectionIntent): Promise<void> {
    await this.ctx.get('settings')?.replace(
      AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE,
      next.kind === 'auto'
        ? { kind: 'auto', ...next.pool === undefined ? {} : { pool: next.pool } }
        : {
          kind: 'model',
          provider: next.provider,
          model: next.model,
          ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
        },
    )
  }
}

export default AgentDefaultModelConfig
