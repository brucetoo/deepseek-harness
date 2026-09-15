import { describe, expect, it } from 'vitest'
import {
  APP_ORIGIN,
  APP_WEBSOCKET_ORIGIN,
  authorizeRequestHeaders,
  classifyNavigation,
} from '../src/security.ts'

describe('desktop request authorization', () => {
  it.each([
    `${APP_ORIGIN}/api/sessions?active=true`,
    `${APP_WEBSOCKET_ORIGIN}/api/events`,
  ])('adds the bearer token for the exact application endpoint %s', (url) => {
    expect(authorizeRequestHeaders(url, {
      Accept: 'application/json',
    }, 'desktop-token')).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer desktop-token',
    })
  })

  it('replaces every existing authorization spelling on the application origin', () => {
    expect(authorizeRequestHeaders(
      APP_ORIGIN,
      {
        authorization: 'Bearer stale-lower',
        Authorization: 'Bearer stale-title',
        'X-Desktop': 'preserved',
      },
      'fresh-token',
    )).toEqual({
      Authorization: 'Bearer fresh-token',
      'X-Desktop': 'preserved',
    })
  })

  it.each([
    'http://127.0.0.1/',
    'http://127.0.0.1:37614/',
    'http://127.0.0.1:37616/',
    'https://127.0.0.1:37615/',
    'wss://127.0.0.1:37615/',
    'ftp://127.0.0.1:37615/',
    'http://localhost:37615/',
    'ws://localhost:37615/',
    'http://user:password@127.0.0.1:37615/',
    'ws://user:password@127.0.0.1:37615/',
    'not a URL',
  ])('does not authorize %s', (url) => {
    const headers = {
      authorization: 'Bearer unrelated',
      'X-Desktop': 'preserved',
    }

    expect(authorizeRequestHeaders(url, headers, 'desktop-token')).toEqual(headers)
  })

  it('evaluates each redirect destination instead of trusting the initial request', () => {
    const initialHeaders = authorizeRequestHeaders(
      `${APP_ORIGIN}/redirect`,
      {},
      'desktop-token',
    )
    const redirectedHeaders = authorizeRequestHeaders(
      'https://example.com/destination',
      {},
      'desktop-token',
    )

    expect(initialHeaders).toEqual({ Authorization: 'Bearer desktop-token' })
    expect(redirectedHeaders).toEqual({})
  })
})

describe('desktop navigation policy', () => {
  it.each([
    APP_ORIGIN,
    `${APP_ORIGIN}/`,
    `${APP_ORIGIN}/settings?tab=models#provider`,
  ])('keeps %s inside the application', (url) => {
    expect(classifyNavigation(url)).toBe('allow-in-app')
  })

  it.each([
    'http://example.com/',
    'https://example.com/path',
  ])('opens explicit external Web URL %s outside the application', (url) => {
    expect(classifyNavigation(url)).toBe('open-external')
  })

  it.each([
    'file:///tmp/secret',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'dsh://settings',
    'http://user:password@127.0.0.1:37615/',
    'not a URL',
  ])('denies unsafe navigation to %s', (url) => {
    expect(classifyNavigation(url)).toBe('deny')
  })
})
