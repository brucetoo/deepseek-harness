# Desktop application

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` packages the existing React application and a self-contained plain-Node Host as an Electron application. Electron owns the window, the Host sidecar, local authentication, and application shutdown; product behavior remains in the existing Host and client plugins.

> **Note:** The desktop application is a preview. Packaging produces unsigned macOS arm64 and Windows x64 developer artifacts.

## Commands

- `pnpm run desktop:dev` rebuilds and validates the sidecar stage, then launches Electron from the checkout.
- `pnpm run desktop:stage` publishes a validated immutable sidecar version under `apps/desktop/.stage/versions/` and updates the atomic `apps/desktop/.stage/current` pointer.
- `pnpm run desktop:package:mac` runs on macOS arm64 and writes the application bundle, ZIP archive, and `SHA256SUMS` under `apps/desktop/dist/`.
- `pnpm run desktop:package:win` runs on Windows x64 and writes the assisted NSIS installer, ZIP archive, and `SHA256SUMS` under `apps/desktop/dist/`.

The stage and packaged artifacts are ignored build output.

## Runtime

The Electron main process starts the bundled Node executable with the staged `dsh web` entry on `127.0.0.1:37615`. Each launch creates a 256-bit bearer token. The Host requires that token for every HTTP request and WebSocket upgrade, while the Electron session injects it only for the exact application origin.

The `BrowserWindow` disables Node integration, enables context isolation and the Chromium sandbox, exposes no preload bridge, denies child windows, and prevents navigation away from the application origin. Explicit external HTTP and HTTPS links open through the operating system.

The application permits one instance. A second launch focuses the existing window. Closing the last window begins bounded sidecar shutdown before Electron exits. Desktop data uses Electron's `userData` directory under its `dsh/` child and does not read the user's CLI `$DSH_HOME`.

## Built-in workflows

The packaged sidecar exposes its exact Node executable and read-only `app/skills` directory to the skill provider. The desktop application includes `office-docx`, `office-xlsx`, and `browser-research`. The Office skills run bundled JavaScript generators with packaged `docx` and `exceljs` dependencies, then use `register_artifact` to place the binary output in the Session's **Deliverables** view. Browser research composes the existing `web_search`, `web_fetch`, and text-file tools into a cited Markdown deliverable.

The **Deliverables** view reconstructs its registry from durable successful mutation and registration calls. It contains no separate database: reload and history paging replay the same Session events, and file actions use the existing workspace-aware Host opener.

## Staging and packaging

[`apps/desktop-runtime`](../desktop-runtime/package.json) is the explicit pnpm deploy root for every runtime and peer dependency needed by the Web composition. Staging builds the repository, creates a production deployment with workspace packages injected as files, copies the current Node executable, and validates required assets, generated Remote modules, native imports, Node version, executable mode, symlink containment, and a checkout-independent CLI smoke run.

Each stage records the source commit, lockfile SHA-256 digest, Node version, platform, and architecture. Packaging accepts only a validated stage that exactly matches its native `darwin-arm64` or `win32-x64` target, places it outside ASAR as `Resources/sidecar`, and uses the pinned local Electron distribution. Windows CI verifies checksums, expands the ZIP, silently installs the NSIS package, checks the embedded sidecar target, launches the installed application until the React page is ready, closes its window, and confirms the sidecar listener exits.

## Limitations

- The fixed port fails loud when another process already owns `37615`.
- The macOS artifact is unsigned and unnotarized. The Windows artifact is unsigned.
- Signing, updates, tray behavior, and background execution after the last window closes are not implemented.
- Browser research retrieves and synthesizes pages but does not click, fill, authenticate, or control an interactive browser session.
- The bundled Office workflows create new DOCX and XLSX files. Editing existing Office documents, recalculating workbook formulas through an Office engine, and PPTX generation are not implemented.
- The desktop carrier uses authenticated loopback HTTP and WebSocket traffic. It does not provide TLS and does not use an Electron IPC transport.
