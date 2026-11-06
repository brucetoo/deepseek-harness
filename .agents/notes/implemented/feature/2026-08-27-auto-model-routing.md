# Agent Note: Availability-first automatic model routing

Status: implemented

English | [中文](2026-08-27-auto-model-routing.zh.md)

## Problem

A Harness process can register several provider/model routes, but each model request still needs one physical route. Manual selection cannot automatically avoid a route that is unhealthy, rate-limited, slow, or saturated when another compatible route is available.

Automatic selection must not erase either identity. Auto is durable user intent, while request headers, request context, and assistant source identity must identify the physical provider and model that served an attempt. Cross-model recovery must also stop once output is committed, because switching after visible text, reasoning, or tool-call output can splice responses from different models.

## Decision

`@deepseek-ai/dsh-llm-auto-router` is an availability-first policy plugin over `agent/resolve-model`, `llm/stream`, and `agent/request-error`. The base bundle mounts it with its default policy, while `agent-default-model` keeps the shipped composition default fixed at `deepseek-official/deepseek-v4-flash`. Users opt into the default Auto pool with `{ provider: 'auto', model: 'auto' }`; `{ provider: 'auto', model: '<pool>' }` selects a named pool. Other provider/model selections pass through unchanged.

The non-surface `model/selection` event stores the requested `ModelSelection`, including a virtual Auto selection. Host resume and fork derive that requested selection from the event rather than the latest physical request header. AgentLoop calls `agent/resolve-model` with phase `preparation` before tool admission and prompt assembly; Auto previews a compatible physical route without reserving capacity. Phase `attempt` runs for each request or retry and reserves the selected physical route before call preparation. Prompt variables, tool admission, request headers, request context, and assistant source identity therefore identify physical routes.

The resolver waterfall keeps routing policy outside AgentLoop while giving assembly and dispatch distinct timing. It avoids a model-router capability seam and does not nest another LLM stream.

## Candidate selection and health

Provider catalogs enumerate default candidates and remain advisory for manual routing, preserving the [provider-routed adapter decision](../architecture/2026-07-14-provider-routed-llm-adapters.md). Explicit route configuration can add an unadvertised model. Pools, route exclusions, enablement, preference multipliers, concurrency limits, token reserve, scoring weights, circuit thresholds, cooldowns, half-open concurrency, and the per-step failover budget are validated plugin configuration.

Each Auto attempt resolves exact model metadata and filters by pool, prior attempts in the step, declared modalities, context capacity, output allowance, circuit state, and concurrency capacity. Missing required metadata makes a route ineligible. The policy does not inspect prompt text or classify task quality; it uses content-block modalities, per-route token measurements, provider-neutral failure facts, first-token latency, and in-flight load. It never truncates context, converts images, or lowers reasoning effort.

Route health is process-local and shared only by plugin mounts with the same resolved policy and owning service identities; an incompatible mount fails during plugin application. Success updates first-token latency and closes the circuit. Provider error finishes update failure and cooldown state. Cancellation, incomplete streams, and wrapper errors release capacity without penalizing the route. Restarting the process resets health.

## Attempts, durability, and failover

The router reserves one route per Agent, turn, step, and physical attempt. Immediately before adapter dispatch, the stream listener appends `llm/auto-route` with the pool, physical route, attempt number, candidate count, and decision reason. Existing `request/header`, `request/context`, and assistant source identity remain the authoritative physical request facts.

A non-empty text or reasoning delta, any tool-call delta, or `block-end` commits output. Before commitment, the prepended `agent/request-error` listener may append `llm/auto-failover` and request another attempt when the configured budget and an untried compatible route remain. Context overflow stays with compaction recovery. If Auto delegates and another recovery listener requests a retry, the next attempt is pinned to the same physical route. Only the Auto listener authorizes a cross-model retry.

Package invariants require contiguous route attempts, physical identity matching the current request header, failover identity matching its prior route, and no failover after committed output. The event envelope format is unchanged, so `SESSION_FORMAT_VERSION` remains `0`.

## Host and Web integration

The Host wire carries one concrete `ModelSelection`; virtual Auto identities remain distinct from the physical `request/header` and assistant source identity. The `/model` popup adds one Auto row, and the composer reflects an active Auto selection without selecting a physical catalog row or showing reasoning-effort controls. Headless Agents read the same default-model service and install the same durable selection capture.

The router publishes optional `llmAutoRouter` operations for pool validation, routability, and image admission. Host reads that service through `ctx.get`, so the base router mount enables Host-side Auto selection and image preflight without making the service a strict Host injection.

## Alternatives considered

**Add a general model-router capability seam to the agent loop.** Conversation requests are the only routing consumer. A Service Definition, Service Provider, and Consumer split would widen the loop before another consumer requires it; existing request and stream extension points carry the implemented behavior.

**Register Auto as an LLM adapter.** A virtual adapter would make physical headers, context, retry policy, and assistant source identity name Auto, or require duplicate dispatch machinery. Resolving before physical call preparation preserves existing ownership.

**Switch inside `llm/stream`.** A prepared call is bound to one adapter, and its physical header is already logged. Asking the loop to retry the open step gives the next route normal preparation, logging, and source attribution.

**Persist only physical request headers.** This loses an unused Auto selection and restores a session as a manual selection of whichever route served last. Requested virtual identity and physical dispatch require separate durable facts.

**Analyze prompt content.** Content-aware or quality routing increases privacy exposure and defines a different policy. This router is metadata-only and availability-first.

## Consequences

Auto improves availability and load distribution without changing manual routing or adapter ownership. The session log explains both the durable virtual choice and every physical attempt, but repeated runs can choose different healthy routes and cross-route retries can lose provider-local KV-cache reuse.

Compatibility depends on complete adapter metadata, token measurement remains an estimate, and health does not coordinate across processes or survive restart. Virtual Auto selections carry no reasoning-effort preference.

The current `agent/request-error` payload identifies only the provider, not the failed model or attempt id. The router therefore attributes recovery only to the latest dispatched Auto attempt whose provider and model also match the current durable request header; overlapping physical attempts still require a richer failure identity for direct correlation.

Failover also depends on the [existing request-recovery extension point](../architecture/2026-06-21-bounded-llm-request-recovery.md), its waterfall ordering, and its retry action. New recovery plugins must preserve Auto's pre-commit-only cross-route ownership and same-route pinning after delegation. Direct `ctx.llm.stream()` callers have no Agent step or request-error lifecycle and remain single-route, single-attempt callers.

Current verification requires the package's routing, stream, failover, persistence, invariant, and Loader-composition checks; Host and Web checks pin virtual selection, physical route evidence, and manual-selection behavior.
