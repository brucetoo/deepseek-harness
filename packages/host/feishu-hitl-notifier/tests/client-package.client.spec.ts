import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('client package publication', () => {
  it('publishes and builds the browser client with required dynamic dependencies', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>
      files: string[]
      dsh: { client: { platform: string; inject: string[] } }
      scripts: { bundle: string }
    }
    expect(pkg.exports['./client']).toEqual({ types: './lib/types/client/index.d.ts', default: './lib/client.js' })
    expect(pkg.files).toContain('lib/client.js')
    expect(pkg.dsh.client).toMatchObject({ platform: 'web' })
    expect(pkg.dsh.client.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes',
    ]))
    expect(pkg.scripts.bundle).toBe('tsdown')
  })
})
