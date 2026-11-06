/** Shared concrete-selection construction for both model picker entries. */
import type { ModelCatalogModel, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Build a concrete intent with the effective effort shown by both pickers.
 * @param current - current logical selection.
 * @param provider - selected provider route.
 * @param model - selected catalog model.
 * @returns concrete intent preserving the current explicit effort on the same route, otherwise using the model default.
 */
export function concreteSelection(
  current: ModelSelection | null,
  provider: string,
  model: ModelCatalogModel,
): ModelSelection {
  const sameRoute = current?.provider === provider
    && current.model === model.id
  const reasoningEffort = sameRoute
    ? current.reasoningEffort ?? model.reasoning?.defaultEffort
    : model.reasoning?.defaultEffort
  return {
    provider,
    model: model.id,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}
