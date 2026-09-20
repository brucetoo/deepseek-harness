import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'

const runtimeRoot = fileURLToPath(new URL('../../desktop-runtime', import.meta.url))
const docxScript = join(runtimeRoot, 'skills/office-docx/scripts/create-document.mjs')
const xlsxScript = join(runtimeRoot, 'skills/office-xlsx/scripts/create-workbook.mjs')
const roots: string[] = []

const fixtureRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-office-skills-'))
  roots.push(root)
  return root
}

const runFailure = (script: string, output: string, spec: unknown) =>
  spawnSync(process.execPath, [script, '--output', output], {
    cwd: fixtureRoot(),
    input: JSON.stringify(spec),
    encoding: 'utf8',
  })

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('bundled Office generators', () => {
  it('creates a readable DOCX with headings, real list numbering, and a table', () => {
    const root = fixtureRoot()
    const output = join(root, 'report.docx')
    const stdout = execFileSync(process.execPath, [docxScript, '--output', output], {
      cwd: root,
      input: JSON.stringify({
        title: 'Quarterly Review',
        subtitle: 'Prepared for Operations',
        sections: [{
          heading: 'Highlights',
          paragraphs: ['Revenue increased while support volume declined.'],
          bullets: ['Retain the current rollout plan', 'Review costs monthly'],
          table: {
            headers: ['Metric', 'Value'],
            rows: [['Revenue', '42'], ['Tickets', '18']],
          },
        }],
      }),
      encoding: 'utf8',
    })
    const archive = unzipSync(readFileSync(output))
    const document = strFromU8(archive['word/document.xml']!)
    const numbering = strFromU8(archive['word/numbering.xml']!)

    expect(JSON.parse(stdout)).toMatchObject({ path: output, type: 'docx' })
    expect(document).toContain('Quarterly Review')
    expect(document).toContain('Revenue increased while support volume declined.')
    expect(document).toContain('Retain the current rollout plan')
    expect(document).toContain('Metric')
    expect(numbering).toContain('w:numFmt w:val="bullet"')
  })

  it('creates a styled XLSX with frozen headers, filters, and cached formula results', async () => {
    const root = fixtureRoot()
    const output = join(root, 'summary.xlsx')
    const stdout = execFileSync(process.execPath, [xlsxScript, '--output', output], {
      cwd: root,
      input: JSON.stringify({
        author: 'Operations',
        sheets: [{
          name: 'Summary',
          columns: [{ header: 'Item', width: 24 }, { header: 'Amount', width: 14 }],
          rows: [
            ['Revenue', 42],
            ['Total', { formula: 'SUM(B2:B2)', result: 42 }],
          ],
        }],
      }),
      encoding: 'utf8',
    })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(output)
    const sheet = workbook.getWorksheet('Summary')!

    expect(JSON.parse(stdout)).toMatchObject({ path: output, type: 'xlsx' })
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(sheet.autoFilter).toBe('A1:B1')
    expect(sheet.getCell('B3').value).toEqual({ formula: 'SUM(B2:B2)', result: 42 })
    expect(sheet.getCell('A1').font?.bold).toBe(true)
  })

  it('rejects formula error results before writing an XLSX', () => {
    const output = join(fixtureRoot(), 'broken.xlsx')
    const result = runFailure(xlsxScript, output, {
      sheets: [{
        name: 'Summary',
        columns: ['Value'],
        rows: [[{ formula: '1/0', result: '#DIV/0!' }]],
      }],
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('result must be a non-error string, number, or boolean')
  })
})
