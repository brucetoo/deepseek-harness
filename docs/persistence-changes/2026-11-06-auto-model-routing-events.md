---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-auto-model-routing-events

English | [中文](2026-11-06-auto-model-routing-events.zh.md)

## Summary

Automatic model routing adds durable route-selection and failover events so a replay can identify the physical provider and model used for each attempt while preserving the requested Auto selection.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both event roots are additions marked ignorable in the session envelope. Readers that do not declare these event payloads may skip them, so the current session format version remains valid.

<a id="verification"></a>
## Verification

The persistence schema extractor classifies both roots as same-version additions. Auto-router persistence tests cover route and failover event payloads, and the repository persistence gates validate the recorded schemas.

<a id="dev-note"></a>
## Dev Note

None.
