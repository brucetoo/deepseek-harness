import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, mkdir } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import ExcelJS from 'exceljs'

const args = process.argv.slice(2)
const FORMULA_ERROR = /^#(?:REF!|DIV\/0!|VALUE!|N\/A|NAME\?)$/

function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function fail(message) {
  throw new Error(`office-xlsx: ${message}`)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`)
  return value
}

async function inputText() {
  const specPath = option('--spec')
  if (specPath !== undefined) return readFile(resolve(specPath), 'utf8')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function cellValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  const formula = record(value, label)
  const expression = nonEmpty(formula.formula, `${label}.formula`)
  const result = formula.result
  if (!['string', 'number', 'boolean'].includes(typeof result) || FORMULA_ERROR.test(String(result))) {
    fail(`${label}.result must be a non-error string, number, or boolean`)
  }
  return { formula: expression.startsWith('=') ? expression.slice(1) : expression, result }
}

function addSheet(workbook, value, sheetIndex) {
  const spec = record(value, `sheets[${sheetIndex}]`)
  const name = nonEmpty(spec.name, `sheets[${sheetIndex}].name`)
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    fail(`sheets[${sheetIndex}].columns must be a non-empty array`)
  }
  const columns = spec.columns.map((column, columnIndex) => {
    if (typeof column === 'string') {
      return { header: nonEmpty(column, `sheets[${sheetIndex}].columns[${columnIndex}]`) }
    }
    const item = record(column, `sheets[${sheetIndex}].columns[${columnIndex}]`)
    const width = item.width
    if (width !== undefined && (typeof width !== 'number' || width < 4 || width > 80)) {
      fail(`sheets[${sheetIndex}].columns[${columnIndex}].width must be between 4 and 80`)
    }
    return {
      header: nonEmpty(item.header, `sheets[${sheetIndex}].columns[${columnIndex}].header`),
      ...(width === undefined ? {} : { width }),
    }
  })
  if (!Array.isArray(spec.rows)) fail(`sheets[${sheetIndex}].rows must be an array`)
  const sheet = workbook.addWorksheet(name, {
    views: spec.freezeHeader === false ? [] : [{ state: 'frozen', ySplit: 1 }],
  })
  sheet.columns = columns.map(column => ({
    header: column.header,
    key: column.header,
    width: column.width ?? Math.min(40, Math.max(12, column.header.length + 4)),
  }))
  for (const [rowIndex, row] of spec.rows.entries()) {
    if (!Array.isArray(row) || row.length !== columns.length) {
      fail(`sheets[${sheetIndex}].rows[${rowIndex}] must have ${columns.length} cells`)
    }
    sheet.addRow(row.map((cell, columnIndex) =>
      cellValue(cell, `sheets[${sheetIndex}].rows[${rowIndex}][${columnIndex}]`)))
  }
  const header = sheet.getRow(1)
  header.height = 24
  header.font = { bold: true, color: { argb: 'FF1B1D21' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EDF2' } }
  header.alignment = { vertical: 'middle' }
  sheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: 'top', wrapText: true }
    row.eachCell((cell) => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFD9DDE3' } },
      }
      if (rowNumber > 1 && cell.type === ExcelJS.ValueType.Formula) {
        cell.font = { color: { argb: 'FF000000' } }
      }
    })
  })
  if (spec.autoFilter !== false) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    }
  }
}

async function main() {
  const output = option('--output')
  if (output === undefined) fail('--output is required')
  const outputPath = resolve(output)
  if (extname(outputPath).toLowerCase() !== '.xlsx') fail('--output must end in .xlsx')
  let input
  try {
    input = JSON.parse(await inputText())
  } catch (error) {
    fail(`spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const spec = record(input, 'spec')
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
    fail('sheets must be a non-empty array')
  }
  const workbook = new ExcelJS.Workbook()
  workbook.creator = typeof spec.author === 'string' ? spec.author : 'DeepSeek Harness'
  workbook.created = new Date()
  spec.sheets.forEach((sheet, index) => addSheet(workbook, sheet, index))
  await mkdir(dirname(outputPath), { recursive: true })
  const temporary = `${outputPath}.${randomUUID()}.tmp`
  try {
    await workbook.xlsx.writeFile(temporary)
    await rename(temporary, outputPath)
  } finally {
    await rm(temporary, { force: true })
  }
  const size = (await readFile(outputPath)).length
  process.stdout.write(`${JSON.stringify({ path: output, bytes: size, type: 'xlsx' })}\n`)
}

await main()
