import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BrowserElementAction } from '@deepseek-ai/dsh-browser'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import PlaywrightElectronBrowserRuntime from '@deepseek-ai/dsh-browser-playwright-electron'

const desktopApplication = resolve(import.meta.dirname, '../../../../apps/desktop')
const require = createRequire(resolve(desktopApplication, 'package.json'))
const electronExecutable = require('electron') as string

let tempRoot = ''

beforeAll(async () => {
  tempRoot = await mkdtemp(resolve(tmpdir(), 'dsh-browser-electron-smoke-'))
})

afterEach(async () => {
  await rm(tempRoot, { force: true, recursive: true })
})

describe('Electron browser worker compatibility', () => {
  it('opens, fills, submits, observes, closes, and removes its profile', async () => {
    const destinationServer = createServer((_request, response) => {
      response.end('<title>Unexpected destination</title>')
    })
    await new Promise<void>(resolveListen => destinationServer.listen(0, '127.0.0.1', resolveListen))
    const destinationAddress = destinationServer.address()
    if (destinationAddress === null || typeof destinationAddress === 'string') {
      throw new Error('destination fixture server did not bind TCP')
    }
    const destinationUrl = `http://127.0.0.1:${destinationAddress.port}/private`
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html>
        <html><head><title>Browser fixture</title></head><body>
          <label>Query <input id="query"></label>
          <button onclick="document.querySelector('[role=status]').textContent =
            'Submitted: ' + document.querySelector('#query').value">Submit</button>
          <button onclick='location.href = ${JSON.stringify(destinationUrl)}'>Unexpected navigation</button>
          <a href="/next">Same origin</a>
          <a href="${destinationUrl}" onclick="event.preventDefault()">Stay here</a>
          <div role="status">Waiting</div>
          <div id="identity-fixture"></div>
        </body></html>`)
    })
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server did not bind TCP')

    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PlaywrightElectronBrowserRuntime, {
      electronExecutable,
      applicationEntry: desktopApplication,
      tempRoot,
      launchTimeoutMs: 10_000,
      operationTimeoutMs: 5_000,
      navigationSettleMs: 100,
      cleanupTimeoutMs: 5_000,
      processGraceMs: 1_000,
      readinessMaxBytes: 16_384,
      snapshotDepth: 8,
    })
    const owner = { id: 'electron-smoke' } as unknown as Agent
    const connect = vi.spyOn(chromium, 'connectOverCDP')
    try {
      const opened = await ctx.browser.open(owner, {
        url: `http://127.0.0.1:${address.port}/`,
      })
      expect(opened.title).toBe('Browser fixture')
      expect(opened.snapshot).toContain('textbox "Query"')

      const connection = connect.mock.results[0]
      if (connection?.type !== 'return') throw new Error('browser did not connect over CDP')
      const browser = await connection.value
      const page = browser.contexts()[0]?.pages()[0]
      if (page === undefined) throw new Error('browser did not expose its page')
      connect.mockRestore()

      const fill = await ctx.browser.prepare(owner, {
        kind: 'fill',
        target: { role: 'textbox', name: 'Query' },
        value: 'real Electron',
      })
      await ctx.browser.commit(owner, fill.id)

      const click = await ctx.browser.prepare(owner, {
        kind: 'click',
        target: { role: 'button', name: 'Submit' },
      })
      const result = await ctx.browser.commit(owner, click.id)
      expect(result.snapshot).toContain('Submitted: real Electron')

      const clickIdentity: BrowserElementAction = {
        kind: 'click',
        target: { role: 'button', name: 'Review' },
      }
      const identityCases: {
        name: string
        html: string
        action: BrowserElementAction
        mutate: (node: HTMLElement | SVGElement) => void
      }[] = [
        {
          name: 'text accessible name',
          html: '<button id="identity-target" onclick="this.dataset.acted = \'yes\'">Review</button>',
          action: clickIdentity,
          mutate: (node) => { node.textContent = 'Review payment' },
        },
        {
          name: 'aria-label accessible name',
          html: '<button id="identity-target" aria-label="Review" onclick="this.dataset.acted = \'yes\'"></button>',
          action: clickIdentity,
          mutate: (node) => { node.setAttribute('aria-label', 'Delete') },
        },
        {
          name: 'aria-labelledby accessible name',
          html: `<span id="identity-label">Review</span>
            <button id="identity-target" aria-labelledby="identity-label" onclick="this.dataset.acted = 'yes'"></button>`,
          action: clickIdentity,
          mutate: (node) => {
            const label = node.ownerDocument.getElementById('identity-label')
            if (label === null) throw new Error('label fixture is missing')
            label.textContent = 'Delete'
          },
        },
        {
          name: 'associated label accessible name',
          html: `<label id="identity-label" for="identity-target">Review</label>
            <input id="identity-target" oninput="this.dataset.acted = 'yes'">`,
          action: {
            kind: 'fill',
            target: { role: 'textbox', name: 'Review' },
            value: 'must not be entered',
          },
          mutate: (node) => {
            const label = node.ownerDocument.getElementById('identity-label')
            if (label === null) throw new Error('label fixture is missing')
            label.setAttribute('for', 'another-input')
          },
        },
        {
          name: 'explicit role',
          html: '<button id="identity-target" onclick="this.dataset.acted = \'yes\'">Review</button>',
          action: clickIdentity,
          mutate: (node) => { node.setAttribute('role', 'link') },
        },
        {
          name: 'implicit role',
          html: `<select id="identity-target" aria-label="Review" onchange="this.dataset.acted = 'yes'">
            <option>One</option><option>Two</option></select>`,
          action: {
            kind: 'select',
            target: { role: 'combobox', name: 'Review' },
            option: 'Two',
          },
          mutate: (node) => { node.setAttribute('multiple', '') },
        },
        {
          name: 'replacement with original accessible identity',
          html: '<button id="identity-target" onclick="this.dataset.acted = \'yes\'">Review</button>',
          action: clickIdentity,
          mutate: (node) => {
            const replacement = node.cloneNode(true) as HTMLElement
            replacement.id = 'identity-replacement'
            node.before(replacement)
            node.textContent = 'Delete'
          },
        },
      ]
      const fixture = page.locator('#identity-fixture')
      for (const testCase of identityCases) {
        await fixture.evaluate((node, html) => { node.innerHTML = html }, testCase.html)
        const prepared = await ctx.browser.prepare(owner, testCase.action)
        await page.locator('#identity-target').evaluate(testCase.mutate)

        await expect.soft(ctx.browser.commit(owner, prepared.id), testCase.name).rejects.toMatchObject({
          code: 'BROWSER_TARGET_CHANGED',
        })
        expect.soft(await fixture.locator('[data-acted]').count(), testCase.name).toBe(0)
      }

      await fixture.evaluate((node) => {
        node.innerHTML = '<button id="identity-target" onclick="this.dataset.acted = \'yes\'">Review</button>'
      })
      const retained = await ctx.browser.prepare(owner, {
        kind: 'click',
        target: { role: 'button', name: 'Review', index: 0 },
      })
      await page.locator('#identity-target').evaluate((node) => {
        const replacement = node.cloneNode(true) as HTMLElement
        replacement.id = 'identity-replacement'
        node.before(replacement)
      })
      await ctx.browser.commit(owner, retained.id)
      expect(await page.locator('#identity-target').getAttribute('data-acted')).toBe('yes')
      expect(await page.locator('#identity-replacement').getAttribute('data-acted')).toBeNull()

      const sameOrigin = await ctx.browser.prepare(owner, {
        kind: 'click',
        target: { role: 'link', name: 'Same origin' },
      })
      await ctx.browser.commit(owner, sameOrigin.id)
      expect(page.url()).toBe(`http://127.0.0.1:${address.port}/next`)

      const stay = await ctx.browser.prepare(owner, {
        kind: 'click',
        target: { role: 'link', name: 'Stay here' },
      })
      await ctx.browser.commit(owner, stay.id)

      const blockedClick = await ctx.browser.prepare(owner, {
        kind: 'click',
        target: { role: 'button', name: 'Unexpected navigation' },
      })
      await expect(ctx.browser.commit(owner, blockedClick.id)).rejects.toMatchObject({
        code: 'BROWSER_NAVIGATION_BLOCKED',
      })
      const recovered = await ctx.browser.snapshot(owner)
      expect(recovered.url).toMatch(/^http:\/\/127\.0\.0\.1:/u)
      expect(typeof recovered.snapshot).toBe('string')

      await ctx.browser.close(owner)
      expect(await readdir(tempRoot)).toEqual([])
    } finally {
      connect.mockRestore()
      await ctx.fiber.dispose()
      await new Promise<void>(resolveClose => server.close(() =>{  resolveClose() }))
      await new Promise<void>(resolveClose => destinationServer.close(() =>{  resolveClose() }))
    }
  }, 30_000)
})
