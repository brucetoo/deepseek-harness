# Agent Note: Feishu notifications for user questions

Status: implemented

English | [中文](2026-08-27-feishu-hitl-notifications.zh.md)

## Problem

A Web agent can wait indefinitely in `ask_user_question` or `exit_plan_mode` while the operator is away from the DSH browser. The existing composer is the authoritative answer surface, but it cannot notify an operator through Feishu. Replacing that surface or registering a second user-question provider would split answer ownership and conflict with the service's single-provider rule.

## Decision

`@deepseek-ai/dsh-user-questions` publishes the contained `user-question/requested` observer event once after a valid request enters the active provider. The provider promise remains authoritative; observer work is concurrent and contained, so it cannot answer, cancel, reject, or delay that promise.

The opt-in `@deepseek-ai/dsh-feishu-hitl-notifier` Host plugin observes agent-owned requests, classifies `plan-review` intent, builds a bounded plain-text card, and invokes the locally installed `feishu-cli` through `ctx.subprocess`. It sends one interactive card to each configured `open_id`, `user_id`, or `chat_id`. The card's button returns to an absolute DSH URL carrying `?session=<id>`; the Client runtime consumes that parameter as the startup selection override after validating it against the first Session list.

The CLI reads credentials from an explicitly resolved `~/.feishu-cli/config.yaml`. The expected deployment uses app ID `cli_a95ed1953aba5bc0`, but the plugin does not inspect or enforce that ID and never reads the app secret. It passes the JSON card as one argv value without a shell. Nonzero exits, timeouts, and malformed CLI output are logged without CLI stderr or recipient identifiers and never enter the model transcript or reject the question. Plugin disposal stops observation, aborts every in-flight delivery, and joins their settlement before teardown completes.

The package is installable and resolvable by the DSH CLI but stays out of shipped bundle patches. A deployment opts in with its own profile patch because its recipients, reachable Web URL, and local CLI are deployment-specific.

## Settings extension

The Host settings namespace, live reconfiguration, and test remote are implemented on this feature branch. The browser card source is also present, but this note does not treat the UI as shipped until its Client contribution is packaged and mounted by the deployment.

The plugin owns one Host settings namespace and exposes one atomic `configuration` value rather than independent settings keys. Its top-level fields are `enabled`; `webBaseUrl`; `recipients`; integer `summaryMaxChars`, defaulting to `240`; and boolean `includeSessionTitle`, defaulting to `true`. `webBaseUrl` must be an absolute HTTP(S) URL of at most 2,048 Unicode code points with no userinfo, query, or fragment. `summaryMaxChars` must be from `1` through `1000`. `recipients` accepts at most 100 unique entries, each with a trimmed `id` of 1 through 512 Unicode code points and a `type` of `open_id`, `user_id`, `chat_id`, or `email`; an enabled configuration requires at least one recipient, while a disabled configuration may persist an empty list. Profile-owned `cli.executable`, `cli.configPath`, and `cli.timeoutMs` are outside the namespace, so browser settings cannot redirect or retune the local credential-bearing process boundary.

A save performs one revision-fenced settings operation for the complete `configuration`. It does not issue one mutation per field. The settings-file provider persists the accepted value, and the plugin live-applies it to later observations without a Host restart. This is runtime configuration replacement, not code HMR. Validation failure, persistence failure, or a revision conflict leaves the full draft intact and presents a sanitized failure for correction; it never partially applies a form.

Each observed question and each test captures one immutable effective-config snapshot before doing work. A later save affects later work only, so one delivery cannot mix old recipients with a new URL or content policy. The plugin remains a single Host instance: one namespace owner, one generated Typert remote, and one observer. Multiple configurable instances were rejected because they would make namespace ownership and event fan-out ambiguous.

The Client contribution is keyed by the plugin-owned namespace under `settings.plugin.item`, rather than adding notifier knowledge to the Settings shell. Its current source uses labeled native controls, keyboard-reachable actions, alert and live-status semantics, and focus placement for a newly added recipient; recipient state is expressed in text rather than by color alone. Shipping the surface requires the Client artifact and generated Typert remote artifacts to accompany the Host plugin.

