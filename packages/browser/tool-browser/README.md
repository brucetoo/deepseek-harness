# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

Model-facing Consumer for the [`ctx.browser`](../browser/README.md) capability. It registers seven tools, owns one-shot approval text, bounds complete UTF-8 observations, contributes public-only operating guidance, and never imports a concrete browser Provider.

## Tools

| Tool | Arguments | Behavior |
|---|---|---|
| `browser_open` | `url` | Approve and open one credential-free HTTP(S) page |
| `browser_snapshot` | none | Return the current URL, title, and ARIA snapshot |
| `browser_click` | accessible role/name and optional index | Prepare, approve, then click one retained element |
| `browser_fill` | target plus complete `value` | Prepare, approve, then replace an ordinary control value |
| `browser_select` | target plus visible `option` | Prepare, approve, then select one option |
| `browser_wait` | `duration_ms` | Wait within the deployment cap, then observe |
| `browser_close` | none | Close the browser and release its ephemeral profile |

Only the exact `allowed-once` approval outcome executes `browser_open`, `browser_click`, `browser_fill`, or `browser_select`. Every other outcome fails closed; a rejected prepared element is released without action.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `maxOutputBytes` | `64000` | Complete UTF-8 observation limit |
| `timeoutMs` | `30000` | Cooperative tool-call budget |
| `maxWaitMs` | `10000` | Maximum accepted `browser_wait` duration |

## Model Experience

### System prompt

#### What the model sees

The stable guidance is:

##### Public browser guidance

```markdown
Use browser_* tools only for public pages that need visible interaction. Do not use them for login, credentials, secrets, private pages, uploads, downloads, popups, screenshots, or coordinate-based interaction. Observe, perform one approved action, then observe again. Always call browser_close when the browser task ends.
```

#### Token effect

The fixed guidance is present while the plugin is mounted. Each successful observation adds bounded URL, title, truncation state, and ARIA content; approval-visible values and subsequent tool results remain in Session history.

#### KV Cache effect

Prefix-stable while plugin registration and guidance remain unchanged. Tool calls, approvals, and results append after the reusable prefix.

### Tool schemas

#### What the model sees

The model sees the generated [seven browser tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser). Targets use exact accessible role/name pairs with an optional zero-based index; no selector, script, coordinate, credential, or file argument exists.

#### Token effect

Schema cost is fixed while configuration and registration are unchanged. Data-dependent results are capped by `maxOutputBytes`.

#### KV Cache effect

Prefix-stable while the seven definitions remain visible; scoped restrictions or plugin lifecycle changes may invalidate reuse from the first changed schema token.

## Known Limitations and Deferred Work

- This Consumer supports public, credential-free interaction only. Login, secrets, private pages, uploads, downloads, popups, screenshots, tabs, and visual coordinates are intentionally rejected or absent.
- Approval is one action at a time and has no persistent site grant.
- Output truncation preserves complete UTF-8 but can omit deeper ARIA state; the model must navigate or narrow the page rather than assume hidden content.
