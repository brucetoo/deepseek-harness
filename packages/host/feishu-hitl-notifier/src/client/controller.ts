/** Staged browser controller for the Feishu notifier's atomic configuration. */
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Recipient identifier kinds accepted by the notifier settings form. */
export type RecipientType = 'email' | 'open_id' | 'user_id' | 'chat_id'

/** Persisted identity of one Feishu notification destination. */
export interface Recipient { type: RecipientType; id: string }

/** Complete editable notifier configuration mirrored from Host settings. */
export interface NotifierConfiguration {
  enabled: boolean
  webBaseUrl: string
  summaryMaxChars: number
  includeSessionTitle: boolean
  recipients: Recipient[]
}

/** Browser status for one recipient test attempt. */
export type TestStatus = 'idle' | 'sending' | 'sent' | 'busy' | 'not-configured' | 'delivery-failed' | 'request-failed'

/** Editable recipient plus browser-local row identity and test status. */
export interface RecipientRow extends Recipient { key: string; testStatus: TestStatus }

/** Reactive state rendered by the Feishu settings card. */
export interface FeishuCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  saving: boolean
  invalid: boolean
  error: string | null
  draft: NotifierConfiguration
  rows: RecipientRow[]
}

/** Store and actions injected into the Feishu settings card. */
export interface FeishuCardFace {
  hooks: { feishuCard: SnapshotStore<FeishuCardState> }
  setEnabled(value: boolean): void
  editWebBaseUrl(value: string): void
  editSummaryMaxChars(value: string): void
  setIncludeSessionTitle(value: boolean): void
  addRecipient(): void
  removeRecipient(key: string): void
  editRecipient(key: string, field: 'type' | 'id', value: string): void
  save(): Promise<void>
  discard(): void
  test(key: string): Promise<void>
  canTest(key: string): { allowed: boolean; reason?: string; warning?: boolean }
}

type SettingsApi = Pick<IApiClient, 'settings'>
type DescribeFace = { acceptView(view: SettingsNamespaceView): void }
type TestRecipient = (recipient: Recipient) => Promise<
  { ok: true; value: { status: string } } | { ok: false; error: { message: string } }
>
const NS = 'feishu-hitl-notifier'
const EMPTY: NotifierConfiguration = { enabled: false, webBaseUrl: '', summaryMaxChars: 240, includeSessionTitle: true, recipients: [] }

