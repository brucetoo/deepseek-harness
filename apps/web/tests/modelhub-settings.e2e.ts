// Web e2e scenario: the optional ModelHub Host plugin joins the real Models
// settings page as a shipped direct provider. Its key remains write-only, its
// exact endpoint and model catalog use the direct-provider editor, and the row
// carries no custom-route tag. No model request is issued.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import * as ModelHub from '@deepseek-ai/dsh-llm-modelhub'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/modelhub-settings', import.meta.url))
const EDITOR_EXPECTED = join(SNAPSHOT_DIR, 'editor.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: ModelHub uses the direct-provider settings editor', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await scaffold.ctx.plugin(ModelHub, {
      endpoint: 'https://modelhub.example/api/modelhub/online/v2/crawl',
      apiKeyEnv: 'MODELHUB_UI_AK',
      defaultContextWindow: 262_144,
      defaultMaxTokens: 32_768,
      models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', input: ['text'] }],
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('stores the key and edits the exact endpoint without labeling the route custom', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-modelhub-settings'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型' }).click()

    await dialog.getByRole('button', { name: '编辑 ByteDance ModelHub (bytedance-modelhub)' }).click()
    const key = dialog.getByRole('textbox', { name: 'API 密钥', exact: true })
    await key.waitFor({ timeout: 10_000 })
    await key.fill('modelhub-e2e-key')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByRole('img', { name: 'API 密钥已配置' }).waitFor({ timeout: 10_000 })

    const row = dialog.locator('li').filter({ hasText: 'ByteDance ModelHub' }).first()
    expect(await row.getByText('自定义', { exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: '编辑 ByteDance ModelHub (bytedance-modelhub)' }).click()
    await dialog.getByText('自定义设置').click()
    const endpoint = dialog.getByLabel('API 地址')
    await endpoint.waitFor({ timeout: 10_000 })
    expect(await endpoint.getAttribute('placeholder'))
      .toBe('https://modelhub.example/api/modelhub/online/v2/crawl')
    expect(await dialog.getByLabel('模型 ID 1').inputValue()).toBe('gpt-5.6-sol')

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EDITOR_EXPECTED, snapshot, MODE)

    await endpoint.fill('https://next.modelhub.example/exact')
    await dialog.getByLabel('显示名称 1').fill('ModelHub Sol')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 ByteDance ModelHub (bytedance-modelhub)。', { exact: true })
      .waitFor({ timeout: 10_000 })
    const settings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('endpoint: https://next.modelhub.example/exact')
    expect(settings).toContain('name: ModelHub Sol')
    expect(settings).not.toContain('modelhub-e2e-key')
    expect(await page.content()).not.toContain('modelhub-e2e-key')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['editor.expected.md'])
  })
})