## Test notification contract

A per-recipient **Test** action calls the generated Typert remote with only the identity of a recipient already present in the saved configuration. It never accepts an arbitrary destination or a draft recipient, and the Host resolves the target again from its immutable saved snapshot. Unsaved recipient edits must be saved before they can be tested.

The test sends a fixed, privacy-safe card that identifies itself as a DSH Feishu notification test. It contains no question text, session title, session link, transcript, draft, tool argument, credential, or recipient identifier. The remote returns only the closed, sanitized statuses `sent`, `busy`, `not-configured`, or `delivery-failed`; raw CLI output, stderr, paths, credentials, and recipient identifiers never cross the boundary. Automatic notifications may be disabled while a saved recipient is tested, but the UI must show an explicit warning that the test is manual and does not enable automatic delivery.

Testing reuses the existing one-shot argv-only delivery path and its configured timeout. It adds no retry, reminder, delivery ledger, or read receipt, and a successful status still means only that the local CLI accepted the send operation.

## Request observation contract

`user-question/requested` is an in-process, non-durable observer notification carrying the already validated `AskUserQuestionRequest`. One service `ask()` call produces at most one notification after the provider accepts the call synchronously. Browser reconnect replay does not produce another event. The event is not a pending-request registry, delivery audit, or answer channel.

The notifier ignores agentless requests because they have no Web session to link. It sends only the first question text, question count, current session title when available, and session link. It never sends `detail`, option descriptions, tool arguments, conversation history, or answer drafts.

## Alternatives considered

**Observe API Proxy `question/requested` frames.** This would couple a Host notification plugin to one transport provider and would not work for other user-question providers.

**Register a second `UserQuestionProvider`.** The service intentionally permits one answer owner. A notification sink is not an answer provider and must not race the Web UI.

**Send through the Feishu OpenAPI SDK.** This would duplicate authentication and token handling already owned by the requested local `feishu-cli` installation.

**Mount the notifier in the default Web bundle.** A default row would make local CLI availability and private recipients product startup requirements. The feature is deployment-specific and remains opt-in.

**Expose profile CLI fields in Settings.** This would let a browser user redirect executable or credential-config resolution. Those fields remain deployment-owned and excluded from the namespace.

**Persist and live-apply each browser field separately.** This would permit mixed generations and partial saves. One atomic `configuration` mutation gives persistence, validation, and runtime replacement the same boundary.

**Let tests target drafts or arbitrary recipients.** This would turn a diagnostic into a general message-sending surface and bypass saved configuration review. Tests resolve exactly one saved recipient on the Host and use fixed content.

**Add retries or a delivery ledger for tests.** This would change the observer's best-effort architecture and introduce durable delivery semantics. Test sends retain the same single-attempt contract as automatic sends.

## Verification

- User-question tests pin exactly one contained event after valid provider entry and no event for admission failures.
- Notifier tests pin argv-only user/group delivery, plan-body and option-description exclusion, delivery failure and malformed-output containment, and unload-time abort/join behavior.
- A real Loader test composes the deployment YAML shape, calls `ctx.userQuestions.ask()`, and observes the resulting `feishu-cli` argv.
- Client runtime tests pin `?session=<id>` startup selection and the no-parameter fallback.
- Host tests pin atomic settings registration, validation limits, disabled empty recipients, immutable per-operation snapshots, live updates, fixed test content, and the four closed remote statuses.
- Client-source tests pin the one-operation revision fence, draft retention on conflict or failure, saved-recipient-only testing, the disabled warning, and the keyed `settings.plugin.item` contribution.
- The package includes its invariant companion, bilingual documentation, generated catalogs, host project reference, and CLI runtime dependency closure.

## Consequences

The design preserves one authoritative DSH answer surface while giving operators an external signal and a working return link. Delivery remains process-local and has no retry, reminder, resolution update, or durable ledger. A Host restart can lose an in-flight notification, and a successful CLI exit cannot prove that a recipient read the card. Following the CLI's active configuration without app-ID verification means changing that file changes the sending robot. The configured DSH URL must be reachable from the Feishu client; a loopback URL on a phone points to the phone, not the Host.
