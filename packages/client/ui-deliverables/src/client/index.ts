/**
 * Deliverables plugin, browser half: registers the produced-files row into
 * the chat view's turn-tail chain, and provides the `chatFileMentions`
 * service that links inline-code mentions of produced files in the closing
 * prose. All policy lives here — the derivation from the mutation tools'
 * `locations`, the mention matching, the chip cap, and the copy — so
 * composing this plugin out of cordis.yml removes both surfaces entirely;
 * the owning view renders an empty chain and inert prose at zero cost.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  resolveWorkspacePath,
  type ClientContext,
  type ISessions,
  type IWorkspaces,
  type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatFileMentions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DeliverablesView, type DeliverablesViewInjected } from './DeliverablesView.tsx'
import { ProducedFiles } from './ProducedFiles.tsx'
import { en, NS, zh, type DeliverablesKey } from './locales.ts'
import {
  deliverablesDefinition, producedFileMentions, selectProducedFiles,
} from './turn-deliverables.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Produced-files row copy. */
    'deliverables': DeliverablesKey
  }
}

export {
  collectSessionDeliverables,
  DeliverablesView,
  type DeliverablesViewInjected,
  type DeliverablesViewProps,
  type SessionDeliverable,
} from './DeliverablesView.tsx'
export { ProducedFiles, type ProducedFilesProps } from './ProducedFiles.tsx'
export { producedForClosing } from './turn-deliverables.ts'

/** Required services for the tail-slot registration and its dictionaries. */
export const inject = [
  'slots',
  'locale',
  'conversationEvents',
  'connection',
  'sessions',
  'workspaces',
]

/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
  ctx.conversationEvents.register(deliverablesDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: selectProducedFiles,
      locale: NS,
      inject: () => ({
        isLoopback: connection.isLoopback,
        hooks: { hostDescription: connection.hostDescription },
      }),
    }, ProducedFiles),
  )
  ctx.slots.inject(
    'conversation.view',
    () => ctx.slots.register({
      name: 'conversation.view',
      id: 'deliverables',
      order: 20,
      locale: NS,
      label: () => t('view.tab'),
      inject: (sessionId: SessionId): DeliverablesViewInjected => {
        const session = sessions.binding(sessionId)?.session
        if (session === undefined) {
          throw new Error(`ui-deliverables: session "${sessionId}" is unavailable`)
        }
        return {
          openFile: (path) => {
            const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
            return workspaces.openPath(resolveWorkspacePath(cwd, path))
          },
          loadOlder: async () => {
            await session.loadOlder()
          },
        }
      },
    }, DeliverablesView),
  )
  // The prose side of the same vocabulary: the chat view reaches this face
  // via ctx.get, so its absence — this plugin composed out — is the off state.
  const mentions: ChatFileMentions = {
    forClosing(owner) {
      // Same claim test the turn-tail chain entry runs: no produced files,
      // no vocabulary — the two surfaces agree by construction.
      const paths = selectProducedFiles(owner)
      if (paths === null) return undefined
      return producedFileMentions(paths, owner.openFile, path => t('produced.open', { name: path }))
    },
  }
  ctx.provide('chatFileMentions', mentions)
}
