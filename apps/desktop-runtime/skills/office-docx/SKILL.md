---
name: office-docx
description: Create polished Word documents as DOCX files. Use when the user asks for a report, memo, brief, proposal, or other editable Word deliverable.
---

# Create A DOCX

Create a JSON specification, run the bundled generator, then register the finished file.

Use this structure:

```json
{
  "title": "Required document title",
  "subtitle": "Optional subtitle",
  "author": "Optional author",
  "sections": [
    {
      "heading": "Optional section heading",
      "paragraphs": ["One paragraph per array item."],
      "bullets": ["Optional real Word list item"],
      "table": {
        "headers": ["Column A", "Column B"],
        "rows": [["Value A", "Value B"]]
      }
    }
  ]
}
```

Run the generator from the target workspace. Prefer stdin so no temporary specification becomes a user deliverable:

```bash
"$DEEPSEEK_HARNESS_DESKTOP_NODE" "$DEEPSEEK_HARNESS_BUNDLED_SKILL_DIR/office-docx/scripts/create-document.mjs" \
  --output "output.docx" <<'JSON'
{...}
JSON
```

Use a `.docx` output path. Keep each paragraph as a separate array item; do not embed newline characters. Use `bullets` for lists and `table` for tabular content. After a successful command, call `register_artifact` with the exact output path so the desktop Results view records it. Mention that same path in the final response.
