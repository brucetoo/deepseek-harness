# Desktop application

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` packages the existing React application and a self-contained plain-Node Host as an Electron application. Electron owns the window, the Host sidecar, local authentication, and application shutdown; product behavior remains in the existing Host and client plugins.

> **Note:** The desktop application is a preview. Packaging currently produces an unsigned macOS arm64 developer artifact.

## Commands

- `pnpm run desktop:dev` rebuilds and validates the sidecar stage, then launches Electron from the checkout.
- `pnpm run desktop:stage` publishes a validated immutable sidecar version under `apps/desktop/.stage/versions/` and updates the atomic `apps/desktop/.stage/current` pointer.
- `pnpm run desktop:package:mac` stages the runtime and writes the application bundle and ZIP archive under `apps/desktop/dist/`.

The stage and packaged artifacts are ignored build output.

## Runtime

The Electron main process starts the bundled Node executable with the staged `dsh web` entry on `127.0.0.1:37615`. Each launch creates a 256-bit bearer token. The Host requires that token for every HTTP request and WebSocket upgrade, while the Electron session injects it only for the exact application origin.

The `BrowserWindow` disables Node integration, enables context isolation and the Chromium sandbox, exposes no preload bridge, denies child windows, and prevents navigation away from the application origin. Explicit external HTTP and HTTPS links open through the operating system.

The application permits one instance. A second launch focuses the existing window. Closing the last window begins bounded sidecar shutdown before Electron exits. Desktop data uses Electron's `userData` directory under its `dsh/` child and does not read the user's CLI `$DSH_HOME`.

## Staging and packaging

[`apps/desktop-runtime`](../desktop-runtime/package.json) is the explicit pnpm deploy root for every runtime and peer dependency needed by the Web composition. Staging builds the repository, creates a production deployment with workspace packages injected as files, copies the current Node executable, and validates required assets, generated Remote modules, native imports, Node version, executable mode, symlink containment, and a checkout-independent CLI smoke run.

Each stage records the source commit, lockfile SHA-256 digest, Node version, platform, and architecture. Packaging accepts only a validated macOS arm64 stage selected by the atomic pointer, places it outside ASAR as `Resources/sidecar`, and uses the pinned local Electron distribution.

## Limitations

- The fixed port fails loud when another process already owns `37615`.
- The macOS artifact is unsigned and unnotarized.
- Windows packaging, signing, updates, tray behavior, and background execution after the last window closes are not implemented.
- The desktop carrier uses authenticated loopback HTTP and WebSocket traffic. It does not provide TLS and does not use an Electron IPC transport.
