/** Session-wide deliverables registry derived from durable mutation events. */

import type {
  ConversationTimelineSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { basename } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './DeliverablesView.module.css'

/** One file's session-wide production history. */
export interface SessionDeliverable {
  readonly path: string
  readonly firstTurn: number
  readonly lastTurn: number
  readonly lastSeq: number
}

/** Host actions owned by the deliverables view registration. */
export interface DeliverablesViewInjected {
  readonly openFile: (path: string) => Promise<void>
  readonly loadOlder: () => Promise<void>
}

/** Props supplied by the conversation view slot and deliverables registration. */
export type DeliverablesViewProps = Pick<ConvViewProps, 'useSession'>
  & InjectFace<DeliverablesViewInjected>
  & PropsLocale<typeof NS>

/**
 * Collect unique produced files from the currently loaded Session timeline.
 * The latest successful mutation wins ordering and last-turn metadata.
 * @param timeline - Engine-owned Turn locations and plugin-published data.
 * @returns Unique files ordered from most to least recently modified.
 */
export function collectSessionDeliverables(
  timeline: ConversationTimelineSnapshot,
): readonly SessionDeliverable[] {
  const byPath = new Map<string, SessionDeliverable>()
  for (const turnNumber of timeline.turnOrder) {
    const turn = timeline.turns.get(turnNumber)
    const produced = turn?.data.get('deliverables')?.produced ?? []
    for (const item of produced) {
      const prior = byPath.get(item.path)
      byPath.set(item.path, {
        path: item.path,
        firstTurn: prior?.firstTurn ?? turnNumber,
        lastTurn: turnNumber,
        lastSeq: item.seq,
      })
    }
  }
  return [...byPath.values()].sort((left, right) => right.lastSeq - left.lastSeq)
}

/**
 * Render all produced files currently available in one Session history.
 * @param props - Session selector, Host actions, and localized copy.
 * @returns The deliverables registry view.
 */
export function DeliverablesView({
  useSession,
  openFile,
  loadOlder,
  t,
}: DeliverablesViewProps) {
  const files = useSession(snapshot => collectSessionDeliverables(snapshot.chat.timeline))
  const hasMore = useSession(snapshot => snapshot.hasMore)
  const loadingOlder = useSession(snapshot => snapshot.loadingOlder)

  return (
    <section className={css.root} aria-labelledby="deliverables-title">
      <header className={css.header}>
        <div>
          <h2 id="deliverables-title" className={css.title}>{t('view.title')}</h2>
          <p className={css.count}>{t('view.count', { count: String(files.length) })}</p>
        </div>
        {hasMore && (
          <button
            type="button"
            className={css.loadOlder}
            disabled={loadingOlder}
            onClick={() => { void loadOlder() }}
          >
            {loadingOlder ? t('view.loadingOlder') : t('view.loadOlder')}
          </button>
        )}
      </header>
      {files.length === 0 ? (
        <p className={css.empty}>{t('view.empty')}</p>
      ) : (
        <ul className={css.list}>
          {files.map(file => (
            <li key={file.path} className={css.item}>
              <button
                type="button"
                className={css.file}
                title={file.path}
                aria-label={t('produced.open', { name: file.path })}
                onClick={() => { void openFile(file.path) }}
              >
                <span className={css.name}>{basename(file.path)}</span>
                <span className={css.path}>{file.path}</span>
              </button>
              <span className={css.turn}>{t('view.turn', { turn: String(file.lastTurn) })}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
