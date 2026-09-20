import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'

describe('ModelHub bundle', () => {
  it('imports the pi-ai adapter only through its package entrypoint', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const source = readFileSync(resolve(root, 'src/index.ts'), 'utf8')

    expect(source).not.toContain('@deepseek-ai/dsh-llm-pi-ai/src/')
  })

  it('ships one secret-free provider row through its manifest', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new TypeError('ModelHub bundle patch must be a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'llm-modelhub',
      name: '@deepseek-ai/dsh-llm-modelhub',
      config: {
        endpoint: 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl',
        apiKeyEnv: 'AIDP_MODELHUB_AK',
        models: [
          { id: 'gpt-5.6-sol' },
          { id: 'gpt-5.5-2026-04-24' },
        ],
      },
    })
    expect(JSON.stringify(rows[0])).not.toContain('ak=')
  })
})
