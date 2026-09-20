# browser/ — visible public-browser capability

English | [中文](README.zh.md)

This family provides one owner-scoped visible browser for credential-free public HTTP(S) pages. It separates the provider-neutral lifecycle, the desktop Electron implementation, and the model-facing approval-aware tools.

| Package | Role | ctx key |
|---|---|---|
| [`browser/`](browser/README.md) | Defines browser ownership, observations, prepared actions, and shared errors | `ctx.browser` |
| [`browser-playwright-electron/`](browser-playwright-electron/README.md) | Runs one ephemeral Electron browser through Playwright over loopback CDP | provides `ctx.browser` |
| [`tool-browser/`](tool-browser/README.md) | Exposes seven public-browser tools with one-shot approval | registers on `ctx.tools` |

The [desktop public-browser Agent Note](../../.agents/notes/implemented/feature/2026-09-16-desktop-public-browser-automation.md) owns the security model, lifecycle, and deferred authenticated-browser work.
