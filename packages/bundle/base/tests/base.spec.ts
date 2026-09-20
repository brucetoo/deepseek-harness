/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.filter(row => row.id === 'llm-auto-router')).toEqual([
      { id: 'llm-auto-router', name: '@deepseek-ai/dsh-llm-auto-router' },
    ])
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-llm-auto-router', 'workspace:^')
    expect(rows.find(row => row.id === 'agent-default-model')).toMatchObject({
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'DISABLED'",
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-claude-code')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })

  it('gates the browser provider and every shipped preset on the same desktop paths', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const repositoryRoot = resolve(root, '../../..')
    const parseRows = (path: string): Record<string, unknown>[] => {
      const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
      if (!Array.isArray(parsed)) throw new TypeError(`${path} must parse to an entry list`)
      return parsed.flatMap((entry): Record<string, unknown>[] => {
        if (typeof entry !== 'object' || entry === null) return []
        return 'insert' in entry
          ? (entry as { insert?: Record<string, unknown>[] }).insert ?? []
          : [entry as Record<string, unknown>]
      })
    }
    const host = parseRows(resolve(root, 'cordis.patch.yml'))
      .find(row => row.id === 'browser-playwright-electron')
    if (host === undefined) throw new Error('base patch must mount browser-playwright-electron')
    const presetRows = ['standard', 'code', 'cordis'].map((preset) => {
      const rows = parseRows(resolve(repositoryRoot, 'apps/cli/config/agent-presets', preset, 'agent.cordis.yml'))
      const row = rows.find(candidate => candidate.id === 'tool-browser')
      if (row === undefined) throw new Error(`${preset} preset must mount tool-browser`)
      return row
    })
    const rows = [host, ...presetRows]
    const off = { process: { env: {} } }
    const on = {
      process: {
        env: {
          DSH_BROWSER_ELECTRON_EXECUTABLE: '/Applications/Electron',
          DSH_BROWSER_APPLICATION_ENTRY: '/Applications/App/app.asar',
          DSH_BROWSER_TEMP_ROOT: '/tmp/dsh-browser',
        },
      },
    }
    for (const row of rows) {
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${String(row.id)} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate(off, expression)), `${String(row.id)} without desktop paths`).toBe(true)
      expect(Boolean(evaluate(on, expression)), `${String(row.id)} with desktop paths`).toBe(false)
    }
    expect(new Set(rows.map(row =>
      (row.disabled as { __jsExpr: string }).__jsExpr,
    ))).toHaveLength(1)
  })
})
