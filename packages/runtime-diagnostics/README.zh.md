---
description: "runtime-diagnostics 包组为包自有运行时关系提供可选检查。"
kind: "package-group"
---

# runtime-diagnostics/ — 运行时关系检查

[English](README.md) | 中文

## 概述

该包组为各包在运行时拥有的事件与可变状态关系提供可选检查。注册服务控制运行哪些包配套入口，本身不导入产品包。

## 目录

- 包
- 相关文档
- Dev Note

## 包

| 包 | 职责 |
|---|---|
| [`invariants/`](invariants/README.zh.md) | 注册 `ctx.invariants` 并运行选中的包配套入口。 |

## 相关文档

- [防御性模式](../../docs/defensive-patterns/README.zh.md) — 运行时检查与故障隔离规则。

## 开发备注

无。
