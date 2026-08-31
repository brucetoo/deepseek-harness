# @deepseek-ai/dsh-feishu-hitl-notifier

English | [中文](README.zh.md)

This opt-in Host plugin sends one Feishu notification when an agent-owned DSH user question reaches its active answer provider. The card links back to DSH Web. It never answers the question or changes the provider result.

## Requirements

A deployment must provide the following components:

- `feishu-cli` on the Host PATH, or an absolute executable path.
- A working CLI configuration. The default is `~/.feishu-cli/config.yaml`.
- An absolute `http` or `https` DSH Web URL reachable from Feishu clients.
- At least one configured `open_id`, `user_id`, `chat_id`, or `email` recipient.

The expected deployment identity is app ID `cli_a95ed1953aba5bc0`. The plugin deliberately doesn't inspect or enforce the app ID. It follows the active CLI configuration and never reads or logs the app secret.

## Add the plugin to a profile

The package stays out of shipped bundle patches because recipients, CLI availability, and the externally reachable Web URL are deployment-specific. Add a row to your own profile patch:

```yaml
- name: "@deepseek-ai/dsh-feishu-hitl-notifier"
  config:
    enabled: true
    webBaseUrl: "https://dsh.example.com/"
    recipients:
      - type: open_id
        id: ou_operator
      - type: chat_id
        id: oc_oncall
    cli:
      executable: feishu-cli
      configPath: ~/.feishu-cli/config.yaml
      timeoutMs: 10000
    summaryMaxChars: 240
    includeSessionTitle: true
```

## Configuration

The plugin accepts these settings:

- `enabled` enables observation. It defaults to `true` when the row is mounted.
- `webBaseUrl` is the absolute DSH Web URL. The card appends the current session as the `session` query parameter.
- `recipients` contains unique recipient objects. `type` is `open_id`, `user_id`, `chat_id`, or `email`, and `id` is the matching Feishu identifier.
- `cli.executable` selects the executable. It defaults to `feishu-cli`.
- `cli.configPath` selects the CLI configuration. It defaults to `~/.feishu-cli/config.yaml`; the plugin expands `~` before spawning.
- `cli.timeoutMs` bounds one recipient delivery. It defaults to 10,000 ms.
- `summaryMaxChars` bounds the first question's normalized summary. It defaults to 240 Unicode code points and accepts integers from 1 through 1,000.
- `includeSessionTitle` includes the current title when available. It defaults to `true`.

## Settings in DSH Web

The browser contribution adds **Feishu HITL notifier** under **Settings → Plugins → Plugin configuration**. It edits `enabled`, `webBaseUrl`, `summaryMaxChars`, `includeSessionTitle`, and up to 100 recipients. Saving persists the complete configuration as one revision-fenced settings mutation and applies it to later notifications without restarting the Host. This is live settings application, not code HMR.

The executable, CLI credential path, and timeout remain deployment-owned and are never exposed to the browser. Each saved recipient has a **Test** action. Tests send one fixed privacy-safe card; they do not include a session, question, title, or return link. An unsaved or changed recipient must be saved before testing. Explicit tests remain available when automatic notifications are disabled and still send a real Feishu message.

## Notification behavior

The plugin observes `user-question/requested`, which fires once after a valid request enters the active provider. It sends ordinary questions as "question confirmation" and questions carrying `plan-review` intent as "plan review." It ignores agentless programmatic requests because they don't identify a Web session.

Each recipient gets one `interactive` card through an argv-only command:

```text
feishu-cli --config <absolute-path> msg send \
  --receive-id-type <type> --receive-id <id> \
  --msg-type interactive --content <json> --output json
```

The card contains only the interaction type, optional session title, bounded first-question summary, question count when greater than one, and DSH link. It doesn't contain `detail`, plans, complete options, option descriptions, tool arguments, conversation history, answer drafts, credentials, or full recipient IDs in logs.

CLI resolution failure prevents plugin activation. Per-recipient delivery failures, nonzero exits, timeouts, and malformed JSON output are logged and contained. They cannot reject, cancel, or delay the original user-question answer.

## Model Experience

None, as this Host-side observer adds no prompt, tool, context message, or provider request.

#### KV Cache effect

None; notification cards remain outside model input and the Session log.

## Known Limitations and Deferred Work

- **No durable delivery** — delivery has no retry, reminder, resolution update, or durable ledger; a Host restart can lose an in-flight notification, and a successful CLI exit doesn't prove that a recipient read the card.
- **The Web URL must be externally reachable** — a loopback URL such as `127.0.0.1` usually doesn't work from a phone.
