# @deepseek-ai/dsh-llm-auto-router

English | [中文](README.zh.md)

Availability-first automatic model routing for Agent requests. Explicit model selections remain fixed; an Auto selection resolves every physical attempt from configured pools using compatibility, process-local health, first-token latency, and in-flight load.

## Configuration

The `default` pool includes every advertised `provider/model` route unless configuration replaces it. Named pools accept include and exclude patterns. `models` is keyed by canonical `provider/model`; each explicit route names its pool and concurrency limit and may set `enabled` or `preferenceMultiplier`. Explicit entries may add routes absent from provider catalogs.

The router rejects routes whose declared modality, context capacity, output allowance, or reasoning efforts cannot serve the request. Missing required metadata makes a route ineligible. The generated [configuration catalog](../../../docs/config-catalog.md) lists defaults for scoring, token reserve, exploration, failure thresholds, cooldowns, half-open probes, and per-step failover limits.

Health state is shared only by plugin instances with the same resolved policy and identical owning Context and service identities. An incompatible process-global reuse fails during plugin application. Successful terminal finishes update latency and clear failures. Provider error finishes update failure and circuit state. Cancellation, preparation failures, incomplete streams, and wrapper errors release capacity without penalizing the provider.

## Selection and failover

`model/selection` stores logical Auto or concrete intent independently from physical request headers. Auto prompt variables remain `provider=auto` and `model=auto`; physical provider/model values are recorded by `request/header`, route events, and assistant provenance.

The router may switch routes only before output commitment. Non-empty text or reasoning, any tool-call delta, and `block-end` commit an attempt. A route event is appended after the delegated iterator successfully enters and before its first chunk is yielded; construction and first-read failures leave no route event. Context overflow remains owned by compaction. When another request-error listener chooses retry, the router pins that retry to the same physical route and consumes the pin only after the replacement reservation succeeds.

## Model Experience

### Automatic request routing

#### What the model sees

The plugin adds no prompt text, messages, schemas, or tool results. All physical attempts receive the same assembled messages. Auto variables remain logical metadata (`provider=auto`, `model=auto`) and do not expose the selected physical route to the prompt.

#### Token effect

The plugin adds no tokens. It measures each candidate against the complete request header and excludes routes that cannot fit measured input, requested or default output, and the configured safety reserve.

#### KV Cache effect

Retries on the same physical route preserve normal provider cache opportunities. Cross-route failover can miss provider-local caches because the next attempt uses another provider/model.

## Known Limitations and Deferred Work

- **Health is process-local** — latency, failure, circuit, and concurrency state reset when the process restarts.
- **Compatibility depends on metadata** — routes without required modality, context, output, or reasoning declarations are ineligible.
- **Auto reasoning effort is not selectable** — automatic intent does not carry a reasoning-effort preference; choose a concrete model to request one.
- **Request-error attribution lacks a model field** — the core event identifies only the provider, so the router also checks its latest dispatched attempt against the current physical request header. Exact attribution relies on that plugin-owned state until the core event carries the model or attempt identity.
