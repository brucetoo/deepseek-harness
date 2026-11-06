/** Browser contribution for the Feishu HITL notifier. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import remoteContribution from '@deepseek-ai/dsh-feishu-hitl-notifier/remote'
import { FeishuSettingsCard } from './FeishuSettingsCard.tsx'
import {
  FeishuSettingsController, type NotifierConfiguration, type Recipient,
} from './controller.ts'

export const inject = ['slots', 'remote', 'configForms']

/** Mount the package-local generated Remote namespace and settings card. */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(remoteContribution)
  ctx.effect(() => async () => { await disposeRemote() }, 'feishu-hitl-notifier: generated client remote')
  ctx.inject([
    'slots', 'configForms', 'remote.feishuHitlNotifier',
  ], (injectedCtx: ClientContext) => {
    const scope = injectedCtx.configForms.get<{ configuration: NotifierConfiguration }>('feishu-hitl-notifier')
    const controller = new FeishuSettingsController(
      scope,
      (recipient: Recipient) => injectedCtx.remote.feishuHitlNotifier.testRecipient(recipient),
    )
    injectedCtx.effect(() => () => { controller.dispose() }, 'feishu-hitl-notifier: settings controller')
    injectedCtx.effect(() => injectedCtx.configForms.whileServed(
      ['feishu-hitl-notifier'],
      () => injectedCtx.slots.inject('plugins.item', () => injectedCtx.slots.register({
        name: 'plugins.item',
        id: 'feishu-hitl-notifier',
        order: 60,
        label: () => 'Feishu HITL',
        inject: () => controller.inject(),
      }, FeishuSettingsCard)),
    ), 'feishu-hitl-notifier: settings page')
  })
}
