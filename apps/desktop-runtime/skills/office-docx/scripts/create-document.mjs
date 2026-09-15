import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  PageNumber,
  Paragraph,
  Packer,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx'

const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function fail(message) {
  throw new Error(`office-docx: ${message}`)
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value
}

function string(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`)
  return value
}

function strings(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    fail(`${label} must be an array of strings`)
  }
  return value
}

async function inputText() {
  const specPath = option('--spec')
  if (specPath !== undefined) return readFile(resolve(specPath), 'utf8')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function tableFrom(value, sectionIndex) {
  const table = record(value, `sections[${sectionIndex}].table`)
  const headers = strings(table.headers, `sections[${sectionIndex}].table.headers`)
  if (headers.length === 0) fail(`sections[${sectionIndex}].table.headers must not be empty`)
  if (!Array.isArray(table.rows)) fail(`sections[${sectionIndex}].table.rows must be an array`)
  const rows = table.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== headers.length) {
      fail(`sections[${sectionIndex}].table.rows[${rowIndex}] must have ${headers.length} cells`)
    }
    return row.map(cell => cell === null ? '' : String(cell))
  })
  const width = Math.floor(9360 / headers.length)
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'D9DDE3' }
  const borders = { top: border, bottom: border, left: border, right: border }
  const cell = (text, heading = false) => new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: heading ? { fill: 'EEF1F5', type: ShadingType.CLEAR } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      children: [new TextRun({ text, bold: heading, size: 20 })],
      spacing: { before: 40, after: 40 },
    })],
  })
  return new Table({
    columnWidths: headers.map(() => width),
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map(value => cell(value, true)) }),
      ...rows.map(row => new TableRow({ children: row.map(value => cell(value)) })),
    ],
  })
}

function documentFrom(input) {
  const spec = record(input, 'spec')
  const title = string(spec.title, 'title')
  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    fail('sections must be a non-empty array')
  }
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      children: [new TextRun(title)],
    }),
  ]
  if (typeof spec.subtitle === 'string' && spec.subtitle.trim() !== '') {
    children.push(new Paragraph({
      children: [new TextRun({ text: spec.subtitle, color: '5F6670', size: 22 })],
      spacing: { after: 260 },
    }))
  }
  spec.sections.forEach((value, sectionIndex) => {
    const section = record(value, `sections[${sectionIndex}]`)
    if (section.heading !== undefined) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun(string(section.heading, `sections[${sectionIndex}].heading`))],
      }))
    }
    for (const paragraph of strings(section.paragraphs, `sections[${sectionIndex}].paragraphs`)) {
      children.push(new Paragraph({
        children: [new TextRun(paragraph)],
        spacing: { after: 140, line: 300 },
      }))
    }
    for (const bullet of strings(section.bullets, `sections[${sectionIndex}].bullets`)) {
      children.push(new Paragraph({
        numbering: { reference: 'document-bullets', level: 0 },
        children: [new TextRun(bullet)],
        spacing: { after: 80 },
      }))
    }
    if (section.table !== undefined) {
      children.push(tableFrom(section.table, sectionIndex))
      children.push(new Paragraph({ children: [new TextRun('')] }))
    }
  })
  return new Document({
    creator: typeof spec.author === 'string' ? spec.author : 'DeepSeek Harness',
    title,
    styles: {
      default: { document: { run: { font: 'Arial', size: 22, color: '17191C' } } },
      paragraphStyles: [
        {
          id: 'Title',
          name: 'Title',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: 'Arial', size: 44, bold: true, color: '17191C' },
          paragraph: { spacing: { before: 120, after: 100 }, outlineLevel: 0 },
        },
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: 'Arial', size: 28, bold: true, color: '17191C' },
          paragraph: { spacing: { before: 260, after: 120 }, outlineLevel: 0 },
        },
      ],
    },
    numbering: {
      config: [{
        reference: 'document-bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '\u2022',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: title, color: '7A8088', size: 18 }),
              new TextRun({ text: '  |  ', color: 'A3A8AF', size: 18 }),
              new TextRun({ children: [PageNumber.CURRENT], color: '7A8088', size: 18 }),
            ],
          })],
        }),
      },
      children,
    }],
  })
}

async function main() {
  const output = option('--output')
  if (output === undefined) fail('--output is required')
  const outputPath = resolve(output)
  if (extname(outputPath).toLowerCase() !== '.docx') fail('--output must end in .docx')
  let input
  try {
    input = JSON.parse(await inputText())
  } catch (error) {
    fail(`spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const bytes = await Packer.toBuffer(documentFrom(input))
  await mkdir(dirname(outputPath), { recursive: true })
  const temporary = `${outputPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, outputPath)
  } finally {
    await rm(temporary, { force: true })
  }
  process.stdout.write(`${JSON.stringify({ path: output, bytes: bytes.length, type: 'docx' })}\n`)
}

await main()
