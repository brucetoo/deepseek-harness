---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-auto-model-routing-events

[English](2026-11-06-auto-model-routing-events.md) | 中文

## 概述

自动模型路由新增持久化的路由选择与故障转移事件，使回放能够识别每次尝试实际使用的提供方和模型，同时保留用户请求的 Auto 选择。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-auto-model-routing-events
baseline: false
changes:
  - root: "event:llm/auto-failover"
    previous: null
    after: "bce21916c308be60543c5af12eba26dfce11f582dab3ce542f385fc068fe738f"
    decision: same-version
  - root: "event:llm/auto-route"
    previous: null
    after: "8ce47453b5a9ed2354017d386a6744f5c7d875a4dc8da22402613f12db1f2b3c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个事件根均为新增项，并在会话信封中标记为可忽略。未声明这些事件载荷的读取器可以跳过它们，因此当前会话格式版本仍然有效。

<a id="verification"></a>
## 验证

持久化 schema 提取器将两个事件根分类为允许保持版本的新增项。Auto Router 持久化测试覆盖路由和故障转移事件载荷，仓库持久化门禁验证登记后的 schema。

<a id="dev-note"></a>
## 开发备注

无。
