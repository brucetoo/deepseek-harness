# @deepseek-ai/dsh-llm-modelhub

English | [中文](README.zh.md)

Optional ByteDance ModelHub provider for the Harness LLM seam. The package is both a Cordis plugin and an installable bundle: its plugin registers the fixed `bytedance-modelhub` route on `ctx.llm`, while [`cordis.patch.yml`](cordis.patch.yml) supplies the internal endpoint and shipped model catalog. `dsh-base` does not mount this route.

## Installation

Install the bundle into each profile that should expose ModelHub:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-llm-modelhub
dsh plugin --profile headless add @deepseek-ai/dsh-llm-modelhub
```

For a source checkout, replace the package name with `./packages/llm/llm-modelhub`. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-llm-modelhub` removes its route, models, settings section, and credential reference together.

## Configuration

The bundle supplies this plugin row:

```yaml
- id: llm-modelhub
  name: '@deepseek-ai/dsh-llm-modelhub'
  config:
    endpoint: https://aidp.bytedance.net/api/modelhub/online/v2/crawl
    apiKeyEnv: AIDP_MODELHUB_AK
    models:
      - id: gpt-5.6-sol
        name: GPT-5.6 Sol
        input: [text]
      - id: gpt-5.5-2026-04-24
        name: GPT-5.5 (2026-04-24)
        input: [text]
```

`endpoint` is the exact POST target: the plugin does not append `/chat/completions`. The URL must be absolute HTTP(S), contain no user information or fragment, and omit the `ak` query parameter. `apiKeyEnv` is a credential reference, not a key; it defaults to `AIDP_MODELHUB_AK` and resolves per request through `ctx.credentials`, or through the trusted launch environment when that service is absent.

`models` is the complete route catalog and must contain at least one unique non-empty id. Each entry may configure `name`, `contextWindow`, `maxTokens`, and `input`; omitted input is text-only. `defaultContextWindow` and `defaultMaxTokens` fill missing capacities and default to 262,144 and 32,768. An entry-level `maxTokens` also becomes the default request cap for that model. `streamIdleTimeoutMs` defaults to five minutes, `maxRequestImageBytes` defaults to 20 MiB, and `retryPolicy` uses the shared normal policy with five retries when omitted.

The plugin owns the `llm-modelhub` settings namespace and declares its route in `ctx.llm.listConfigurableProviders()`, so the Web Models page can store the referenced credential and override configuration without a restart. The page treats it as a shipped direct provider rather than a custom route: API key is the primary field, while the exact endpoint and model catalog use the same curated fold pattern as DeepSeek. Configuration changes apply to the next request; an in-flight request retains the endpoint, model catalog, and credential reference it started with.

## Request behavior

Each request resolves the credential, adds it as the `ak` query parameter, suppresses the ordinary Bearer header, and adds a fresh UUID in `X-TT-LOGID`. The request uses pi-ai's OpenAI Chat Completions serialization with ModelHub compatibility fixed to `supportsStore: false`, `supportsDeveloperRole: false`, and `maxTokensField: max_tokens`. Provider error text is scrubbed for raw and URL-encoded forms of the credential before it can reach a session log.

## Model Experience

### ModelHub request

#### What the model sees

The selected ModelHub model receives the Harness system prompt, message history, tool schemas, and supported call configuration through pi-ai's Chat Completions conversion. This plugin adds no prompt prose. Image content is available only for models whose configured `input` includes `image` and requires `ctx.attachments`.

#### Token effect

Provider tokenization governs exact input. When accumulated base64 image payload exceeds `maxRequestImageBytes`, pi-ai conversion replaces the oldest images with its fixed omission text.

#### KV Cache effect

An unchanged assembled request prefix remains eligible for provider cache reuse. Changing the endpoint, model, prompt, schema, history, or image-retention decision may prevent reuse from the first changed token.

### ModelHub response

#### What the model sees

pi-ai events become Harness reasoning, text, tool-call, usage, and finish chunks; tool arguments remain raw JSON strings in the Harness log.

#### Token effect

Only response blocks retained by the agent loop enter later requests. pi-ai folds reasoning tokens into output usage when the provider does not report them separately.

#### KV Cache effect

Recorded response blocks append to the next request without changing its earlier prefix. Query credentials and request ids are transport metadata and do not enter model context.

## Known Limitations and Deferred Work

- **The configured catalog is authoritative** — the exact POST target provides no corresponding model-list endpoint, so model additions and capability changes require configuration updates.
- **Query credentials remain visible to ModelHub infrastructure** — the plugin prevents configuration storage, Bearer duplication, and propagation through provider error text, but cannot control upstream proxy or server URL logging.
- **Reasoning controls are not advertised** — the shipped catalog has no verified ModelHub effort mapping; requests use the endpoint's default until that mapping is documented.
