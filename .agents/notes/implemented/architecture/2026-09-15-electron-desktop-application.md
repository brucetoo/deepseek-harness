# Agent Note: Electron desktop application with an authenticated local Host

Status: implemented

English | [中文](2026-09-15-electron-desktop-application.zh.md)

## Problem

DeepSeek Harness needs an installable desktop application that reuses the existing Host and React client without requiring a separately installed Node.js runtime. The application must keep a fixed loopback Host inaccessible to unrelated local callers, own its process lifecycle, isolate desktop state from the user's CLI installation, and package the complete runtime selected by the Web composition.

The GUI architecture reserved an Electron IPC carrier, but implementing it first would duplicate HTTP routes, WebSocket streams, dynamic plugin bundles, static assets, and downloads before the desktop application could run existing product workflows. Source launches also resolve workspace links, generated modules, native dependencies, and ambient executables that an installed application cannot assume.

## Decision

`apps/desktop` is an Electron application with one hardened `BrowserWindow` and one independent plain-Node Host sidecar. The shipped developer artifact targets unsigned macOS arm64. Windows remains unsupported until a Windows package passes equivalent runtime and application verification.

The sidecar runs the staged `dsh web` entry on `127.0.0.1:37615` with browser opening disabled. Each launch creates a 256-bit bearer token supplied through a dedicated environment variable. `dsh-host-webserver` requires the exact `Authorization: Bearer <token>` value for every HTTP request and WebSocket upgrade before route selection when its optional `bearerTokenEnv` config is present. Ordinary browser deployments remain unauthenticated unless they configure this field.

The Electron session injects the header only for the exact application HTTP and WebSocket origins. The window disables Node integration, enables context isolation and the Chromium sandbox, exposes no general preload bridge, denies new windows, and blocks navigation away from the local application origin. Explicit external HTTP and HTTPS links open through the operating system.

The application holds the single-instance lock before starting the Host. A second launch focuses the existing window. Closing the last window begins bounded sidecar shutdown before Electron exits. Startup and shutdown failures use token-free categorized diagnostics. Desktop state uses Electron's `userData/dsh` directory, so the packaged application does not load the user's CLI profiles or `$DSH_HOME`.

## Packaged runtime

`apps/desktop-runtime` is the explicit pnpm deploy root for every direct runtime and peer dependency required by the Web composition. `desktop:stage` builds Host packages and Web assets, creates a production deployment with workspace packages injected as files, copies the current Node executable, and validates required files, Cordis configuration, generated Remote modules, native imports, executable mode, Node version, symlink containment, and a checkout-independent CLI smoke run.

Each candidate records the source commit, lockfile SHA-256 digest, Node version, platform, and architecture. A validated candidate moves to `.stage/versions/<id>`, then an atomic `.stage/current` file selects it for new development launches and packaging. Existing launches retain their immutable version directory.

Packaged mode resolves `process.resourcesPath/sidecar`; development mode resolves the version selected by `.stage/current`. `DSH_DESKTOP_SIDECAR_ROOT` is the only explicit path override. Neither mode falls back to an ambient Node executable or checkout entrypoint. Electron Builder places the selected stage outside ASAR and emits an unsigned arm64 application bundle and ZIP archive from the pinned local Electron distribution.

## Verification

Focused tests cover bearer authentication, exact-origin header injection, navigation policy, single-instance behavior, startup diagnostics, shutdown escalation, immutable stage publication, closure validation, package configuration, and packaged-path resolution. Stage validation loads `node-pty` and `koffi` and invokes the staged CLI under a scrubbed environment.

A real packaged application smoke run starts from the `.app`, waits for the React interface, dismisses the first-run notice, opens Settings through a mouse event, captures the rendered window, exits through the Electron browser lifecycle, verifies exit code zero and sidecar process count, and repeats the launch against the same desktop data directory.

## Alternatives considered

**Implement the Electron IPC carrier first.** This removes the loopback listener but requires replacements for every existing Web transport behavior. IPC remains a hardening option if authenticated loopback becomes the limiting security or deployment factor.

**Run the Harness in Electron's main process.** This removes one process but couples Electron's Node ABI, native modules, failures, and shutdown ordering to the agent runtime. The sidecar preserves failure isolation and the CLI's plain-Node execution model.

**Use Tauri and the operating-system WebView.** This adds Rust and platform WebView differences while the current package graph still requires a Node-compatible Host process.

**Build separate native user interfaces.** Native clients duplicate the established React client and delay product parity. The desktop shell reuses that client and adds operating-system integration.

**Treat loopback reachability as authentication.** Other local processes can call a fixed port directly. Host and origin checks do not authenticate such callers, so the desktop deployment requires a per-launch secret.

## Consequences

The desktop application exercises the same routes, streams, bundles, assets, and downloads as the browser application without a second transport implementation. The cost is a fixed local port, an application-specific bearer layer, a bundled Node runtime, and a substantially larger artifact than a system-WebView shell.

The macOS artifact is unsigned and unnotarized. Packaging copies the build machine's Node executable after validating platform, architecture, and version; signed distribution requires platform runtime acquisition with integrity verification. Updates, tray behavior, background execution after the last window closes, Office generation, browser automation, and cloud execution remain separate product capabilities implemented through plugins rather than Electron main-process logic.
