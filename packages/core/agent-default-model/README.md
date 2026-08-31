# @deepseek-ai/dsh-agent-default-model

English | [中文](README.zh.md)

The deployment default used when an entry point creates an Agent that has no session-local model selection. `AgentDefaultModelConfig` provides `ctx.agentDefaultModel`; direct entry points such as `dsh --profile headless` and Host-backed entry points such as ApiProxy read the same service instead of owning parallel provider/model defaults.

The plugin config requires `{ provider, model }`. That composition entry becomes `{ kind: 'model', provider, model }` at runtime and forms the base of the `agent-default-model` Settings section. A mounted settings provider layers the user's choice over it, and changes are visible on the next `currentSelection()` read. `reasoningEffort` belongs to the Settings section but deliberately not to plugin config: a complete saved selection can clear an effort when the next selected model has none, while a composition value would be inherited again.

- `ctx.agentDefaultModel.currentSelection()` returns a detached `ModelSelectionIntent`: either `{ kind: 'auto', pool? }` or `{ kind: 'model', provider, model, reasoningEffort? }`.
- `ctx.agentDefaultModel.compositionSelection()` returns the concrete composition entry for APIs that require a physical Agent creation seed even when the logical default is Auto.
- `ctx.agentDefaultModel.saveSelection(intent)` saves the complete discriminated intent. Without a settings provider it is a no-op and the concrete composition entry remains current.

The service does not validate catalog membership. A provider route may serve an unadvertised model, and the consumer that actually opens a model request owns availability diagnostics.

## Model Experience

Indirectly, through the provider/model selection supplied to an entry point; request assembly and adapters own the model-visible request.

#### KV Cache effect

Changing the default affects only Agents that subsequently resolve from it. An existing session whose log already contains `model/selection` keeps that intent, so this service does not invalidate its established prefix.

## Known Limitations and Deferred Work

- The service owns one process-wide default; per-session selection remains the entry point's responsibility.
- Without a settings provider, `saveSelection()` cannot retain a selection for a later Agent.
