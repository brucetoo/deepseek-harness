# Agent Note: Electron desktop application with an authenticated local Host

Status: implemented

English | [中文](2026-09-15-electron-desktop-application.zh.md)

## Problem

DeepSeek Harness needs an installable desktop application that reuses the existing Host and React client without requiring a separately installed Node.js runtime. The application must keep a fixed loopback Host inaccessible to unrelated local callers, own its process lifecycle, isolate desktop state from the user's CLI installation, and package the complete runtime selected by the Web composition.

The GUI architecture reserved an Electron IPC carrier, but implementing it first would duplicate HTTP routes, WebSocket streams, dynamic plugin bundles, static assets, and downloads before the desktop application could run existing product workflows. Source launches also resolve workspace links, generated modules, native dependencies, and ambient executables that an installed application cannot assume.

## Decision

`apps/desktop` is an Electron application with one hardened `BrowserWindow` and one independent plain-Node Host sidecar. Native packaging produces unsigned macOS arm64 and Windows x64 developer artifacts. A target command rejects a different host platform, host architecture, or staged runtime.

The sidecar runs the staged `dsh web` entry on `127.0.0.1:37615` with browser opening disabled. Each launch creates a 256-bit bearer token supplied through a dedicated environment variable. `dsh-host-webserver` requires the exact `Authorization: Bearer <token>` value for every HTTP request and WebSocket upgrade before route selection when its optional `bearerTokenEnv` config is present. Ordinary browser deployments remain unauthenticated unless they configure this field.

The Electron session injects the header only for the exact application HTTP and WebSocket origins. The window disables Node integration, enables context isolation and the Chromium sandbox, exposes no general preload bridge, denies new windows, and blocks navigation away from the local application origin. Explicit external HTTP and HTTPS links open through the operating system.

The application holds the single-instance lock before starting the Host. A second launch focuses the existing window. The main process waits up to 60 seconds for Host readiness before reporting `SIDECAR_TIMEOUT`. Closing the last window begins bounded sidecar shutdown before Electron exits. Startup and shutdown failures use token-free categorized diagnostics. Desktop state uses Electron's `userData/dsh` directory, so the packaged application does not load the user's CLI profiles or `$DSH_HOME`.

## Packaged runtime

`apps/desktop-runtime` is the explicit pnpm deploy root for every direct runtime and peer dependency required by the Web composition. `desktop:stage` builds Host packages and Web assets, creates a production deployment with workspace packages injected as files, copies the current Node executable, and validates required files, Cordis configuration, generated Remote modules, native imports, executable mode, Node version, symlink containment, and a checkout-independent CLI smoke run.

`DSH_DESKTOP_LOCAL_PLUGINS` is an explicit build input containing a JSON array of local npm package directories. Each package must declare a profile bundle through `dsh.bundle.patch`. Staging packs each directory into a tarball, installs it below an isolated application-owned dependency root with lifecycle scripts disabled, and links packages already present in the closed desktop runtime so Cordis and Harness services retain one installation identity. The stage retains each tarball and a manifest containing its package name, version, patch path, installation root, and SHA-256 digest. The Electron launcher resolves only contained paths from that manifest, links each staged local package's installed dependency closure into the desktop profile module fallback, and passes each patch to `dsh web`; it never resolves the original local directory after staging. A staged `@anweat/dsh-browser` package replaces the built-in Electron browser provider by keeping the `DSH_BROWSER_*` launch variables unset, preventing duplicate `browser` service registration while preserving the user's selected provider.

Each candidate records the source commit, lockfile SHA-256 digest, Node version, platform, and architecture. A validated candidate moves to `.stage/versions/<id>`, then an atomic `.stage/current` file selects it for new development launches and packaging. Existing launches retain their immutable version directory.

Packaged mode resolves `process.resourcesPath/sidecar`; development mode resolves the version selected by `.stage/current`. `DSH_DESKTOP_SIDECAR_ROOT` is the only explicit path override. Neither mode falls back to an ambient Node executable or checkout entrypoint. Electron Builder places the selected stage outside ASAR and provisions the Electron version pinned by `apps/desktop/package.json`. Packaging disables implicit CI publishing, emits local artifacts, and then writes `SHA256SUMS` for the distributable files. macOS packaging emits an arm64 application bundle and ZIP archive. Windows packaging emits an x64 assisted per-user NSIS installer and ZIP archive.

