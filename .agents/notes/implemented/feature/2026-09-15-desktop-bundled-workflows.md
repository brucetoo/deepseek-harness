# Agent Note: desktop-bundled document and research workflows

Status: implemented

English | [中文](2026-09-15-desktop-bundled-workflows.zh.md)

## Problem

The Electron application carries a self-contained Host, but a fresh installation has no reliable procedure for producing editable Office files. User-level skills and system Python or Node packages vary by machine. The existing web tools retrieve public pages, but their low-level search and fetch operations do not define a repeatable research-to-deliverable workflow.

Binary files also bypass the text mutation tools whose presentation `locations` feed the produced-files UI. Inferring outputs from terminal text or directory scans cannot distinguish intended deliverables from temporary or unrelated files.

## Decision

The desktop runtime ships three read-only bundled skills under its deploy root: `office-docx`, `office-xlsx`, and `browser-research`. Electron passes that directory as `DSH_BUNDLED_SKILL_DIR`; the existing filesystem skill provider loads it at bundled rank. The sidecar also receives `DEEPSEEK_HARNESS_DESKTOP_NODE` and `DEEPSEEK_HARNESS_BUNDLED_SKILL_DIR` for shell commands. These names stay outside the managed `DSH_*` namespace that shell execution rebuilds per call, so the subprocess scrub preserves the exact staged executable and skill path without treating ambient values as trusted session facts.

The DOCX generator uses the maintained `docx` package and accepts a bounded document vocabulary of title, subtitle, sections, paragraphs, real Word lists, and tables. The XLSX generator uses `exceljs` and accepts worksheets, columns, rows, optional frozen headers and filters, plus formulas that carry a non-error cached result. Both parse JSON from a file or stdin, validate required fields, write beside the requested output through a temporary file, and publish only a `.docx` or `.xlsx` target.

The browser research skill composes the existing `web_search`, `web_fetch`, and `write` tools. It requires primary-source preference, claim cross-checking when possible, inline citations, and a local Markdown report. It explicitly does not claim interactive browser control.

`register_artifact` is the durable handoff for binary producers. The agent-scoped filesystem tool suite owns it, so the process-global tool layer remains empty and presets that omit `dsh-tool-fs` do not inherit the tool or its prompt. It resolves a workspace-relative path through `ctx.fs`, requires an existing regular file, records the filesystem observation, and publishes an edit-kind presentation location. The ordinary tool log therefore reconstructs both the completed registration and the Results UI without another persistence format.

Staging rejects a runtime missing any bundled skill entry, generator script, or the `docx` and `exceljs` dependencies. The scripts resolve those packages from the deployed `app/node_modules` tree.

## Alternatives considered

**Depend on Python, LibreOffice, or globally installed npm packages.** This produces richer editing and recalculation options, but makes a clean desktop installation host-dependent and breaks the self-contained packaging requirement.

**Build OOXML archives directly.** DOCX and XLSX are ZIP-based formats, but hand-written XML duplicates maintained libraries and increases corruption and compatibility risk.

**Infer deliverables from Bash output or workspace scans.** Terminal text has no authoritative path format, and workspace diffs race unrelated writers. Explicit registration identifies the intended existing file.

**Treat web search as browser automation.** Search and HTTP retrieval cover research, not login, click, form, upload, or visual interaction semantics. Keeping the names separate prevents the product from promising an unsupported control path.

## Verification

Unit tests execute both generators through Node. DOCX verification unpacks the archive and checks document text, numbering, and tables. XLSX verification reloads the workbook and checks frozen headers, filters, formulas, cached results, and formula-error rejection. Desktop lifecycle tests pin the injected paths, while stage tests require every skill, script, and runtime dependency. Client tests cover cross-Turn aggregation, ordering, history paging, file opening, registration, and plugin disposal; assembled composition coverage pins the model-visible tool and prompt.

## Consequences

A packaged desktop installation can create new DOCX and XLSX deliverables and turn web research into a cited Markdown file without external language runtimes. Generated binaries appear in the same durable Results view as text files after explicit registration.

The first Office vocabulary intentionally does not edit existing documents, render previews, recalculate formulas through an Office engine, or generate PPTX. Browser research does not control an interactive browser. Those capabilities require separate providers rather than hidden assumptions in these skills.
