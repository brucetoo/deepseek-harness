import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BrowserInvariant from '../src/invariant.ts'

describe('browser invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(BrowserInvariant)

    expect(BrowserInvariant.name).toBe('browser-invariant')
    expect(BrowserInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-browser', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
