/** Accessible card for editing and testing Feishu notification recipients. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FeishuCardFace } from './controller.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import css from './FeishuSettingsCard.module.css'

export type FeishuSettingsCardProps = PropsRuntime<'settings.plugin.item'> & InjectFace<FeishuCardFace>
const TYPES = [['email', 'Email'], ['open_id', 'Open ID'], ['user_id', 'User ID'], ['chat_id', 'Group chat ID']] as const

/** Render the Feishu notifier configuration card. */
export function FeishuSettingsCard(props: FeishuSettingsCardProps) {
  const state = props.useFeishuCard(value => value)
  const [open, setOpen] = useState(true)
  const newInput = useRef<HTMLInputElement>(null)
  const previousCount = useRef(state.rows.length)
  useEffect(() => {
    if (state.rows.length > previousCount.current) newInput.current?.focus()
    previousCount.current = state.rows.length
  }, [state.rows.length])
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  return <li className={css.card}>
    <button type="button" className={css.header} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
      <span><strong>Feishu HITL notifier</strong><small>Send a Feishu card when DSH needs human input.</small></span>
      <span className={css.badges}>{state.dirty ? <b>Unsaved</b> : null}{state.error ? <b>Error</b> : null}</span>
    </button>
    {open ? <div className={css.body}>
      {!state.writable ? <p role="status">Read-only settings</p> : null}
      {state.error ? <p role="alert" className={css.error}>{state.error}</p> : null}
      <label className={css.check}><input type="checkbox" checked={state.draft.enabled} disabled={disabled} onChange={(event) => { props.setEnabled(event.currentTarget.checked) }} /> Enabled</label>
      <label>Web URL<input type="url" value={state.draft.webBaseUrl} disabled={disabled} aria-invalid={state.invalid} onChange={(event) => { props.editWebBaseUrl(event.currentTarget.value) }} /></label>
      <label>Summary max chars<input type="number" min="1" value={state.draft.summaryMaxChars} disabled={disabled} onChange={(event) => { props.editSummaryMaxChars(event.currentTarget.value) }} /></label>
      <label className={css.check}><input type="checkbox" checked={state.draft.includeSessionTitle} disabled={disabled} onChange={(event) => { props.setIncludeSessionTitle(event.currentTarget.checked) }} /> Include title</label>
      <fieldset disabled={disabled}><legend>Recipients</legend>
        {state.rows.map((row, index) => {
          const gate = props.canTest(row.key)
          return <div className={css.row} key={row.key}>
            <label>Type<select disabled={disabled} value={row.type} onChange={(event) => { props.editRecipient(row.key, 'type', event.currentTarget.value) }}>{TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label>ID<input disabled={disabled} ref={index === state.rows.length - 1 ? newInput : undefined} value={row.id} onChange={(event) => { props.editRecipient(row.key, 'id', event.currentTarget.value) }} /></label>
            <button type="button" disabled={disabled || !gate.allowed || row.testStatus === 'sending'} title={gate.reason} onClick={() => { void props.test(row.key) }}>Test</button>
            <button type="button" aria-label="Remove recipient" disabled={disabled || state.rows.length === 1 && state.draft.enabled} onClick={() => { props.removeRecipient(row.key) }}>Remove</button>
            <span aria-live="polite" role="status">{{
              idle: gate.reason ?? '', sending: 'Sending', sent: 'Test sent', busy: 'A test is already running',
              'not-configured': 'Save this recipient before testing',
              'delivery-failed': 'Feishu delivery failed', 'request-failed': 'Test request failed',
            }[row.testStatus]}</span>
          </div>
        })}
        <button type="button" disabled={disabled || state.rows.length >= 100} onClick={() => { props.addRecipient() }}>Add</button>
      </fieldset>
      {!state.draft.enabled
        ? <p className={css.warning}>Testing sends a real Feishu message even while automatic notifications are disabled.</p>
        : null}
      <div className={css.actions}>
        <button type="button" disabled={disabled || !state.dirty} onClick={props.discard}>Discard</button>
        <button
          type="button"
          disabled={disabled || !state.dirty || state.invalid}
          onClick={() => { void props.save() }}
        >
          {state.saving ? 'Saving' : 'Save'}
        </button>
      </div>
    </div> : null}
  </li>
}
