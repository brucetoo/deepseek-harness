import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as browserProvider from '@deepseek-ai/dsh-browser-playwright-electron'
import * as toolBrowser from '@deepseek-ai/dsh-tool-browser'

describe('desktop browser real-load-path guard', () => {
  it('unwraps and mounts the Service Provider and Consumer through Loader semantics', async () => {
    const loader = Object.create(Loader.prototype) as Loader
    const provider = loader.unwrapExports(browserProvider) as Parameters<Context['plugin']>[0]
    const consumer = loader.unwrapExports(toolBrowser) as Parameters<Context['plugin']>[0]
    expect(provider).toBe(browserProvider.default)
    expect((provider as { inject?: unknown }).inject).toEqual(['subprocess'])
    expect(consumer).toBe(toolBrowser)
    expect(toolBrowser.inject).toEqual(['tools', 'browser', 'approval', 'systemPrompt'])

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(LocalSubprocessRuntime)
    const providerFiber = await ctx.plugin(provider, {
      electronExecutable: '/Applications/Electron',
      applicationEntry: '/Applications/App/app.asar',
      tempRoot: '/tmp/dsh-browser',
    })
    const consumerFiber = await ctx.plugin(consumer)

    expect(ctx.get('browser')).toBeDefined()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('browser_'))).toHaveLength(7)

    await consumerFiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('browser_'))).toEqual([])
    await providerFiber.dispose()
    expect(ctx.get('browser')).toBeUndefined()
  })
})
