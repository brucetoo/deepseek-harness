---
description: "The runtime-diagnostics package group provides opt-in checks for package-owned runtime relationships."
kind: "package-group"
---

# runtime-diagnostics/ — runtime relationship checks

English | [中文](README.zh.md)

## Summary

This group provides opt-in checks for event and mutable-state relationships that packages own at runtime. The registry controls which package companions run without importing product packages itself.

## Table of Contents

- Packages
- Related documentation
- Dev Note

## Packages

| Package | Role |
|---|---|
| [`invariants/`](invariants/README.md) | Registers `ctx.invariants` and runs selected package companions. |

## Related documentation

- [Defensive patterns](../../docs/defensive-patterns/README.md) — runtime checks and failure containment rules.

## Dev Note

None.
