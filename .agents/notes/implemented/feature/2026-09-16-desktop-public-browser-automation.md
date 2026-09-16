# Agent Note: Desktop public-web browser automation

Status: implemented

English | [中文](2026-09-16-desktop-public-browser-automation.zh.md)

## Problem

The desktop application can search and fetch public pages through the [bundled `browser-research` workflow](../../implemented/feature/2026-09-15-desktop-bundled-workflows.md), but it cannot operate a rendered page. Tasks that require following controls, entering ordinary form values, selecting options, or checking a resulting page therefore stop at research even when the user can see and complete the interaction manually.

Adding browser control also introduces authority that HTTP retrieval does not carry. A controlled page can hold private text, run scripts, contact other origins, submit state-changing requests, and retain credentials. Browser observations become model-visible tool results and therefore enter the durable Session log. The first implementation must provide useful interaction without claiming safe authentication, arbitrary browser control, or persistence it cannot yet defend.

## Decision

The desktop composition includes a browser capability seam with three independently owned roles:

- `@deepseek-ai/dsh-browser` defines the browser runtime, typed operations, owner identity, prepared-action lifecycle, page observations, and error taxonomy.
- `@deepseek-ai/dsh-browser-playwright-electron` provides the runtime through Playwright and the Electron executable already carried by the desktop application.
- `@deepseek-ai/dsh-tool-browser` contributes model-facing browser tools, approval requests, output bounds, prompt guidance, and tool presentation.

The desktop sidecar passes explicit Electron executable, application entry, and temporary-data root paths. Conditional Host and Agent-Preset rows mount the provider and Consumer only when those values exist; ordinary CLI, Web, headless, and SDK compositions do not expose browser tools.

The tool set is `browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_select`, `browser_wait`, and `browser_close`. Model-supplied targets use accessible role, accessible name, and an optional index. CSS, XPath, coordinates, arbitrary JavaScript, tabs, screenshots, uploads, downloads, and popup control are absent.

## Execution model

The provider pins `playwright-core` and connects through its public `chromium.connectOverCDP` API. It launches the packaged Electron executable in a dedicated browser-worker mode through `ctx.subprocess`; the worker binds Chromium debugging to `127.0.0.1` on an operating-system-assigned port and creates one visible hardened `BrowserWindow`. The provider parses the bounded readiness output, connects, and never publishes a stable endpoint.

One DSH Session owns the browser at a time. Opening creates a new worker with a private temporary profile. Another Session receives `BROWSER_BUSY` until the owner closes the visible browser and process-tree cleanup reaches quiescence. Browser state never transfers between Sessions or application launches: cookies, local storage, IndexedDB, caches, service workers, and HTTP authentication data disappear with the temporary profile.

Every successful open or action returns the current URL, title, and an ARIA snapshot. The snapshot uses a configured Playwright depth and timeout, then the Consumer caps the complete UTF-8 tool result and marks truncation. The model follows an observe-one-action-observe loop instead of chaining assumptions about page state.

## Authorization and target identity

`browser_open`, `browser_click`, `browser_fill`, and `browser_select` request one-shot approval before committing. Only the exact `allowed-once` outcome permits execution. Rejection, cancellation, unavailability, malformed answers, policy `never`, timeout, or provider failure releases any prepared state and performs no browser action.

Approval text names the current URL and exact target. It includes a statically visible link or form destination, selected option, or complete fill value. Password controls are rejected before approval. The approval text also states that supplied values and subsequent page observations enter Session history.

For element actions, the provider resolves one exact element before approval and records its observable tag, type, accessible identity, link target, and form target. Immediately before commit it requires the same attached element and matching fingerprint. Playwright's accessible locator must still include that retained element, so changes to role, text, ARIA names, or associated labels fail without retargeting a replacement. Script-installed behavior can still change without an observable fingerprint change and remains a stated risk.

## Navigation and lifecycle

The worker permits only credential-free HTTP and HTTPS top-level URLs. `browser_open` admits its exact origin and same-origin redirects. A prepared click or form action may admit an inspected cross-origin destination for that action; every other cross-origin top-level navigation is blocked and reports the attempted URL plus whether the current page remains usable. Cross-origin subresources remain available because ordinary public pages require them.

The provider waits for the worker to acknowledge a navigation permit before sending a CDP action. It revokes unused permission when the action succeeds or fails and waits for that acknowledgement before returning. Failed revocation terminates the worker because a reusable permit cannot remain active.

