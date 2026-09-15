# Agent Note: Desktop public-web browser automation

Status: proposed

English | [中文](2026-09-16-desktop-public-browser-automation.zh.md)

## Problem

The desktop application can search and fetch public pages through the [bundled `browser-research` workflow](../../implemented/feature/2026-09-15-desktop-bundled-workflows.md), but it cannot operate a rendered page. Tasks that require following controls, entering ordinary form values, selecting options, or checking a resulting page therefore stop at research even when the user can see and complete the interaction manually.

Adding browser control also introduces authority that HTTP retrieval does not carry. A controlled page can hold private text, run scripts, contact other origins, submit state-changing requests, and retain credentials. Browser observations become model-visible tool results and therefore enter the durable Session log. The first implementation must provide useful interaction without claiming safe authentication, arbitrary browser control, or persistence it cannot yet defend.

## Proposal

Add a desktop-only browser capability seam with three independently owned roles:

- `@deepseek-ai/dsh-browser` defines the browser runtime, typed operations, owner identity, prepared-action lifecycle, page observations, and error taxonomy.
- `@deepseek-ai/dsh-browser-playwright-electron` provides the runtime through Playwright and the Electron executable already carried by the desktop application.
- `@deepseek-ai/dsh-tool-browser` contributes model-facing browser tools, approval requests, output bounds, prompt guidance, and tool presentation.

The desktop sidecar passes explicit Electron executable, application entry, and temporary-data root paths. Conditional Host and Agent-Preset rows mount the provider and Consumer only when those values exist; ordinary CLI, Web, headless, and SDK compositions do not expose browser tools.

The initial tool set is `browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_select`, `browser_wait`, and `browser_close`. Model-supplied targets use accessible role, accessible name, and an optional index. CSS, XPath, coordinates, arbitrary JavaScript, tabs, screenshots, uploads, downloads, and popup control are absent.

## Execution model

The provider pins `playwright-core` and connects through its public `chromium.connectOverCDP` API. It launches the packaged Electron executable in a dedicated browser-worker mode through `ctx.subprocess`; the worker binds Chromium debugging to `127.0.0.1` on an operating-system-assigned port and creates one visible hardened `BrowserWindow`. The provider parses the bounded readiness output, connects, and never publishes a stable endpoint.

One DSH Session owns the browser at a time. Opening creates a new worker with a private temporary profile. Another Session receives `BROWSER_BUSY` until the owner closes the visible browser and process-tree cleanup reaches quiescence. Browser state never transfers between Sessions or application launches: cookies, local storage, IndexedDB, caches, service workers, and HTTP authentication data disappear with the temporary profile.

Every successful open or action returns the current URL, title, and an ARIA snapshot. The snapshot uses a configured Playwright depth and timeout, then the Consumer caps the complete UTF-8 tool result and marks truncation. The model follows an observe-one-action-observe loop instead of chaining assumptions about page state.

## Authorization and target identity

`browser_open`, `browser_click`, `browser_fill`, and `browser_select` request one-shot approval before committing. Only the exact `allowed-once` outcome permits execution. Rejection, cancellation, unavailability, malformed answers, policy `never`, timeout, or provider failure releases any prepared state and performs no browser action.

Approval text names the current URL and exact target. It includes a statically visible link or form destination, selected option, or complete fill value. Password controls are rejected before approval. The approval text also states that supplied values and subsequent page observations enter Session history.

For element actions, the provider resolves one exact element before approval and records its observable tag, type, accessible identity, link target, and form target. Immediately before commit it requires the same attached element and matching fingerprint. A changed or detached element fails; the provider never resolves the selector again after approval. Script-installed behavior can still change without an observable fingerprint change and remains a stated risk.

## Navigation and lifecycle

The worker permits only credential-free HTTP and HTTPS top-level URLs. `browser_open` admits its exact origin and same-origin redirects. A prepared click or form action may admit an inspected cross-origin destination for that action; every other cross-origin top-level navigation is blocked and reports the attempted URL plus whether the current page remains usable. Cross-origin subresources remain available because ordinary public pages require them.

The window disables Node integration, enables context isolation and the Chromium sandbox, denies permission requests, child windows, downloads, and file chooser uploads, and rejects non-Web top-level navigation. The browser is not an authentication carrier: the bundled skill rejects tasks that need login, secrets, private pages, uploads, downloads, popups, screenshots, or unsupported visual/coordinate interaction before opening it.

Provider calls serialize. Approval waits use the tool execution signal. `browser_close`, visible-window closure, `agent/disposed`, Consumer disposal, provider disposal, cancellation, failed launch, renderer or worker crash, and CDP disconnect all converge on one teardown operation. Teardown terminates the complete process tree, removes the temporary profile, and releases ownership only after quiescence; no path silently retries or transfers ownership.

## Verification

Package tests cover ownership, busy and closing states, every approval outcome, exact prepared-element identity, fingerprint drift, password rejection, URL validation, redirect and cross-origin policy, popup/download/upload denial, output bounds, cancellation, crash recovery, and idempotent teardown. A Loader test boots the real three-package composition and proves registration and disposal.

A keyless assembled scenario drives a deterministic local public form through the real model/tool/session path, including approval decisions and the visible observe-act-observe transcript. Packaged macOS and native Windows tests launch the actual browser worker, while an Electron or Playwright version change must pass the same compatibility smoke.

## Alternatives considered

**Bundle Playwright Chromium.** This follows Playwright's primary browser path but adds another large browser payload plus download, integrity, cache, and platform-release ownership when Electron already carries a compatible Chromium runtime.

**Mount Playwright MCP or the agent CLI.** Those products provide broad browser tools but bypass this repository's approval audit, canonical tool results, Session logging, UI presentation, and package lifecycle. They also require a separately distributed browser.

**Drive Electron `webContents` and the DOM directly.** This would hand-roll locator resolution, actionability, waiting, accessibility snapshots, and cancellation behavior already maintained by Playwright.

**Reuse a persistent browser profile.** Login reuse reduces friction but lets a later Session inherit prior cookies and storage, complicates profile locking and crash recovery, and expands the impact of the temporary CDP listener. Authentication requires a separate design.

**Use Playwright's experimental Electron launcher with a custom executable.** Its custom-executable path does not inject Playwright's Electron loader, so adopting it would depend on a private bootstrap protocol rather than the documented CDP client.

## Acceptance criteria

- Desktop sessions expose the seven browser tools; non-desktop compositions expose none.
- A model can open a local fixture, observe it, complete an approved public form interaction, verify the resulting page, and close the browser through durable tool calls.
- Every non-`allowed-once` approval outcome executes no action.
- Unsupported protocols, credentials, passwords, popups, permissions, downloads, uploads, and unapproved top-level origins fail closed.
- Concurrent Sessions cannot observe or control each other's page, and every terminal lifecycle path removes the worker and temporary profile before releasing ownership.
- Model-visible output always reports URL, title, truncation, and enough current ARIA state to choose the next supported action.
- Unit, Loader, assembled, packaged macOS, and native Windows evidence cover their stated layers.

## Risks

The ephemeral CDP listener is unauthenticated and reachable by another same-user process that discovers its random port while a browser task runs. This local threat is accepted for the first public-page-only implementation; authenticated browsing cannot ship on this transport without a stronger control channel.

ARIA extraction can consume memory before the Consumer applies its byte cap, and accessible role/name targeting cannot operate canvases, unlabeled controls, or visual-only interfaces. Dynamic event handlers can change after approval without changing the recorded element fingerprint. Cross-origin subresources can contact public or private network services. These constraints remain explicit product limits rather than being described as comprehensive browser automation.
