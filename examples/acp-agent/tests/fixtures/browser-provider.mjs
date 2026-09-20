import BrowserRuntime, {
  BrowserError,
  BrowserPreparedActionId,
  parsePublicBrowserUrl,
} from '@deepseek-ai/dsh-browser'

const pageUrl = 'https://example.test/form'

const snapshot = state => ({
  url: pageUrl,
  title: 'Public form',
  snapshot: [
    '- heading "Public form"',
    `- textbox "Query": ${state.value}`,
    '- button "Submit"',
    `- status: ${state.submitted ? `Submitted: ${state.value}` : 'Waiting'}`,
  ].join('\n'),
})

/** Deterministic Provider used by the assembled keyless browser snapshot. */
export default class BrowserFixtureRuntime extends BrowserRuntime {
  instance
  nextId = 0

  open(owner, request) {
    const url = parsePublicBrowserUrl(request.url)
    if (url !== pageUrl) throw new BrowserError('fixture URL mismatch', 'BROWSER_FIXTURE_URL')
    this.instance = { owner, value: '', submitted: false, prepared: new Map() }
    return Promise.resolve(snapshot(this.instance))
  }

  snapshot(owner) {
    return Promise.resolve(snapshot(this.owned(owner)))
  }

  prepare(owner, action) {
    const state = this.owned(owner)
    const valid = (action.kind === 'fill' && action.target.role === 'textbox' && action.target.name === 'Query')
      || (action.kind === 'click' && action.target.role === 'button' && action.target.name === 'Submit')
    if (!valid) throw new BrowserError('fixture target mismatch', 'BROWSER_TARGET_MISSING')
    const id = BrowserPreparedActionId(`fixture-action-${++this.nextId}`)
    const fingerprint = {
      tagName: action.kind === 'fill' ? 'input' : 'button',
      role: action.target.role,
      accessibleName: action.target.name,
    }
    state.prepared.set(id, action)
    return Promise.resolve({ id, owner, pageUrl, action, fingerprint })
  }

  commit(owner, id) {
    const state = this.owned(owner)
    const action = state.prepared.get(id)
    if (action === undefined) {
      throw new BrowserError('fixture prepared action is missing', 'BROWSER_PREPARED_ACTION_MISSING')
    }
    state.prepared.delete(id)
    if (action.kind === 'fill') state.value = action.value
    if (action.kind === 'click') state.submitted = true
    return Promise.resolve(snapshot(state))
  }

  release(owner, id) {
    this.owned(owner).prepared.delete(id)
    return Promise.resolve()
  }

  wait(owner) {
    return Promise.resolve(snapshot(this.owned(owner)))
  }

  close(owner) {
    if (this.instance?.owner === owner) this.instance = undefined
    return Promise.resolve()
  }

  owned(owner) {
    if (this.instance === undefined) {
      throw new BrowserError('fixture browser is not open', 'BROWSER_NOT_OPEN')
    }
    if (this.instance.owner !== owner) {
      throw new BrowserError('fixture browser belongs to another Session', 'BROWSER_FOREIGN_OWNER')
    }
    return this.instance
  }
}