## Verification

Focused tests cover bearer authentication, exact-origin header injection, navigation policy, single-instance behavior, startup diagnostics, shutdown escalation, immutable stage publication, closure validation, package configuration, and packaged-path resolution. Stage validation loads `node-pty` and `koffi` and invokes the staged CLI under a scrubbed environment.

A real packaged macOS application smoke run starts from the `.app`, waits for the React interface, dismisses the first-run notice, opens Settings through a mouse event, captures the rendered window, exits through the Electron browser lifecycle, verifies exit code zero and sidecar process count, and repeats the launch against the same desktop data directory. Native Windows CI verifies distributable checksums and ZIP expansion, silently installs the NSIS package, checks the embedded stage metadata, launches the installed executable until its React page appears through Electron CDP, closes the window, requires exit code zero, and rejects a remaining sidecar listener.

[Native Windows run 35054280752](https://github.com/brucetoo/deepseek-harness/actions/runs/35054280752) checked out `04ebede20f281d35e8f15006d701bb0fb6323f5c` and passed 284 focused tests, the repository build, packaging, and installed-application verification. Independently recomputed SHA-256 digests matched `SHA256SUMS`: `3c2f8dd824470f237e6c43b6c4425745258fa3489b6920a6bdf7bda02d32c068` for the NSIS installer and `ef59c30a5d4409013f7e3da2096bce2af332193c9f390285c278486b0a4ca806` for the ZIP. The ZIP records that exact commit with Node `v24.20.0` for `win32-x64` and contains the four bundled workflow skills.

## Alternatives considered

**Implement the Electron IPC carrier first.** This removes the loopback listener but requires replacements for every existing Web transport behavior. IPC remains a hardening option if authenticated loopback becomes the limiting security or deployment factor.

**Run the Harness in Electron's main process.** This removes one process but couples Electron's Node ABI, native modules, failures, and shutdown ordering to the agent runtime. The sidecar preserves failure isolation and the CLI's plain-Node execution model.

**Use Tauri and the operating-system WebView.** This adds Rust and platform WebView differences while the current package graph still requires a Node-compatible Host process.

**Build separate native user interfaces.** Native clients duplicate the established React client and delay product parity. The desktop shell reuses that client and adds operating-system integration.

**Treat loopback reachability as authentication.** Other local processes can call a fixed port directly. Host and origin checks do not authenticate such callers, so the desktop deployment requires a per-launch secret.

**Load the user's ambient CLI plugins at runtime.** This would make an installed application depend on mutable machine state, let local profile changes alter the desktop composition without rebuilding, and fail when the artifact moves to another machine. Explicit staging captures the selected package bytes and configuration instead.

## Consequences

The desktop application exercises the same routes, streams, bundles, assets, and downloads as the browser application without a second transport implementation. The cost is a fixed local port, an application-specific bearer layer, a bundled Node runtime, and a substantially larger artifact than a system-WebView shell.

Local bundle builds are intentionally machine-specific developer artifacts. Their tarballs and digests make the selected bytes inspectable, but they are outside the repository lockfile and must be supplied again for a later rebuild. Installation lifecycle scripts are disabled, so a local package must ship its built runtime files; its pack lifecycle may still run while the trusted local source directory is captured.

The macOS artifact is unsigned and unnotarized, and the Windows installer and executable are unsigned. Packaging copies the native build host's Node executable after validating platform, architecture, and version. Signed distribution requires platform credentials and release provenance beyond the developer artifacts. Updates, tray behavior, background execution after the last window closes, editing existing Office documents, presentation generation, and cloud execution remain separate product capabilities implemented through plugins rather than Electron main-process logic. The packaged plugin composition provides new DOCX and XLSX creation, cited browser research, and approved interaction with credential-free public pages.
