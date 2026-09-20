# Browser Automation

English | [中文](browser.zh.md)

The browser automation seam controls one visible, ephemeral browser for credential-free public HTTP(S) pages. It is split into a Service Definition ([`dsh-browser`](../../packages/browser/browser)), a desktop Provider ([`dsh-browser-playwright-electron`](../../packages/browser/browser-playwright-electron)), and a model-facing Consumer ([`dsh-tool-browser`](../../packages/browser/tool-browser)). The capability is optional and is mounted only by desktop compositions that supply the Electron executable, application entry, and temporary-profile root.

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)

## Ownership and lifecycle

Every operation carries the exact owning `Agent`; another Session receives `BROWSER_BUSY` or `BROWSER_FOREIGN_OWNER` and cannot observe or operate the page. `open` allocates a worker and private profile, while `close`, cancellation, Agent disposal, Provider disposal, and worker failure converge on awaited driver, process-tree, and profile cleanup before ownership is released.

## Requests and observations

| Type | Fields and meaning |
|---|---|
| `BrowserOpenRequest` | `url`: absolute credential-free HTTP(S) target |
| `BrowserWaitRequest` | `durationMs`: positive provider wait duration |
| `BrowserObservation` | final top-level `url`, document `title`, and bounded-depth ARIA `snapshot` |
| `BrowserElementTarget` | exact accessible `role`, exact accessible `name`, and optional zero-based `index` |
| `BrowserElementAction` | closed `click`, `fill`, or `select` request union |

`parsePublicBrowserUrl` canonicalizes supported URLs and rejects malformed, non-HTTP(S), or credential-bearing input with `BROWSER_INVALID_URL`. `BrowserError` has an open string code so Provider-specific failures remain possible.

## Prepared actions

Element mutation uses `prepare` → approval → `commit`. `prepare` retains the exact element handle and returns `BrowserPreparedAction`, including an opaque `BrowserPreparedActionId`, the current page URL, original action, and observable `BrowserElementFingerprint`. `commit` checks that same attached handle and fingerprint, executes it once, and consumes the id; `release` disposes it without action. This prevents approval from being transferred to a newly matched element, but cannot detect a script handler change that leaves the observable fingerprint unchanged.

## Desktop policy

The Electron worker admits the opened origin and later same-origin top-level navigation. A prepared link or form destination can admit one inspected cross-origin destination; other top-level origins are blocked and reported through a correlated private worker protocol. Permissions, child windows, downloads, webviews, non-Web top-level URLs, and password fills fail closed. Cross-origin subresources remain available, and the loopback CDP endpoint is unauthenticated, so this implementation is not an authentication carrier.

The [desktop public-browser Agent Note](../../.agents/notes/implemented/feature/2026-09-16-desktop-public-browser-automation.md) records the security trade-offs and rejected alternatives.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowser--browserruntime-abstract-seam"></a>

### `ctx.browser` — `BrowserRuntime` (abstract seam)

One visible ephemeral browser owned by an exact live Agent and therefore by its Session. Implementations serialize calls and release ownership only after complete worker and profile cleanup.

```ts cordis-catalog
/**
 * Open a new ephemeral browser after the Consumer obtains approval.
 * @param owner - Exact Agent whose Session owns the browser.
 * @param request - Canonical credential-free HTTP(S) target.
 * @param signal - Cancellation of launch and navigation.
 * @returns Current rendered page observation.
 */
abstract open( owner: Agent, request: BrowserOpenRequest, signal?: AbortSignal, ): Promise<BrowserObservation>

/**
 * Observe the current page without changing it.
 * @param owner - Exact owning Agent.
 * @param signal - Cancellation of snapshot collection.
 * @returns Current rendered page observation.
 */
abstract snapshot(owner: Agent, signal?: AbortSignal): Promise<BrowserObservation>

/**
 * Resolve and retain one exact element without acting on it.
 * @param owner - Exact owning Agent.
 * @param action - Accessible target and requested mutation.
 * @param signal - Cancellation of element resolution.
 * @returns Prepared identity and approval-visible fingerprint.
 */
abstract prepare( owner: Agent, action: BrowserElementAction, signal?: AbortSignal, ): Promise<BrowserPreparedAction>

/**
 * Recheck and commit a previously prepared element action exactly once.
 * @param owner - Exact owning Agent.
 * @param id - Provider-issued prepared action identity.
 * @param signal - Cancellation of action and resulting observation.
 * @returns Current rendered page observation.
 */
abstract commit( owner: Agent, id: BrowserPreparedActionId, signal?: AbortSignal, ): Promise<BrowserObservation>

/**
 * Release one prepared action without executing it. Implementations make
 * repeated release harmless so every fail-closed path can converge here.
 * @param owner - Exact owning Agent.
 * @param id - Provider-issued prepared action identity.
 */
abstract release(owner: Agent, id: BrowserPreparedActionId): Promise<void>

/**
 * Wait for a bounded interval, then observe the current page.
 * @param owner - Exact owning Agent.
 * @param request - Duration selected by the Consumer within its configured cap.
 * @param signal - Cancellation of the wait.
 * @returns Current rendered page observation.
 */
abstract wait( owner: Agent, request: BrowserWaitRequest, signal?: AbortSignal, ): Promise<BrowserObservation>

/**
 * Close the owner's browser and await worker and profile quiescence.
 * @param owner - Exact owning Agent.
 */
abstract close(owner: Agent): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
