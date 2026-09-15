# Agent Note: Electron desktop application with an authenticated local Host

Status: proposed

English | [中文](2026-09-15-electron-desktop-application.zh.md)

## Problem

DeepSeek Harness provides a browser application and a CLI, but it does not provide an installable desktop application. A desktop executable must start the existing Host and React client without requiring a separately installed Node.js runtime, keep the Host inaccessible to unrelated local pages and processes, own the Host process lifecycle, and package the exact runtime closure needed by the selected composition.

The existing GUI architecture anticipated an Electron IPC transport and states that Electron does not use `dsh-host-webserver`. Implementing that transport would require a second carrier for every HTTP route, WebSocket stream, dynamic plugin bundle, static asset, and download behavior before the first desktop build can exercise the existing product. The current Web carrier already provides those behaviors, but loopback reachability and browser-origin checks are not authentication: another local process can connect directly, and a browser can reach a known port.

Desktop packaging adds a second failure class. A development checkout can resolve workspace symlinks, generated Remote modules, native dependencies, and a machine-installed Node.js executable that an installed application cannot assume. A package that launches successfully from source is not evidence that its staged application is self-contained.

## Proposal

Add an Electron application under `apps/desktop` that owns one hardened `BrowserWindow` and one independent plain-Node Host sidecar. The first implementation targets an unsigned macOS arm64 developer artifact. Windows packaging remains part of the design, but no Windows support claim is made until a Windows artifact passes the same staged-runtime and application tests.

The sidecar runs the built `dsh web` entry with the ordinary Web composition, fixed loopback port `37615`, browser opening disabled, and one per-launch 256-bit bearer token supplied only through a dedicated environment variable. The Electron main process waits for exactly one canonical readiness line from stdout before loading the application origin. Startup fails with a categorized diagnostic for timeout, early exit, malformed or duplicate readiness, port conflict, missing staged files, or navigation failure.

`dsh-host-webserver` gains optional bearer authentication resolved from a named environment variable during activation. When configured, it rejects every HTTP request and every upgrade request before route selection, including static files, dynamic plugin bundles, downloads, API calls, and event streams. It compares the exact `Authorization: Bearer <token>` value without logging the token. Ordinary `dsh web` remains unauthenticated unless this option is explicitly configured.

The Electron session injects the bearer header only for the exact `http://127.0.0.1:37615` origin. It does not attach the header to redirects, subresources, or requests for any other origin. The window uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, exposes no general preload bridge, denies new windows, blocks navigation away from the application origin, and opens explicit external HTTP or HTTPS links through the operating system.

The application is single-instance. A second launch focuses the existing window and starts no second Host. Closing the last window quits the application. Quit first asks the sidecar to terminate and waits for bounded shutdown so session state can flush; it then escalates to forced termination and reports that escalation without leaving a child process.

## Packaged runtime

The staging command builds the Host packages and Web assets, creates an exact production dependency closure for `@deepseek-ai/dsh`, and places that closure plus a platform Node.js executable outside ASAR. Staging validates the CLI entry, Web assets, Cordis configuration, generated Remote modules, native dependencies, executable modes, and resolved symlinks before Electron packaging starts.

The staged metadata records the source commit, lockfile digest, Node.js version, platform, and architecture. The desktop main process resolves only staged paths in packaged mode and refuses a partial stage. Development mode may use the checkout entrypoints, but the packaged smoke test must launch with the staged runtime and a scrubbed environment that does not depend on the checkout's `node_modules`, `PATH`, or Node.js installation.

## Delivery phases

P0 delivers the existing product workflows in a real desktop window: initial model configuration, workspace selection, session creation and resume, streamed tool output, approvals and user questions, produced-file opening and downloading, clean quit, and relaunch. It does not add a tray, background execution after the window closes, automatic updates, Office generation, browser automation, cloud execution, or crash-safe replay of an interrupted external action.

The next phase adds product capabilities through existing plugin extension points rather than Electron-specific business logic: a durable produced-file registry, Office document and spreadsheet generation, presentation generation, browser tasks, previews, and task-oriented entry points. These capabilities retain the same Web client and Host sidecar architecture.

## Alternatives considered

**Implement the planned Electron IPC carrier first.** This removes the loopback listener but requires complete replacements for HTTP routing, WebSocket event streams, dynamic bundles, static assets, and downloads before any existing workflow runs. It remains a future hardening option if the authenticated loopback carrier becomes the limiting security or deployment factor.

**Run the Harness inside Electron's main process.** This removes one process but couples Electron's Node ABI, native modules, failures, and shutdown ordering to the agent runtime. An independent sidecar preserves failure isolation and lets the packaged Host use the same plain-Node behavior as the CLI.

**Use Tauri and the operating-system WebView.** Tauri reduces shell size but introduces Rust and platform WebView differences while still requiring a Node-compatible Host process for the current package graph. It does not reduce the first release's integration work enough to justify a second runtime toolchain.

**Build separate native user interfaces.** Native macOS and Windows clients would duplicate the established React client and delay feature parity. The desktop shell exists to reuse that client while adding process ownership and operating-system integration.

**Treat loopback reachability as sufficient.** A fixed local port is reachable by other processes and browser pages. Host and origin checks defend browser confusion but do not authenticate a direct local caller, so the desktop deployment requires a per-launch secret.

## Acceptance criteria

- An unsigned macOS arm64 application launches on a machine with no separately installed Node.js and reaches the existing React application within ten seconds on a measured cold start.
- Every HTTP route and WebSocket upgrade returns an authentication failure without the exact per-launch token; the Electron application supplies that token only to the exact application origin.
- The BrowserWindow security flags, navigation rules, external-link behavior, download behavior, and absence of a general renderer bridge are covered by focused tests.
- A second launch focuses the existing window without starting another Host, while close and quit leave no sidecar process.
- The staged runtime validates its Node executable, dependency closure, Web assets, generated modules, native modules, file modes, symlinks, commit, and lockfile digest.
- Keyless tests exercise startup parsing, early exit, timeout, duplicate readiness, graceful shutdown, forced termination, and packaged-path resolution.
- A real packaged-app smoke test covers launch, initial render, one keyless interaction path, quit, and relaunch from the artifact rather than the source checkout.
- Windows support is documented as unverified until the corresponding artifact is built and exercised on Windows.

## Risks

An Electron request-header hook can leak the bearer token if its URL filter is broader than the exact origin or if redirects are allowed to carry modified headers. Tests must assert negative cases for alternate hosts, ports, schemes, and redirected requests.

Authentication in the generic Web server changes a shared carrier and must remain disabled by default. The implementation must reject before both ordinary and upgrade route dispatch so no plugin can accidentally bypass it.

Copying a development Node.js executable can produce a machine-specific artifact. The staging command must pin and inspect the executable, and release automation must replace local copying with platform-specific runtime acquisition plus integrity verification before signed distribution.

The fixed port can be occupied. P0 fails with an actionable diagnostic instead of silently selecting another origin, because changing the origin would invalidate the exact header-injection and navigation policy.

The existing Web architecture note's hypothetical IPC direction remains valuable but does not describe this first desktop carrier. If this proposal ships, that note and the Web server subsystem documentation must be updated to state authenticated loopback reuse as the current Electron transport and IPC as a deferred alternative.
