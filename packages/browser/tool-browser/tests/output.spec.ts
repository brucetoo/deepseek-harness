import { describe, expect, it } from 'vitest'
import { projectBrowserObservation } from '../src/output.ts'

describe('projectBrowserObservation', () => {
  it('returns empty fields when even one UTF-8 code point exceeds each field budget', () => {
    expect(projectBrowserObservation({
      url: '页',
      title: '页',
      snapshot: '页',
    }, 1)).toEqual({
      url: '',
      title: '',
      snapshot: '',
      truncated: true,
    })
  })
})