function copy(value: NotifierConfiguration): NotifierConfiguration {
  return { ...value, recipients: value.recipients.map(recipient => ({ ...recipient })) }
}
function cleanMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)
  return text.replace(/<[^>]*>/gu, '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 240) || 'Request failed'
}
function valid(configuration: NotifierConfiguration): boolean {
  if (Array.from(configuration.webBaseUrl).length > 2048) return false
  try {
    const url = new URL(configuration.webBaseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false
  } catch { return false }
  if (!Number.isInteger(configuration.summaryMaxChars)
    || configuration.summaryMaxChars < 1 || configuration.summaryMaxChars > 1000) return false
  if (configuration.recipients.length > 100 || configuration.enabled && configuration.recipients.length === 0) return false
  const keys = configuration.recipients.map((recipient) => {
    const id = recipient.id.trim()
    return Array.from(id).length >= 1 && Array.from(id).length <= 512
      ? `${recipient.type}:${id}`
      : undefined
  })
  return keys.every(key => key !== undefined) && new Set(keys).size === keys.length
}

/** Owns one draft and writes the complete configuration under one revision fence. */
export class FeishuSettingsController {
  /** Reactive card state consumed by the injected settings component. */
  readonly store: SnapshotStore<FeishuCardState> = createSnapshotStore({
    available: false, writable: false, dirty: false, saving: false, invalid: false,
    error: null, draft: copy(EMPTY), rows: [],
  })
  private saved = copy(EMPTY)
  private editRevision: number | undefined
  private nextKey = 0
  private readonly unsubscribe: () => void

  constructor(
    private readonly scope: SettingsScope<{ configuration: NotifierConfiguration }>,
    private readonly api: SettingsApi,
    private readonly describe: DescribeFace,
    private readonly testRecipient: TestRecipient,
  ) {
    this.unsubscribe = scope.subscribe(() => { this.sync() })
    this.sync()
  }

  private sync(): void {
    const snapshot = this.scope.getSnapshot()
    const current = this.store.getSnapshot()
    const configuration = snapshot.value?.configuration
    if (configuration !== undefined) this.saved = copy(configuration)
    if (current.dirty || configuration === undefined) {
      this.store.set({ ...current, available: snapshot.status === 'ready', writable: snapshot.writable })
      return
    }
    this.store.set({ ...current, available: snapshot.status === 'ready', writable: snapshot.writable, draft: copy(configuration), rows: this.rows(configuration) })
  }

  private rows(configuration: NotifierConfiguration): RecipientRow[] {
    return configuration.recipients.map(recipient => ({ key: `recipient-${this.nextKey++}`, ...recipient, testStatus: 'idle' }))
  }
  private stage(change: (draft: NotifierConfiguration, rows: RecipientRow[]) => void): void {
    const before = this.store.getSnapshot()
    if (!before.writable || before.saving) return
    if (!before.dirty) this.editRevision = this.scope.getSnapshot().revision
    const draft = copy(before.draft)
    const rows = before.rows.map(row => ({ ...row }))
    change(draft, rows)
    draft.recipients = rows.map(({ type, id }) => ({ type, id }))
    this.store.set({ ...before, draft, rows, dirty: true, invalid: !valid(draft), error: null })
  }
  /**
   * Stage the automatic-delivery setting.
   *
   * @param value - whether later admitted questions trigger automatic delivery.
   */
  setEnabled(value: boolean): void { this.stage((draft) => { draft.enabled = value }) }

  /**
   * Stage the session-return URL.
   *
   * @param value - absolute DSH Web URL entered by the operator.
   */
  editWebBaseUrl(value: string): void { this.stage((draft) => { draft.webBaseUrl = value }) }

  /**
   * Stage the question-summary limit.
   *
   * @param value - decimal input for the question-summary code-point limit.
   */
  editSummaryMaxChars(value: string): void { this.stage((draft) => { draft.summaryMaxChars = Number(value) }) }

  /**
   * Stage the session-title inclusion setting.
   *
   * @param value - whether cards include an available session title.
   */
  setIncludeSessionTitle(value: boolean): void { this.stage((draft) => { draft.includeSessionTitle = value }) }

  /** Add one unsaved recipient row when the configured limit allows it. */
  addRecipient(): void {
    this.stage((_draft, rows) => { if (rows.length < 100) rows.push({ key: `recipient-${this.nextKey++}`, type: 'email', id: '', testStatus: 'idle' }) })
  }

  /**
   * Remove one staged recipient when the enabled configuration remains valid.
   *
   * @param key - browser-local identity of the recipient row to remove.
   */
  removeRecipient(key: string): void {
    this.stage((draft, rows) => {
      if (rows.length === 1 && draft.enabled) return
      const index = rows.findIndex(row => row.key === key)
      if (index >= 0) rows.splice(index, 1)
    })
  }

  /**
   * Edit one recipient field and reset its test status.
   *
   * @param key - browser-local identity of the recipient row.
   * @param field - recipient field to replace.
   * @param value - next field value from the form control.
   */
  editRecipient(key: string, field: 'type' | 'id', value: string): void {
    this.stage((_draft, rows) => {
      const row = rows.find(candidate => candidate.key === key)
      if (row === undefined) return
      if (field === 'type') row.type = value as RecipientType
      else row.id = value
      row.testStatus = 'idle'
    })
  }

  /** Replace the draft with the latest saved configuration. */
  discard(): void {
    const before = this.store.getSnapshot()
    if (!before.writable || before.saving) return
    this.editRevision = undefined
    this.store.set({ ...before, draft: copy(this.saved), rows: this.rows(this.saved), dirty: false, invalid: false, error: null })
  }

  /**
   * Persist the complete valid draft under its captured revision.
   *
   * @returns fulfillment after the save succeeds or its sanitized failure enters card state.
   */
  async save(): Promise<void> {
    const before = this.store.getSnapshot()
    if (!before.writable || !before.dirty || before.invalid || before.saving) return
    this.store.set({ ...before, saving: true, error: null })
    try {
      const response = await this.api.settings.mutate({ ns: NS, ops: [{ op: 'set', path: ['configuration'], value: copy(before.draft) }], ...(this.editRevision === undefined ? {} : { expectedRevision: this.editRevision }) })
      if (!response.result.ok) throw new Error(response.result.error.message)
      this.describe.acceptView(response.result.value)
      const committed = (response.result.value.value as { configuration?: NotifierConfiguration } | null)
        ?.configuration
      if (committed === undefined) throw new Error('Settings response did not contain the saved configuration.')
      this.saved = copy(committed)
      this.editRevision = undefined
      this.store.set({
        ...this.store.getSnapshot(),
        saving: false,
        dirty: false,
        draft: copy(committed),
        rows: this.rows(committed),
        error: null,
      })
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), saving: false, error: cleanMessage(error) })
    }
  }

  /**
   * Check whether a row names a saved recipient eligible for a test send.
   *
   * @param key - browser-local identity of the recipient row.
   * @returns admission and any operator-facing reason or disabled-notification warning.
   */
  canTest(key: string): { allowed: boolean; reason?: string; warning?: boolean } {
    const state = this.store.getSnapshot()
    const row = state.rows.find(candidate => candidate.key === key)
    if (!state.writable || row === undefined) return { allowed: false }
    const committed = this.saved.recipients.some(recipient =>
      recipient.type === row.type && recipient.id === row.id)
    if (!committed) return { allowed: false, reason: 'Save this recipient before testing.' }
    return { allowed: true, ...(state.draft.enabled ? {} : { warning: true }) }
  }

  /**
   * Send the fixed test card to a saved recipient and publish its sanitized status.
   *
   * @param key - browser-local identity of the recipient row.
   * @returns fulfillment after the request settles and card state is updated.
   */
  async test(key: string): Promise<void> {
    const gate = this.canTest(key)
    if (!gate.allowed) return
    const before = this.store.getSnapshot()
    const row = before.rows.find(candidate => candidate.key === key)
    if (row === undefined || row.testStatus === 'sending') return
    this.setTest(key, 'sending')
    try {
      const response = await this.testRecipient({ type: row.type, id: row.id })
      if (!response.ok) this.setTest(key, 'request-failed')
      else if (response.value.status === 'sent'
        || response.value.status === 'busy'
        || response.value.status === 'not-configured'
        || response.value.status === 'delivery-failed') this.setTest(key, response.value.status)
      else this.setTest(key, 'request-failed')
    } catch { this.setTest(key, 'request-failed') }
  }
  private setTest(key: string, status: TestStatus): void {
    const before = this.store.getSnapshot()
    this.store.set({ ...before, rows: before.rows.map(row => row.key === key ? { ...row, testStatus: status } : row) })
  }
  /**
   * Build the settings component's store and action facade.
   *
   * @returns the stable store and actions injected into the settings component.
   */
  inject(): FeishuCardFace {
    return {
      hooks: { feishuCard: this.store },
      setEnabled: (value) => { this.setEnabled(value) },
      editWebBaseUrl: (value) => { this.editWebBaseUrl(value) },
      editSummaryMaxChars: (value) => { this.editSummaryMaxChars(value) },
      setIncludeSessionTitle: (value) => { this.setIncludeSessionTitle(value) },
      addRecipient: () => { this.addRecipient() },
      removeRecipient: (key) => { this.removeRecipient(key) },
      editRecipient: (key, field, value) => { this.editRecipient(key, field, value) },
      save: () => this.save(),
      discard: () => { this.discard() },
      test: key => this.test(key),
      canTest: key => this.canTest(key),
    }
  }

  /** Stop mirroring the Host settings scope. */
  dispose(): void { this.unsubscribe() }
}
