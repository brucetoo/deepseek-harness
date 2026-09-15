import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BrowserPlaywrightElectronInvariant from '../src/invariant.ts'

describe('browser-playwright-electron invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(BrowserPlaywrightElectronInvariant)

    expect(BrowserPlaywrightElectronInvariant.name).toBe(
      'browser-playwright-electron-invariant',
    )
    expect(BrowserPlaywrightElectronInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-browser-playwright-electron', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
