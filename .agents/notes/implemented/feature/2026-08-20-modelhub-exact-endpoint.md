# Agent Note: Optional ModelHub provider plugin

Status: implemented

English | [中文](2026-08-20-modelhub-exact-endpoint.zh.md)

## Problem

The internal ModelHub exposes OpenAI Chat Completions request fields at one fixed POST URL, authenticates with an `ak` query parameter, and requires a per-request `X-TT-LOGID`. The generic pi-ai adapter addresses standard protocol paths and Bearer authentication. Adding ModelHub transport rules to that adapter would broaden its public configuration for one deployment, while mounting the internal route in `dsh-base` would expose an opt-in provider in every profile.

## Decision

`@deepseek-ai/dsh-llm-modelhub` is a separate LLM Service Provider plugin and an installable bundle. Its Cordis plugin registers only `bytedance-modelhub` on the existing `ctx.llm` capability and delegates provider-neutral message, tool, replay, attachment, timeout, and stream conversion to the exported `PiAiAdapter`. The package itself owns ModelHub's exact-target transport wrapper, query authentication, request-id header, compatibility flags, model catalog configuration, and diagnostics.

The bundle patch supplies the internal endpoint, the `AIDP_MODELHUB_AK` credential reference, and the initial `gpt-5.6-sol` and `gpt-5.5-2026-04-24` text-only catalog. `dsh-base` keeps `llm-pi-ai` dormant and does not mount ModelHub. Installing or removing the bundle adds or removes the route, settings namespace, and model catalog as one profile layer.

The plugin resolves `AIDP_MODELHUB_AK` per request through the credentials service, or through the trusted launch environment when that service is absent. Dispatch adds the key to `ak`, suppresses the Bearer header, and adds a fresh UUID in `X-TT-LOGID`. The configured endpoint cannot contain URL user information, a fragment, or an existing `ak` parameter. Provider error text is scrubbed for raw and URL-encoded forms of the key before pi-ai converts it into a Harness failure.

The plugin owns the `llm-modelhub` settings namespace and registers a shipped configurable-provider directory entry. The Models page recognizes this namespace as a direct-adapter family: it stores the key write-only, presents the exact endpoint and model catalog in the same curated fold pattern as DeepSeek, and does not label the route Custom. Endpoint, credential reference, model catalog, capacity fallbacks, image bound, idle timeout, and retry policy are therefore composition values that user settings can override live. An operation captures one immutable pi-ai provider snapshot before credential resolution, so an in-flight request cannot combine facts from two settings generations.

## Alternatives considered

- **Add `exactEndpoint` to `llm-pi-ai`.** This reuses its route configuration directly, but makes one provider's exact URL, query credential, trace header, and redaction behavior part of the generic adapter's public contract. A dedicated provider plugin keeps those rules with their current owner and still reuses pi-ai conversion.
- **Configure a second `llm-pi-ai` instance from an optional bundle.** Both instances would declare the same `llm-pi-ai` settings namespace and installed-provider directory, causing ownership collisions even when their active routes differ.
- **Mount ModelHub in `dsh-base`.** This avoids an installation step but makes an internal provider and missing credential visible in every shipped profile. The bundle mechanism already provides reversible opt-in composition.
- **Implement Chat Completions conversion again.** A standalone wire adapter would isolate the package completely but duplicate message, tool, attachment, replay, timeout, and stream behavior already implemented by `PiAiAdapter`.

## Verification

Package tests pin endpoint validation, model catalog validation, exact request paths, query authentication, absent Bearer headers, UUID request ids, `max_tokens`, credential redaction, missing credentials, image loading, replay degradation, full and simplified pi-ai streams, route disposal, and the bundle manifest. Client tests pin the ModelHub field mapping and shipped directory metadata. A real Loader composition mounts the plugin with file settings and credentials, applies a live retry-policy change, and completes a request through the configured exact endpoint. A keyless headless snapshot boots a runnable example with the optional plugin and pins its provider selection, model metadata, and missing-credential result in the durable transcript; a real Web snapshot pins the direct-provider editor, write-only credential handling, exact endpoint, model catalog, and absence of a Custom label.

## Consequences

ModelHub becomes installable per profile without changing the default model catalog or the generic pi-ai configuration contract. The package adds one provider-specific adapter and depends on pi-ai's exported adapter API; a breaking pi-ai-adapter change therefore requires coordinated updates. Exact endpoints remain unavailable through generic `llm-pi-ai` profiles unless another consumer justifies a provider-neutral extension.

Query credentials exist transiently in outbound URLs and may be visible to ModelHub infrastructure. The plugin prevents source/config storage, Bearer duplication, and propagation through provider error text, but cannot control upstream URL logging.