The window disables Node integration, enables context isolation and the Chromium sandbox, denies permission requests, child windows, downloads, and file chooser uploads, and rejects non-Web top-level navigation. The browser is not an authentication carrier: the bundled skill rejects tasks that need login, secrets, private pages, uploads, downloads, popups, screenshots, or unsupported visual/coordinate interaction before opening it.

Provider calls serialize. Approval waits use the tool execution signal. `browser_close`, visible-window closure, `agent/disposed`, Consumer disposal, provider disposal, cancellation, failed launch, and renderer or worker crash converge on teardown. Driver cleanup runs with a deadline alongside process-tree termination. Ownership is released only after the tree exits and the temporary profile is removed; a disconnected driver cannot keep ownership after those resources are gone. A close timeout retains ownership, and later process-tree exit resumes cleanup. Browser actions are never retried automatically.

## Verification

Package tests cover URL validation, ownership, busy state, every approval outcome, exact prepared-element identity, fingerprint drift, password rejection, output bounds, cancellation, worker-exit recovery, and teardown. Desktop worker tests pin the origin policy, command grammar, private-profile selection, and event encoding. A Loader test boots the three-package composition and proves registration.

A keyless ACP snapshot runs a deterministic browser Provider through the real Agent, Session, tool, approval, persistence, and protocol path. Its transcript retains three `allowed-once` decisions, the public value, the submitted result, the explicit close, and the seven-tool schema plus prompt guidance.

A keyless Electron compatibility test launches the actual worker and Playwright versions, opens a deterministic local form, fills and clicks accessible controls, observes the result, verifies that an unapproved cross-origin script navigation reports `BROWSER_NAVIGATION_BLOCKED`, takes a later snapshot, closes the browser, and confirms profile removal. Native Windows packaging remains a release gate before a Windows artifact can be claimed verified.

The implementation passed 119 browser package tests at per-file 100% coverage, 157 focused desktop, packaging, and workspace-constraint tests, the keyless ACP snapshot, the real Electron compatibility test, all 13 hygiene checks, and desktop staging. The macOS release rehearsal at `bd5ce394eed3dcc253b32777cb9d12603fc9fdc7` produced `DeepSeek-Harness-0.1.1-rc.2-arm64.zip` with SHA-256 `3834ef81e7e436eeb24cb29f27035c9db9b76b9f789106456a024a9d19826952`; checksum verification and a packaged-application smoke test confirmed React readiness, sidecar startup and shutdown, the packaged permit and identity checks, worker-exit termination ordering, and sidecar-port release.

## Alternatives considered

**Bundle Playwright Chromium.** This follows Playwright's primary browser path but adds another large browser payload plus download, integrity, cache, and platform-release ownership when Electron already carries a compatible Chromium runtime.

**Mount Playwright MCP or the agent CLI.** Those products provide broad browser tools but bypass this repository's approval audit, canonical tool results, Session logging, UI presentation, and package lifecycle. They also require a separately distributed browser.

**Drive Electron `webContents` and the DOM directly.** This would hand-roll locator resolution, actionability, waiting, accessibility snapshots, and cancellation behavior already maintained by Playwright.

**Reuse a persistent browser profile.** Login reuse reduces friction but lets a later Session inherit prior cookies and storage, complicates profile locking and crash recovery, and expands the impact of the temporary CDP listener. Authentication requires a separate design.

**Use Playwright's experimental Electron launcher with a custom executable.** Its custom-executable path does not inject Playwright's Electron loader, so adopting it would depend on a private bootstrap protocol rather than the documented CDP client.

## Consequences

The ephemeral CDP listener is unauthenticated and reachable by another same-user process that discovers its random port while a browser task runs. This local threat is accepted for the first public-page-only implementation; authenticated browsing cannot ship on this transport without a stronger control channel.

ARIA extraction can consume memory before the Consumer applies its byte cap, and accessible role/name targeting cannot operate canvases, unlabeled controls, or visual-only interfaces. Dynamic event handlers can change after approval without changing the recorded element fingerprint. Cross-origin subresources can contact public or private network services. These constraints remain explicit product limits rather than being described as comprehensive browser automation.

The desktop application gains useful visible public-page interaction without inheriting browser identity or credentials across Sessions. Every mutation costs a one-shot approval and every successful observation adds bounded but data-dependent Session history. Cancelled navigation can leave an operable empty document, so the model must inspect the returned state instead of assuming the prior page survived.
