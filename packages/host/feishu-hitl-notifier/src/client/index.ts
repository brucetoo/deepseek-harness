/** Browser contribution for the Feishu HITL notifier. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import remoteContribution from '@deepseek-ai/dsh-feishu-hitl-notifier/remote'
import { FeishuSettingsCard } from './FeishuSettingsCard.tsx'
import {
  FeishuSettingsController, type NotifierConfiguration, type Recipient,
} from './controller.ts'

export const inject = ['slots', 'connection', 'remote', 'settingsScope']

/** Mount the package-local generated Remote namespace and settings card. */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(remoteContribution)
  ctx.effect(() => async () => { await disposeRemote() }, 'feishu-hitl-notifier: generated client remote')
  ctx.inject([
    'slots', 'connection', 'settingsScope', 'remote.feishuHitlNotifier',
  ], (injectedCtx: ClientContext) => {
    const { api } = injectedCtx.get('connection') as ConnectionHandle
    const scope = injectedCtx.settingsScope.bind<{ configuration: NotifierConfiguration }>({
      namespace: 'feishu-hitl-notifier',
    })
    const controller = new FeishuSettingsController(
      scope,
      api,
      injectedCtx.settingsScope.describe(),
      (recipient: Recipient) => injectedCtx.remote.feishuHitlNotifier.testRecipient(recipient),
    )
    injectedCtx.effect(() => () => { controller.dispose() }, 'feishu-hitl-notifier: settings controller')
    injectedCtx.slots.inject('settings.plugin.item', () => injectedCtx.slots.register({
      name: 'settings.plugin.item', key: 'feishu-hitl-notifier', inject: () => controller.inject(),
    }, FeishuSettingsCard))
  })
}
