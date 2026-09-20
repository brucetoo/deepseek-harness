# @deepseek-ai/dsh-browser

English | [中文](README.zh.md)

Provider-neutral Service Definition for one visible, ephemeral browser exposed as `ctx.browser`. The service ties every operation to the exact owning `Agent`, serializes provider calls, and represents pages as a URL, title, and ARIA snapshot.

## API

`BrowserRuntime` defines `open`, `snapshot`, `prepare`, `commit`, `release`, `wait`, and `close`. Element changes use a two-phase operation: `prepare` retains one exact accessible element and returns an opaque `BrowserPreparedActionId` plus its observable fingerprint; after approval, `commit` rechecks and operates that retained element once. `release` disposes rejected or cancelled prepared state without acting.

`parsePublicBrowserUrl` accepts only absolute credential-free HTTP(S) URLs. `BrowserError` carries stable shared and provider-specific `BROWSER_*` codes.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-browser`, which owns schemas, approval text, prompt guidance, output bounds, and rendering.

#### KV Cache effect

No direct invalidation; the Consumer owns model-request changes.

## Known Limitations and Deferred Work

- The interface intentionally omits authenticated profiles, tabs, arbitrary scripts, coordinates, screenshots, uploads, downloads, and popup control.
- Prepared fingerprints cover observable element identity but cannot prove that script-installed handlers remain unchanged between approval and commit.
