import { describe, expect, it } from 'vitest'
import {
  BrowserError,
  BrowserPreparedActionId,
  parsePublicBrowserUrl,
} from '../src/index.ts'

describe('parsePublicBrowserUrl', () => {
  it('accepts credential-free HTTP and HTTPS URLs and returns their canonical form', () => {
    expect(parsePublicBrowserUrl('https://example.com/a b?q=1#result')).toBe(
      'https://example.com/a%20b?q=1#result',
    )
    expect(parsePublicBrowserUrl('http://127.0.0.1:4173/form')).toBe(
      'http://127.0.0.1:4173/form',
    )
  })

  it.each([
    'file:///tmp/private.txt',
    'javascript:alert(1)',
    'https://user@example.com/',
    'https://user:secret@example.com/',
    'not a URL',
  ])('rejects an unsupported or credential-bearing URL: %s', (value) => {
    expect(() => parsePublicBrowserUrl(value)).toThrow(
      expect.objectContaining({ code: 'BROWSER_INVALID_URL' }),
    )
  })
})

describe('BrowserPreparedActionId', () => {
  it('brands a provider-issued action identity without changing its value', () => {
    expect(BrowserPreparedActionId('prepared-1')).toBe('prepared-1')
  })
})

describe('BrowserError', () => {
  it('carries a stable machine-routable code and cause', () => {
    const cause = new Error('worker closed')
    const error = new BrowserError('browser unavailable', 'BROWSER_UNAVAILABLE', { cause })

    expect(error.name).toBe('BrowserError')
    expect(error.code).toBe('BROWSER_UNAVAILABLE')
    expect(error.cause).toBe(cause)
  })
})
