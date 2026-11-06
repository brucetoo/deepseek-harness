---
description: "The browser package group provides a public-page browser service, an Electron provider, and approval-aware model tools."
kind: "package-group"
---

# browser/ — visible public-browser capability

English | [中文](README.zh.md)

## Summary

This family provides one owner-scoped visible browser for credential-free public HTTP(S) pages. It separates the provider-neutral lifecycle, the desktop Electron implementation, and the model-facing approval-aware tools.

## Table of Contents

- Packages
- Related documentation
- Dev Note

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`browser/`](browser/README.md) | Defines browser ownership, observations, prepared actions, and shared errors | `ctx.browser` |
| [`browser-playwright-electron/`](browser-playwright-electron/README.md) | Runs one ephemeral Electron browser through Playwright over loopback CDP | provides `ctx.browser` |
| [`tool-browser/`](tool-browser/README.md) | Exposes seven public-browser tools with one-shot approval | registers on `ctx.tools` |

## Related documentation

- [Browser subsystem](../../docs/subsystems/browser.md) — shared types, provider behavior, and tool flow.
- [Desktop public-browser Agent Note](../../.agents/notes/implemented/feature/2026-09-16-desktop-public-browser-automation.md) — security model, lifecycle, and deferred authenticated-browser work.

## Dev Note

None.
