# @deepseek-ai/dsh-browser-playwright-electron

English | [中文](README.zh.md)

Desktop Service Provider for [`@deepseek-ai/dsh-browser`](../browser/README.md). It launches the packaged Electron executable in a dedicated worker mode, discovers its random loopback CDP endpoint from bounded startup output, and connects `playwright-core` to the worker's single page.

## Runtime

Each `open` creates a private temporary Chromium profile and one visible hardened window. The worker denies permissions, downloads, uploads through webviews, child windows, non-Web navigation, and unapproved top-level origins. A correlated stdin/stdout protocol acknowledges permit installation and revocation and reports blocked destinations. Unused permits are revoked when the approved action settles; failed revocation closes the worker. Before acting, the retained element must still match its approved accessible role/name and DOM fingerprint.

Provider disposal, Agent disposal, cancellation, explicit close, worker exit, and failed launch converge on cleanup. Driver cleanup has a deadline and cannot delay worker termination. Ownership remains reserved until the process tree exits and the profile is removed, including when descendants exit after a close timeout. Driver cleanup errors remain visible but do not retain ownership after process and profile cleanup succeeds.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `electronExecutable` | required | Packaged Electron executable path |
| `applicationEntry` | required | Desktop application entry passed to Electron |
| `tempRoot` | required | Parent directory for ephemeral browser profiles |
| `launchTimeoutMs` | `10000` | Worker readiness deadline |
| `operationTimeoutMs` | `10000` | Playwright and worker-protocol deadline |
| `navigationSettleMs` | `50` | Post-operation interval before navigation-policy inspection |
| `cleanupTimeoutMs` | `5000` | Driver cleanup and process-tree quiescence deadline |
| `processGraceMs` | `2000` | Worker termination grace |
| `readinessMaxBytes` | `16384` | Startup and protocol line bound |
| `snapshotDepth` | `8` | Maximum ARIA snapshot depth |

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-browser`; this Provider returns URL, title, and ARIA state but registers no prompt or tool schema.

#### KV Cache effect

No direct invalidation; the Consumer owns model-request changes.

## Known Limitations and Deferred Work

- CDP is unauthenticated on a random loopback port, so another process running as the same OS user could attach while a task is active.
- ARIA snapshots cannot represent canvas-only or unlabeled interfaces, and cancelled top-level navigation may leave an operable but empty document.
- The Provider uses the Electron-bundled Chromium rather than a separately pinned Playwright browser, so Electron or Playwright upgrades require the real compatibility smoke.
