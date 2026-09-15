---
name: office-xlsx
description: Create formatted Excel workbooks as XLSX files. Use when the user asks for a spreadsheet, tracker, table export, calculation sheet, or editable workbook.
---

# Create An XLSX

Create a JSON specification, run the bundled generator, then register the finished file.

Use this structure:

```json
{
  "author": "Optional author",
  "sheets": [
    {
      "name": "Summary",
      "columns": [
        { "header": "Item", "width": 24 },
        { "header": "Amount", "width": 14 }
      ],
      "rows": [
        ["Example", 42],
        ["Total", { "formula": "SUM(B2:B2)", "result": 42 }]
      ],
      "freezeHeader": true,
      "autoFilter": true
    }
  ]
}
```

Run the generator from the target workspace. Prefer stdin so no temporary specification becomes a user deliverable:

```bash
"$DEEPSEEK_HARNESS_DESKTOP_NODE" "$DEEPSEEK_HARNESS_BUNDLED_SKILL_DIR/office-xlsx/scripts/create-workbook.mjs" \
  --output "output.xlsx" <<'JSON'
{...}
JSON
```

Every row must have exactly as many cells as `columns`. Formula cells require both `formula` and a non-error cached `result`; never return `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, or `#NAME?`. Use formulas for calculated values instead of hardcoding the calculation result alone. After a successful command, call `register_artifact` with the exact output path so the desktop Results view records it. Mention that same path in the final response.
